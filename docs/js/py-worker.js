// Runs Python (Pyodide) off the main thread.
//
// in:  { type: 'run',  files: [[path, content]], dirs, entry, argv, requirements }
//      { type: 'code', files, dirs, code, argv, cwd, requirements }     python -c "..."
//      { type: 'repl', files, dirs, requirements }
//      { type: 'pip',  action: 'install' | 'uninstall' | 'list' | 'freeze' | 'show', args: [...] }
//      { type: 'stdin', line }   { type: 'eof' }
// out: { type: 'out', data }                       text for the terminal
//      { type: 'done', status, changed: [[path, content]], deleted: [path], installed?: [name] }

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

def _cc_exit_status(e):
    code = e.code
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    print(code, file=sys.stderr)
    return 1

def _cc_report():
    et, ev, tb = sys.exc_info()
    while tb is not None and not tb.tb_frame.f_code.co_filename.startswith(('${ROOT}/', '<string>')):
        tb = tb.tb_next
    traceback.print_exception(et, ev, tb)

# Runs a program like "python file.py"; returns the exit status.
def _cc_run(path, argv):
    os.chdir(os.path.dirname(path) or '${ROOT}')
    sys.argv = [os.path.basename(path)] + list(argv)
    sys.path[0:0] = [os.path.dirname(path)]
    try:
        runpy.run_path(path, run_name='__main__')
        return 0
    except SystemExit as e:
        return _cc_exit_status(e)
    except KeyboardInterrupt:
        print("KeyboardInterrupt")
        return 130
    except BaseException:
        _cc_report()
        return 1
    finally:
        sys.path.pop(0)
        sys.stdout.flush()
        sys.stderr.flush()
        _cc_forget_project_modules()

# python -c "code"
def _cc_code(src, argv, cwd):
    os.chdir(cwd)
    sys.argv = ['-c'] + list(argv)
    sys.path[0:0] = [cwd]
    try:
        exec(compile(src, '<string>', 'exec'), {'__name__': '__main__'})
        return 0
    except SystemExit as e:
        return _cc_exit_status(e)
    except BaseException:
        _cc_report()
        return 1
    finally:
        sys.path.pop(0)
        sys.stdout.flush()
        _cc_forget_project_modules()

# pip, on top of micropip (pure-Python packages from PyPI, and Pyodide's own builds of numpy, pandas, ...)
def _cc_pip_error(e, spec):
    msg = str(e)
    if "pure Python 3 wheel" in msg or "Can't find a pure" in msg:
        return f"ERROR: {spec} needs compiled code that isn't available in the browser. Only pure-Python packages, and the ones Pyodide provides (numpy, pandas, matplotlib, ...), can be installed here."
    if "No matching distribution" in msg or "Can't fetch metadata" in msg or "404" in msg:
        return f"ERROR: No matching distribution found for {spec}"
    if "fetch" in msg.lower() or "network" in msg.lower():
        return f"ERROR: Could not reach the package index to download {spec}. Check the internet connection."
    return f"ERROR: {msg}"

async def _cc_pip(action, args):
    import micropip
    pkgs = lambda: {k.lower(): v for k, v in micropip.list().items()}
    if action == 'install':
        added, status = [], 0
        for spec in args:
            before = {k: v.version for k, v in pkgs().items()}
            print(f"Collecting {spec}")
            try:
                await micropip.install(spec)
            except BaseException as e:
                print(_cc_pip_error(e, spec))
                status = 1
                continue
            now = pkgs()
            new = [f"{v.name}-{v.version}" for k, v in now.items() if before.get(k) != v.version]
            if new:
                print("Successfully installed " + " ".join(sorted(new)))
            else:
                base = spec.split('=')[0].split('<')[0].split('>')[0].strip().lower()
                v = now.get(base)
                print(f"Requirement already satisfied: {spec}" + (f" ({v.version})" if v else ""))
            added.append(spec)
        return [status, added]
    if action == 'uninstall':
        status = 0
        for name in args:
            v = pkgs().get(name.lower())
            if not v:
                print(f"WARNING: Skipping {name} as it is not installed.")
                continue
            try:
                micropip.uninstall(name)
                print(f"Successfully uninstalled {v.name}-{v.version}")
            except BaseException as e:
                print(f"ERROR: {e}")
                status = 1
        return [status, []]
    if action in ('list', 'freeze'):
        rows = sorted(((v.name, v.version) for v in pkgs().values()), key=lambda r: r[0].lower())
        if action == 'freeze':
            for n, ver in rows:
                print(f"{n}=={ver}")
        else:
            w = max([len('Package')] + [len(n) for n, _ in rows])
            vw = max([len('Version')] + [len(ver) for _, ver in rows])
            print('Package'.ljust(w) + ' ' + 'Version')
            print('-' * w + ' ' + '-' * vw)
            for n, ver in rows:
                print(n.ljust(w) + ' ' + ver)
        return [0, []]
    if action == 'show':
        status = 0
        for name in args:
            v = pkgs().get(name.lower())
            if not v:
                print(f"WARNING: Package(s) not found: {name}")
                status = 1
                continue
            print(f"Name: {v.name}\\nVersion: {v.version}\\nSource: {v.source}")
        return [status, []]
    print(f'ERROR: unknown command "{action}"')
    return [1, []]

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

