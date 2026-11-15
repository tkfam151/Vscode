// Runs JavaScript the way Node.js does, inside a browser worker.
//
//  - require() and import, between the workspace's own files
//  - npm packages listed in package.json, loaded from the jsDelivr CDN
//  - Node's fs (the workspace files), path, readline, process, events, util, os
//  - the program ends when its code, timers and open readline interfaces are done
//
// in:  { type: 'run', files: [[path, content]], dirs, entry, code?, argv, cwd, deps, env }
//      { type: 'stdin', line } / { type: 'eof' }
// out: { type: 'out', data } / { type: 'done', status, changed: [[path, content]], deleted: [path] }

const CDN = 'https://cdn.jsdelivr.net/npm/';
const out = (data) => postMessage({ type: 'out', data });

// ---------------------------------------------------------------- console --
const show = (v, depth = 0, seen = new Set()) => {
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
  if (typeof v === 'function') return v.toString().startsWith('class') ? `[class ${v.name || '(anonymous)'}]` : `[Function: ${v.name || '(anonymous)'}]`;
  if (typeof v === 'bigint') return v + 'n';
  if (typeof v === 'symbol') return v.toString();
  if (v instanceof Error) return cleanStack(v);
  if (v === null || typeof v !== 'object') return String(v);
  if (seen.has(v)) return '[Circular]';
  if (depth > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.length ? '[ ' + v.map((x) => show(x, depth + 1, seen)).join(', ') + ' ]' : '[]';
    if (v instanceof Map) return `Map(${v.size}) { ` + [...v].map(([k, x]) => show(k, depth + 1, seen) + ' => ' + show(x, depth + 1, seen)).join(', ') + ' }';
    if (v instanceof Set) return `Set(${v.size}) { ` + [...v].map((x) => show(x, depth + 1, seen)).join(', ') + ' }';
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (typeof v.then === 'function') return 'Promise { <pending> }';
    const keys = Object.keys(v);
    const body = keys.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + show(v[k], depth + 1, seen)).join(', ');
    const name = v.constructor && v.constructor !== Object && v.constructor.name ? v.constructor.name + ' ' : '';
    return name + (body ? '{ ' + body + ' }' : '{}');
  } catch {
    return String(v);
  } finally {
    seen.delete(v);
  }
};
const format = (args) => {
  // printf-style %s %d %i %f %o %O %j like Node's util.format
  if (typeof args[0] === 'string' && /%[sdifjoO%]/.test(args[0])) {
    let i = 1;
    const head = args[0].replace(/%([sdifjoO%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      if (f === 's') return typeof a === 'string' ? a : show(a, 1);
      if (f === 'd' || f === 'i') return String(f === 'i' ? parseInt(a) : Number(a));
      if (f === 'f') return String(parseFloat(a));
      if (f === 'j') return JSON.stringify(a);
      return show(a, 1);
    });
    return [head, ...args.slice(i).map((x) => show(x))].join(' ');
  }
  return args.map((x) => show(x)).join(' ');
};
const counts = new Map();
const timersByLabel = new Map();
let indent = '';
const log = (...a) => out(indent + format(a).replace(/\n/g, '\n' + indent) + '\n');
Object.assign(console, {
  log, info: log, debug: log, warn: log, error: log, trace: log,
  table: (rows) => {
    if (!rows || typeof rows !== 'object') return log(rows);
    const keys = Object.keys(rows);
    const cols = [...new Set(keys.flatMap((k) => (rows[k] && typeof rows[k] === 'object' ? Object.keys(rows[k]) : ['Values'])))];
    const data = keys.map((k) => [k, ...cols.map((c) => (rows[k] && typeof rows[k] === 'object' ? (c in rows[k] ? show(rows[k][c], 1) : '') : c === 'Values' ? show(rows[k], 1) : ''))]);
    const head = ['(index)', ...cols];
    const w = head.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)));
    const line = (l, m, r) => l + w.map((n) => '─'.repeat(n + 2)).join(m) + r;
    const row = (r) => '│' + r.map((x, i) => ' ' + x.padEnd(w[i]) + ' ').join('│') + '│';
    out([line('┌', '┬', '┐'), row(head), line('├', '┼', '┤'), ...data.map(row), line('└', '┴', '┘')].join('\n') + '\n');
  },
  count: (l = 'default') => (counts.set(l, (counts.get(l) || 0) + 1), log(`${l}: ${counts.get(l)}`)),
  time: (l = 'default') => timersByLabel.set(l, performance.now()),
  timeEnd: (l = 'default') => log(`${l}: ${(performance.now() - (timersByLabel.get(l) ?? performance.now())).toFixed(3)}ms`),
  group: (...a) => (a.length && log(...a), (indent += '  ')),
  groupEnd: () => (indent = indent.slice(2)),
  assert: (ok, ...a) => ok || log('Assertion failed' + (a.length ? ': ' + format(a) : '')),
});

