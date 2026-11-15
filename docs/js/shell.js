// The student's terminal: a small shell over the workspace files, plus
// runners for Python (Pyodide worker) and JavaScript (plain worker).
// Everything here runs in the student's own browser tab.

import { entryFor } from './vfs.js';
export { entryFor };

const HELP = `Commands
  python FILE.py      run Python                  python          interactive Python
  node FILE.js|.ts    run JavaScript/TypeScript   pip install X   install a Python package
  lua FILE.lua        run Lua                     sqlite [FILE.sql]  run SQL (SQLite)
  bash FILE.sh        run a script of these commands, one per line
  preview FILE        show a web page (.html), Markdown (.md) or picture in the preview pane
  run FILE|FOLDER     run anything; a folder runs its main file (main.py, index.html, ...)
  ls [DIR]   cat FILE   cd DIR   pwd   mkdir DIR   touch FILE
  rm [-r] PATH   mv FROM TO   cp FROM TO   echo TEXT [> FILE]   clear   help
Keys: Ctrl+C stops a running program, Ctrl+D ends input, Up/Down recall earlier commands.
`;

// How each kind of file runs. `cmd` is the terminal command; `preview` opens the preview pane.
const LANGUAGES = [
  { re: /\.py$/i, cmd: 'python' },
  { re: /\.(js|mjs|cjs)$/i, cmd: 'node' },
  { re: /\.(ts|mts)$/i, cmd: 'node' },
  { re: /\.lua$/i, cmd: 'lua' },
  { re: /\.sql$/i, cmd: 'sqlite' },
  { re: /\.(sh|bash)$/i, cmd: 'bash' },
  { re: /\.(html?|md|markdown|css|png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i, cmd: 'preview' },
];
// Languages the editor colours but this browser version cannot run.
const EDIT_ONLY = {
  java: 'Java', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', go: 'Go', rs: 'Rust', rb: 'Ruby',
  php: 'PHP', kt: 'Kotlin', swift: 'Swift', r: 'R', scala: 'Scala', dart: 'Dart', pl: 'Perl', vb: 'Visual Basic',
};

/** The command that runs `path` (a file), or an Error explaining why it can't run. */
export function commandFor(path) {
  const lang = LANGUAGES.find((l) => l.re.test(path));
  if (lang) return lang.cmd;
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (EDIT_ONLY[ext]) {
    return new Error(`${EDIT_ONLY[ext]} can't run in the browser version of ClassCode (it needs a real computer to compile it). You can still write and save ${EDIT_ONLY[ext]} here.`);
  }
  return new Error(`Don't know how to run ${path}. Runnable: .py .js .ts .lua .sql .sh .html .md, or a folder with a main file.`);
}

const quoteArg = (p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p);


const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

/** Resolve `p` against `cwd`; both are project-relative without a leading slash. */
export function resolvePath(cwd, p) {
  const parts = p.startsWith('/') || p.startsWith('~') ? [] : cwd.split('/').filter(Boolean);
  for (const seg of p.replace(/^~/, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function splitArgs(line) {
  const args = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return args;
}

const JS_WORKER = `
const show = (v, depth = 0) => {
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
  if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
  if (v instanceof Error) return v.stack || String(v);
  if (v === null || typeof v !== 'object') return String(v);
  if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  try {
    if (Array.isArray(v)) return '[ ' + v.map((x) => show(x, depth + 1)).join(', ') + ' ]';
    if (v instanceof Map) return 'Map(' + v.size + ') { ' + [...v].map(([k, x]) => show(k, depth + 1) + ' => ' + show(x, depth + 1)).join(', ') + ' }';
    if (v instanceof Set) return 'Set(' + v.size + ') { ' + [...v].map((x) => show(x, depth + 1)).join(', ') + ' }';
    const body = Object.entries(v).map(([k, x]) => k + ': ' + show(x, depth + 1)).join(', ');
    const name = v.constructor && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
    return name + (body ? '{ ' + body + ' }' : '{}');
  } catch { return String(v); }
};
const out = (data) => postMessage({ type: 'out', data });
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => out(a.map((x) => show(x)).join(' ') + '\\n');

// Like Node, finish when the script and all its timers are done.
let pending = 0, mainDone = false;
const settle = () => { if (mainDone && pending === 0) postMessage({ type: 'done' }); };
const _st = setTimeout, _ct = clearTimeout, _si = setInterval, _ci = clearInterval;
const live = new Set();
self.setTimeout = (fn, ms, ...a) => { pending++; const id = _st(() => { live.delete(id); try { fn(...a); } finally { pending--; settle(); } }, ms); live.add(id); return id; };
self.clearTimeout = (id) => { if (live.delete(id)) { pending--; _ct(id); settle(); } };
self.setInterval = (fn, ms, ...a) => { pending++; const id = _si(fn, ms, ...a); live.add(id); return id; };
self.clearInterval = (id) => { if (live.delete(id)) { pending--; _ci(id); settle(); } };
self.onerror = (e) => { out('Uncaught ' + (e.message || e) + '\\n'); };
self.onunhandledrejection = (e) => { out('Uncaught (in promise) ' + show(e.reason) + '\\n'); };

self.onmessage = async ({ data }) => {
  try {
    const AsyncFunction = (async () => {}).constructor;
    await new AsyncFunction(data.code + '\\n//# sourceURL=' + data.name)();
  } catch (e) {
    out((e && e.stack && e.stack.includes(e.message) ? e.stack.split('\\n').slice(0, 4).join('\\n') : String(e)) + '\\n');
  }
  mainDone = true;
  settle();
};
`;

export class Session {
  /**
   * @param {object} o
   * @param {(data: string) => void} o.write   raw terminal output (already \r\n)
   * @param {import('./vfs.js').VFS} o.vfs
   * @param {(path: string) => void} o.onPreview
   */
  constructor({ write, vfs, onPreview, compileTs }) {
    this.write = write;
    this.vfs = vfs;
    this.onPreview = onPreview;
    this.compileTs = compileTs; // (path) => Promise<javascript>, from the editor
    this.queue = []; // commands waiting to run (from a bash script)
    this.cwd = '';
    this.line = '';
    this.history = [];
    this.histPos = 0;
    this.running = null; // { kill(), stdin(line), eof() }
    this.pyWorker = null;
    this.disposed = false;
  }

  start() {
    this.write(crlf('Welcome to your ClassCode terminal. Type help to see what it can do.\n'));
    this.prompt();
  }

  prompt() {
    this.line = '';
    this.histPos = this.history.length;
    if (this.disposed) return;
    if (this.queue.length) {
      // next line of a bash script
      const next = this.queue.shift();
      this.write(`\x1b[2m+ ${next}\x1b[0m\r\n`);
      setTimeout(() => this.exec(next, { fromScript: true }), 0);
      return;
    }
    this.write(`\x1b[1;32m~${this.cwd ? '/' + this.cwd : ''}\x1b[0m $ `);
  }

  print(text) {
    if (!this.disposed) this.write(crlf(text));
  }

  /** Keystrokes from this tab's terminal or from the teacher. */
  input(data) {
    if (this.disposed) return;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\x1b') {
        // escape sequence: only Up/Down are used
        const seq = data.slice(i, i + 3);
        if (seq === '\x1b[A' || seq === '\x1b[B') {
          if (!this.running) this.recall(seq === '\x1b[A' ? -1 : 1);
          i += 2;
        } else {
          const m = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i));
          i += (m ? m[0].length : 1) - 1;
        }
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && data[i - 1] === '\r') continue;
        this.write('\r\n');
        const line = this.line;
        this.line = '';
        if (this.running) this.running.stdin(line);
        else this.exec(line);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.write('\b \b');
        }
      } else if (ch === '\x03') {
        this.write('^C\r\n');
        this.queue.length = 0;
        if (this.running) this.running.kill();
        else this.prompt();
      } else if (ch === '\x04') {
        if (this.running && !this.line) this.running.eof();
      } else if (ch === '\x0c') {
        if (!this.running) {
          this.write('\x1b[2J\x1b[3J\x1b[H');
          this.prompt();
        }
      } else if (ch >= ' ' || ch === '\t') {
        const c = ch === '\t' ? '    ' : ch;
        this.line += c;
        this.write(c);
      }
    }
  }

  recall(dir) {
    const pos = this.histPos + dir;
    if (pos < 0 || pos > this.history.length) return;
    this.histPos = pos;
    this.write('\b \b'.repeat(this.line.length));
    this.line = this.history[pos] ?? '';
    this.write(this.line);
  }

  /** Run a command as if it had been typed (used by the Run button). */
  runCommand(cmd) {
    if (this.disposed) return;
    if (this.running) {
      this.write('^C\r\n');
      this.running.kill({ then: () => this.runCommand(cmd) });
      return;
    }
    this.write('\b \b'.repeat(this.line.length) + cmd + '\r\n');
    this.line = '';
    this.exec(cmd);
  }

  async exec(raw, { fromScript = false } = {}) {
    const line = raw.trim();
    if (!line) return this.prompt();
    if (!fromScript && this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 200) this.history.shift();

    // echo-style redirect: CMD > file / CMD >> file
    let redirect = null;
    let cmdline = line;
    const rm = /^(.*?)\s*(>>?)\s*(\S+)\s*$/.exec(line);
    if (rm && /^(echo|cat|ls|pwd)\b/.test(rm[1])) {
      cmdline = rm[1];
      redirect = { append: rm[2] === '>>', path: resolvePath(this.cwd, rm[3]) };
    }
    const [cmd, ...args] = splitArgs(cmdline);
    let output = '';
    const say = (s) => (output += s);
    const { vfs } = this;
    const at = (p) => resolvePath(this.cwd, p);

    try {
      switch (cmd) {
        case 'help':
          say(HELP);
          break;
        case 'clear':
          this.write('\x1b[2J\x1b[3J\x1b[H');
          break;
        case 'pwd':
          say('~' + (this.cwd ? '/' + this.cwd : '') + '\n');
          break;
        case 'ls': {
          const target = at(args.find((a) => !a.startsWith('-')) || '.');
          if (vfs.has(target)) say(target.split('/').pop() + '\n');
          else if (!vfs.isDir(target)) throw new Error(`ls: ${target}: No such file or directory`);
          else {
            const names = vfs.list(target).map((e) => (e.dir ? `\x1b[1;34m${e.name}/\x1b[0m` : e.name));
            if (names.length) say(names.join(redirect ? '\n' : '  ') + '\n');
          }
          break;
        }
        case 'cd': {
          const target = at(args[0] || '/');
          if (!vfs.isDir(target)) throw new Error(`cd: ${args[0]}: No such directory`);
          this.cwd = target;
          break;
        }
        case 'cat':
          if (!args.length) throw new Error('cat: which file?');
          for (const a of args) {
            if (!vfs.has(at(a))) throw new Error(`cat: ${a}: No such file`);
            const text = vfs.get(at(a));
            if (text.startsWith('data:')) {
              say(`[${a} is a picture, ${Math.round((text.length * 0.75) / 1024)} KB. Open it from the file list, or preview it.]\n`);
              continue;
            }
            say(text.endsWith('\n') || !text ? text : text + '\n');
          }
          break;
        case 'echo':
          say(args.join(' ') + '\n');
          break;
        case 'mkdir':
          if (!args.length) throw new Error('mkdir: which directory?');
          for (const a of args.filter((x) => !x.startsWith('-'))) vfs.mkdir(at(a));
          break;
        case 'touch':
          for (const a of args) if (!vfs.has(at(a))) vfs.set(checkName(at(a)), '');
          break;
        case 'rm': {
          const recursive = args.some((a) => /^-[a-z]*r/i.test(a));
          const targets = args.filter((a) => !a.startsWith('-'));
          if (!targets.length) throw new Error('rm: which file?');
          for (const a of targets) {
            const p = at(a);
            if (vfs.has(p)) vfs.delete(p);
            else if (p && vfs.isDir(p)) {
              if (!recursive) throw new Error(`rm: ${a}: is a directory (use rm -r)`);
              vfs.rmdir(p);
              if (this.cwd === p || this.cwd.startsWith(p + '/')) this.cwd = '';
            } else throw new Error(`rm: ${a}: No such file or directory`);
          }
          break;
        }
        case 'mv':
        case 'cp': {
          if (args.length !== 2) throw new Error(`${cmd}: use ${cmd} FROM TO`);
          const from = at(args[0]);
          let to = at(args[1]);
          if (!vfs.has(from)) {
            if (!(cmd === 'mv' && from && vfs.isDir(from))) throw new Error(`${cmd}: ${args[0]}: No such file`);
            // moving a folder
            if (vfs.isDir(to) && !vfs.has(to)) to = (to ? to + '/' : '') + from.split('/').pop();
            if (to === from) break;
            if (to.startsWith(from + '/')) throw new Error('mv: cannot move a folder into itself');
            if (vfs.has(to) || vfs.isDir(to)) throw new Error(`mv: ${args[1]} already exists`);
            vfs.renameDir(from, checkName(to));
            if (this.cwd === from || this.cwd.startsWith(from + '/')) this.cwd = to + this.cwd.slice(from.length);
            break;
          }
          if (vfs.isDir(to) && !vfs.has(to)) to = (to ? to + '/' : '') + from.split('/').pop();
          if (to === from) break;
          vfs.set(checkName(to), vfs.get(from));
          if (cmd === 'mv') vfs.delete(from);
          break;
        }
        case 'preview':
        case 'open': {
          let p = at(args[0] || (vfs.has(at('index.html')) ? 'index.html' : '.'));
          if (!vfs.has(p) && vfs.isDir(p)) p = this.entryIn(p, /\.(html?|md|markdown)$/i, 'preview', 'index.html');
          if (!vfs.has(p)) throw new Error(`preview: ${args[0] || 'index.html'}: No such file`);
          this.onPreview(p);
          break;
        }
        case 'python':
        case 'python3':
        case 'py': {
          const file = args.find((a) => !a.startsWith('-'));
          if (!file) return this.runPython({ type: 'repl' });
          let entry = at(file);
          if (!vfs.has(entry) && vfs.isDir(entry)) entry = this.entryIn(entry, /\.py$/i, 'python', 'main.py');
          if (!vfs.has(entry)) throw new Error(`python: can't open file '${file}': No such file`);
          return this.runPython({ type: 'run', entry, argv: args.slice(args.indexOf(file) + 1) });
        }
        case 'pip':
        case 'pip3': {
          if (args[0] !== 'install' || args.length < 2) throw new Error('Use: pip install PACKAGE');
          return this.runPython({ type: 'pip', packages: args.slice(1).filter((a) => !a.startsWith('-')) });
        }
        case 'node':
        case 'js':
        case 'ts-node':
        case 'tsx':
        case 'deno': {
          if (!args[0]) throw new Error('Use: node FILE.js  or  node FILE.ts');
          let p = at(args[0]);
          if (!vfs.has(p) && vfs.isDir(p)) p = this.entryIn(p, /\.(js|mjs|cjs|ts|mts)$/i, 'node', 'main.js');
          if (!vfs.has(p)) throw new Error(`node: cannot find '${args[0]}'`);
          return this.runJs(p);
        }
        case 'lua': {
          if (!args[0]) throw new Error('Use: lua FILE.lua');
          let p = at(args[0]);
          if (!vfs.has(p) && vfs.isDir(p)) p = this.entryIn(p, /\.lua$/i, 'lua', 'main.lua');
          if (!vfs.has(p)) throw new Error(`lua: cannot open ${args[0]}`);
          return this.runLua(p);
        }
        case 'sqlite':
        case 'sqlite3':
        case 'sql': {
          const file = args.find((a) => !a.startsWith('-'));
          if (!file) return this.runSql(null);
          let p = at(file);
          if (!vfs.has(p) && vfs.isDir(p)) p = this.entryIn(p, /\.sql$/i, 'sqlite', 'main.sql');
          if (!vfs.has(p)) throw new Error(`sqlite: cannot open ${file}`);
          return this.runSql(p);
        }
        case 'bash':
        case 'sh':
        case 'source': {
          if (!args[0]) throw new Error('Use: bash FILE.sh');
          const p = at(args[0]);
          if (!vfs.has(p)) throw new Error(`bash: ${args[0]}: No such file`);
          const lines = vfs
            .get(p)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'));
          if (lines.length > 500) throw new Error('bash: scripts can have at most 500 commands');
          this.queue.unshift(...lines);
          break;
        }
        case 'run': {
          // run anything: picks the right command from the file type
          const target = at(args[0] || '.');
          let file = target;
          if (!vfs.has(target)) {
            if (!vfs.isDir(target)) throw new Error(`run: ${args[0]}: No such file or folder`);
            file = entryFor(vfs, target);
            if (!file) throw new Error(`run: ${target || '~'} is a folder with nothing to run. Add a main.py, index.html or main.js to it.`);
          }
          const how = commandFor(file);
          if (how instanceof Error) throw how;
          return this.exec(`${how} ${quoteArg('/' + file)} ${args.slice(1).map(quoteArg).join(' ')}`, { fromScript: true });
        }
        default:
          throw new Error(`${cmd}: command not found. Type help to see what this terminal can do.`);
      }
      if (redirect) {
        const text = output.replace(/\x1b\[[0-9;]*m/g, '');
        vfs.set(checkName(redirect.path), redirect.append ? (vfs.get(redirect.path) || '') + text : text);
      } else this.print(output);
    } catch (e) {
      this.print(e.message + '\n');
    }
    this.prompt();
  }

  /** The file a command should run when given a folder. */
  entryIn(dir, kind, cmd, wanted) {
    const prefix = dir ? dir + '/' : '';
    const entry = entryFor(this.vfs, dir);
    if (entry && kind.test(entry)) return entry;
    const ofKind = this.vfs.list(dir).filter((e) => !e.dir && kind.test(e.name));
    if (ofKind.length === 1) return prefix + ofKind[0].name;
    throw new Error(`${cmd}: ${dir || '~'} is a folder. Put a ${wanted} in it, or name the file to run.`);
  }

  // ------------------------------------------------------------ runners --

  ensurePyWorker() {
    if (!this.pyWorker) {
      this.pyWorker = new Worker(new URL('./py-worker.js', import.meta.url), { type: 'module' });
      this.pyFresh = true;
    }
    return this.pyWorker;
  }

  runPython(job) {
    const worker = this.ensurePyWorker();
    if (this.pyFresh) {
      this.print('\x1b[2mStarting Python...\x1b[0m\n');
      this.pyFresh = false;
    }
    const sent = this.vfs.entries();
    const finish = (after) => {
      this.running = null;
      worker.onmessage = null;
      this.prompt();
      after?.then?.();
    };
    worker.onerror = (e) => {
      this.print(`Python stopped unexpectedly: ${e.message || 'worker error'}\n`);
      this.killPython();
      finish();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'out') this.print(data.data);
      else if (data.type === 'done') {
        for (const [path, content] of data.changed) this.vfs.set(path, content, 'program');
        for (const path of data.deleted) if (this.vfs.get(path) === new Map(sent).get(path)) this.vfs.delete(path, 'program');
        finish();
      }
    };
    this.running = {
      stdin: (line) => worker.postMessage({ type: 'stdin', line }),
      eof: () => worker.postMessage({ type: 'eof' }),
      // A busy Python loop cannot be interrupted politely, so stop the worker; the next run starts a new one.
      kill: (after) => {
        this.killPython();
        finish(after);
      },
    };
    worker.postMessage({ ...job, files: sent, dirs: this.vfs.allDirs() });
  }

  killPython() {
    this.pyWorker?.terminate();
    this.pyWorker = null;
  }

  runJs(path) {
    const url = URL.createObjectURL(new Blob([JS_WORKER], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let finished = false;
    const finish = (after) => {
      if (finished) return;
      finished = true;
      worker.terminate();
      URL.revokeObjectURL(url);
      this.running = null;
      this.prompt();
      after?.then?.();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'out') this.print(data.data);
      else if (data.type === 'done') finish();
    };
    this.running = { stdin: () => {}, eof: () => {}, kill: finish };
    if (!/\.(ts|mts)$/i.test(path)) return worker.postMessage({ code: this.vfs.get(path), name: path });
    // TypeScript: the editor's built-in compiler turns it into JavaScript first.
    if (!this.compileTs) {
      this.print('TypeScript is not available here.\n');
      return finish();
    }
    this.compileTs(path).then(
      (code) => !finished && worker.postMessage({ code, name: path }),
      (e) => {
        this.print(`Could not compile ${path}: ${e.message || e}\n`);
        finish();
      },
    );
  }

  runLua(path) {
    const worker = new Worker(new URL('./lua-worker.js', import.meta.url));
    const finish = (after) => {
      worker.terminate();
      this.running = null;
      this.prompt();
      after?.then?.();
    };
    worker.onerror = (e) => {
      this.print(`Lua stopped: ${e.message || 'error'}\n`);
      finish();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'out') this.print(data.data);
      else if (data.type === 'done') finish();
    };
    this.running = { stdin: () => {}, eof: () => {}, kill: finish };
    worker.postMessage({ code: this.vfs.get(path), name: path });
  }

  /** Run a .sql file, or (path null) an interactive sqlite> prompt. Each run starts with an empty database. */
  runSql(path) {
    const worker = new Worker(new URL('../vendor/sqljs/worker.sql-wasm.js', import.meta.url));
    let pending = '';
    let id = 0;
    const finish = (after) => {
      worker.terminate();
      this.running = null;
      this.prompt();
      after?.then?.();
    };
    const exec = (sql) =>
      new Promise((resolve) => {
        const my = ++id;
        worker.onmessage = ({ data }) => {
          if (data.id !== my) return;
          if (data.error) this.print(`Error: ${data.error}\n`);
          else for (const r of data.results || []) this.print(sqlTable(r.columns, r.values));
          resolve();
        };
        worker.postMessage({ id: my, action: 'exec', sql });
      });
    worker.onerror = (e) => {
      this.print(`SQLite stopped: ${e.message || 'error'}\n`);
      finish();
    };
    if (path) {
      this.running = { stdin: () => {}, eof: () => {}, kill: finish };
      exec(this.vfs.get(path)).then(() => this.running && finish());
      return;
    }
    this.print('SQLite (in-memory database). End statements with ; — type .tables, or .exit to leave.\n');
    const ask = () => this.write(pending ? '   ...> ' : 'sqlite> ');
    this.running = {
      kill: finish,
      eof: () => finish(),
      stdin: async (line) => {
        const t = line.trim();
        if (!pending && (t === '.exit' || t === '.quit')) return finish();
        if (!pending && t === '.tables') {
          await exec("select name from sqlite_master where type = 'table' order by name;");
          return ask();
        }
        pending += line + '\n';
        if (t.endsWith(';')) {
          const sql = pending;
          pending = '';
          await exec(sql);
        }
        if (this.running) ask();
      },
    };
    ask();
  }

  dispose() {
    this.disposed = true;
    if (this.running) this.running.kill();
    this.killPython();
  }
}

/** Format query results as a text table. */
function sqlTable(columns, rows) {
  const cell = (v) => (v === null ? 'NULL' : v instanceof Uint8Array ? `<${v.length} bytes>` : String(v));
  const data = rows.map((r) => r.map(cell));
  const widths = columns.map((c, i) => Math.min(40, Math.max(c.length, ...data.map((r) => r[i].length))));
  const fit = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
  const line = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+\n';
  const row = (r) => '| ' + r.map((v, i) => fit(v, widths[i])).join(' | ') + ' |\n';
  return line + row(columns) + line + data.map(row).join('') + line + `(${rows.length} row${rows.length === 1 ? '' : 's'})\n`;
}

function checkName(path) {
  if (!path || path.length > 200 || /[\x00-\x1f\\]/.test(path)) throw new Error('That file name is not allowed');
  return path;
}