// Packages named in requirements.txt are installed before the program runs
// (once per Python session), so "pip install" lasts like on a real computer.
const installedReqs = new Set();
async function ensureRequirements(py, reqs = []) {
  const missing = reqs.filter((r) => !installedReqs.has(r));
  if (!missing.length) return;
  out(`\x1b[2mInstalling requirements: ${missing.join(', ')}\x1b[0m\n`);
  try {
    await py.loadPackage('micropip', { messageCallback: () => {}, errorCallback: () => {} });
    const micropip = py.pyimport('micropip');
    for (const r of missing) {
      try {
        await micropip.install(r);
        installedReqs.add(r);
      } catch (e) {
        out(`WARNING: could not install ${r} (${String(e.message || e).split('\n').pop()})\n`);
      }
    }
    micropip.destroy?.();
  } catch (e) {
    out(`WARNING: could not install packages: ${e.message || e}\n`);
  }
}

async function withProject(files, fn, dirs = [], requirements = []) {
  let py;
  try {
    py = await boot();
  } catch (e) {
    out(`Could not start Python: ${e.message}\n`);
    return postMessage({ type: 'done', status: 1, changed: [], deleted: [] });
  }
  try {
    // The last program may have left Python inside a project folder; step out
    // before clearing the project, or removing that folder fails.
    py.FS.chdir('/');
    writeProject(py, files, dirs);
  } catch (e) {
    out(`Could not prepare the files: ${e.message || e.name || e}\n`);
    return postMessage({ type: 'done', status: 1, changed: [], deleted: [] });
  }
  let status = 0;
  try {
    await ensureRequirements(py, requirements);
    const r = await fn(py);
    if (typeof r === 'number') status = r;
  } catch (e) {
    out(String(e.message || e) + '\n');
    status = 1;
  }
  let result = { changed: [], deleted: [] };
  try {
    result = diffProject(py, files);
  } catch {}
  postMessage({ type: 'done', status, ...result });
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
  } else if (data.type === 'run' || data.type === 'code' || data.type === 'repl') {
    // fresh input for each program; piped-in lines arrive right after this message
    lines.length = 0;
    eof = false;
  }
  if (data.type === 'run') {
    await withProject(
      data.files,
      async (py) => {
        const source = new Map(data.files).get(data.entry) ?? '';
        try {
          await py.loadPackagesFromImports(source, { messageCallback: () => {}, errorCallback: () => {} });
        } catch {
          // offline or unknown package: let the import fail with Python's own error
        }
        py.globals.set('_cc_path', `${ROOT}/${data.entry}`);
        py.globals.set('_cc_argv', py.toPy(data.argv || []));
        return py.runPythonAsync('_cc_run(_cc_path, _cc_argv)');
      },
      data.dirs,
      data.requirements,
    );
  } else if (data.type === 'code') {
    await withProject(
      data.files,
      async (py) => {
        try {
          await py.loadPackagesFromImports(data.code, { messageCallback: () => {}, errorCallback: () => {} });
        } catch {}
        py.globals.set('_cc_src', data.code);
        py.globals.set('_cc_argv', py.toPy(data.argv || []));
        py.globals.set('_cc_cwd', data.cwd ? `${ROOT}/${data.cwd}` : ROOT);
        return py.runPythonAsync('_cc_code(_cc_src, _cc_argv, _cc_cwd)');
      },
      data.dirs,
      data.requirements,
    );
  } else if (data.type === 'repl') {
    await withProject(data.files, (py) => py.runPythonAsync('_cc_repl()'), data.dirs, data.requirements);
  } else if (data.type === 'pip') {
    let py;
    try {
      py = await boot();
      await py.loadPackage('micropip', { messageCallback: () => {}, errorCallback: () => {} });
    } catch (e) {
      out(`ERROR: pip isn't available (${e.message || e}). Check the internet connection.\n`);
      return postMessage({ type: 'done', status: 1, changed: [], deleted: [] });
    }
    let status = 1;
    let installed = [];
    try {
      py.globals.set('_cc_action', data.action);
      py.globals.set('_cc_args', py.toPy(data.args || []));
      const r = await py.runPythonAsync('await _cc_pip(_cc_action, _cc_args)');
      [status, installed] = r.toJs();
      r.destroy();
      for (const spec of installed) installedReqs.add(spec);
    } catch (e) {
      out(`ERROR: ${e.message || e}\n`);
    }
    postMessage({ type: 'done', status, changed: [], deleted: [], installed });
  }
};

postMessage({ type: 'booted' });