// -------------------------------------------------------------- lifetime --
let files; // Map path -> content (paths have no leading slash)
let dirs;
const changed = new Map();
const deleted = new Set();
let cwd = '';
let pending = 0;
let mainDone = false;
let finished = false;
let exitCode = 0;
const exitHandlers = [];

class ExitSignal {
  constructor(code) {
    this.code = code;
  }
}
function finish(code = exitCode) {
  if (finished) return;
  for (const h of exitHandlers.splice(0)) {
    try {
      h(code);
    } catch {}
  }
  finished = true;
  postMessage({ type: 'done', status: code, changed: [...changed], deleted: [...deleted] });
}
const settle = () => mainDone && pending === 0 && finish();

const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;
const _setInterval = setInterval;
const _clearInterval = clearInterval;
const live = new Map(); // id -> kind
self.setTimeout = (fn, ms, ...a) => {
  pending++;
  const id = _setTimeout(() => {
    live.delete(id);
    try {
      typeof fn === 'function' && fn(...a);
    } catch (e) {
      crash(e);
    } finally {
      pending--;
      settle();
    }
  }, ms);
  live.set(id, 't');
  return id;
};
self.clearTimeout = (id) => {
  if (live.delete(id)) {
    pending--;
    _clearTimeout(id);
    settle();
  }
};
self.setInterval = (fn, ms, ...a) => {
  pending++;
  const id = _setInterval(() => {
    try {
      fn(...a);
    } catch (e) {
      crash(e);
    }
  }, ms);
  live.set(id, 'i');
  return id;
};
self.clearInterval = (id) => {
  if (live.delete(id)) {
    pending--;
    _clearInterval(id);
    settle();
  }
};
self.setImmediate = (fn, ...a) => self.setTimeout(fn, 0, ...a);
self.clearImmediate = self.clearTimeout;

let blobNames = new Map(); // blob url -> file path, for readable error messages
function cleanStack(e) {
  let s = (e && e.stack) || String(e);
  if (e && e.message && !s.includes(e.message)) s = `${e.name || 'Error'}: ${e.message}\n` + s;
  for (const [url, path] of blobNames) s = s.split(url).join('/' + path);
  // keep the student's own frames, drop the runner's
  const lines = s.split('\n').filter((l) => !/node-worker\.js|<anonymous>:\d|cdn\.jsdelivr|^\s*at (async )?(Promise|runMain|loadCjs)/.test(l));
  return lines.slice(0, 8).join('\n');
}
function crash(e) {
  if (e instanceof ExitSignal || finished) return finish(e?.code);
  out('Uncaught ' + cleanStack(e) + '\n');
  finish(1);
}
self.addEventListener('error', (ev) => {
  ev.preventDefault();
  crash(ev.error ?? ev.message);
});
self.addEventListener('unhandledrejection', (ev) => {
  ev.preventDefault();
  crash(ev.reason);
});

// ------------------------------------------------------------------ stdin --
const lines = [];
const lineWaiters = [];
let stdinClosed = false;
function nextLine() {
  return new Promise((resolve) => {
    if (lines.length) resolve(lines.shift());
    else if (stdinClosed) resolve(null);
    else {
      lineWaiters.push(resolve);
      postMessage({ type: 'need-input' });
    }
  });
}

