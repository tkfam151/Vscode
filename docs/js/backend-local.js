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

  const need = (role) => {
    if (!me) throw new Error('Please sign in');
    if (role && me.role !== role) throw new Error('Not allowed');
  };

  const access = (db, wsId) => {
    const e = db.enrollments.find((x) => x.id === wsId);
    const c = e && db.classes.find((x) => x.id === e.classId);
    if (!e || !c || !me) return null;
    const role = e.studentId === me.id ? 'student' : c.teacherId === me.id ? 'teacher' : null;
    return role ? { e, c, role } : null;
  };

  return {
    async init() {
      const id = sessionStorage.getItem(SESSION_KEY);
      const u = id && load().users.find((x) => x.id === id);
      me = u ? publicUser(u) : null;
      return me;
    },

    async signUp({ email, password, displayName, role }) {
      const db = load();
      email = email.trim().toLowerCase();
      if (db.users.some((u) => u.email === email)) throw new Error('That email already has an account');
      const u = { id: uid(), email, password, displayName: displayName.trim() || email, role };
      db.users.push(u);
      save(db);
      sessionStorage.setItem(SESSION_KEY, u.id);
      return (me = publicUser(u));
    },

    async signIn({ email, password }) {
      const u = load().users.find((x) => x.email === email.trim().toLowerCase() && x.password === password);
      if (!u) throw new Error('Wrong email or password');
      sessionStorage.setItem(SESSION_KEY, u.id);
      return (me = publicUser(u));
    },

    async signOut() {
      sessionStorage.removeItem(SESSION_KEY);
      me = null;
    },

    async listClasses() {
      need();
      const db = load();
      if (me.role === 'teacher') {
        return db.classes
          .filter((c) => c.teacherId === me.id)
          .map((c) => ({ id: c.id, name: c.name, joinCode: c.joinCode, studentCount: db.enrollments.filter((e) => e.classId === c.id).length }));
      }
      return db.enrollments
        .filter((e) => e.studentId === me.id)
        .map((e) => {
          const c = db.classes.find((x) => x.id === e.classId);
          const t = db.users.find((u) => u.id === c.teacherId);
          return { id: c.id, name: c.name, teacherName: t?.displayName || '', workspaceId: e.id };
        });
    },

    async createClass(name) {
      need('teacher');
      const db = load();
      let joinCode;
      do {
        joinCode = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      } while (db.classes.some((c) => c.joinCode === joinCode));
      const c = { id: uid(), teacherId: me.id, name: name.trim(), joinCode };
      db.classes.push(c);
      save(db);
      return { id: c.id };
    },

    async deleteClass(id) {
      need('teacher');
      const db = load();
      if (!db.classes.some((c) => c.id === id && c.teacherId === me.id)) throw new Error('Class not found');
      for (const e of db.enrollments.filter((x) => x.classId === id)) delete db.files[e.id];
      db.enrollments = db.enrollments.filter((e) => e.classId !== id);
      db.classes = db.classes.filter((c) => c.id !== id);
      save(db);
    },

    async getRoster(classId) {
      need('teacher');
      const db = load();
      const c = db.classes.find((x) => x.id === classId && x.teacherId === me.id);
      if (!c) throw new Error('Class not found');
      const students = db.enrollments
        .filter((e) => e.classId === classId)
        .map((e) => ({ workspaceId: e.id, studentId: e.studentId, displayName: db.users.find((u) => u.id === e.studentId)?.displayName || '' }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      return { class: { id: c.id, name: c.name, joinCode: c.joinCode }, students };
    },

    async joinClass(code) {
      need('student');
      const db = load();
      const c = db.classes.find((x) => x.joinCode === code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (!c) throw new Error('No class found with that code');
      if (!db.enrollments.some((e) => e.classId === c.id && e.studentId === me.id)) {
        db.enrollments.push({ id: uid(), classId: c.id, studentId: me.id });
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
      };
    },

    async listFiles(workspaceId) {
      const db = load();
      if (!access(db, workspaceId)) throw new Error('Workspace not found');
      return Object.entries(db.files[workspaceId] || {}).map(([path, content]) => ({ path, content }));
    },

    async saveFile(workspaceId, path, content) {
      const db = load();
      if (access(db, workspaceId)?.role !== 'student') throw new Error('Not allowed');
      (db.files[workspaceId] ||= {})[path] = content;
      save(db);
    },

    async deleteFile(workspaceId, path) {
      const db = load();
      if (access(db, workspaceId)?.role !== 'student') throw new Error('Not allowed');
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
          const known = peers.has(data.payload.id);
          peers.set(data.payload.id, { state: data.payload.state, seen: Date.now() });
          if (!known) emitPresence();
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
