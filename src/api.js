// Dashboard HTTP handler: JSON API under /api, static files for everything else.

import fs from 'node:fs';
import path from 'node:path';
import { verifyPassword } from './db.js';
import { parseCookies, sameOrigin } from './workspaces.js';

const SESSION_COOKIE = 'cc_session';
const PUBLIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      return reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(bad('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Fixed-window limiter to slow down password and join-code guessing. */
function createLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { count: 0, reset: now + windowMs }));
    if (++h.count > max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  };
}

export function createApp({ config, store, manager }) {
  const loginLimit = createLimiter(10, 5 * 60_000);
  const joinLimit = createLimiter(20, 5 * 60_000);
  const signupLimit = createLimiter(20, 60 * 60_000);
  const secure = config.scheme === 'https' ? '; Secure' : '';

  const setSession = (res, userId) => {
    const { token, maxAgeSeconds } = store.createSession(userId);
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
  };

  const wsView = (id) => {
    const s = manager.status(id);
    return { state: s.state, idleMs: s.idleMs ?? null, lastStopReason: s.lastStopReason ?? null };
  };

  /** Load a workspace and check that `user` is its student or the class's teacher. */
  const authorizeWorkspace = (user, id) => {
    const ws = Number.isInteger(id) ? store.getWorkspace(id) : null;
    if (!ws || (ws.studentId !== user.id && ws.teacherId !== user.id)) throw new HttpError(404, 'Workspace not found');
    return ws;
  };

  const ownClass = (user, id) => {
    const cls = Number.isInteger(id) ? store.getClass(id) : null;
    if (!cls || cls.teacherId !== user.id) throw new HttpError(404, 'Class not found');
    return cls;
  };

  // route table: [method, pattern, { auth, role }, handler]
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
    routes.push({ method, re, keys, opts, handler });
  };

  route('GET', '/api/config', { auth: false }, () => ({
    idleMinutes: Math.round(config.idleMs / 60_000),
    teacherCodeRequired: Boolean(config.teacherSignupCode),
  }));

  route('POST', '/api/signup', { auth: false }, ({ body, res, ip }) => {
    signupLimit(ip);
    const role = str(body.role);
    const username = str(body.username);
    const displayName = str(body.displayName) || username;
    const password = typeof body.password === 'string' ? body.password : '';
    if (role !== 'teacher' && role !== 'student') throw bad('Choose teacher or student');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw bad('Username must be 3–32 letters, numbers, dots, dashes or underscores');
    if (displayName.length > 60) throw bad('Name is too long');
    if (password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters');
    if (role === 'teacher' && config.teacherSignupCode && str(body.teacherCode) !== config.teacherSignupCode) {
      throw new HttpError(403, 'Incorrect teacher sign-up code');
    }
    let user;
    try {
      user = store.createUser({ username, displayName, role, password });
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'That username is taken');
      throw e;
    }
    setSession(res, user.id);
    return { user };
  });

  route('POST', '/api/login', { auth: false }, ({ body, res, ip }) => {
    const username = str(body.username);
    loginLimit(`${ip}|${username.toLowerCase()}`);
    const row = store.getUserForLogin(username);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!row || !verifyPassword(password, row.passwordHash)) throw new HttpError(401, 'Wrong username or password');
    setSession(res, row.id);
    const { passwordHash, ...user } = row;
    return { user };
  });

  route('POST', '/api/logout', { auth: false }, ({ req, res }) => {
    store.deleteSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return {};
  });

  route('GET', '/api/me', { auth: false }, ({ user }) => ({ user }));

  // ---- classes ----
  route('GET', '/api/classes', {}, ({ user }) => {
    if (user.role === 'teacher') return { classes: store.listTeacherClasses(user.id) };
    return {
      classes: store.listStudentClasses(user.id).map((c) => ({ ...c, workspace: wsView(c.workspaceId) })),
    };
  });

  route('POST', '/api/classes', { role: 'teacher' }, ({ user, body }) => {
    const name = str(body.name);
    if (!name || name.length > 80) throw bad('Class name must be 1–80 characters');
    return { class: store.createClass(user.id, name) };
  });

  route('GET', '/api/classes/:id', { role: 'teacher' }, ({ user, params }) => {
    const cls = ownClass(user, params.id);
    const students = store.listRoster(cls.id).map((s) => ({ ...s, workspace: wsView(s.workspaceId) }));
    return { class: { id: cls.id, name: cls.name, joinCode: cls.joinCode }, students };
  });

  route('DELETE', '/api/classes/:id', { role: 'teacher' }, async ({ user, params }) => {
    const cls = ownClass(user, params.id);
    const ids = store.listClassWorkspaceIds(cls.id);
    store.deleteClass(cls.id);
    await Promise.all(ids.map((id) => manager.destroy(id).catch(() => {})));
    return {};
  });

  route('POST', '/api/join', { role: 'student' }, ({ user, body }) => {
    joinLimit(user.id);
    const code = str(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cls = code ? store.getClassByCode(code) : null;
    if (!cls) throw new HttpError(404, 'No class found with that code');
    store.enroll(cls.id, user.id);
    return { class: { id: cls.id, name: cls.name } };
  });

  // ---- workspaces ----
  route('POST', '/api/workspaces/:id/open', {}, async ({ user, params, req }) => {
    const ws = authorizeWorkspace(user, params.id);
    try {
      await manager.ensureStarted(ws.id);
    } catch (e) {
      throw new HttpError(503, `Could not start the workspace: ${e.message}`);
    }
    const hostHeader = req.headers.host || 'localhost';
    const hostname = config.publicHost || new URL(`http://${hostHeader}`).hostname;
    const viewer = {
      userId: user.id,
      isTeacher: user.id !== ws.studentId,
      studentName: ws.studentName,
      className: ws.className,
      dashboardUrl: `${config.scheme}://${hostHeader}`,
    };
    return { url: manager.createEnterUrl(ws.id, viewer, hostname) };
  });

  route('POST', '/api/workspaces/:id/stop', {}, async ({ user, params }) => {
    const ws = authorizeWorkspace(user, params.id);
    await manager.stop(ws.id, 'manual');
    return {};
  });

  // Remove a student from a class (teacher). Deletes that student's files for the class.
  route('DELETE', '/api/workspaces/:id', { role: 'teacher' }, async ({ user, params }) => {
    const ws = authorizeWorkspace(user, params.id);
    if (ws.teacherId !== user.id) throw new HttpError(404, 'Workspace not found');
    store.deleteEnrollment(ws.id);
    await manager.destroy(ws.id);
    return {};
  });

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  async function handleApi(req, res, pathname) {
    try {
      // CSRF: workspace ports share this host's cookies, so never trust a cross-origin caller.
      if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'Cross-origin request refused');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const user = store.getSessionUser(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
        if (r.opts.auth !== false && !user) throw new HttpError(401, 'Please sign in');
        if (r.opts.role && user.role !== r.opts.role) throw new HttpError(403, 'Not allowed');
        const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
        const body = req.method === 'GET' ? {} : await readJson(req);
        const ip = req.socket.remoteAddress || '';
        return sendJson(res, 200, (await r.handler({ req, res, user, params, body, ip })) ?? {});
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
      else res.end();
    }
  }

  function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    return handleStatic(req, res, pathname);
  };
}