// --------------------------------------------------------- node built-ins --
const norm = (p) => {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
};
const abs = (p) => norm(String(p).startsWith('/') ? p : cwd + '/' + p);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const path = {
  sep: '/',
  delimiter: ':',
  join: (...p) => '/' + norm(p.join('/')),
  resolve: (...p) => {
    let r = '/' + cwd;
    for (const x of p) r = String(x).startsWith('/') ? x : r + '/' + x;
    return '/' + norm(r);
  },
  normalize: (p) => (String(p).startsWith('/') ? '/' : '') + norm(p),
  dirname: (p) => {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
  },
  basename: (p, ext) => {
    const b = String(p).replace(/\/+$/, '').split('/').pop();
    return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
  },
  extname: (p) => {
    const b = String(p).split('/').pop();
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
  },
  isAbsolute: (p) => String(p).startsWith('/'),
  relative: (from, to) => {
    const a = norm(path.resolve(from)).split('/').filter(Boolean);
    const b = norm(path.resolve(to)).split('/').filter(Boolean);
    while (a.length && b.length && a[0] === b[0]) a.shift(), b.shift();
    return [...a.map(() => '..'), ...b].join('/');
  },
  parse: (p) => ({ root: String(p).startsWith('/') ? '/' : '', dir: path.dirname(p), base: path.basename(p), ext: path.extname(p), name: path.basename(p, path.extname(p)) }),
};
path.posix = path;

const fsError = (code, msg, p) => Object.assign(new Error(`${code}: ${msg}, '${p}'`), { code, path: p });
const isDirPath = (p) => p === '' || dirs.has(p) || [...files.keys()].some((f) => f.startsWith(p + '/')) || [...dirs].some((d) => d.startsWith(p + '/'));
const decodeDataUrl = (c) => {
  const bin = atob(c.slice(c.indexOf(',') + 1));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const fs = {
  readFileSync(p, opts) {
    const f = abs(p);
    if (!files.has(f)) throw fsError(isDirPath(f) ? 'EISDIR' : 'ENOENT', isDirPath(f) ? 'illegal operation on a directory, read' : 'no such file or directory, open', p);
    const c = files.get(f);
    if (c.startsWith('data:')) return decodeDataUrl(c); // a picture: its bytes
    return c; // text (as if read with 'utf8')
  },
  writeFileSync(p, data) {
    const f = abs(p);
    if (dirOf(f) && !isDirPath(dirOf(f))) throw fsError('ENOENT', 'no such file or directory, open', p);
    const text = typeof data === 'string' ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);
    files.set(f, text);
    changed.set(f, text);
    deleted.delete(f);
  },
  appendFileSync(p, data) {
    const f = abs(p);
    fs.writeFileSync(p, (files.get(f) ?? '') + String(data));
  },
  existsSync: (p) => files.has(abs(p)) || isDirPath(abs(p)),
  mkdirSync(p, opts) {
    const f = abs(p);
    if (files.has(f) || (isDirPath(f) && !opts?.recursive)) throw fsError('EEXIST', 'file already exists, mkdir', p);
    dirs.add(f);
    changed.set(f + '/', '');
  },
  readdirSync(p = '.', opts) {
    const d = abs(p);
    if (!isDirPath(d)) throw fsError('ENOENT', 'no such file or directory, scandir', p);
    const prefix = d ? d + '/' : '';
    const names = new Map();
    for (const f of [...files.keys(), ...dirs]) {
      if (!f.startsWith(prefix) || f === d) continue;
      const rest = f.slice(prefix.length);
      const name = rest.split('/')[0];
      if (name) names.set(name, rest.includes('/') || dirs.has(prefix + name));
    }
    const sorted = [...names].sort(([a], [b]) => a.localeCompare(b));
    if (opts?.withFileTypes) return sorted.map(([name, dir]) => ({ name, isDirectory: () => dir, isFile: () => !dir }));
    return sorted.map(([n]) => n);
  },
  unlinkSync(p) {
    const f = abs(p);
    if (!files.delete(f)) throw fsError('ENOENT', 'no such file or directory, unlink', p);
    changed.delete(f);
    deleted.add(f);
  },
  rmSync(p, opts) {
    const f = abs(p);
    if (files.has(f)) return fs.unlinkSync(p);
    if (!isDirPath(f)) {
      if (opts?.force) return;
      throw fsError('ENOENT', 'no such file or directory, rm', p);
    }
    if (!opts?.recursive) throw fsError('ERR_FS_EISDIR', 'Path is a directory', p);
    for (const k of [...files.keys()]) if (k.startsWith(f + '/')) fs.unlinkSync('/' + k);
    for (const d of [...dirs]) if (d === f || d.startsWith(f + '/')) dirs.delete(d), deleted.add(d + '/');
  },
  renameSync(a, b) {
    const text = fs.readFileSync(a);
    fs.writeFileSync(b, text);
    fs.unlinkSync(a);
  },
  copyFileSync(a, b) {
    fs.writeFileSync(b, files.get(abs(a)) ?? fs.readFileSync(a));
  },
  statSync(p) {
    const f = abs(p);
    if (files.has(f)) return { isFile: () => true, isDirectory: () => false, size: files.get(f).length, mtime: new Date() };
    if (isDirPath(f)) return { isFile: () => false, isDirectory: () => true, size: 0, mtime: new Date() };
    throw fsError('ENOENT', 'no such file or directory, stat', p);
  },
};
fs.promises = Object.fromEntries(
  Object.entries(fs)
    .filter(([k]) => k.endsWith('Sync'))
    .map(([k, f]) => [k.replace(/Sync$/, ''), async (...a) => f(...a)]),
);
// callback style: fs.readFile(path, 'utf8', (err, data) => ...)
for (const [k, f] of Object.entries(fs)) {
  if (!k.endsWith('Sync')) continue;
  fs[k.replace(/Sync$/, '')] = (...a) => {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
    let result;
    let err = null;
    try {
      result = f(...a);
    } catch (e) {
      err = e;
    }
    if (cb) self.setTimeout(() => cb(err, result), 0);
  };
}
fs.exists = (p, cb) => self.setTimeout(() => cb(fs.existsSync(p)), 0);

