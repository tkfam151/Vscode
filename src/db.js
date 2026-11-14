import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'classcode.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('teacher','student')),
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    -- One enrollment == one workspace. The enrollment id is the workspace id.
    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE (class_id, student_id)
    );
  `);
  return new Store(db);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  // ---- users & sessions ----
  createUser({ username, displayName, role, password }) {
    const r = this.db
      .prepare('INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?)')
      .run(username, displayName, role, hashPassword(password), Date.now());
    return this.getUser(Number(r.lastInsertRowid));
  }

  getUser(id) {
    return this.db.prepare('SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?').get(id);
  }

  getUserForLogin(username) {
    return this.db
      .prepare('SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash FROM users WHERE username = ?')
      .get(username);
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
      .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
    return { token, maxAgeSeconds: SESSION_TTL_MS / 1000 };
  }

  getSessionUser(token) {
    if (!token) return null;
    return (
      this.db
        .prepare(
          `SELECT u.id, u.username, u.display_name AS displayName, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`,
        )
        .get(sha256(token), Date.now()) || null
    );
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  // ---- classes ----
  createClass(teacherId, name) {
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = '';
      for (const b of crypto.randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      try {
        const r = this.db
          .prepare('INSERT INTO classes (teacher_id, name, join_code, created_at) VALUES (?,?,?,?)')
          .run(teacherId, name, code, Date.now());
        return this.getClass(Number(r.lastInsertRowid));
      } catch (e) {
        if (!/UNIQUE/.test(String(e.message))) throw e;
      }
    }
    throw new Error('could not allocate a join code');
  }

  getClass(id) {
    return this.db
      .prepare('SELECT id, teacher_id AS teacherId, name, join_code AS joinCode, created_at AS createdAt FROM classes WHERE id = ?')
      .get(id);
  }

  getClassByCode(code) {
    return this.db
      .prepare('SELECT id, teacher_id AS teacherId, name, join_code AS joinCode FROM classes WHERE join_code = ?')
      .get(code);
  }

  listTeacherClasses(teacherId) {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.join_code AS joinCode, c.created_at AS createdAt,
                (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS studentCount
         FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC`,
      )
      .all(teacherId);
  }

  listStudentClasses(studentId) {
    return this.db
      .prepare(
        `SELECT c.id, c.name, t.display_name AS teacherName, e.id AS workspaceId
         FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN users t ON t.id = c.teacher_id
         WHERE e.student_id = ? ORDER BY e.created_at DESC`,
      )
      .all(studentId);
  }

  listRoster(classId) {
    return this.db
      .prepare(
        `SELECT e.id AS workspaceId, u.id AS studentId, u.username, u.display_name AS displayName
         FROM enrollments e JOIN users u ON u.id = e.student_id
         WHERE e.class_id = ? ORDER BY u.display_name COLLATE NOCASE`,
      )
      .all(classId);
  }

  listClassWorkspaceIds(classId) {
    return this.db.prepare('SELECT id FROM enrollments WHERE class_id = ?').all(classId).map((r) => r.id);
  }

  deleteClass(id) {
    this.db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  }

  // ---- enrollments / workspaces ----
  enroll(classId, studentId) {
    this.db
      .prepare('INSERT OR IGNORE INTO enrollments (class_id, student_id, created_at) VALUES (?,?,?)')
      .run(classId, studentId, Date.now());
  }

  /** Workspace with everything needed for authorization and display. */
  getWorkspace(id) {
    return this.db
      .prepare(
        `SELECT e.id, e.student_id AS studentId, s.display_name AS studentName,
                c.id AS classId, c.name AS className, c.teacher_id AS teacherId
         FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN users s ON s.id = e.student_id
         WHERE e.id = ?`,
      )
      .get(id);
  }

  deleteEnrollment(id) {
    this.db.prepare('DELETE FROM enrollments WHERE id = ?').run(id);
  }
}
