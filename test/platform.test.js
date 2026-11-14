// End-to-end test of the control plane with a fake workspace driver
// (a tiny HTTP server stands in for code-server).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { createApp } from '../src/api.js';

class FakeDriver {
  servers = new Map();
  destroyed = [];
  seenCookies = [];
  folderFor() {
    return '/project';
  }
  async start(id) {
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') return res.end('ok');
      this.seenCookies.push(req.headers.cookie || '');
      res.writeHead(200, { 'set-cookie': ['cc_session=evil; Path=/', 'theme=dark; Path=/'] });
      res.end(`workspace ${id} ${req.url}`);
    });
    server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    this.servers.set(id, server);
    return { host: '127.0.0.1', port: server.address().port };
  }
  async stop(id) {
    const s = this.servers.get(id);
    this.servers.delete(id);
    if (s) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }
  async destroy(id) {
    await this.stop(id);
    this.destroyed.push(id);
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classcode-test-'));
const config = {
  host: '127.0.0.1',
  scheme: 'http',
  publicHost: null,
  idleMs: 60 * 60_000,
  portStart: 19500,
  portCount: 20,
  startTimeoutMs: 5000,
  teacherSignupCode: null,
};
const driver = new FakeDriver();
const quiet = { log() {}, error() {} };
let store, manager, server, base;

before(async () => {
  store = openDb(dataDir);
  manager = new WorkspaceManager({ config, driver, log: quiet });
  server = http.createServer(createApp({ config, store, manager }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await manager.shutdown();
  server.closeAllConnections();
  server.close();
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Minimal cookie-jar client. */
function client() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const remember = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  return {
    jar,
    async api(method, p, body, headers = {}) {
      const res = await fetch(base + p, {
        method,
        headers: { 'content-type': 'application/json', cookie: cookieHeader(), ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async get(url, headers = {}) {
      const res = await fetch(url, { redirect: 'manual', headers: { cookie: cookieHeader(), ...headers } });
      remember(res);
      return res;
    },
  };
}

const teacher = client();
const otherTeacher = client();
const alice = client();
const bob = client();
let classId, joinCode, aliceWs, bobWs;

test('accounts: sign up, log in, validation', async () => {
  let r = await teacher.api('POST', '/api/signup', { role: 'teacher', username: 'ms.lee', displayName: 'Ms Lee', password: 'correct horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'teacher');
  assert.equal((await otherTeacher.api('POST', '/api/signup', { role: 'teacher', username: 'mr.kay', password: 'correct horse' })).status, 200);
  assert.equal((await alice.api('POST', '/api/signup', { role: 'student', username: 'alice', displayName: 'Alice', password: 'password1' })).status, 200);
  assert.equal((await bob.api('POST', '/api/signup', { role: 'student', username: 'bob', displayName: 'Bob', password: 'password2' })).status, 200);

  assert.equal((await client().api('POST', '/api/signup', { role: 'student', username: 'ALICE', password: 'password1' })).status, 409);
  assert.equal((await client().api('POST', '/api/signup', { role: 'student', username: 'carol', password: 'short' })).status, 400);
  assert.equal((await client().api('POST', '/api/login', { username: 'alice', password: 'wrong-password' })).status, 401);

  const again = client();
  assert.equal((await again.api('POST', '/api/login', { username: 'alice', password: 'password1' })).status, 200);
  assert.equal((await again.api('GET', '/api/me')).body.user.username, 'alice');
  await again.api('POST', '/api/logout');
  assert.equal((await again.api('GET', '/api/me')).body.user, null);
  assert.equal((await client().api('GET', '/api/classes')).status, 401);
});

test('classes: teacher creates, students join by code', async () => {
  assert.equal((await alice.api('POST', '/api/classes', { name: 'nope' })).status, 403);
  const r = await teacher.api('POST', '/api/classes', { name: 'Period 3 Python' });
  assert.equal(r.status, 200);
  ({ id: classId, joinCode } = r.body.class);
  assert.match(joinCode, /^[A-Z2-9]{8}$/);

  assert.equal((await alice.api('POST', '/api/join', { code: 'WRONGCODE' })).status, 404);
  assert.equal((await alice.api('POST', '/api/join', { code: joinCode.toLowerCase() })).status, 200);
  assert.equal((await alice.api('POST', '/api/join', { code: joinCode })).status, 200); // idempotent
  assert.equal((await bob.api('POST', '/api/join', { code: joinCode })).status, 200);

  const mine = (await alice.api('GET', '/api/classes')).body.classes;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].workspace.state, 'stopped');
  aliceWs = mine[0].workspaceId;
  bobWs = (await bob.api('GET', '/api/classes')).body.classes[0].workspaceId;
  assert.notEqual(aliceWs, bobWs);

  const roster = (await teacher.api('GET', `/api/classes/${classId}`)).body.students;
  assert.deepEqual(roster.map((s) => s.displayName), ['Alice', 'Bob']);
  assert.equal((await otherTeacher.api('GET', `/api/classes/${classId}`)).status, 404);
});

test('workspace access control', async () => {
  assert.equal((await bob.api('POST', `/api/workspaces/${aliceWs}/open`)).status, 404);
  assert.equal((await otherTeacher.api('POST', `/api/workspaces/${aliceWs}/open`)).status, 404);
  assert.equal((await otherTeacher.api('POST', `/api/workspaces/${aliceWs}/stop`)).status, 404);
  assert.equal((await client().api('POST', `/api/workspaces/${aliceWs}/open`)).status, 401);
  assert.equal(manager.status(aliceWs).state, 'stopped');
});

test('API refuses cross-origin and non-JSON writes', async () => {
  const r = await alice.api('POST', `/api/workspaces/${aliceWs}/open`, {}, { origin: 'http://127.0.0.1:19500' });
  assert.equal(r.status, 403);
  const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('student opens a workspace; teacher can enter it too', async () => {
  const r = await alice.api('POST', `/api/workspaces/${aliceWs}/open`);
  assert.equal(r.status, 200);
  const enter = new URL(r.body.url);
  assert.equal(enter.hostname, '127.0.0.1');
  const wsBase = enter.origin;
  assert.equal(manager.status(aliceWs).state, 'running');

  // no cookie yet -> refused
  assert.equal((await client().get(`${wsBase}/some/file`)).status, 401);

  const res = await alice.get(r.body.url);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/__classroom/');
  assert.ok(alice.jar.has(`cc_ws_${aliceWs}`));
  // enter links are single-use
  assert.equal((await client().get(r.body.url)).status, 403);

  const shell = await (await alice.get(`${wsBase}/__classroom/`)).text();
  assert.match(shell, /"studentName":"Alice"/);
  assert.match(shell, /"isTeacher":false/);

  // proxied to the student's code-server, without leaking platform cookies
  const proxied = await alice.get(`${wsBase}/hello?x=1`, { cookie: `cc_session=secret; cc_ws_${aliceWs}=${alice.jar.get(`cc_ws_${aliceWs}`)}; theme=dark` });
  assert.equal(await proxied.text(), `workspace ${aliceWs} /hello?x=1`);
  assert.equal(driver.seenCookies.at(-1), 'theme=dark');
  assert.deepEqual(proxied.headers.getSetCookie(), ['theme=dark; Path=/']);

  // another origin (e.g. another workspace port) cannot use the cookie
  assert.equal((await alice.get(`${wsBase}/hello`, { origin: 'http://127.0.0.1:1' })).status, 403);

  // Bob's dashboard session is useless here
  assert.equal((await bob.get(`${wsBase}/hello`)).status, 401);

  // teacher gets their own way in to the same workspace
  const t = await teacher.api('POST', `/api/workspaces/${aliceWs}/open`);
  assert.equal(new URL(t.body.url).origin, wsBase);
  await teacher.get(t.body.url);
  const tShell = await (await teacher.get(`${wsBase}/__classroom/`)).text();
  assert.match(tShell, /"isTeacher":true/);
  assert.equal(await (await teacher.get(`${wsBase}/x`)).text(), `workspace ${aliceWs} /x`);

  // each running workspace has its own port
  const b = await bob.api('POST', `/api/workspaces/${bobWs}/open`);
  assert.notEqual(new URL(b.body.url).port, enter.port);
});

test('websocket upgrades need a session and a matching Origin', async () => {
  const port = manager.status(aliceWs).port;
  const cookie = `cc_ws_${aliceWs}=${alice.jar.get(`cc_ws_${aliceWs}`)}`;
  const upgrade = (headers) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } });
      req.on('upgrade', (res, socket) => (socket.destroy(), resolve(res.statusCode)));
      req.on('response', (res) => (res.resume(), resolve(res.statusCode)));
      req.on('error', reject);
      req.end();
    });
  assert.equal(await upgrade({ cookie, origin: `http://127.0.0.1:${port}` }), 101);
  assert.equal(await upgrade({ cookie, origin: 'http://127.0.0.1:1' }), 403);
  assert.equal(await upgrade({ cookie }), 403);
  assert.equal(await upgrade({ origin: `http://127.0.0.1:${port}` }), 403);
});

test('idle workspaces are closed and must be reopened', async () => {
  const port = manager.status(aliceWs).port;
  const wsBase = `http://127.0.0.1:${port}`;
  const ws = manager.active.get(aliceWs);

  // a ping without input does not count as activity, a ping with input does
  ws.lastActivity = Date.now() - 30 * 60_000;
  let ping = await fetch(`${wsBase}/__classroom/ping?active=0`, { method: 'POST', headers: { cookie: `cc_ws_${aliceWs}=${alice.jar.get(`cc_ws_${aliceWs}`)}` } });
  assert.ok((await ping.json()).remainingMs <= 30 * 60_000);
  ping = await fetch(`${wsBase}/__classroom/ping?active=1`, { method: 'POST', headers: { cookie: `cc_ws_${aliceWs}=${alice.jar.get(`cc_ws_${aliceWs}`)}` } });
  assert.ok((await ping.json()).remainingMs > 59 * 60_000);

  // 59 minutes idle: still open
  ws.lastActivity = Date.now() - 59 * 60_000;
  manager.reap();
  assert.equal(manager.status(aliceWs).state, 'running');

  // 60 minutes idle: closed
  ws.lastActivity = Date.now() - 60 * 60_000;
  manager.reap();
  await ws.stopPromise;
  assert.deepEqual(manager.status(aliceWs), { state: 'stopped', lastStopReason: 'idle' });
  assert.equal(driver.servers.has(aliceWs), false);
  await assert.rejects(fetch(`${wsBase}/hello`));
  assert.equal(manager.status(bobWs).state, 'running'); // others unaffected

  // reopening works, and the old cookie is no longer valid
  const oldCookie = `cc_ws_${aliceWs}=${alice.jar.get(`cc_ws_${aliceWs}`)}`;
  const r = await alice.api('POST', `/api/workspaces/${aliceWs}/open`);
  assert.equal(r.status, 200);
  const origin = new URL(r.body.url).origin;
  assert.equal((await fetch(`${origin}/hello`, { headers: { cookie: oldCookie } })).status, 401);
  await alice.get(r.body.url);
  assert.equal((await alice.get(`${origin}/hello`)).status, 200);
});

test('teacher can close a workspace, remove a student, delete the class', async () => {
  assert.equal((await teacher.api('POST', `/api/workspaces/${bobWs}/stop`)).status, 200);
  assert.equal(manager.status(bobWs).state, 'stopped');

  assert.equal((await alice.api('DELETE', `/api/workspaces/${aliceWs}`)).status, 403);
  assert.equal((await teacher.api('DELETE', `/api/workspaces/${bobWs}`)).status, 200);
  assert.ok(driver.destroyed.includes(bobWs));
  assert.equal((await bob.api('GET', '/api/classes')).body.classes.length, 0);

  assert.equal((await otherTeacher.api('DELETE', `/api/classes/${classId}`)).status, 404);
  assert.equal((await teacher.api('DELETE', `/api/classes/${classId}`)).status, 200);
  assert.ok(driver.destroyed.includes(aliceWs));
  assert.equal(manager.active.size, 0);
  assert.equal((await alice.api('GET', '/api/classes')).body.classes.length, 0);
});
