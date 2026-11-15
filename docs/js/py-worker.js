// Runs Python (Pyodide) off the main thread.
//
// in:  { type: 'run',  files: [[path, content]], entry, argv }
//      { type: 'repl', files: [[path, content]] }
//      { type: 'pip',  packages: [name] }
//      { type: 'stdin', line }   { type: 'eof' }
// out: { type: 'out', data }                       text for the terminal
//      { type: 'done', changed: [[path, content]], deleted: [path] }

import { loadPyodide } from '../vendor/pyodide/pyodide.mjs';

const ROOT = '/project';
// Extra packages (numpy, pandas, ...) are downloaded on demand from the Pyodide CDN.
const PYODIDE_VERSION = '314.0.8';
const PACKAGE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const MAX_FILE = 256 * 1024;
const out = (data) => postMessage({ type: 'out', data });

// ---- stdin: lines arrive from the page; Python waits on a promise ----
const lines = [];
let waiting = null;
let eof = false;
self.ccReadLine = () =>
  new Promise((resolve) => {
    if (lines.length) resolve(lines.shift());
    else if (eof) resolve(null);
    else waiting = resolve;
  });

let ready = null;
function boot() {
  return (ready ||= (async () => {
    const indexURL = new URL('../vendor/pyodide/', import.meta.url).href;
    const py = await loadPyodide({ indexURL, packageBaseUrl: PACKAGE_CDN });
    const decoder = new TextDecoder();
    const sink = {
      write: (buf) => {
        out(decoder.decode(buf, { stream: true }));
        return buf.length;
      },
      isatty: true,
    };
    py.setStdout(sink);
    py.setStderr(sink);
    py.FS.mkdirTree(ROOT);
    await py.runPythonAsync(`
import builtins, sys, os, runpy, traceback, code
from pyodide.ffi import run_sync, can_run_sync
from js import ccReadLine

def _cc_input(prompt=''):
    sys.stdout.write(str(prompt))
    sys.stdout.flush()
    if not can_run_sync():
        raise RuntimeError("input() is not supported in this browser. Use a recent Chrome or Edge.")
    line = run_sync(ccReadLine())
    if line is None:
        raise EOFError("EOF when reading a line")
    return line

builtins.input = _cc_input

def _cc_forget_project_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None) or ''
        if f.startswith('${ROOT}/'):
            del sys.modules[name]

def _cc_run(path, argv):
    os.chdir(os.path.dirname(path) or '${ROOT}')
    sys.argv = [os.path.basename(path)] + list(argv)
    sys.path[0:0] = [os.path.dirname(path)]
    try:
        runpy.run_path(path, run_name='__main__')
    except SystemExit:
        pass
    except KeyboardInterrupt:
        print("KeyboardInterrupt")
    except BaseException:
        et, ev, tb = sys.exc_info()
        while tb is not None and not tb.tb_frame.f_code.co_filename.startswith('${ROOT}/'):
            tb = tb.tb_next
        traceback.print_exception(et, ev, tb)
    finally:
        sys.path.pop(0)
        sys.stdout.flush()
        _cc_forget_project_modules()

def _cc_repl():
    os.chdir('${ROOT}')
    console = code.InteractiveConsole(locals={'__name__': '__console__'})
    print("Python " + sys.version.split()[0] + "  (type exit() or press Ctrl+D to leave)")
    more = False
    while True:
        try:
            line = input('... ' if more else '>>> ')
        except EOFError:
            print()
            break
        try:
            more = console.push(line)
        except SystemExit:
            break
    sys.stdout.flush()
    _cc_forget_project_modules()
`);
    return py;
  })());
}

function rmTree(FS, dir) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (FS.isDir(FS.stat(p).mode)) {
      rmTree(FS, p);
      FS.rmdir(p);
    } else FS.unlink(p);
  }
}

// Pictures are stored as data URLs; Python sees the real image bytes.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const MAX_IMAGE = 2_200_000; // bytes

