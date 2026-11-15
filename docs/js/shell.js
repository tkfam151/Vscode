// The terminal: a zsh-like shell over the workspace files, running entirely in
// the browser. Programs run in workers: Python (Pyodide), JavaScript (a
// Node.js-like runner with npm packages), Lua and SQLite.
//
// Shell features: pipes (|), && || ;, redirects (> >> <), $VARIABLES, * globs,
// exit codes ($?), Tab completion and history. pip and npm install real
// packages from the internet; they are remembered in requirements.txt and
// package.json.

import { entryFor } from './vfs.js';
export { entryFor };

const HELP = `\x1b[1mRunning code\x1b[0m
  python FILE.py       python -c "code"      python  (interactive)    python -m pip ...
  node FILE.js|.ts     node -e "code"        lua FILE.lua            sqlite [FILE.sql]
  run FILE|FOLDER      bash FILE.sh          open FILE (preview a web page or picture)
  code FILE            open a file in the editor
\x1b[1mPackages\x1b[0m
  pip install NAME     pip install -r requirements.txt     pip list | uninstall | freeze | show
  npm init             npm install NAME      npm uninstall NAME     npm list    npm run SCRIPT   npm start
\x1b[1mInternet\x1b[0m
  curl URL             curl -o FILE URL      curl -X POST -H "Content-Type: application/json" -d '{"a":1}' URL
  curl -i / -I URL     wget URL              (works with sites that allow web pages to read them, e.g. APIs)
\x1b[1mFiles\x1b[0m
  ls [-la]  cd  pwd  cat  head  tail  wc  grep  find  tree  mkdir [-p]  touch  cp [-r]  mv  rm [-r]  rmdir
\x1b[1mShell\x1b[0m
  echo  sort  uniq  history  clear  env  export  which  whoami  date  sleep  true  false
  cmd1 | cmd2    cmd1 && cmd2    cmd1 || cmd2    cmd > file    cmd >> file    cmd < file    *.py    $?  $HOME
Keys: Tab completes names, Up/Down recall commands, Ctrl+C stops a program, Ctrl+D ends input, Ctrl+L clears.
`;

// How each kind of file runs. `cmd` is the terminal command; `preview` opens the preview pane.
const LANGUAGES = [
  { re: /\.py$/i, cmd: 'python' },
  { re: /\.(js|mjs|cjs)$/i, cmd: 'node' },
  { re: /\.(ts|mts)$/i, cmd: 'node' },
  { re: /\.lua$/i, cmd: 'lua' },
  { re: /\.sql$/i, cmd: 'sqlite' },
  { re: /\.(sh|bash|zsh)$/i, cmd: 'bash' },
  { re: /\.(html?|md|markdown|css|png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i, cmd: 'preview' },
];
// Languages the editor colours but this browser version cannot run.
const EDIT_ONLY = {
  java: 'Java', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', go: 'Go', rs: 'Rust', rb: 'Ruby',
  php: 'PHP', kt: 'Kotlin', swift: 'Swift', r: 'R', scala: 'Scala', dart: 'Dart', pl: 'Perl', vb: 'Visual Basic',
};
// Real-computer tools that can't exist in a browser tab.
const NEEDS_COMPUTER = {
  git: 'Git', brew: 'Homebrew', apt: 'apt', 'apt-get': 'apt', sudo: 'sudo', ssh: 'ssh',
  java: 'Java', javac: 'Java', gcc: 'a C compiler', 'g++': 'a C++ compiler', clang: 'a C compiler', make: 'make',
  go: 'Go', cargo: 'Rust', rustc: 'Rust', ruby: 'Ruby', php: 'PHP', dotnet: '.NET', docker: 'Docker', yarn: 'yarn', pnpm: 'pnpm',
  vim: 'vim', nano: 'nano', emacs: 'emacs', top: 'top', ps: 'ps', kill: 'kill', chmod: 'chmod', ping: 'ping',
  icoa: 'the ICOA CLI',
};
const SERVER_HINT = "Your school's ClassCode server version gives every student a real Linux computer where this works.";

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

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const quoteArg = (p) => (/[\s"'$&|;<>*?]/.test(p) ? "'" + p.replace(/'/g, `'\\''`) + "'" : p);

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

class ShellError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}
const fail = (msg, status) => {
  throw new ShellError(msg, status);
};

// ----------------------------------------------------------------- parsing --
// line -> [{ op: null | ';' | '&&' | '||', pipeline: [{ argv: [{ text, glob }], redirects: [{ op, target }] }] }]
function parse(line, env) {
  const tokens = [];
  let i = 0;
  let word = null; // { text, glob, quoted }
  const flush = () => {
    if (word) tokens.push({ t: 'w', ...word });
    word = null;
  };
  const add = (s, globbable) => {
    word ||= { text: '', glob: false, quoted: false };
    word.text += s;
    if (globbable && /[*?]/.test(s)) word.glob = true;
  };
  const expand = (quoted) => {
    // $NAME, ${NAME}, $?, $$
    const m = /^\$(\?|\$|\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
    if (!m) {
      add('$', false);
      i++;
      return;
    }
    const name = m[1].replace(/[{}]/g, '');
    add(String(env[name] ?? ''), false);
    if (quoted) word.quoted = true;
    i += m[0].length;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else if (c === '#' && !word) {
      break; // comment
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) fail('unmatched quote: \'', 2);
      add(line.slice(i + 1, end), false);
      word.quoted = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      word ||= { text: '', glob: false, quoted: true };
      word.quoted = true;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
          add(line[i + 1], false);
          i += 2;
        } else if (line[i] === '$') expand(true);
        else add(line[i++], false);
      }
      if (line[i] !== '"') fail('unmatched quote: "', 2);
      i++;
    } else if (c === '\\') {
      add(line[i + 1] ?? '', false);
      i += 2;
    } else if (c === '$') {
      expand(false);
    } else if ('|&;<>'.includes(c) || (c === '2' && line[i + 1] === '>' && !word)) {
      flush();
      const op = ['2>&1', '&&', '||', '>>', '2>', '|', ';', '>', '<', '&'].find((o) => line.startsWith(o, i));
      tokens.push({ t: 'op', v: op });
      i += op.length;
    } else {
      add(c, true);
      i++;
    }
  }
  flush();

  const chain = [];
  let cmd = { argv: [], redirects: [] };
  let pipeline = [cmd];
  let op = null;
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === 'w') cmd.argv.push(tok);
    else if (['>', '>>', '<', '2>'].includes(tok.v)) {
      const target = tokens[++k];
      if (!target || target.t !== 'w') fail(`parse error near \`${tok.v}'`, 2);
      cmd.redirects.push({ op: tok.v, target: target.text });
    } else if (tok.v === '2>&1' || tok.v === '&') {
      // errors already go to the terminal; background jobs aren't supported, so just run it
    } else if (tok.v === '|') {
      if (!cmd.argv.length) fail("parse error near `|'", 2);
      cmd = { argv: [], redirects: [] };
      pipeline.push(cmd);
    } else {
      if (!cmd.argv.length && tok.v !== ';') fail(`parse error near \`${tok.v}'`, 2);
      if (cmd.argv.length) chain.push({ op, pipeline });
      op = tok.v;
      cmd = { argv: [], redirects: [] };
      pipeline = [cmd];
    }
  }
  if (cmd.argv.length) chain.push({ op, pipeline });
  else if (pipeline.length > 1) fail("parse error near `|'", 2);
  return chain;
}

// Split a line at ; && || (outside quotes) without expanding anything, so each
// part sees variables and $? as they are when it runs.
function splitChain(line) {
  const parts = [];
  let op = null;
  let start = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') i++;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    else if (c === ';' || (c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      const text = line.slice(start, i).trim();
      const next = c === ';' ? ';' : c + c;
      if (!text) {
        if (next !== ';' || parts.length === 0) fail(`parse error near \`${next}'`, 2);
      } else parts.push({ op, text });
      op = next;
      i += next.length - 1;
      start = i + 1;
    }
  }
  if (quote) fail(`unmatched quote: ${quote}`, 2);
  const tail = line.slice(start).replace(/(^|\s)#.*$/, '').trim();
  if (tail) parts.push({ op, text: tail });
  else if (op && op !== ';') fail(`parse error near \`${op}'`, 2);
  return parts;
}

const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');

