// Workspace manager.
//
// Every running workspace gets its own TCP port on this machine (http://<ip>:<port>/).
// A separate port means a separate browser origin, so code running inside one
// student's VS Code cannot script the dashboard or another student's workspace.
//
// The port is served by an authenticating reverse proxy in this process:
//   browser --> :<port> (this file) --> 127.0.0.1:<private port> (code-server)
//
// Paths under /__classroom/ are answered by the proxy itself (login hand-off,
// the wrapper page with the idle timer, activity pings). Everything else is
// forwarded to code-server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const SHELL_HTML = fs.readFileSync(new URL('./shell.html', import.meta.url), 'utf8');
const ENTER_TOKEN_TTL_MS = 60_000;
const COOKIE_PREFIX = 'cc_'; // all platform cookies; never forwarded to student code

const randomToken = () => crypto.randomBytes(32).toString('base64url');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Remove the platform's own cookies so they never reach a student's container. */
function stripPlatformCookies(header) {
  return String(header || '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(COOKIE_PREFIX))
    .join('; ');
}

/** True when the request's Origin header (if any) matches the host it was sent to. */
export function sameOrigin(req, { required = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) return !required;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  constructor({ config, driver, log = console }) {
    this.config = config;
    this.driver = driver;
    this.log = log;
    this.active = new Map(); // id -> workspace
    this.lastStop = new Map(); // id -> { reason, at }
    this.usedPorts = new Set();
    this.reaper = setInterval(() => this.reap(), 15_000);
    this.reaper.unref();
  }

  status(id) {
    const ws = this.active.get(id);
    if (!ws) {
      const last = this.lastStop.get(id);
      return { state: 'stopped', lastStopReason: last?.reason ?? null };
    }
    return {
      state: ws.state,
      port: ws.port,
      idleMs: Date.now() - ws.lastActivity,
      remainingMs: Math.max(0, this.config.idleMs - (Date.now() - ws.lastActivity)),
    };
  }

  /** Start the workspace if it is not running. Resolves once code-server answers. */
  ensureStarted(id) {
    let ws = this.active.get(id);
    if (ws) {
      if (ws.state === 'stopping') return ws.stopPromise.then(() => this.ensureStarted(id));
      return ws.startPromise;
    }
    ws = {
      id,
      state: 'starting',
      port: null,
      target: null,
      server: null,
      sockets: new Set(),
      lastActivity: Date.now(),
      enterTokens: new Map(), // token -> { viewer, expires }
      sessions: new Map(), // cookie value -> viewer
    };
    this.active.set(id, ws);
    ws.startPromise = this.#start(ws).then(
      () => ws,
      async (err) => {
        this.log.error(`[workspace ${id}] failed to start: ${err.message}`);
        await this.stop(id, 'error');
        throw err;
      },
    );
    return ws.startPromise;
  }

  async #start(ws) {
    await this.#listen(ws);
    ws.target = await this.driver.start(ws.id);
    await this.#waitReady(ws);
    if (ws.state !== 'starting') throw new Error('workspace was stopped while starting');
    ws.state = 'running';
    ws.lastActivity = Date.now();
    this.lastStop.delete(ws.id);
    this.log.log(`[workspace ${ws.id}] running on port ${ws.port}`);
  }

  async #listen(ws) {
    const { config } = this;
    const handler = (req, res) => this.#onRequest(ws, req, res);
    const server =
      config.scheme === 'https'
        ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
        : http.createServer(handler);
    server.on('upgrade', (req, socket, head) => this.#onUpgrade(ws, req, socket, head));
    server.on('connection', (s) => {
      ws.sockets.add(s);
      s.once('close', () => ws.sockets.delete(s));
    });
    ws.server = server;

    for (let i = 0; i < config.portCount; i++) {
      const port = config.portStart + i;
      if (this.usedPorts.has(port)) continue;
      this.usedPorts.add(port);
      const ok = await new Promise((resolve) => {
        const onError = () => resolve(false);
        server.once('error', onError);
        server.listen(port, config.host, () => {
          server.off('error', onError);
          resolve(true);
        });
      });
      if (ok) {
        ws.port = port;
        return;
      }
      this.usedPorts.delete(port);
    }
    throw new Error('All workspace ports are in use. Try again once another workspace closes.');
  }

  async #waitReady(ws) {
    const deadline = Date.now() + this.config.startTimeoutMs;
    while (Date.now() < deadline) {
      if (ws.state !== 'starting') return;
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: ws.target.host, port: ws.target.port, path: '/healthz', timeout: 2000 }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('VS Code did not start in time');
  }

  /** One-time link that logs `viewer` into the workspace's own origin. */
  createEnterUrl(id, viewer, hostname) {
    const ws = this.active.get(id);
    if (!ws || ws.state !== 'running') throw new Error('workspace is not running');
    const token = randomToken();
    ws.enterTokens.set(token, { viewer, expires: Date.now() + ENTER_TOKEN_TTL_MS });
    ws.lastActivity = Date.now();
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    return `${this.config.scheme}://${host}:${ws.port}/__classroom/enter?token=${token}`;
  }

  stop(id, reason = 'manual') {
    const ws = this.active.get(id);
    if (!ws) return Promise.resolve();
    if (ws.state === 'stopping') return ws.stopPromise;
    ws.state = 'stopping';
    ws.stopPromise = (async () => {
      this.log.log(`[workspace ${id}] stopping (${reason})`);
      ws.sessions.clear();
      ws.enterTokens.clear();
      if (ws.server) {
        ws.server.close();
        for (const s of ws.sockets) s.destroy();
      }
      try {
        await this.driver.stop(id);
      } catch (e) {
        this.log.error(`[workspace ${id}] error while stopping: ${e.message}`);
      }
      if (ws.port) this.usedPorts.delete(ws.port);
      this.active.delete(id);
      this.lastStop.set(id, { reason, at: Date.now() });
    })();
    return ws.stopPromise;
  }

  /** Stop and delete the student's files (student removed / class deleted). */
  async destroy(id) {
    await this.stop(id, 'deleted');
    this.lastStop.delete(id);
    await this.driver.destroy(id);
  }

  reap() {
    const now = Date.now();
    for (const ws of this.active.values()) {
      if (ws.state === 'running' && now - ws.lastActivity >= this.config.idleMs) this.stop(ws.id, 'idle');
    }
  }

  async shutdown() {
    clearInterval(this.reaper);
    await Promise.all([...this.active.keys()].map((id) => this.stop(id, 'shutdown')));
  }

  // ---------------------------------------------------------------- proxy --

  #cookieName(ws) {
    return `${COOKIE_PREFIX}ws_${ws.id}`;
  }

  #viewer(ws, req) {
    const value = parseCookies(req.headers.cookie)[this.#cookieName(ws)];
    return (value && ws.sessions.get(value)) || null;
  }

  #onRequest(ws, req, res) {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/__classroom/enter') return this.#enter(ws, url, res);

    const viewer = this.#viewer(ws, req);
    if (!viewer || ws.state !== 'running') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(
        '<!doctype html><meta charset="utf-8"><title>Workspace closed</title>' +
          '<body style="font:16px system-ui;margin:15vh auto;max-width:28rem;text-align:center">' +
          '<h2>This workspace is not open</h2><p>Open it again from your class dashboard.</p>',
      );
    }
    // Other origins (e.g. a page served from another student's workspace port)
    // must not be able to drive this workspace with the viewer's cookie.
    if (!sameOrigin(req)) {
      res.writeHead(403);
      return res.end('cross-origin request refused');
    }

    if (url.pathname === '/__classroom/' || url.pathname === '/__classroom') return this.#shell(ws, viewer, res);
    if (url.pathname === '/__classroom/ping') return this.#ping(ws, req, res);
    if (url.pathname.startsWith('/__classroom/')) {
      res.writeHead(404);
      return res.end('not found');
    }

    // Someone typed the bare workspace URL: send them to the wrapper so the idle timer sees their activity.
    if (req.method === 'GET' && url.pathname === '/' && !req.headers.referer && !url.searchParams.has('folder')) {
      res.writeHead(302, { location: '/__classroom/' });
      return res.end();
    }

    const headers = { ...req.headers };
    const cookie = stripPlatformCookies(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    const upstream = http.request(
      { host: ws.target.host, port: ws.target.port, method: req.method, path: req.url, headers },
      (up) => {
        const out = { ...up.headers };
        if (out['set-cookie']) {
          // student code must not be able to plant cookies that look like ours
          out['set-cookie'] = out['set-cookie'].filter((c) => !c.trim().startsWith(COOKIE_PREFIX));
        }
        res.writeHead(up.statusCode, up.statusMessage, out);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('workspace unavailable');
    });
    req.pipe(upstream);
  }

  #onUpgrade(ws, req, socket, head) {
    const viewer = this.#viewer(ws, req);
    // Browsers do not apply CORS to WebSockets, so the Origin check is mandatory here.
    if (!viewer || ws.state !== 'running' || !sameOrigin(req, { required: true })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(ws.target.port, ws.target.host, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        if (name.toLowerCase() === 'cookie') {
          value = stripPlatformCookies(value);
          if (!value) continue;
        }
        raw += `${name}: ${value}\r\n`;
      }
      upstream.write(raw + '\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  }

  #enter(ws, url, res) {
    const token = url.searchParams.get('token') || '';
    const entry = ws.enterTokens.get(token);
    ws.enterTokens.delete(token);
    if (!entry || entry.expires < Date.now() || ws.state !== 'running') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('This link has expired. Open the workspace again from your class dashboard.');
    }
    const value = randomToken();
    ws.sessions.set(value, entry.viewer);
    ws.lastActivity = Date.now();
    const secure = this.config.scheme === 'https' ? '; Secure' : '';
    res.writeHead(302, {
      'set-cookie': `${this.#cookieName(ws)}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      location: '/__classroom/',
    });
    res.end();
  }

  #shell(ws, viewer, res) {
    const info = {
      workspaceId: ws.id,
      className: viewer.className,
      studentName: viewer.studentName,
      isTeacher: viewer.isTeacher,
      dashboardUrl: viewer.dashboardUrl,
      idleMinutes: Math.round(this.config.idleMs / 60_000),
      frameSrc: `/?folder=${encodeURIComponent(this.driver.folderFor(ws.id))}`,
    };
    const json = JSON.stringify(info).replace(/</g, '\\u003c');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "frame-ancestors 'self'",
    });
    res.end(SHELL_HTML.replace('"__INFO__"', () => json));
  }

  #ping(ws, req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('active') === '1') ws.lastActivity = Date.now();
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ remainingMs: Math.max(0, this.config.idleMs - (Date.now() - ws.lastActivity)) }));
  }
}