function fromDataUrl(content) {
  const m = /^data:[^;,]*;base64,/.exec(content);
  if (!m) return null;
  const bin = atob(content.slice(m[0].length));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toDataUrl(path, bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream'};base64,${btoa(bin)}`;
}

function writeProject(py, files, dirs = []) {
  rmTree(py.FS, ROOT);
  for (const dir of dirs) py.FS.mkdirTree(`${ROOT}/${dir}`);
  for (const [path, content] of files) {
    const full = `${ROOT}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    py.FS.writeFile(full, fromDataUrl(content) ?? content);
  }
}

/** Files the program created or changed (text only), and files it removed. */
function diffProject(py, files) {
  const before = new Map(files);
  const seen = new Set();
  const changed = [];
  const strict = new TextDecoder('utf-8', { fatal: true });
  const walk = (dir, rel) => {
    for (const name of py.FS.readdir(dir)) {
      if (name === '.' || name === '..' || name === '__pycache__') continue;
      const p = `${dir}/${name}`;
      const r = rel ? `${rel}/${name}` : name;
      const st = py.FS.stat(p);
      if (py.FS.isDir(st.mode)) walk(p, r);
      else {
        seen.add(r);
        // pictures a program saves (for example a matplotlib chart) are kept too
        if (IMAGE_RE.test(r)) {
          if (st.size > MAX_IMAGE) continue;
          const url = toDataUrl(r, py.FS.readFile(p));
          const old = before.get(r);
          if (!old || old.slice(old.indexOf(',')) !== url.slice(url.indexOf(','))) changed.push([r, url]);
          continue;
        }
        if (st.size > MAX_FILE) continue;
        try {
          const text = strict.decode(py.FS.readFile(p));
          if (before.get(r) !== text) changed.push([r, text]);
        } catch {
          // binary output: not kept
        }
      }
    }
  };
  walk(ROOT, '');
  return { changed, deleted: [...before.keys()].filter((p) => !seen.has(p)) };
}

async function withProject(files, fn, dirs = []) {
  let py;
  try {
    py = await boot();
  } catch (e) {
    out(`Could not start Python: ${e.message}\n`);
    return postMessage({ type: 'done', changed: [], deleted: [] });
  }
  lines.length = 0;
  eof = false;
  try {
    // The last program may have left Python inside a project folder; step out
    // before clearing the project, or removing that folder fails.
    py.FS.chdir('/');
    writeProject(py, files, dirs);
  } catch (e) {
    out(`Could not prepare the files: ${e.message || e.name || e}\n`);
    return postMessage({ type: 'done', changed: [], deleted: [] });
  }
  try {
    await fn(py);
  } catch (e) {
    out(String(e.message || e) + '\n');
  }
  let result = { changed: [], deleted: [] };
  try {
    result = diffProject(py, files);
  } catch {}
  postMessage({ type: 'done', ...result });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stdin') {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(data.line);
    } else lines.push(data.line);
  } else if (data.type === 'eof') {
    eof = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  } else if (data.type === 'run') {
    await withProject(data.files, async (py) => {
      const source = new Map(data.files).get(data.entry) ?? '';
      try {
        await py.loadPackagesFromImports(source, { messageCallback: () => {}, errorCallback: () => {} });
      } catch {
        // offline or unknown package: let the import fail with Python's own error
      }
      py.globals.set('_cc_path', `${ROOT}/${data.entry}`);
      py.globals.set('_cc_argv', py.toPy(data.argv || []));
      await py.runPythonAsync('_cc_run(_cc_path, _cc_argv)');
    }, data.dirs);
  } else if (data.type === 'repl') {
    await withProject(data.files, (py) => py.runPythonAsync('_cc_repl()'), data.dirs);
  } else if (data.type === 'pip') {
    await withProject([], async (py) => {
      await py.loadPackage('micropip', { messageCallback: () => {} });
      const micropip = py.pyimport('micropip');
      for (const name of data.packages) {
        out(`Installing ${name}...\n`);
        await micropip.install(name);
      }
      out('Done.\n');
    }).catch(() => {});
  }
};

postMessage({ type: 'booted' });