// ------------------------------------------------------------------ session --
export class Session {
  /**
   * @param {object} o
   * @param {(data: string) => void} o.write   raw terminal output
   * @param {import('./vfs.js').VFS} o.vfs
   * @param {(path: string) => void} o.onPreview   show a web page / picture
   * @param {(path: string) => void} [o.onOpen]     open a file in the editor
   * @param {(path: string) => Promise<string>} [o.compileTs]
   * @param {string} [o.user]  name in the prompt
   * @param {string} [o.host]
   */
  constructor({ write, vfs, onPreview, onOpen, compileTs, user = 'student', host = 'classcode' }) {
    // remember whether the cursor is at the start of a line (for zsh's missing-newline mark)
    this.atLineStart = true;
    this.write = (d) => {
      if (!d) return;
      const plain = d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (plain) this.atLineStart = /[\r\n]$/.test(plain);
      if (/\x1b\[H$/.test(d)) this.atLineStart = true;
      write(d);
    };
    this.vfs = vfs;
    this.onPreview = onPreview;
    this.onOpen = onOpen;
    this.compileTs = compileTs;
    this.user = user;
    this.host = host;
    this.env = { HOME: '/', USER: user, LOGNAME: user, SHELL: '/bin/zsh', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
    this.cwd = '';
    this.line = '';
    this.history = [];
    this.histPos = 0;
    this.status = 0; // $?
    this.busy = false; // a command line is running
    this.running = null; // the program reading input: { kill(), stdin(line), eof() }
    this.interrupted = false;
    this.sink = null; // captures output for pipes and redirects
    this.pyWorker = null;
    this.disposed = false;
    this.idle = Promise.resolve();
  }

  start() {
    const d = new Date();
    const stamp = d.toDateString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 8);
    this.write(crlf(`Last login: ${stamp} on ttys000\nWelcome to your ClassCode terminal. Type help to see what it can do.\n`));
    this.prompt();
  }

  get dirLabel() {
    return this.cwd ? this.cwd.split('/').pop() : '~';
  }

  prompt() {
    this.line = '';
    this.histPos = this.history.length;
    if (this.disposed) return;
    // like zsh: output that didn't end with a newline gets a highlighted % and a line break
    if (!this.atLineStart) this.write('\x1b[7m%\x1b[0m\r\n');
    // plain, like the default Mac terminal: "name@host folder %", or "email folder %" when there's no host
    this.write(`${this.host ? `${this.user}@${this.host}` : this.user} ${this.dirLabel} % `);
  }

  print(text) {
    if (this.disposed) return;
    if (this.sink) this.sink(text);
    else this.write(crlf(text));
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
          if (!this.busy) this.recall(seq === '\x1b[A' ? -1 : 1);
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
        else if (!this.busy) this.submit(line);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.write('\b \b');
        }
      } else if (ch === '\x03') {
        this.write('^C\r\n');
        this.line = '';
        if (this.busy) {
          this.interrupted = true;
          this.running?.kill();
        } else this.prompt();
      } else if (ch === '\x04') {
        if (this.running && !this.line) this.running.eof();
      } else if (ch === '\x0c') {
        if (!this.busy) {
          this.write('\x1b[2J\x1b[3J\x1b[H');
          const typed = this.line;
          this.prompt();
          this.line = typed;
          this.write(typed);
        }
      } else if (ch === '\t') {
        if (!this.busy) this.complete();
      } else if (ch >= ' ') {
        if (this.busy && !this.running) continue; // nothing is reading input right now
        this.line += ch;
        this.write(ch);
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

  /** Tab: complete a command or a file/folder name. */
  complete() {
    const m = /(\S*)$/.exec(this.line);
    const word = m[1].replace(/^['"]/, '');
    const firstWord = !this.line.slice(0, this.line.length - m[1].length).trim();
    let options;
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const base = word.slice(slash + 1);
    if (firstWord && !dirPart) {
      options = COMMANDS.filter((c) => c.startsWith(base)).map((c) => ({ name: c, dir: false }));
    } else {
      const dir = resolvePath(this.cwd, dirPart || '.');
      if (!this.vfs.isDir(dir)) return;
      options = this.vfs.list(dir).filter((e) => e.name.startsWith(base));
    }
    if (!options.length) return;
    let add;
    if (options.length === 1) {
      const o = options[0];
      add = o.name.slice(base.length) + (o.dir ? '/' : ' ');
    } else {
      let common = options[0].name;
      for (const o of options) while (!o.name.startsWith(common)) common = common.slice(0, -1);
      add = common.slice(base.length);
      if (!add) {
        this.write('\r\n' + options.map((o) => o.name + (o.dir ? '/' : '')).join('  ') + '\r\n');
        const typed = this.line;
        this.prompt();
        this.line = typed;
        this.write(typed);
        return;
      }
    }
    this.line += add;
    this.write(add);
  }

  /** Run a command as if it had been typed (Run button, teacher's Run). */
  async runCommand(cmd) {
    if (this.disposed) return;
    if (this.busy) {
      this.write('^C\r\n');
      this.interrupted = true;
      this.running?.kill();
      await this.idle;
    }
    this.write('\b \b'.repeat(this.line.length) + cmd + '\r\n');
    this.line = '';
    await this.submit(cmd);
  }

  async submit(raw) {
    const line = raw.trim();
    if (!line) return this.prompt();
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 500) this.history.shift();
    this.busy = true;
    this.interrupted = false;
    let done;
    this.idle = new Promise((r) => (done = r));
    try {
      await this.runLine(line);
    } finally {
      this.busy = false;
      this.running = null;
      this.sink = null;
      done();
      this.prompt();
    }
  }

  /** Run a whole command line (with ; && || and pipes). Returns its exit status. */
  async runLine(line) {
    let parts;
    try {
      parts = splitChain(line);
    } catch (e) {
      this.print(`zsh: ${e.message}\n`);
      return (this.status = e.status ?? 2);
    }
    if (/Homebrew\/install|brew\.sh\/install|install\.sh\b.*brew/i.test(line)) {
      this.print(`Homebrew can't be installed here: this terminal runs inside your web browser, and Homebrew needs a real Mac or Linux computer with sudo and compilers. ${SERVER_HINT}\nFor packages here, use pip install (Python) or npm install (JavaScript).\n`);
      return (this.status = 1);
    }
    if (/\$\(|`/.test(line.replace(/'[^']*'/g, ''))) {
      this.print('zsh: command substitution ($(...) and backticks) is not supported in this browser terminal.\n');
      return (this.status = 2);
    }
    for (const { op, text } of parts) {
      if (this.interrupted || this.disposed) break;
      if (op === '&&' && this.status !== 0) continue;
      if (op === '||' && this.status === 0) continue;
      let chain;
      try {
        chain = parse(text, { ...this.env, PWD: '/' + this.cwd, '?': this.status, $: 4242 });
      } catch (e) {
        this.print(`zsh: ${e.message}\n`);
        this.status = e.status ?? 2;
        continue;
      }
      for (const { pipeline } of chain) this.status = await this.runPipeline(pipeline);
    }
    if (this.interrupted) this.status = 130;
    return this.status;
  }

  async runPipeline(cmds) {
    let input = null;
    let status = 0;
    for (let k = 0; k < cmds.length; k++) {
      if (this.interrupted) return 130;
      const { argv, redirects } = cmds[k];
      const args = this.expandGlobs(argv);
      const outFile = redirects.filter((r) => r.op === '>' || r.op === '>>').pop();
      const errFile = redirects.find((r) => r.op === '2>');
      const inFile = redirects.find((r) => r.op === '<');
      if (inFile) {
        const p = resolvePath(this.cwd, inFile.target);
        if (!this.vfs.has(p)) {
          this.print(`zsh: no such file or directory: ${inFile.target}\n`);
          return 1;
        }
        input = this.vfs.get(p);
      }
      const last = k === cmds.length - 1;
      const capture = !last || outFile || errFile?.target === '/dev/null';
      let buf = '';
      const outer = this.sink;
      if (capture) this.sink = (t) => (buf += t);
      try {
        status = await this.runCommandArgs(args, input);
      } finally {
        this.sink = outer;
      }
      if (!last) input = stripAnsi(buf);
      else if (outFile) {
        if (outFile.target === '/dev/null') continue;
        const p = resolvePath(this.cwd, outFile.target);
        try {
          checkName(p);
          if (this.vfs.isDir(p) && !this.vfs.has(p)) fail(`is a directory: ${outFile.target}`);
          const text = stripAnsi(buf);
          this.vfs.set(p, outFile.op === '>>' ? (this.vfs.get(p) || '') + text : text);
        } catch (e) {
          this.print(`zsh: ${e.message}\n`);
          status = 1;
        }
      } else if (capture) this.print(buf);
    }
    return status;
  }

  expandGlobs(argv) {
    const out = [];
    for (const w of argv) {
      if (!w.glob) {
        out.push(w.text);
        continue;
      }
      const slash = w.text.lastIndexOf('/');
      const dirPart = slash >= 0 ? w.text.slice(0, slash + 1) : '';
      const re = globToRe(w.text.slice(slash + 1));
      const dir = resolvePath(this.cwd, dirPart || '.');
      const hits = this.vfs.isDir(dir)
        ? this.vfs
            .list(dir)
            .filter((e) => re.test(e.name) && (!e.name.startsWith('.') || w.text.slice(slash + 1).startsWith('.')))
            .map((e) => dirPart + e.name)
        : [];
      if (hits.length) out.push(...hits.sort());
      else out.push(w.text); // like bash: no match keeps the pattern
    }
    return out;
  }

  /** One command (no pipes). `stdin` is piped-in text or null. Returns its exit status. */
  async runCommandArgs(args, stdin) {
    const [cmd, ...rest] = args;
    // NAME=value on its own sets a variable
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd) && !rest.length) {
      const [k, ...v] = cmd.split('=');
      this.env[k] = v.join('=');
      return 0;
    }
    const fn = this.builtins[cmd];
    try {
      if (fn) return (await fn.call(this, rest, stdin)) ?? 0;
      if (NEEDS_COMPUTER[cmd]) {
        this.print(
          `zsh: ${cmd}: not available here. This terminal runs inside your web browser, so it can't install or run ${NEEDS_COMPUTER[cmd]}. ${SERVER_HINT}` +
            (cmd === 'sudo' || cmd === 'apt' || cmd === 'apt-get' || cmd === 'brew' ? ' Use pip install or npm install for packages.' : '') +
            '\n',
        );
        return 127;
      }
      // a file run directly: ./script.sh, ./main.py
      if (/^\.{0,2}\//.test(cmd)) {
        const p = resolvePath(this.cwd, cmd);
        if (this.vfs.has(p)) {
          const how = commandFor(p);
          if (!(how instanceof Error) && how !== 'preview') return this.builtins[how].call(this, [cmd, ...rest], stdin);
        }
        fail(`no such file or directory: ${cmd}`, 127);
      }
      fail(`command not found: ${cmd}`, 127);
    } catch (e) {
      if (!(e instanceof ShellError)) throw e;
      const who = /^(command not found|no such file)/.test(e.message) ? 'zsh: ' : cmd === 'npm' ? 'npm ' : /^(pip3?|python3?|py)$/.test(cmd) && /^(ERROR|WARNING)/.test(e.message) ? '' : `${cmd}: `;
      this.print(`${who}${e.message}\n`);
      return e.status;
    }
  }

  // ----------------------------------------------------------- helpers --
  at(p) {
    return resolvePath(this.cwd, p);
  }

  readText(p, cmd) {
    const f = this.at(p);
    if (!this.vfs.has(f)) fail(this.vfs.isDir(f) ? `${p}: Is a directory` : `${p}: No such file or directory`);
    const t = this.vfs.get(f);
    return t.startsWith('data:') ? `[${p} is a picture]\n` : t;
  }

  /** Text from files named in args, or from the pipe. */
  inputText(files, stdin, cmd) {
    if (files.length) return files.map((f) => this.readText(f, cmd)).join('');
    if (stdin != null) return stdin;
    fail('needs a file name, or text piped in (for example: cat notes.txt | ' + cmd + ' ...)');
  }

  /** The nearest file called `name` in the current folder or above. */
  nearest(name, from = this.cwd) {
    let dir = from;
    for (;;) {
      const p = (dir ? dir + '/' : '') + name;
      if (this.vfs.has(p)) return p;
      if (!dir) return null;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
  }

  /** The file a command should run when given a folder. */
  entryIn(dir, kind, cmd, wanted) {
    const prefix = dir ? dir + '/' : '';
    const entry = entryFor(this.vfs, dir);
    if (entry && kind.test(entry)) return entry;
    const ofKind = this.vfs.list(dir).filter((e) => !e.dir && kind.test(e.name));
    if (ofKind.length === 1) return prefix + ofKind[0].name;
    fail(`${dir || '~'} is a folder. Put a ${wanted} in it, or name the file to run.`);
  }

  // Packages remembered for Python (requirements.txt) and JavaScript (package.json).
  requirements(fromDir) {
    const p = this.nearest('requirements.txt', fromDir);
    if (!p) return [];
    return this.vfs
      .get(p)
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l && !l.startsWith('-'));
  }

  packageJson(create) {
    let p = this.nearest('package.json');
    if (!p) {
      if (!create) return null;
      p = (this.cwd ? this.cwd + '/' : '') + 'package.json';
      const name = (this.cwd.split('/').pop() || 'my-project').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      this.vfs.set(p, JSON.stringify({ name, version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js', test: 'echo "Error: no test specified" && exit 1' }, dependencies: {} }, null, 2) + '\n');
    }
    let data;
    try {
      data = JSON.parse(this.vfs.get(p));
    } catch (e) {
      fail(`${p} is not valid JSON: ${e.message}`);
    }
    return { path: p, data, save: () => this.vfs.set(p, JSON.stringify(data, null, 2) + '\n') };
  }

  nodeDeps(fromDir) {
    // merge package.json dependencies from the root down to `fromDir` (nearest wins)
    const deps = {};
    const parts = fromDir ? fromDir.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      const p = [...parts.slice(0, i), 'package.json'].join('/');
      if (!this.vfs.has(p)) continue;
      try {
        const j = JSON.parse(this.vfs.get(p));
        Object.assign(deps, j.devDependencies, j.dependencies);
      } catch {}
    }
    return deps;
  }

  // ------------------------------------------------------------- runners --
  // Each returns a promise of the exit status. Piped-in text is typed into the program.

  attach(worker, onMessage, kill) {
    return new Promise((resolve) => {
      let ended = false;
      const end = (status) => {
        if (ended) return;
        ended = true;
        if (this.running === handle) this.running = null;
        resolve(status);
      };
      const handle = {
        stdin: (line) => worker.postMessage({ type: 'stdin', line }),
        eof: () => worker.postMessage({ type: 'eof' }),
        kill: () => {
          kill();
          end(130);
        },
      };
      this.running = handle;
      worker.onmessage = ({ data }) => onMessage(data, end);
      worker.onerror = (e) => {
        e.preventDefault?.();
        this.print(`The program stopped unexpectedly: ${e.message || 'error'}\n`);
        kill();
        end(1);
      };
    });
  }

  feed(stdin) {
    if (stdin == null) return;
    const lines = stdin.replace(/\n$/, '').split('\n');
    for (const l of lines) this.running?.stdin(l);
    this.running?.eof();
  }

  applyChanges(data, sent) {
    const before = new Map(sent);
    for (const [path, content] of data.changed || []) this.vfs.set(path, content, 'program');
    for (const path of data.deleted || []) if (this.vfs.get(path) === before.get(path) || path.endsWith('/')) this.vfs.delete(path, 'program');
  }

  ensurePyWorker() {
    if (!this.pyWorker) {
      this.pyWorker = new Worker(new URL('./py-worker.js', import.meta.url), { type: 'module' });
      this.pyFresh = true;
    }
    return this.pyWorker;
  }

  killPython() {
    this.pyWorker?.terminate();
    this.pyWorker = null;
  }

  runPython(job, stdin) {
    const worker = this.ensurePyWorker();
    if (this.pyFresh) {
      this.print('\x1b[2mStarting Python...\x1b[0m\n');
      this.pyFresh = false;
    }
    const sent = this.vfs.entries();
    let installed = [];
    const done = this.attach(
      worker,
      (data, end) => {
        if (data.type === 'out') this.print(data.data);
        else if (data.type === 'done') {
          this.applyChanges(data, sent);
          installed = data.installed || [];
          end(data.status ?? 0);
        }
      },
      // a busy Python loop can't be interrupted politely: stop the worker; the next run starts a new one
      () => this.killPython(),
    );
    worker.postMessage({ ...job, files: sent, dirs: this.vfs.allDirs() });
    this.feed(stdin);
    return done.then((status) => ({ status, installed }));
  }

  async runJs(entry, { code, argv = [] } = {}, stdin) {
    let source = null;
    if (entry && /\.(ts|mts)$/i.test(entry)) {
      // TypeScript: the editor's built-in compiler turns it into JavaScript first
      if (!this.compileTs) fail('TypeScript is not available here.');
      try {
        source = await this.compileTs(entry);
      } catch (e) {
        fail(`could not compile ${entry}: ${e.message || e}`);
      }
    }
    const worker = new Worker(new URL('./node-worker.js', import.meta.url), { type: 'module' });
    const files = this.vfs.entries();
    if (source != null) {
      const i = files.findIndex(([p]) => p === entry);
      files[i] = [entry, source];
    }
    const done = this.attach(
      worker,
      (data, end) => {
        if (data.type === 'out') this.print(data.data);
        else if (data.type === 'done') {
          worker.terminate();
          this.applyChanges(data, files);
          end(data.status ?? 0);
        }
      },
      () => worker.terminate(),
    );
    const from = entry ? (entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '') : this.cwd;
    worker.postMessage({
      type: 'run',
      files,
      dirs: this.vfs.allDirs(),
      entry,
      code,
      argv,
      cwd: this.cwd,
      deps: this.nodeDeps(from),
      env: { USER: this.user, HOME: '/' },
    });
    this.feed(stdin);
    return done;
  }

  runLua(path) {
    const worker = new Worker(new URL('./lua-worker.js', import.meta.url));
    const done = this.attach(
      worker,
      (data, end) => {
        if (data.type === 'out') {
          this.print(data.data);
          if (/^[^\n]*:\d+: /.test(data.data)) this.luaFailed = true;
        } else if (data.type === 'done') {
          worker.terminate();
          end(this.luaFailed ? 1 : 0);
        }
      },
      () => worker.terminate(),
    );
    this.luaFailed = false;
    worker.postMessage({ code: this.vfs.get(path), name: path });
    return done;
  }

  /** Run SQL text, or (sql null) an interactive sqlite> prompt. Each run starts with an empty database. */
  runSql(sql, interactive) {
    const worker = new Worker(new URL('../vendor/sqljs/worker.sql-wasm.js', import.meta.url));
    let id = 0;
    let failed = false;
    const exec = (text) =>
      new Promise((resolve) => {
        const my = ++id;
        worker.onmessage = ({ data }) => {
          if (data.id !== my) return;
          if (data.error) {
            this.print(`Error: ${data.error}\n`);
            failed = true;
          } else for (const r of data.results || []) this.print(sqlTable(r.columns, r.values));
          resolve();
        };
        worker.postMessage({ id: my, action: 'exec', sql: text });
      });
    return new Promise((resolve) => {
      const end = (status) => {
        worker.terminate();
        if (this.running === handle) this.running = null;
        resolve(status);
      };
      worker.onerror = (e) => {
        this.print(`SQLite stopped: ${e.message || 'error'}\n`);
        end(1);
      };
      let pending = '';
      const ask = () => this.write(pending ? '   ...> ' : 'sqlite> ');
      const handle = {
        kill: () => end(130),
        eof: () => end(0),
        stdin: async (line) => {
          if (!interactive) return;
          const t = line.trim();
          if (!pending && (t === '.exit' || t === '.quit')) return end(0);
          if (!pending && t === '.tables') {
            await exec("select name from sqlite_master where type = 'table' order by name;");
            return ask();
          }
          pending += line + '\n';
          if (t.endsWith(';')) {
            const text = pending;
            pending = '';
            await exec(text);
          }
          if (this.running === handle) ask();
        },
      };
      this.running = handle;
      if (!interactive) {
        exec(sql).then(() => end(failed ? 1 : 0));
        return;
      }
      this.print('SQLite (in-memory database). End statements with ; — type .tables, or .exit to leave.\n');
      ask();
    });
  }

  dispose() {
    this.disposed = true;
    this.interrupted = true;
    this.running?.kill();
    this.killPython();
  }
}

// ---------------------------------------------------------------- commands --
// Each builtin: (args, stdin) => exit status (or undefined for 0). `this` is the Session.
const builtins = {
  help() {
    this.print(HELP);
  },
  man(args) {
    this.print(`No manual here. Type help for the list of commands${args[0] ? `, or try ${args[0]} --help` : ''}.\n`);
  },
  clear() {
    if (!this.sink) this.write('\x1b[2J\x1b[3J\x1b[H');
  },
  pwd() {
    this.print('/' + this.cwd + '\n');
  },
  cd(args) {
    const target = args[0] === '-' ? this.prevCwd ?? '' : this.at(args[0] || '~');
    if (!this.vfs.isDir(target)) fail(this.vfs.has(target) ? `not a directory: ${args[0]}` : `no such file or directory: ${args[0]}`);
    this.prevCwd = this.cwd;
    this.cwd = target;
  },
  ls(args) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const long = flags.includes('l');
    const all = flags.includes('a');
    const one = flags.includes('1') || !!this.sink;
    const targets = args.filter((a) => !a.startsWith('-'));
    let status = 0;
    const show = (dir, label) => {
      let entries = this.vfs.list(dir).filter((e) => all || !e.name.startsWith('.'));
      if (label) this.print(`${label}:\n`);
      if (long) {
        const rows = entries.map((e) => {
          const p = (dir ? dir + '/' : '') + e.name;
          const size = e.dir ? 64 : Math.round((this.vfs.get(p) || '').length * (this.vfs.get(p)?.startsWith('data:') ? 0.75 : 1));
          return [e.dir ? 'drwxr-xr-x' : '-rw-r--r--', String(size), e.dir ? `\x1b[1;34m${e.name}\x1b[0m` : e.name];
        });
        const w = Math.max(1, ...rows.map((r) => r[1].length));
        this.print(`total ${rows.length}\n` + rows.map((r) => `${r[0]}  1 ${this.user}  staff  ${r[1].padStart(w)} ${r[2]}\n`).join(''));
      } else if (entries.length) {
        const names = entries.map((e) => (e.dir ? `\x1b[1;34m${e.name}\x1b[0m` : e.name));
        this.print(names.join(one ? '\n' : '  ') + '\n');
      }
    };
    if (!targets.length) targets.push('.');
    targets.forEach((t, i) => {
      const p = this.at(t);
      if (this.vfs.has(p)) this.print(t + '\n');
      else if (!this.vfs.isDir(p)) {
        this.print(`ls: ${t}: No such file or directory\n`);
        status = 1;
      } else {
        if (i && targets.length > 1) this.print('\n');
        show(p, targets.length > 1 ? t : '');
      }
    });
    return status;
  },
  ll(args) {
    return builtins.ls.call(this, ['-l', ...args]);
  },
  cat(args, stdin) {
    const number = args.includes('-n');
    const text = this.inputText(args.filter((a) => a !== '-n'), stdin, 'cat');
    this.print(number ? text.replace(/\n$/, '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n' : text.endsWith('\n') || !text ? text : text + '\n');
  },
  echo(args) {
    const noNewline = args[0] === '-n';
    const words = noNewline || args[0] === '-e' ? args.slice(1) : args;
    let text = words.join(' ');
    // like bash: escapes such as \n only with -e, so code written with echo stays as typed
    if (args[0] === '-e') text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    this.print(text + (noNewline ? '' : '\n'));
  },
  printf(args) {
    let i = 1;
    const out = (args[0] || '').replace(/%[sd%]/g, (m) => (m === '%%' ? '%' : args[i++] ?? '')).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    this.print(out);
  },
  mkdir(args) {
    const parents = args.includes('-p');
    const dirs = args.filter((a) => !a.startsWith('-'));
    if (!dirs.length) fail('usage: mkdir [-p] directory ...');
    for (const a of dirs) {
      const p = this.at(a);
      if (this.vfs.has(p) || (this.vfs.isDir(p) && !parents)) fail(`${a}: File exists`);
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      if (!parents && !this.vfs.isDir(parent)) fail(`${a}: No such file or directory`);
      this.vfs.mkdir(checkName(p));
    }
  },
  rmdir(args) {
    for (const a of args) {
      const p = this.at(a);
      if (!this.vfs.isDir(p) || !p) fail(`${a}: No such file or directory`);
      if (this.vfs.list(p).length) fail(`${a}: Directory not empty`);
      this.vfs.rmdir(p);
    }
  },
  touch(args) {
    for (const a of args) if (!this.vfs.has(this.at(a))) this.vfs.set(checkName(this.at(a)), '');
  },
  rm(args) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const recursive = /r/i.test(flags);
    const force = flags.includes('f');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (!targets.length) fail('usage: rm [-rf] file ...');
    let status = 0;
    for (const a of targets) {
      const p = this.at(a);
      if (this.vfs.has(p)) this.vfs.delete(p);
      else if (p && this.vfs.isDir(p)) {
        if (!recursive) {
          this.print(`rm: ${a}: is a directory\n`);
          status = 1;
          continue;
        }
        this.vfs.rmdir(p);
        if (this.cwd === p || this.cwd.startsWith(p + '/')) this.cwd = '';
      } else if (!force) {
        this.print(`rm: ${a}: No such file or directory\n`);
        status = 1;
      }
    }
    return status;
  },
  mv(args) {
    return copyOrMove.call(this, 'mv', args);
  },
  cp(args) {
    return copyOrMove.call(this, 'cp', args);
  },
  tree(args) {
    const root = this.at(args.find((a) => !a.startsWith('-')) || '.');
    if (!this.vfs.isDir(root)) fail(`${args[0]} [error opening dir]`);
    let nd = 0;
    let nf = 0;
    const lines = [args.find((a) => !a.startsWith('-')) || '.'];
    const walk = (dir, prefix) => {
      const entries = this.vfs.list(dir);
      entries.forEach((e, i) => {
        const lastOne = i === entries.length - 1;
        lines.push(prefix + (lastOne ? '└── ' : '├── ') + (e.dir ? `\x1b[1;34m${e.name}\x1b[0m` : e.name));
        if (e.dir) {
          nd++;
          walk((dir ? dir + '/' : '') + e.name, prefix + (lastOne ? '    ' : '│   '));
        } else nf++;
      });
    };
    walk(root, '');
    this.print(lines.join('\n') + `\n\n${nd} director${nd === 1 ? 'y' : 'ies'}, ${nf} file${nf === 1 ? '' : 's'}\n`);
  },
  find(args) {
    const start = args[0] && !args[0].startsWith('-') ? args[0] : '.';
    const root = this.at(start);
    if (!this.vfs.isDir(root)) fail(`${start}: No such file or directory`);
    const nameAt = args.indexOf('-name') >= 0 ? args.indexOf('-name') : args.indexOf('-iname');
    const pattern = nameAt >= 0 ? args[nameAt + 1] : null;
    const re = pattern ? new RegExp(globToRe(pattern).source, args[nameAt] === '-iname' ? 'i' : '') : null;
    const type = args.includes('-type') ? args[args.indexOf('-type') + 1] : null;
    const shown = (p) => (start === '.' ? './' : start.replace(/\/$/, '') + '/') + p.slice(root ? root.length + 1 : 0);
    const out = [];
    if (!type || type === 'd') if (!re || re.test(start)) out.push(start);
    const walk = (dir) => {
      for (const e of this.vfs.list(dir)) {
        const p = (dir ? dir + '/' : '') + e.name;
        if ((!re || re.test(e.name)) && (!type || (type === 'd') === e.dir)) out.push(shown(p));
        if (e.dir) walk(p);
      }
    };
    walk(root);
    if (out.length) this.print(out.join('\n') + '\n');
  },
  grep(args, stdin) {
    const flags = new Set();
    const rest = [];
    for (const a of args) {
      if (/^-[a-zA-Z]+$/.test(a) && !rest.length) for (const f of a.slice(1)) flags.add(f);
      else rest.push(a);
    }
    const [pattern, ...targets] = rest;
    if (pattern == null) fail('usage: grep [-i -n -v -c -o -r -l] PATTERN [FILE ...]', 2);
    let re;
    try {
      re = new RegExp(flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, flags.has('i') ? 'i' : '');
    } catch {
      fail(`invalid pattern: ${pattern}`, 2);
    }
    let sources;
    if (flags.has('r') || flags.has('R')) {
      const roots = targets.length ? targets : ['.'];
      sources = [];
      for (const t of roots) {
        const r = this.at(t);
        if (this.vfs.has(r)) sources.push([t, this.vfs.get(r)]);
        else for (const p of this.vfs.paths()) if ((!r || p.startsWith(r + '/')) && !this.vfs.get(p).startsWith('data:')) sources.push([p.slice(r ? r.length + 1 : 0) ? (t === '.' ? '' : t.replace(/\/$/, '') + '/') + p.slice(r ? r.length + 1 : 0) : p, this.vfs.get(p)]);
      }
    } else if (targets.length) sources = targets.map((t) => [t, this.readText(t)]);
    else if (stdin != null) sources = [[null, stdin]];
    else fail('needs a file name, or text piped in', 2);
    const showName = sources.length > 1 || flags.has('r') || flags.has('R');
    let matched = 0;
    for (const [name, text] of sources) {
      const lines = text.replace(/\n$/, '').split('\n');
      let count = 0;
      lines.forEach((line, i) => {
        if (re.test(line) === flags.has('v')) return;
        count++;
        matched++;
        if (flags.has('c') || flags.has('l')) return;
        const prefix = (showName && name ? `\x1b[35m${name}\x1b[0m:` : '') + (flags.has('n') ? `\x1b[32m${i + 1}\x1b[0m:` : '');
        if (flags.has('o') && !flags.has('v')) {
          // only the matching parts, one per line
          for (const m of line.matchAll(new RegExp(re.source, re.flags + 'g'))) if (m[0]) this.print(prefix + `\x1b[1;31m${m[0]}\x1b[0m\n`);
          return;
        }
        const shown = flags.has('v') ? line : line.replace(new RegExp(re.source, re.flags + 'g'), (m) => `\x1b[1;31m${m}\x1b[0m`);
        this.print(prefix + shown + '\n');
      });
      if (flags.has('c')) this.print((showName && name ? name + ':' : '') + count + '\n');
      if (flags.has('l') && count) this.print(name + '\n');
    }
    return matched ? 0 : 1;
  },
  head(args, stdin) {
    return headTail.call(this, 'head', args, stdin);
  },
  tail(args, stdin) {
    return headTail.call(this, 'tail', args, stdin);
  },
  wc(args, stdin) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const files = args.filter((a) => !a.startsWith('-'));
    const count = (t) => [t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0, (t.match(/\S+/g) || []).length, new TextEncoder().encode(t).length];
    const pick = (c) => [flags.includes('l') || !flags ? c[0] : null, flags.includes('w') || !flags ? c[1] : null, flags.includes('c') || !flags ? c[2] : null].filter((x) => x != null).map((x) => String(x).padStart(8)).join('');
    if (!files.length) this.print(pick(count(this.inputText([], stdin, 'wc'))) + '\n');
    else for (const f of files) this.print(pick(count(this.readText(f))) + ' ' + f + '\n');
  },
  sort(args, stdin) {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    let lines = this.inputText(args.filter((a) => !a.startsWith('-')), stdin, 'sort').replace(/\n$/, '').split('\n');
    lines.sort(flags.includes('n') ? (a, b) => parseFloat(a) - parseFloat(b) : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (flags.includes('r')) lines.reverse();
    if (flags.includes('u')) lines = [...new Set(lines)];
    this.print(lines.join('\n') + '\n');
  },
  uniq(args, stdin) {
    const countThem = args.includes('-c');
    const lines = this.inputText(args.filter((a) => !a.startsWith('-')), stdin, 'uniq').replace(/\n$/, '').split('\n');
    const out = [];
    for (const l of lines) {
      if (out.length && out[out.length - 1][0] === l) out[out.length - 1][1]++;
      else out.push([l, 1]);
    }
    this.print(out.map(([l, n]) => (countThem ? String(n).padStart(4) + ' ' : '') + l).join('\n') + '\n');
  },
  history() {
    this.print(this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n');
  },
  whoami() {
    this.print(this.user + '\n');
  },
  hostname() {
    this.print(this.host + '\n');
  },
  uname(args) {
    this.print(args.includes('-a') ? `ClassCode ${this.host} 1.0 browser\n` : 'ClassCode\n');
  },
  date() {
    this.print(new Date().toString().replace(/ \(.*\)$/, '') + '\n');
  },
  which(args) {
    let status = 0;
    for (const a of args) {
      if (builtins[a]) this.print(`/usr/bin/${a}\n`);
      else {
        this.print(`${a} not found\n`);
        status = 1;
      }
    }
    return status;
  },
  env() {
    this.print(Object.entries({ ...this.env, PWD: '/' + this.cwd }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  },
  printenv(args) {
    if (!args.length) return builtins.env.call(this);
    for (const a of args) if (a in this.env) this.print(this.env[a] + '\n');
  },
  export(args) {
    for (const a of args) {
      const [k, ...v] = a.split('=');
      if (v.length) this.env[k] = v.join('=');
    }
  },
  unset(args) {
    for (const a of args) delete this.env[a];
  },
  true() {
    return 0;
  },
  false() {
    return 1;
  },
  async sleep(args) {
    const ms = Math.min(600, parseFloat(args[0]) || 0) * 1000;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.running = { stdin() {}, eof() {}, kill: () => (clearTimeout(t), resolve()) };
    });
    this.running = null;
  },
  exit(args) {
    if (!this.inScript) this.print('This terminal stays open while the workspace is open. Use the Dashboard button to leave.\n');
    return parseInt(args[0]) || 0;
  },
  open(args) {
    return builtins.preview.call(this, args);
  },
  preview(args) {
    let p = this.at(args.find((a) => !a.startsWith('-')) || (this.vfs.has(this.at('index.html')) ? 'index.html' : '.'));
    if (!this.vfs.has(p) && this.vfs.isDir(p)) p = this.entryIn(p, /\.(html?|md|markdown)$/i, 'preview', 'index.html');
    if (!this.vfs.has(p)) fail(`The file ${args[0] || 'index.html'} does not exist.`);
    if (/\.(html?|md|markdown|css|png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(p)) this.onPreview(p);
    else this.onOpen?.(p);
  },
  code(args) {
    if (!args.length) fail('usage: code FILE');
    for (const a of args) {
      const p = this.at(a);
      if (!this.vfs.has(p)) this.vfs.set(checkName(p), '');
      this.onOpen?.(p);
    }
  },
  async run(args, stdin) {
    const target = this.at(args[0] || '.');
    let file = target;
    if (!this.vfs.has(target)) {
      if (!this.vfs.isDir(target)) fail(`${args[0]}: No such file or folder`);
      file = entryFor(this.vfs, target);
      if (!file) fail(`${target || '~'} is a folder with nothing to run. Add a main.py, index.html or main.js to it.`);
    }
    const how = commandFor(file);
    if (how instanceof Error) fail(how.message);
    return this.builtins[how].call(this, ['/' + file, ...args.slice(1)], stdin);
  },
  async bash(args, stdin, keepCwd = false) {
    if (args[0] === '-c') return this.runLine(args.slice(1).join(' '));
    if (!args[0]) fail('interactive shells are not supported here. Use: bash FILE.sh');
    const p = this.at(args[0]);
    if (!this.vfs.has(p)) fail(`${args[0]}: No such file or directory`, 127);
    const lines = this.vfs.get(p).split(/\r?\n/);
    const saved = { cwd: this.cwd, env: { ...this.env } };
    args.slice(1).forEach((a, i) => (this.env[String(i + 1)] = a));
    this.env['0'] = args[0];
    let status = 0;
    this.inScript = (this.inScript || 0) + 1;
    try {
      for (const l of lines) {
        if (this.interrupted) return 130;
        if (!l.trim() || l.trim().startsWith('#')) continue;
        status = await this.runLine(l);
        if (/^\s*exit\b/.test(l)) break;
      }
    } finally {
      this.inScript--;
    }
    if (!keepCwd) {
      this.cwd = saved.cwd;
      this.env = saved.env;
    }
    return status;
  },
  sh(args, stdin) {
    return builtins.bash.call(this, args, stdin);
  },
  zsh(args, stdin) {
    return builtins.bash.call(this, args, stdin);
  },
  source(args, stdin) {
    return builtins.bash.call(this, args, stdin, true);
  },

  // --------------------------------------------------------------- python --
  async python(args, stdin) {
    if (args[0] === '--version' || args[0] === '-V') return this.print('Python 3.14.2\n');
    if (args[0] === '-m') {
      const mod = args[1];
      if (mod === 'pip') return builtins.pip.call(this, args.slice(2), stdin);
      if (mod === 'venv') return this.print("No virtual environment is needed here: pip installs packages just for this workspace.\n");
      if (!mod) fail('Argument expected for the -m option', 2);
      const p = this.at(mod.replace(/\./g, '/') + '.py');
      const pkg = this.at(mod.replace(/\./g, '/') + '/__main__.py');
      const file = this.vfs.has(p) ? p : this.vfs.has(pkg) ? pkg : null;
      if (!file) fail(`No module named ${mod}`);
      return builtins.python.call(this, ['/' + file, ...args.slice(2)], stdin);
    }
    if (args[0] === '-c') {
      const { status } = await this.runPython({ type: 'code', code: args[1] ?? '', argv: args.slice(2), cwd: this.cwd, requirements: this.requirements(this.cwd) }, stdin);
      return status;
    }
    const file = args.find((a) => !a.startsWith('-'));
    if (!file) {
      const { status } = await this.runPython({ type: 'repl', requirements: this.requirements(this.cwd) }, stdin);
      return status;
    }
    let entry = this.at(file);
    if (!this.vfs.has(entry) && this.vfs.isDir(entry)) entry = this.entryIn(entry, /\.py$/i, 'python', 'main.py');
    if (!this.vfs.has(entry)) fail(`can't open file '${file}': [Errno 2] No such file or directory`, 2);
    const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
    const { status } = await this.runPython({ type: 'run', entry, argv: args.slice(args.indexOf(file) + 1), requirements: this.requirements(dir) }, stdin);
    return status;
  },
  python3(args, stdin) {
    return builtins.python.call(this, args, stdin);
  },
  py(args, stdin) {
    return builtins.python.call(this, args, stdin);
  },
  async pip(args, stdin) {
    const sub = args[0];
    if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
      return this.print('Usage:\n  pip install NAME [NAME ...]\n  pip install -r requirements.txt\n  pip uninstall NAME\n  pip list | freeze | show NAME\n');
    }
    if (sub === '--version' || sub === '-V') return this.print('pip 24.0 from Pyodide (python 3.14)\n');
    if (sub === 'install') {
      const rest = args.slice(1);
      const fromFile = rest.indexOf('-r') >= 0 ? rest[rest.indexOf('-r') + 1] : null;
      let specs = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '-r');
      if (fromFile) {
        const p = this.at(fromFile);
        if (!this.vfs.has(p)) fail(`ERROR: Could not open requirements file: [Errno 2] No such file or directory: '${fromFile}'`);
        specs = [...specs, ...this.requirementsFrom(p)];
      }
      if (!specs.length) fail('ERROR: You must give at least one requirement to install (see "pip help")');
      const { status, installed } = await this.runPython({ type: 'pip', action: 'install', args: specs });
      if (!fromFile && installed.length) this.remember('requirements.txt', installed);
      return status;
    }
    if (sub === 'uninstall') {
      const names = args.slice(1).filter((a) => !a.startsWith('-'));
      if (!names.length) fail('ERROR: You must give at least one requirement to uninstall');
      const { status } = await this.runPython({ type: 'pip', action: 'uninstall', args: names });
      this.forget('requirements.txt', names);
      return status;
    }
    if (['list', 'freeze', 'show'].includes(sub)) {
      const { status } = await this.runPython({ type: 'pip', action: sub, args: args.slice(1).filter((a) => !a.startsWith('-')) });
      return status;
    }
    fail(`ERROR: unknown command "${sub}"`);
  },
  pip3(args, stdin) {
    return builtins.pip.call(this, args, stdin);
  },

  // ----------------------------------------------------------- javascript --
  async node(args, stdin) {
    if (args[0] === '-v' || args[0] === '--version') return this.print('v22.0.0 (ClassCode browser runtime)\n');
    if (args[0] === '-e' || args[0] === '--eval') return this.runJs(null, { code: args[1] ?? '', argv: args.slice(2) }, stdin);
    if (args[0] === '-p' || args[0] === '--print') return this.runJs(null, { code: `console.log(${args[1] ?? 'undefined'})`, argv: args.slice(2) }, stdin);
    const file = args.find((a) => !a.startsWith('-'));
    if (!file) fail('the interactive Node prompt is not available here. Use: node FILE.js  or  node -e "code"');
    let p = this.at(file);
    if (!this.vfs.has(p) && this.vfs.isDir(p)) p = this.entryIn(p, /\.(js|mjs|cjs|ts|mts)$/i, 'node', 'index.js');
    for (const ext of ['', '.js', '.mjs', '.cjs', '.ts']) {
      if (this.vfs.has(p + ext)) {
        p += ext;
        break;
      }
    }
    if (!this.vfs.has(p)) fail(`Cannot find module '/${p}'`);
    return this.runJs(p, { argv: args.slice(args.indexOf(file) + 1) }, stdin);
  },
  'ts-node'(args, stdin) {
    return builtins.node.call(this, args, stdin);
  },
  tsx(args, stdin) {
    return builtins.node.call(this, args, stdin);
  },
  deno(args, stdin) {
    return builtins.node.call(this, args[0] === 'run' ? args.slice(1) : args, stdin);
  },
  async npm(args, stdin) {
    return npm.call(this, args, stdin);
  },
  async curl(args) {
    return curl.call(this, args);
  },
  async wget(args) {
    const quiet = args.includes('-q');
    const oAt = args.indexOf('-O');
    const url = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-O');
    if (!url) fail('missing URL\nUsage: wget [-q] [-O FILE] URL');
    const name = oAt >= 0 ? args[oAt + 1] : decodeURIComponent(new URL(withScheme(url)).pathname.split('/').pop() || '') || 'index.html';
    if (!quiet) this.print(`--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${withScheme(url)}\n`);
    const status = await curl.call(this, ['-s', '-f', '-L', '-o', name, url], { wget: true, quiet });
    if (!status && !quiet) this.print(`\nSaving to: ‘${name}’\n\n‘${name}’ saved\n`);
    return status ? (status === 22 ? 8 : 4) : 0;
  },
  npx(args) {
    fail(`npx can't run terminal programs here, because this terminal runs inside your web browser. To use a package's code, install it with "npm install NAME" and import it in your program. ${SERVER_HINT}`, 127);
  },

  // ------------------------------------------------------------ other langs --
  lua(args) {
    if (!args[0]) fail('the interactive Lua prompt is not available here. Use: lua FILE.lua');
    let p = this.at(args[0]);
    if (!this.vfs.has(p) && this.vfs.isDir(p)) p = this.entryIn(p, /\.lua$/i, 'lua', 'main.lua');
    if (!this.vfs.has(p)) fail(`cannot open ${args[0]}`);
    return this.runLua(p);
  },
  sqlite(args, stdin) {
    const file = args.find((a) => !a.startsWith('-') && !/\.(db|sqlite3?)$/i.test(a));
    if (file) {
      let p = this.at(file);
      if (!this.vfs.has(p) && this.vfs.isDir(p)) p = this.entryIn(p, /\.sql$/i, 'sqlite', 'main.sql');
      if (!this.vfs.has(p)) fail(`cannot open ${file}`);
      return this.runSql(this.vfs.get(p), false);
    }
    if (stdin != null) return this.runSql(stdin, false);
    return this.runSql(null, true);
  },
  sqlite3(args, stdin) {
    return builtins.sqlite.call(this, args, stdin);
  },
  sql(args, stdin) {
    return builtins.sqlite.call(this, args, stdin);
  },
};
Session.prototype.builtins = builtins;
const COMMANDS = Object.keys(builtins).sort();

Session.prototype.requirementsFrom = function (p) {
  return this.vfs
    .get(p)
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'));
};
// Add or remove package lines in requirements.txt (nearest, or a new one here).
Session.prototype.remember = function (name, specs) {
  const p = this.nearest(name) || (this.cwd ? this.cwd + '/' : '') + name;
  const lines = this.vfs.has(p) ? this.vfs.get(p).replace(/\n$/, '').split('\n').filter(Boolean) : [];
  const key = (s) => s.split(/[=<>!~\[ ;]/)[0].trim().toLowerCase();
  let added = 0;
  for (const s of specs) {
    const i = lines.findIndex((l) => key(l) === key(s));
    if (i >= 0) {
      if (/[=<>~]/.test(s)) lines[i] = s;
    } else {
      lines.push(s);
      added++;
    }
  }
  const isNew = !this.vfs.has(p);
  this.vfs.set(p, lines.join('\n') + '\n');
  if (added) this.print(`\x1b[2mSaved to ${p}${isNew ? ' (new file)' : ''}: these packages are installed again automatically when your Python runs.\x1b[0m\n`);
};
Session.prototype.forget = function (name, names) {
  const p = this.nearest(name);
  if (!p) return;
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const lines = this.vfs.get(p).split('\n').filter((l) => !drop.has(l.split(/[=<>!~\[ ;]/)[0].trim().toLowerCase()));
  this.vfs.set(p, lines.filter(Boolean).join('\n') + (lines.some(Boolean) ? '\n' : ''));
};

function copyOrMove(cmd, args) {
  const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a));
  const names = args.filter((a) => !a.startsWith('-'));
  if (names.length < 2) fail(`usage: ${cmd} SOURCE ... TARGET`);
  const target = this.at(names.pop());
  const many = names.length > 1;
  if (many && !this.vfs.isDir(target)) fail(`${names[names.length]}: not a directory`);
  for (const n of names) {
    const from = this.at(n);
    let to = this.vfs.isDir(target) && !this.vfs.has(target) ? (target ? target + '/' : '') + from.split('/').pop() : target;
    if (to === from) continue;
    if (this.vfs.has(from)) {
      this.vfs.set(checkName(to), this.vfs.get(from));
      if (cmd === 'mv') this.vfs.delete(from);
    } else if (from && this.vfs.isDir(from)) {
      if (to.startsWith(from + '/')) fail(`cannot ${cmd === 'mv' ? 'move' : 'copy'} a folder into itself`);
      if (cmd === 'mv') {
        this.vfs.renameDir(from, checkName(to));
        if (this.cwd === from || this.cwd.startsWith(from + '/')) this.cwd = to + this.cwd.slice(from.length);
      } else {
        if (!recursive) fail(`${n} is a directory (not copied). Use cp -r`);
        this.vfs.mkdir(to);
        for (const d of this.vfs.allDirs()) if (d.startsWith(from + '/')) this.vfs.mkdir(to + d.slice(from.length));
        for (const p of this.vfs.paths()) if (p.startsWith(from + '/')) this.vfs.set(to + p.slice(from.length), this.vfs.get(p));
      }
    } else fail(`${n}: No such file or directory`);
  }
}

function headTail(which, args, stdin) {
  let n = 10;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') n = parseInt(args[++i]);
    else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1));
    else if (/^-n\d+$/.test(args[i])) n = parseInt(args[i].slice(2));
    else files.push(args[i]);
  }
  if (Number.isNaN(n)) fail('illegal line count');
  const lines = this.inputText(files, stdin, which).replace(/\n$/, '').split('\n');
  const picked = which === 'head' ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n));
  this.print(picked.join('\n') + '\n');
}