class EventEmitter {
  constructor() {
    this._ev = {};
  }
  on(n, f) {
    (this._ev[n] ||= []).push(f);
    return this;
  }
  addListener(n, f) {
    return this.on(n, f);
  }
  once(n, f) {
    const g = (...a) => (this.off(n, g), f(...a));
    return this.on(n, g);
  }
  off(n, f) {
    this._ev[n] = (this._ev[n] || []).filter((x) => x !== f);
    return this;
  }
  removeListener(n, f) {
    return this.off(n, f);
  }
  removeAllListeners(n) {
    if (n) delete this._ev[n];
    else this._ev = {};
    return this;
  }
  emit(n, ...a) {
    const l = this._ev[n] || [];
    for (const f of [...l]) f.apply(this, a);
    return l.length > 0;
  }
  listenerCount(n) {
    return (this._ev[n] || []).length;
  }
}

const process = new EventEmitter();
Object.assign(process, {
  argv: ['node'],
  env: {},
  platform: 'linux',
  version: 'v22.0.0',
  versions: { node: '22.0.0' },
  pid: 1,
  exitCode: undefined,
  cwd: () => '/' + cwd,
  chdir: (d) => {
    const n = abs(d);
    if (!isDirPath(n)) throw fsError('ENOENT', 'no such file or directory, chdir', d);
    cwd = n;
  },
  exit: (code) => {
    finish(code ?? process.exitCode ?? exitCode);
    throw new ExitSignal(code ?? 0);
  },
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  hrtime: Object.assign((prev) => {
    const t = performance.now();
    const s = Math.floor(t / 1000);
    const ns = Math.floor((t % 1000) * 1e6);
    return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
  }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0 }),
  uptime: () => performance.now() / 1000,
  stdout: { write: (s) => (out(String(s)), true), isTTY: true, columns: 80 },
  stderr: { write: (s) => (out(String(s)), true), isTTY: true },
});
process.stdin = new EventEmitter();
process.on = function (n, f) {
  if (n === 'exit') exitHandlers.push(f);
  return EventEmitter.prototype.on.call(this, n, f);
};
self.process = process;
self.global = self;

