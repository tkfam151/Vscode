// Demo data layer: everything lives in this browser (localStorage), and live
// channels use BroadcastChannel so two tabs can play teacher and student.
// Not secure and not shared between computers. For trying the site only.

const DB_KEY = 'classcode_demo_db';
const SESSION_KEY = 'classcode_demo_user'; // sessionStorage: one signed-in user per tab
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || { users: [], classes: [], enrollments: [], files: {} };
  } catch {
    return { users: [], classes: [], enrollments: [], files: {} };
  }
};
const save = (db) => localStorage.setItem(DB_KEY, JSON.stringify(db));
const uid = () => crypto.randomUUID();
const publicUser = (u) => ({ id: u.id, displayName: u.displayName, role: u.role });

export function create() {
  let me = null;

  const isStaff = (u) => u && (u.role === 'teacher' || u.role === 'admin');
  const need = (role) => {
    if (!me) throw new Error('Please sign in');
    const ok = !role || (role === 'teacher' ? isStaff(me) : me.role === role);
    if (!ok) throw new Error('Not allowed');
  };
  const ownClass = (db, classId) => {
    need('teacher');
    const c = db.classes.find((x) => x.id === classId && (x.teacherId === me.id || me.role === 'admin'));
    if (!c) throw new Error('Class not found');
    return c;
  };
  const inviteLink = (u) => {
    u.inviteToken = uid();
    return new URL('set-password.html', location.href).href.split(/[?#]/)[0] + '?invite=' + u.inviteToken;
  };

  const access = (db, wsId) => {
    const e = db.enrollments.find((x) => x.id === wsId);
    const c = e && db.classes.find((x) => x.id === e.classId);
    if (!e || !c || !me) return null;
    const role = e.studentId === me.id ? 'student' : c.teacherId === me.id || me.role === 'admin' ? 'teacher' : null;
    return role ? { e, c, role } : null;
  };

  return {
    async init() {
      const id = sessionStorage.getItem(SESSION_KEY);
      const u = id && load().users.find((x) => x.id === id);
      me = u ? publicUser(u) : null;
      return me;
    },

    // Sign-ups are students. Demo only: the first account becomes the admin,
    // standing in for the SQL step in the real setup.
    async signUp({ email, password, displayName }) {
      const db = load();
      email = email.trim().toLowerCase();
      if (db.users.some((u) => u.email === email)) throw new Error('That email already has an account');
      const role = db.users.some((u) => u.role === 'admin') ? 'student' : 'admin';
      const u = { id: uid(), email, password, displayName: displayName.trim() || email, role };
      db.users.push(u);
      save(db);
      sessionStorage.setItem(SESSION_KEY, u.id);
      return (me = publicUser(u));
    },

    async signIn({ email, password }) {
      const u = load().users.find((x) => x.email === email.trim().toLowerCase());
      if (u?.pending) throw new Error('Set your password first, using the link from your invite');
      if (!u || u.password !== password) throw new Error('Wrong email or password');
      sessionStorage.setItem(SESSION_KEY, u.id);
      return (me = publicUser(u));
    },

    async signOut() {
      sessionStorage.removeItem(SESSION_KEY);
      me = null;
    },

    // ---- admin: teacher accounts. No email in demo mode: the page shows the link instead. ----
    async listStaff() {
      need('admin');
      return load()
        .users.filter(isStaff)
        .map((u) => ({ id: u.id, displayName: u.displayName, role: u.role, email: u.email, status: u.pending ? 'invited' : 'active', classCount: load().classes.filter((c) => c.teacherId === u.id).length }))
        .sort((a, b) => a.role.localeCompare(b.role) || a.displayName.localeCompare(b.displayName));
    },

    async inviteStaff({ email, displayName, role }) {
      need('admin');
      const db = load();
      email = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
      if (!displayName.trim()) throw new Error("Enter the teacher's name");
      if (db.users.some((u) => u.email === email)) throw new Error('That email already has an account');
      const u = { id: uid(), email, password: null, pending: true, displayName: displayName.trim().slice(0, 60), role: role === 'admin' ? 'admin' : 'teacher' };
      const demoLink = inviteLink(u);
      db.users.push(u);
      save(db);
      return { id: u.id, demoLink };
    },

    async resendInvite(id) {
      need('admin');
      const db = load();
      const u = db.users.find((x) => x.id === id && isStaff(x));
      if (!u) throw new Error('Teacher account not found');
      const demoLink = inviteLink(u);
      save(db);
      return { sent: u.pending ? 'invite' : 'reset', demoLink };
    },

    async removeStaff(id) {
      need('admin');
      if (id === me.id) throw new Error("You can't remove your own account");
      const db = load();
      if (!db.users.some((x) => x.id === id && isStaff(x))) throw new Error('Teacher account not found');
      const classIds = new Set(db.classes.filter((c) => c.teacherId === id).map((c) => c.id));
      for (const e of db.enrollments.filter((x) => classIds.has(x.classId))) delete db.files[e.id];
      db.enrollments = db.enrollments.filter((e) => !classIds.has(e.classId));
      db.classes = db.classes.filter((c) => !classIds.has(c.id));
      db.users = db.users.filter((u) => u.id !== id);
      save(db);
    },

    // Demo mode sends no email: the page shows the reset link instead.
    async requestPasswordReset(email) {
      const db = load();
      const u = db.users.find((x) => x.email === String(email).trim().toLowerCase());
      if (!u) return {};
      const demoLink = inviteLink(u);
      save(db);
      return { demoLink };
    },

    // ---- set-password page ----
    async invitedUser() {
      const token = new URLSearchParams(location.search).get('invite');
      const u = token && load().users.find((x) => x.inviteToken === token);
      return u ? { email: u.email, displayName: u.displayName } : null;
    },

    async setPassword(password) {
      const token = new URLSearchParams(location.search).get('invite');
      const db = load();
      const u = token && db.users.find((x) => x.inviteToken === token);
      if (!u) throw new Error('This link has expired');
      u.password = password;
      u.pending = false;
      delete u.inviteToken;
      save(db);
      sessionStorage.setItem(SESSION_KEY, u.id);
      me = publicUser(u);
    },

    async listClasses() {
      need();
      const db = load();
      if (isStaff(me)) {
        return db.classes
          .filter((c) => c.teacherId === me.id || me.role === 'admin')
          .map((c) => ({
            id: c.id,
            name: c.name,
            joinCode: c.joinCode,
            studentCount: db.enrollments.filter((e) => e.classId === c.id && (e.kind || 'student') === 'student').length,
            teacherName: db.users.find((u) => u.id === c.teacherId)?.displayName || '',
            teacherId: c.teacherId,
            mine: c.teacherId === me.id,
          }))
          .sort((a, b) => Number(b.mine) - Number(a.mine));
      }
      return db.enrollments
        .filter((e) => e.studentId === me.id && (e.kind || 'student') === 'student')
        .map((e) => {
          const c = db.classes.find((x) => x.id === e.classId);
          const t = db.users.find((u) => u.id === c.teacherId);
          return { id: c.id, name: c.name, teacherName: t?.displayName || '', workspaceId: e.id };
        });
    },

    async createClass(name, teacherId) {
      need('teacher');
      const db = load();
      const owner = teacherId || me.id;
      if (owner !== me.id) {
        if (me.role !== 'admin') throw new Error('Only admins can create classes for other teachers');
        if (!db.users.some((u) => u.id === owner && isStaff(u))) throw new Error('That person is not a teacher');
      }
      let joinCode;
      do {
        joinCode = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      } while (db.classes.some((c) => c.joinCode === joinCode));
      const c = { id: uid(), teacherId: owner, name: name.trim(), joinCode };
      db.classes.push(c);
      save(db);
      return { id: c.id };
    },

    async deleteClass(id) {
      need('teacher');
      const db = load();
      if (!db.classes.some((c) => c.id === id && (c.teacherId === me.id || me.role === 'admin'))) throw new Error('Class not found');
      for (const e of db.enrollments.filter((x) => x.classId === id)) delete db.files[e.id];
      db.enrollments = db.enrollments.filter((e) => e.classId !== id);
      db.classes = db.classes.filter((c) => c.id !== id);
      if (db.classFiles) delete db.classFiles[id];
      save(db);
    },

    async getRoster(classId) {
      need('teacher');
      const db = load();
      const c = db.classes.find((x) => x.id === classId && (x.teacherId === me.id || me.role === 'admin'));
      if (!c) throw new Error('Class not found');
      const students = db.enrollments
        .filter((e) => e.classId === classId && (e.kind || 'student') === 'student')
        .map((e) => ({ workspaceId: e.id, studentId: e.studentId, displayName: db.users.find((u) => u.id === e.studentId)?.displayName || '' }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      const teacherName = db.users.find((u) => u.id === c.teacherId)?.displayName || '';
      return { class: { id: c.id, name: c.name, joinCode: c.joinCode, teacherId: c.teacherId, teacherName }, students };
    },

    // ---- announcements ----
    async listAnnouncements(classId, limit = 50) {
      need();
      const db = load();
      const c = db.classes.find((x) => x.id === classId);
      const member = c && (c.teacherId === me.id || me.role === 'admin' || db.enrollments.some((e) => e.classId === classId && e.studentId === me.id));
      if (!member) return [];
      return (db.announcements || [])
        .filter((a) => a.classId === classId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((a) => ({ ...a, authorName: db.users.find((u) => u.id === a.authorId)?.displayName || 'Teacher' }));
    },

    async postAnnouncement(classId, body) {
      const db = load();
      ownClass(db, classId);
      body = String(body).trim();
      if (!body || body.length > 2000) throw new Error('A message must be 1 to 2000 characters');
      const a = { id: uid(), classId, authorId: me.id, body, createdAt: new Date().toISOString() };
      (db.announcements ||= []).push(a);
      save(db);
      return { id: a.id, classId, body, createdAt: a.createdAt };
    },

    async deleteAnnouncement(id) {
      const db = load();
      const a = (db.announcements || []).find((x) => x.id === id);
      if (!a) return;
      ownClass(db, a.classId);
      db.announcements = db.announcements.filter((x) => x.id !== id);
      save(db);
    },

    // ---- starter files ----
    async listStarterFiles(classId) {
      const db = load();
      ownClass(db, classId);
      return Object.entries(db.classFiles?.[classId] || {}).map(([path, content]) => ({ path, content }));
    },

    async saveStarterFile(classId, path, content) {
      const db = load();
      ownClass(db, classId);
      ((db.classFiles ||= {})[classId] ||= {})[path] = content;
      save(db);
    },

    async deleteStarterFile(classId, path) {
      const db = load();
      ownClass(db, classId);
      if (db.classFiles?.[classId]) delete db.classFiles[classId][path];
      save(db);
    },

    async copyStarterToStudents(classId) {
      const db = load();
      ownClass(db, classId);
      let files = 0;
      let students = 0;
      for (const e of db.enrollments.filter((x) => x.classId === classId && (x.kind || 'student') === 'student')) {
        const mine = (db.files[e.id] ||= {});
        let added = 0;
        for (const [path, content] of Object.entries(db.classFiles?.[classId] || {})) {
          if (!(path in mine)) (mine[path] = content), added++;
        }
        files += added;
        if (added) students++;
      }
      save(db);
      return { files, students };
    },

    // the teacher's own workspace in a class (made on first use, with the starter files)
    async setClassTeacher(classId, teacherId) {
      need('admin');
      const db = load();
      const c = db.classes.find((x) => x.id === classId);
      if (!c) throw new Error('Class not found');
      if (!db.users.some((u) => u.id === teacherId && isStaff(u))) throw new Error('That person is not a teacher');
      c.teacherId = teacherId;
      save(db);
      return { id: classId, teacherId };
    },

    async teacherWorkspace(classId) {
      const db = load();
      ownClass(db, classId);
      let e = db.enrollments.find((x) => x.classId === classId && x.studentId === me.id);
      if (!e) {
        e = { id: uid(), classId, studentId: me.id, kind: 'teacher' };
        db.enrollments.push(e);
        db.files[e.id] = { ...(db.classFiles?.[classId] || {}) };
        save(db);
      }
      return e.id;
    },

    async joinClass(code) {
      need('student');
      const db = load();
      const c = db.classes.find((x) => x.joinCode === code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (!c) throw new Error('No class found with that code');
      if (!db.enrollments.some((e) => e.classId === c.id && e.studentId === me.id)) {
        const e = { id: uid(), classId: c.id, studentId: me.id };
        db.enrollments.push(e);
        db.files[e.id] = { ...(db.classFiles?.[c.id] || {}) }; // a copy of the starter files
        save(db);
      }
    },

    async removeStudent(workspaceId) {
      need('teacher');
      const db = load();
      if (access(db, workspaceId)?.role !== 'teacher') throw new Error('Not found');
      db.enrollments = db.enrollments.filter((e) => e.id !== workspaceId);
      delete db.files[workspaceId];
      save(db);
    },

    async getWorkspace(id) {
      need();
      const db = load();
      const a = access(db, id);
      if (!a) throw new Error('Workspace not found');
      return {
        id,
        classId: a.c.id,
        className: a.c.name,
        studentId: a.e.studentId,
        studentName: db.users.find((u) => u.id === a.e.studentId)?.displayName || '',
        role: a.role,
        kind: a.e.kind || 'student',
      };
    },

    async listFiles(workspaceId) {
      const db = load();
      if (!access(db, workspaceId)) throw new Error('Workspace not found');
      return Object.entries(db.files[workspaceId] || {}).map(([path, content]) => ({ path, content }));
    },

    async saveFile(workspaceId, path, content) {
      const db = load();
      if (!access(db, workspaceId)) throw new Error('Not allowed');
      (db.files[workspaceId] ||= {})[path] = content;
      save(db);
    },

    async deleteFile(workspaceId, path) {
      const db = load();
      if (!access(db, workspaceId)) throw new Error('Not allowed');
      if (db.files[workspaceId]) delete db.files[workspaceId][path];
      save(db);
    },

    channel(name) {
      const bc = new BroadcastChannel('classcode:' + name);
      const handlers = new Map();
      const peers = new Map(); // id -> { state, seen }
      const self = uid();
      let tracked = null;
      let presenceCb = null;
      const emitPresence = () => presenceCb?.([...peers.values()].map((p) => p.state));
      const beat = () => tracked && bc.postMessage({ event: '__here', payload: { id: self, state: tracked } });
      const timer = setInterval(() => {
        beat();
        const cutoff = Date.now() - 5000;
        let changed = false;
        for (const [id, p] of peers) if (p.seen < cutoff) changed = peers.delete(id) || changed;
        if (changed) emitPresence();
      }, 2000);
      bc.onmessage = ({ data }) => {
        if (data.event === '__here') {
          const before = peers.get(data.payload.id);
          peers.set(data.payload.id, { state: data.payload.state, seen: Date.now() });
          if (!before || JSON.stringify(before.state) !== JSON.stringify(data.payload.state)) emitPresence();
        } else if (data.event === '__gone') {
          if (peers.delete(data.payload.id)) emitPresence();
        } else if (data.event === '__who') beat();
        else handlers.get(data.event)?.(data.payload);
      };
      return {
        ready: Promise.resolve(),
        on: (event, cb) => handlers.set(event, cb),
        send: (event, payload) => bc.postMessage({ event, payload }),
        track(state) {
          tracked = state;
          beat();
        },
        untrack() {
          tracked = null;
          bc.postMessage({ event: '__gone', payload: { id: self } });
        },
        onPresence(cb) {
          presenceCb = cb;
          bc.postMessage({ event: '__who' });
        },
        close() {
          clearInterval(timer);
          if (tracked) bc.postMessage({ event: '__gone', payload: { id: self } });
          bc.close();
        },
      };
    },
  };
}