// --------------------------------------------------------------------- curl --
// Real HTTP requests with the browser's fetch(). A site only answers a web page
// when it allows it (CORS), which most public APIs do.
const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : 'https://' + u);
const TEXT_TYPE = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded|ld\+json|graphql)|image\/svg)/i;

async function curl(args, opts = {}) {
  const o = { method: null, headers: {}, data: null, out: null, remoteName: false, include: false, head: false, silent: false, fail: false, verbose: false, user: null, writeOut: null };
  const urls = [];
  if (args.includes('--help') || args.includes('-h')) {
    this.print('Usage: curl [options...] <url>\n -d, --data <data>   send data (POST)\n -H, --header <h>    add a header\n -i, --include       show response headers\n -I, --head          headers only\n -o, --output <file> save to a file\n -O                  save using the URL\'s file name\n -s, --silent        no progress or errors\n -X, --request <m>   method (GET, POST, PUT, DELETE...)\n --json <data>       send JSON\n');
    return 0;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (i + 1 >= args.length) fail(`(2) option ${a}: requires parameter`, 2);
      return args[++i];
    };
    if (a === '-X' || a === '--request') o.method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const c = h.indexOf(':');
      if (c > 0) o.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(a)) {
      let d = next();
      if (d.startsWith('@') && a !== '--data-raw') d = this.readText(d.slice(1));
      o.data = o.data == null ? d : o.data + '&' + d;
    } else if (a === '--json') {
      let d = next();
      if (d.startsWith('@')) d = this.readText(d.slice(1));
      o.data = d;
      o.headers['Content-Type'] ??= 'application/json';
      o.headers['Accept'] ??= 'application/json';
    } else if (a === '-F' || a === '--form') {
      const [k, ...v] = next().split('=');
      (o.form ||= new FormData()).append(k, v.join('='));
    } else if (a === '-o' || a === '--output') o.out = next();
    else if (a === '-O' || a === '--remote-name') o.remoteName = true;
    else if (a === '-u' || a === '--user') o.user = next();
    else if (a === '-A' || a === '--user-agent' || a === '-e' || a === '--referer' || a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '--retry') next();
    else if (a === '-w' || a === '--write-out') o.writeOut = next();
    else if (a === '-i' || a === '--include') o.include = true;
    else if (a === '-I' || a === '--head') o.head = true;
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a === '-f' || a === '--fail') o.fail = true;
    else if (/^-[a-zA-Z]+$/.test(a) && a.length > 2) {
      // combined short flags like -sSL, -fsSL, -sI
      for (const f of a.slice(1)) {
        if (f === 's') o.silent = true;
        else if (f === 'i') o.include = true;
        else if (f === 'I') o.head = true;
        else if (f === 'f') o.fail = true;
        else if (f === 'v') o.verbose = true;
        else if (f === 'O') o.remoteName = true;
      }
    } else if (['-s', '--silent', '-S', '--show-error', '-L', '--location', '-k', '--insecure', '--compressed', '-#', '--progress-bar', '-N', '--no-buffer', '-g'].includes(a)) {
      if (a === '-s' || a === '--silent') o.silent = true;
    } else if (a.startsWith('-')) fail(`option ${a}: is unknown\ncurl: try 'curl --help' for more information`, 2);
    else urls.push(a);
  }
  if (!urls.length) fail('no URL specified!\ncurl: try \'curl --help\' for more information', 2);
  let status = 0;
  for (const raw of urls) {
    const url = withScheme(raw);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail(`(3) URL rejected: Malformed input to a URL function`, 3);
    }
    if (parsed.protocol === 'http:' && location.protocol === 'https:') {
      this.print(`curl: (7) This page is https, so the browser blocks plain http:// addresses. Try https://${parsed.host}${parsed.pathname}${parsed.search}\n`);
      status = 7;
      continue;
    }
    const method = o.method || (o.head ? 'HEAD' : o.data != null || o.form ? 'POST' : 'GET');
    const headers = { ...o.headers };
    if (o.data != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (o.user) headers['Authorization'] = 'Basic ' + btoa(o.user);
    if (o.verbose) this.print(`> ${method} ${parsed.pathname}${parsed.search} HTTP/1.1\n> Host: ${parsed.host}\n` + Object.entries(headers).map(([k, v]) => `> ${k}: ${v}\n`).join('') + '>\n');
    const ctrl = new AbortController();
    this.running = { stdin() {}, eof() {}, kill: () => ctrl.abort() };
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : o.form || o.data, signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
      this.running = null;
      if (ctrl.signal.aborted) return 130;
      if (!o.silent || opts.wget) {
        this.print(
          opts.wget
            ? `Connecting to ${parsed.host}... failed: the site didn't answer, or it doesn't let web pages read it (CORS).\n`
            : `curl: (7) Failed to connect to ${parsed.host}: the site didn't answer, or it doesn't let web pages read it (CORS).\n` +
                `      This terminal runs in your browser, so it can only reach sites that allow that, like most public APIs\n      (for example https://api.github.com, https://jsonplaceholder.typicode.com, https://wttr.in/?format=3).\n`,
        );
      }
      status = 7;
      continue;
    }
    const type = res.headers.get('content-type') || '';
    const headerText = `HTTP/1.1 ${res.status} ${res.statusText || ''}`.trimEnd() + '\n' + [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
    if (o.verbose) this.print(headerText.replace(/^/gm, '< ').replace(/< $/, ''));
    if (o.fail && res.status >= 400) {
      this.running = null;
      if (!o.silent || opts.wget) this.print(opts.wget ? `ERROR ${res.status}: ${res.statusText || 'Error'}.\n` : `curl: (22) The requested URL returned error: ${res.status}\n`);
      status = 22;
      continue;
    }
    if (o.head) {
      this.print(headerText);
      this.running = null;
      continue;
    }
    let body;
    let bytes;
    try {
      if (TEXT_TYPE.test(type) || /charset=/i.test(type)) body = await res.text();
      else {
        bytes = new Uint8Array(await res.arrayBuffer());
        // no type, or unclear: treat as text if it decodes cleanly
        try {
          const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (!/[\x00-\x08\x0e-\x1f]/.test(t.slice(0, 2000))) body = t;
        } catch {}
      }
    } catch (e) {
      this.running = null;
      if (ctrl.signal.aborted) return 130;
      this.print(`curl: (56) Failure when receiving data from the peer\n`);
      status = 56;
      continue;
    }
    this.running = null;
    const size = body != null ? new TextEncoder().encode(body).length : bytes.length;
    const outName = o.out || (o.remoteName ? decodeURIComponent(parsed.pathname.split('/').pop() || '') : null);
    if (o.remoteName && !outName) fail('(23) Remote file name has no length!', 23);
    if (outName) {
      const p = this.at(outName);
      checkName(p);
      if (body != null && !(bytes && /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(p))) this.vfs.set(p, body);
      else if (/^image\//i.test(type) || /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(p)) {
        if (size > 2_200_000) fail(`(23) ${outName} is too big to keep (pictures can be up to about 2 MB)`, 23);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        this.vfs.set(p, `data:${type.split(';')[0] || 'image/png'};base64,${btoa(bin)}`);
      } else fail(`(23) ${outName} is a binary file; only text files and pictures can be saved in the workspace`, 23);
      if (!o.silent && !opts.wget) {
        const secs = Math.max(0.001, (performance.now() - t0) / 1000);
        const speed = String(Math.round(size / secs));
        this.print(
          '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n' +
            '                                 Dload  Upload   Total   Spent    Left  Speed\n' +
            `100 ${String(size).padStart(6)}  100 ${String(size).padStart(6)}    0     0  ${speed.padStart(6)}      0 --:--:-- --:--:-- --:--:-- ${speed.padStart(6)}\n`,
        );
      }
    } else {
      if (o.include) this.print(headerText);
      if (body != null) this.print(body);
      else this.print(`Warning: Binary output can mess up your terminal. Use "--output FILE" to save it to a file.\n`);
    }
    if (o.writeOut) this.print(o.writeOut.replace(/%\{http_code\}/g, res.status).replace(/%\{size_download\}/g, size).replace(/%\{content_type\}/g, type).replace(/\\n/g, '\n'));
  }
  return status;
}