// readline: question() and 'line' events read what's typed in the terminal
function createInterface() {
  const rl = new EventEmitter();
  let open = true;
  let listening = false;
  pending++; // an open interface keeps the program running, as in Node
  const pump = async () => {
    if (listening) return;
    listening = true;
    while (open && rl.listenerCount('line')) {
      const l = await nextLine();
      if (!open) break;
      if (l === null) {
        rl.close();
        break;
      }
      rl.emit('line', l);
    }
    listening = false;
  };
  rl.on = function (n, f) {
    EventEmitter.prototype.on.call(this, n, f);
    if (n === 'line') queueMicrotask(pump);
    return this;
  };
  rl.question = (q, opts, cb) => {
    cb = typeof opts === 'function' ? opts : cb;
    out(String(q));
    const p = nextLine().then((l) => l ?? '');
    if (cb) p.then(cb);
    return p;
  };
  rl.prompt = () => out(rl._prompt ?? '> ');
  rl.setPrompt = (p) => (rl._prompt = p);
  rl.write = (s) => out(String(s));
  rl.close = () => {
    if (!open) return;
    open = false;
    rl.emit('close');
    pending--;
    settle();
  };
  rl[Symbol.asyncIterator] = async function* () {
    while (open) {
      const l = await nextLine();
      if (l === null) break;
      yield l;
    }
    rl.close();
  };
  return rl;
}
const readline = { createInterface };
const readlinePromises = {
  createInterface: (...a) => {
    const rl = createInterface(...a);
    const q = rl.question;
    rl.question = (prompt) => q(prompt);
    return rl;
  },
};

const util = {
  format: (...a) => format(a),
  inspect: (v) => show(v, 1),
  promisify: (f) => (...a) => new Promise((res, rej) => f(...a, (e, v) => (e ? rej(e) : res(v)))),
  isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  types: {},
};
const os = { EOL: '\n', platform: () => 'linux', type: () => 'Linux', arch: () => 'wasm', cpus: () => [{}], homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'classcode', userInfo: () => ({ username: 'student' }) };
class AssertionError extends Error {}
const assert = Object.assign((v, m) => { if (!v) throw new AssertionError(m || 'Assertion failed'); }, {
  ok: (v, m) => assert(v, m),
  equal: (a, b, m) => assert(a == b, m || `${show(a, 1)} == ${show(b, 1)}`),
  strictEqual: (a, b, m) => assert(Object.is(a, b), m || `Expected values to be strictly equal:\n\n${show(a, 1)} !== ${show(b, 1)}`),
  notStrictEqual: (a, b, m) => assert(!Object.is(a, b), m || `${show(a, 1)} should not equal ${show(b, 1)}`),
  deepStrictEqual: (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m || `Expected values to be deeply equal:\n${show(a, 1)}\n${show(b, 1)}`),
  deepEqual: (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m),
  throws: (f, m) => {
    try {
      f();
    } catch {
      return;
    }
    throw new AssertionError(m || 'Missing expected exception.');
  },
  AssertionError,
});
assert.strict = assert;
const timers = { setTimeout: self.setTimeout, clearTimeout: self.clearTimeout, setInterval: self.setInterval, clearInterval: self.clearInterval, setImmediate: self.setImmediate };
const timersPromises = { setTimeout: (ms, v) => new Promise((r) => self.setTimeout(() => r(v), ms)) };

const BUILTINS = {
  fs, 'fs/promises': fs.promises, path, 'path/posix': path, readline, 'readline/promises': readlinePromises, process, events: Object.assign(EventEmitter, { EventEmitter }),
  util, os, assert, 'assert/strict': assert, timers, 'timers/promises': timersPromises,
};
const UNSUPPORTED = new Set(['http', 'https', 'net', 'child_process', 'cluster', 'worker_threads', 'crypto', 'zlib', 'stream', 'tls', 'dgram', 'dns', 'vm', 'buffer']);
const builtinName = (s) => s.replace(/^node:/, '');
const isBuiltin = (s) => builtinName(s) in BUILTINS || UNSUPPORTED.has(builtinName(s));
function builtin(s) {
  const n = builtinName(s);
  if (n in BUILTINS) return BUILTINS[n];
  throw new Error(`The Node module '${n}' isn't available in this browser terminal.${n === 'http' || n === 'https' ? ' Use fetch() to load web pages and APIs.' : ''}`);
}
self.__cc_builtin = builtin;

// ---------------------------------------------------------------- modules --
let deps = {}; // npm packages from package.json: name -> version
const bareName = (spec) => /^(@[^/]+\/[^/]+|[^/]+)/.exec(spec)[1];
const exactVersion = (range) => {
  const m = /\d+(\.\d+){0,2}(-[\w.]+)?/.exec(String(range || ''));
  return m ? m[0] : 'latest';
};
function packageUrl(spec) {
  const name = bareName(spec);
  if (!(name in deps)) {
    throw Object.assign(new Error(`Cannot find module '${spec}'\nIt isn't installed. Run:  npm install ${name}`), { code: 'MODULE_NOT_FOUND' });
  }
  return `${CDN}${name}@${exactVersion(deps[name])}${spec.slice(name.length)}/+esm`;
}

function resolveLocal(spec, fromDir) {
  const base = norm(spec.startsWith('/') ? spec : fromDir + '/' + spec);
  for (const c of [base, base + '.js', base + '.mjs', base + '.cjs', base + '.ts', base + '.json', base + '/index.js', base + '/index.mjs']) {
    if (files.has(c)) return c;
  }
  throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' });
}