// ---------------------------------------------------------------------- npm --
// Packages come from the npm registry through the jsDelivr CDN, which also
// turns them into browser modules. package.json records them, as with real npm.
const NPM_API = 'https://data.jsdelivr.com/v1/packages/npm/';
const NPM_CDN = 'https://cdn.jsdelivr.net/npm/';

async function resolveNpm(name, range) {
  let res;
  try {
    res = await fetch(`${NPM_API}${name}/resolved?specifier=${encodeURIComponent(range || 'latest')}`);
  } catch {
    fail(`ERR! network: could not reach the package server (cdn.jsdelivr.net). Check the internet connection.`);
  }
  const data = res.ok ? await res.json().catch(() => null) : null;
  if (!data?.version) {
    if (res.status === 404 || res.ok) fail(`ERR! 404 Not Found - '${name}${range ? '@' + range : ''}' is not in the npm registry.`);
    fail(`ERR! the package server answered ${res.status}. Try again in a moment.`);
  }
  return data.version;
}
// Fetch the browser build once (so the first run is fast). Returns false when
// the CDN has no browser build, e.g. for packages that are only terminal programs.
async function warmNpm(name, version) {
  let res;
  try {
    res = await fetch(`${NPM_CDN}${name}@${version}/+esm`);
    await res.text();
  } catch {
    fail(`ERR! network: could not download ${name}. Check the internet connection.`);
  }
  return res.ok;
}
async function npmMeta(name, version) {
  try {
    const r = await fetch(`${NPM_CDN}${name}@${version}/package.json`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
// What to tell the student about a package that won't fully work in the browser (or null).
function npmNote(name, meta, browser) {
  const bins = meta?.bin ? (typeof meta.bin === 'string' ? [name.split('/').pop()] : Object.keys(meta.bin)) : [];
  if (bins.length && !browser) return `${name} is a terminal program (${bins.join(', ')}). It was added to package.json, but programs like that need a real computer, so it can't run in this browser terminal. ${SERVER_HINT}`;
  if (bins.length) return `${name} is a terminal program (${bins.join(', ')}). Its command can't run in this browser terminal; your code can still import the parts that work in a browser. ${SERVER_HINT}`;
  if (!browser) return `${name} was added to package.json, but it has no version that runs in a web browser, so programs here can't import it. ${SERVER_HINT}`;
  return null;
}

async function npm(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const t0 = performance.now();
  const took = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    return this.print('Usage: npm <command>\n\n  npm init              make a package.json\n  npm install NAME      add a package (npm i NAME)\n  npm install           install everything in package.json\n  npm uninstall NAME    remove a package\n  npm list              show installed packages\n  npm run SCRIPT        run a script from package.json\n  npm start / npm test\n');
  }
  if (sub === '-v' || sub === '--version') return this.print('10.9.0\n');
  if (sub === 'init') {
    if (this.vfs.has((this.cwd ? this.cwd + '/' : '') + 'package.json')) fail('package.json already exists here.');
    const pj = this.packageJson(true);
    this.print(`Wrote to /${pj.path}:\n\n${JSON.stringify(pj.data, null, 2)}\n\n`);
    return 0;
  }
  if (['install', 'i', 'add', 'isntall', 'in'].includes(sub)) {
    const dev = rest.some((a) => a === '-D' || a === '--save-dev');
    if (rest.some((a) => a === '-g' || a === '--global')) {
      this.print(`\x1b[33mnpm warn\x1b[0m -g: there are no global programs in this browser terminal, so the package is added to package.json for your code to use instead.\n`);
    }
    const specs = rest.filter((a) => !a.startsWith('-'));
    const pj = this.packageJson(true);
    const section = dev ? 'devDependencies' : 'dependencies';
    pj.data[section] ||= {};
    if (!specs.length) {
      const all = { ...pj.data.dependencies, ...pj.data.devDependencies };
      const names = Object.keys(all);
      for (const n of names) {
        const v = await resolveNpm(n, all[n]);
        await warmNpm(n, v); // packages without a browser build are fine to keep listed
      }
      this.print(names.length ? `\nadded ${names.length} package${names.length === 1 ? '' : 's'}, and audited ${names.length} package${names.length === 1 ? '' : 's'} in ${took()}\n\nfound 0 vulnerabilities\n` : `\nup to date, audited 1 package in ${took()}\n\nfound 0 vulnerabilities\n`);
      return 0;
    }
    let added = 0;
    const cliPackages = [];
    for (const spec of specs) {
      const m = /^(@[^/@]+\/[^@]+|[^@]+)(?:@(.+))?$/.exec(spec);
      if (!m) fail(`ERR! Invalid package name "${spec}"`);
      const [, name, range] = m;
      this.print(`\x1b[2m⠋ fetching ${name}...\x1b[0m\r`);
      const version = await resolveNpm(name, range);
      const browser = await warmNpm(name, version);
      const meta = await npmMeta(name, version);
      this.print('\x1b[2K');
      if (!browser && !meta) fail(`ERR! ${name}@${version} could not be downloaded. Try again in a moment.`);
      const note = npmNote(name, meta, browser);
      if (note) cliPackages.push(note);
      if (pj.data.dependencies?.[name] && section !== 'dependencies') delete pj.data.dependencies[name];
      if (pj.data.devDependencies?.[name] && section !== 'devDependencies') delete pj.data.devDependencies[name];
      if (!pj.data[section][name]) added++;
      pj.data[section][name] = range && /^\d+\.\d+\.\d+/.test(range) ? range : '^' + version;
    }
    pj.data[section] = Object.fromEntries(Object.entries(pj.data[section]).sort(([a], [b]) => a.localeCompare(b)));
    pj.save();
    this.print(`\n${added ? `added ${added} package${added === 1 ? '' : 's'}` : 'up to date'}, and audited ${Object.keys({ ...pj.data.dependencies, ...pj.data.devDependencies }).length + 1} packages in ${took()}\n\nfound 0 vulnerabilities\n`);
    for (const note of cliPackages) this.print(`\x1b[33mnpm warn\x1b[0m ${note}\n`);
    if (!this.npmHintShown) {
      this.npmHintShown = true;
      this.print(`\x1b[2mSaved in /${pj.path}. Packages load from the internet when your program runs, so there is no node_modules folder.\x1b[0m\n`);
    }
    return 0;
  }
  if (['uninstall', 'remove', 'rm', 'un', 'r'].includes(sub)) {
    const pj = this.packageJson(false);
    if (!pj) fail('ERR! no package.json here');
    let removed = 0;
    for (const n of rest.filter((a) => !a.startsWith('-'))) {
      for (const s of ['dependencies', 'devDependencies']) if (pj.data[s]?.[n]) delete pj.data[s][n], removed++;
    }
    pj.save();
    this.print(`\nremoved ${removed} package${removed === 1 ? '' : 's'} in ${took()}\n`);
    return 0;
  }
  if (['list', 'ls', 'la', 'll'].includes(sub)) {
    const pj = this.packageJson(false);
    if (!pj) return this.print(`/${this.cwd}\n└── (empty)\n`), 0;
    const all = Object.entries({ ...pj.data.dependencies, ...pj.data.devDependencies });
    this.print(`${pj.data.name || 'project'}@${pj.data.version || '1.0.0'} /${pj.path.replace(/\/?package\.json$/, '')}\n` + (all.length ? all.map(([n, v], i) => `${i === all.length - 1 ? '└──' : '├──'} ${n}@${String(v).replace(/^[\^~]/, '')}`).join('\n') : '└── (empty)') + '\n');
    return 0;
  }
  if (['view', 'info', 'show'].includes(sub)) {
    if (!rest[0]) fail('ERR! npm view NAME');
    const v = await resolveNpm(rest[0], 'latest');
    this.print(`\n\x1b[1m${rest[0]}\x1b[0m@\x1b[32m${v}\x1b[0m\nlatest: ${v}\n\n`);
    return 0;
  }
  if (sub === 'run' || sub === 'run-script' || sub === 'start' || sub === 'test' || sub === 't') {
    const pj = this.packageJson(false);
    const scripts = pj?.data.scripts || {};
    const name = sub === 'start' ? 'start' : sub === 'test' || sub === 't' ? 'test' : rest[0];
    if (!name) {
      const list = Object.entries(scripts);
      this.print(list.length ? `Scripts available in ${pj.data.name}:\n` + list.map(([k, v]) => `  ${k}\n    ${v}`).join('\n') + '\n' : 'No scripts in package.json.\n');
      return 0;
    }
    let script = scripts[name];
    if (!script && name === 'start' && this.vfs.has((pj ? pj.path.replace(/package\.json$/, '') : '') + 'server.js')) script = 'node server.js';
    if (!script) fail(`ERR! Missing script: "${name}"\n\nTo see a list of scripts, run:\n  npm run`);
    const extra = (sub === 'run' || sub === 'run-script' ? rest.slice(1) : rest).filter((a) => a !== '--');
    this.print(`\n> ${pj.data.name || 'project'}@${pj.data.version || '1.0.0'} ${name}\n> ${script}\n\n`);
    const saved = this.cwd;
    this.cwd = pj.path.includes('/') ? pj.path.slice(0, pj.path.lastIndexOf('/')) : '';
    try {
      return await this.runLine(script + (extra.length ? ' ' + extra.map(quoteArg).join(' ') : ''));
    } finally {
      this.cwd = saved;
    }
  }
  fail(`Unknown command: "${sub}"\n\nTo see a list of supported npm commands, run:\n  npm help`);
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
  if (!path || path.length > 200 || /[\x00-\x1f\\]/.test(path)) fail('That file name is not allowed');
  return path;
}