const ESM_RE = /(^|[\n;}])\s*(import\s*[\w*{$'"]|export\s+(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/;
const isEsmPath = (p, code) => /\.mjs$/.test(p) || (!/\.cjs$/.test(p) && ESM_RE.test(stripComments(code)));
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\n]+)\2/g;
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

// --- import (ES modules): every file becomes a blob: URL with its imports rewritten
const esmUrls = new Map();
async function esmUrl(p) {
  const known = esmUrls.get(p);
  if (known === 'loading') throw new Error(`Files import each other in a circle (${p}); this terminal can't run that.`);
  if (known) return known;
  esmUrls.set(p, 'loading');
  let code;
  const src = files.get(p);
  if (p.endsWith('.json')) code = `export default ${src};`;
  else if (!isEsmPath(p, src)) code = `export default self.__cc_requireFile(${JSON.stringify(p)});`;
  else {
    const map = new Map();
    for (const m of src.matchAll(SPEC_RE)) if (!map.has(m[3])) map.set(m[3], await specUrl(m[3], dirOf(p)));
    code = src.replace(SPEC_RE, (all, a, q, s) => a + q + (map.get(s) ?? s) + q);
  }
  const url = URL.createObjectURL(new Blob([code + `\n//# sourceURL=/${p}`], { type: 'text/javascript' }));
  blobNames.set(url, p);
  esmUrls.set(p, url);
  return url;
}
const builtinUrls = new Map();
function builtinUrl(spec) {
  const n = builtinName(spec);
  if (!builtinUrls.has(n)) {
    const mod = builtin(n);
    const names = Object.keys(mod).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
    const code = `const m = self.__cc_builtin(${JSON.stringify(n)});\nexport default m;\n${names.length ? `export const { ${names.join(', ')} } = m;` : ''}`;
    builtinUrls.set(n, URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  }
  return builtinUrls.get(n);
}
async function specUrl(spec, fromDir) {
  if (isBuiltin(spec)) return builtinUrl(spec);
  if (/^(\.{1,2}\/|\/)/.test(spec)) return esmUrl(resolveLocal(spec, fromDir));
  if (/^(https?:|data:|blob:)/.test(spec)) return spec;
  return packageUrl(spec);
}

// --- require (CommonJS): packages are fetched before the program starts
const packages = new Map(); // spec -> module namespace
async function preloadRequires() {
  const wanted = new Set();
  for (const [p, src] of files) {
    if (!/\.(js|cjs|ts)$/.test(p) || isEsmPath(p, src)) continue;
    for (const m of src.matchAll(REQUIRE_RE)) {
      const s = m[2];
      if (!isBuiltin(s) && !/^(\.{1,2}\/|\/)/.test(s)) wanted.add(s);
    }
  }
  for (const s of wanted) {
    let url;
    try {
      url = packageUrl(s);
    } catch {
      continue; // reported when the program actually requires it
    }
    try {
      packages.set(s, await import(url));
    } catch (e) {
      packages.set(s, Object.assign(new Error(`Could not load the package '${s}' from the internet (${e.message}).`), { code: 'MODULE_NOT_FOUND' }));
    }
  }
}
const cjsCache = new Map();
const AsyncFunction = (async () => {}).constructor;
function makeRequire(fromDir) {
  const require = (spec) => {
    spec = String(spec);
    if (isBuiltin(spec)) return builtin(spec);
    if (/^(\.{1,2}\/|\/)/.test(spec)) return requireFile(resolveLocal(spec, fromDir));
    if (!packages.has(spec)) packageUrl(spec); // throws "not installed" if it isn't in package.json
    const ns = packages.get(spec);
    if (!ns) throw new Error(`require('${spec}') must use a fixed name so it can be loaded before the program starts.`);
    if (ns instanceof Error) throw ns;
    return ns.default ?? ns; // a CommonJS package's module.exports, or the module itself
  };
  require.resolve = (s) => '/' + resolveLocal(s, fromDir);
  return require;
}
function requireFile(p) {
  if (p.endsWith('.json')) return JSON.parse(files.get(p));
  if (cjsCache.has(p)) return cjsCache.get(p).exports;
  const src = files.get(p);
  if (isEsmPath(p, src)) throw new Error(`/${p} uses import/export. Load it with import instead of require().`);
  const module = { exports: {}, id: '/' + p, filename: '/' + p, loaded: false };
  cjsCache.set(p, module);
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src + `\n//# sourceURL=/${p}`);
  fn(module.exports, makeRequire(dirOf(p)), module, '/' + p, '/' + dirOf(p));
  module.loaded = true;
  return module.exports;
}
self.__cc_requireFile = requireFile;

// ------------------------------------------------------------------- run --
async function runMain(msg) {
  files = new Map(msg.files);
  dirs = new Set(msg.dirs || []);
  cwd = msg.cwd || '';
  deps = msg.deps || {};
  Object.assign(process.env, { HOME: '/', USER: 'student', PATH: '/usr/bin', ...msg.env });
  let entry = msg.entry;
  if (msg.code != null) {
    entry = norm(cwd + '/[eval].js');
    files.set(entry, msg.code);
  }
  process.argv = ['node', '/' + entry, ...(msg.argv || [])];
  if (isEsmPath(entry, files.get(entry))) {
    await import(await esmUrl(entry));
  } else {
    await preloadRequires();
    const module = { exports: {}, id: '.', filename: '/' + entry };
    cjsCache.set(entry, module);
    // async wrapper so top-level await works in plain scripts too
    const fn = new AsyncFunction('exports', 'require', 'module', '__filename', '__dirname', files.get(entry) + `\n//# sourceURL=/${entry}`);
    await fn(module.exports, makeRequire(dirOf(entry)), module, '/' + entry, '/' + dirOf(entry));
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stdin') {
    if (lineWaiters.length) lineWaiters.shift()(data.line);
    else lines.push(data.line);
    return;
  }
  if (data.type === 'eof') {
    stdinClosed = true;
    while (lineWaiters.length) lineWaiters.shift()(null);
    return;
  }
  if (data.type !== 'run') return;
  try {
    await runMain(data);
  } catch (e) {
    return crash(e);
  }
  mainDone = true;
  if (process.exitCode !== undefined) exitCode = process.exitCode;
  settle();
};
