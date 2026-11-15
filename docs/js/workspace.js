// The workspace page.
//
// Student: owns the files, runs programs in their own tab, and streams the
//          terminal and edits to the teacher over the live channel.
// Teacher: sees the same terminal and files live, and can type in the terminal.
//
// Live channel "ws:<workspace id>" events:
//   hello            teacher -> student   "send me the current state"
//   snapshot {term, active}  student -> teacher
//   out {d}          student -> teacher   terminal output
//   in {d}           teacher -> student   teacher's keystrokes
//   file {path, content} / unlink {path} / active {path}   student -> teacher
//   bye              student -> teacher   workspace closed
//
// Starter mode (workspace.html?starter=<class id>): the teacher edits the
// class's starter files, which every student gets a copy of when they join.
// No live channel; the terminal runs in the teacher's browser for trying things.

/* global Terminal, FitAddon, monaco, require, marked */

import { backend, demoMode } from './backend.js';
import { IDLE_MINUTES, SCHOOL_NAME } from '../config.js';
import { VFS, entryFor } from './vfs.js';
import { isImage, isDataUrl, imageUrl, readUpload, sizeLabel } from './media.js';
import { makeZip } from './zip.js';

// Per-person settings for this browser (text size, word wrap, panel sizes).
const PREFS_KEY = 'classcode_prefs';
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
};
import { Session, commandFor } from './shell.js';
import { applyBrand } from './brand.js';

applyBrand();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const starterClass = params.get('starter');
const wsId = starterClass ? null : params.get('ws');
const IDLE_MS = IDLE_MINUTES * 60_000;
const SCROLLBACK_BYTES = 60_000;
const STARTER = 'print("Hello from ClassCode!")\n';
const BIG_FILE = 200_000; // characters; bigger files are not sent over the live channel

function overlay(title, msg, button, action) {
  $('overlayTitle').textContent = title;
  $('overlayMsg').textContent = msg;
  $('overlayBtn').textContent = button;
  $('overlayBtn').onclick = action;
  $('overlay').hidden = false;
}

const fatal = (msg) => overlay('Could not open this workspace', msg, 'Try again', () => location.reload());

async function main() {
  const user = await backend.init();
  if (!user || !(wsId || starterClass)) return location.replace('./');

  // Where this page's files are stored.
  let info, store;
  if (starterClass) {
    const roster = await backend.getRoster(starterClass);
    info = { role: 'starter', className: roster.class.name, studentName: 'Starter files' };
    store = {
      list: () => backend.listStarterFiles(starterClass),
      save: (path, content) => backend.saveStarterFile(starterClass, path, content),
      remove: (path) => backend.deleteStarterFile(starterClass, path),
    };
  } else {
    info = await backend.getWorkspace(wsId);
    store = {
      list: () => backend.listFiles(wsId),
      save: (path, content) => backend.saveFile(wsId, path, content),
      remove: (path) => backend.deleteFile(wsId, path),
    };
  }
  const isTeacher = info.role === 'teacher';
  // the terminal prompt shows who is typing, like "alice@SISB ~ %"
  const shellIdentity = {
    user: (user.displayName || 'student').split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'student',
    host: (SCHOOL_NAME || 'classcode').replace(/\s+/g, '-'),
    onOpen: (p) => {
      if (isTeacher) $('follow').checked = false;
      openFile(p);
    },
  };
  const isStarter = info.role === 'starter';

  document.title = `${info.studentName} · ${info.className}`;
  $('who').textContent = `${info.className} · ${info.studentName}`;
  $('teacherBadge').hidden = !isTeacher && !isStarter;
  if (isStarter) {
    $('teacherBadge').textContent = 'Model workspace';
    document.querySelector('#bar a.btn[href="./"]').href = `./#/class/${encodeURIComponent(starterClass)}`;
  }
  $('followWrap').hidden = !isTeacher;

  // ---------------------------------------------------------------- files --
  const vfs = new VFS();
  const stored = await store.list();
  vfs.load(stored);
  if (info.role === 'student' && !stored.length) {
    vfs.files.set('main.py', STARTER);
    store.save('main.py', STARTER).catch(() => {});
  }

  // --------------------------------------------------------------- editor --
  await new Promise((resolve) => {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], resolve);
  });
  const editor = monaco.editor.create($('editor'), {
    model: null,
    theme: 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: prefs.fontSize || 14,
    wordWrap: prefs.wrap ? 'on' : 'off',
    scrollBeyondLastLine: false,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    stickyScroll: { enabled: true },
    renderWhitespace: 'selection',
    tabSize: 4,
    insertSpaces: true,
    smoothScrolling: true,
  });

  const models = new Map();
  let active = null;
  let applyingRemote = false;
  const modelFor = (path) => {
    let m = models.get(path);
    if (!m) {
      m = monaco.editor.createModel(vfs.get(path) ?? '', undefined, monaco.Uri.file('/' + path));
      m.onDidChangeContent(() => {
        if (!applyingRemote) vfs.set(path, m.getValue(), 'editor');
      });
      models.set(path, m);
    }
    return m;
  };

  // ---- editor tabs ----
  const openTabs = [];
  function renderTabs() {
    for (let i = openTabs.length - 1; i >= 0; i--) if (!vfs.has(openTabs[i])) openTabs.splice(i, 1);
    $('tabs').replaceChildren(
      ...openTabs.map((p) => {
        const tab = document.createElement('div');
        tab.className = 'tab' + (p === active ? ' active' : '');
        tab.setAttribute('role', 'tab');
        tab.title = p;
        const name = document.createElement('span');
        name.textContent = p.split('/').pop();
        // show the folder when two open files share a name
        if (openTabs.filter((q) => q.split('/').pop() === name.textContent).length > 1 && p.includes('/')) {
          const dir = document.createElement('span');
          dir.className = 'dir';
          dir.textContent = p.slice(0, p.lastIndexOf('/'));
          name.append(' ', dir);
        }
        const x = document.createElement('button');
        x.className = 'x';
        x.title = 'Close (Ctrl+W)';
        x.textContent = '×';
        x.onclick = (ev) => {
          ev.stopPropagation();
          closeTab(p);
        };
        tab.append(name, x);
        tab.onclick = () => p !== active && openFile(p);
        tab.onauxclick = (ev) => ev.button === 1 && closeTab(p);
        if (p === active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        return tab;
      }),
    );
  }
  function closeTab(path) {
    const i = openTabs.indexOf(path);
    if (i < 0) return;
    openTabs.splice(i, 1);
    if (path === active) openFile(openTabs[Math.min(i, openTabs.length - 1)] ?? null);
    else renderTabs();
  }

  // What Run, rename and delete act on: the open file, or a folder clicked in the tree.
  let selected = null; // { path, dir }
  const collapsed = new Set();

  function select(path, dir) {
    selected = path === null ? null : { path, dir };
    const name = path === null ? '' : path.split('/').pop() + (dir ? '/' : '');
    $('run').textContent = name ? `▶ Run ${name.length > 18 ? name.slice(0, 17) + '…' : name}` : '▶ Run';
    $('run').title = dir ? `Run the folder ${path}/ (its main file) — Ctrl+Enter` : `Run ${path || 'the open file'} — Ctrl+Enter`;
  }

  function openFile(path, { announce = true } = {}) {
    if (path && !vfs.has(path)) path = null;
    active = path;
    select(path, false);
    // make sure the file is visible in the tree
    for (let i = path ? path.indexOf('/') : -1; i > 0; i = path.indexOf('/', i + 1)) collapsed.delete(path.slice(0, i));
    const picture = path && isDataUrl(vfs.get(path));
    editor.setModel(path && !picture ? modelFor(path) : null);
    $('editor').hidden = !!picture || !path;
    $('imageView').hidden = !picture;
    $('emptyState').hidden = !!path;
    if (picture) showImage(path);
    if (path && !openTabs.includes(path)) openTabs.push(path);
    renderTabs();
    updateStatus();
    renderFiles();
    if (announce && !isTeacher) channel.send('active', { path });
    if (!$('preview').hidden && path && /\.(html?|md|markdown)$/i.test(path)) showPreview(path);
  }

  // Uploaded pictures open in a viewer instead of the code editor.
  function showImage(path) {
    const content = vfs.get(path);
    $('imageImg').src = content;
    $('imageImg').alt = path;
    $('imageImg').onload = () =>
      ($('imageInfo').textContent = `${path} · ${$('imageImg').naturalWidth} × ${$('imageImg').naturalHeight} px · ${sizeLabel(content.length)}. Use it in a web page with <img src="${path.split('/').pop()}">.`);
  }

  function renderFiles() {
    if (selected?.dir && !vfs.isDir(selected.path)) select(active, false);
    const rows = [];
    const walk = (dir, depth) => {
      for (const e of vfs.list(dir)) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        const li = document.createElement('li');
        li.title = p;
        li.style.paddingLeft = 8 + depth * 14 + 'px';
        const chev = document.createElement('span');
        chev.className = 'chev';
        const label = document.createElement('span');
        label.textContent = e.name;
        li.append(chev, label);
        if (e.dir) {
          const open = !collapsed.has(p);
          li.className = 'folder' + (selected?.dir && selected.path === p ? ' active' : '');
          chev.textContent = open ? '▾' : '▸';
          chev.onclick = (ev) => {
            ev.stopPropagation();
            open ? collapsed.add(p) : collapsed.delete(p);
            renderFiles();
          };
          li.onclick = () => {
            if (selected?.dir && selected.path === p) open ? collapsed.add(p) : collapsed.delete(p);
            else collapsed.delete(p);
            select(p, true);
            renderFiles();
          };
          rows.push(li);
          if (open) walk(p, depth + 1);
        } else {
          if (!selected?.dir && p === active) li.className = 'active';
          li.onclick = () => {
            if (isTeacher) $('follow').checked = false;
            openFile(p);
          };
          rows.push(li);
        }
      }
    };
    walk('', 0);
    $('files').replaceChildren(...rows);
  }

  // Keep editor models, the file list, storage and the teacher in step with the files.
  const saveTimers = new Map();
  const sendTimers = new Map();
  let pendingSaves = 0;
  const showSaved = () => {
    $('saved').className = '';
    $('saved').textContent = pendingSaves ? 'Saving…' : '✓ All changes saved';
  };

  // Apply someone else's version of a file while keeping this person's cursor:
  // replace only the changed middle part instead of the whole text.
  function applyRemote(model, content) {
    const old = model.getValue();
    let start = 0;
    while (start < old.length && start < content.length && old[start] === content[start]) start++;
    let endOld = old.length;
    let endNew = content.length;
    while (endOld > start && endNew > start && old[endOld - 1] === content[endNew - 1]) endOld--, endNew--;
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(endOld);
    applyingRemote = true;
    model.pushEditOperations(
      [],
      [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: content.slice(start, endNew) }],
      () => null,
    );
    applyingRemote = false;
  }
  const later = (timers, key, ms, fn) => {
    clearTimeout(timers.get(key)?.id);
    const entry = { fn, id: setTimeout(() => (timers.delete(key), fn()), ms) };
    timers.set(key, entry);
  };
  // Ctrl+S: send and save everything waiting, right now.
  const flushAll = () => {
    for (const timers of [sendTimers, saveTimers]) {
      for (const [key, entry] of [...timers]) {
        clearTimeout(entry.id);
        timers.delete(key);
        entry.fn();
      }
    }
  };

  vfs.onChange((path, content, source) => {
    if (path.endsWith('/') && content === null) collapsed.delete(path.slice(0, -1));
    const model = models.get(path);
    if (content === null) {
      model?.dispose();
      models.delete(path);
      if (active === path) openFile(vfs.paths()[0] || null);
    } else if (model && source !== 'editor' && model.getValue() !== content) {
      applyRemote(model, content);
    }
    if (content !== null && path === active && isDataUrl(content) === $('imageView').hidden) openFile(path, { announce: false });
    else if (content !== null && path === active && isDataUrl(content)) showImage(path);
    renderFiles();
    if (content === null && openTabs.includes(path)) renderTabs();
    if (!$('preview').hidden) later(sendTimers, '\0preview', 400, () => showPreview(previewPath));
    // Changes that came from the other person are already saved and shared by them.
    if (source === 'remote') return;

    // Live messages have a size limit, so big files (pictures) are announced
    // once saved, and the other side loads them from storage.
    const big = content !== null && content.length > BIG_FILE;
    if (!big) {
      later(sendTimers, path, 200, () =>
        content === null ? channel.send('unlink', { path }) : channel.send('file', { path, content: vfs.get(path) ?? '' }),
      );
    }
    if (!saveTimers.has(path)) pendingSaves++;
    showSaved();
    later(saveTimers, path, 700, async () => {
      try {
        const exists = path.endsWith('/') ? vfs.dirs.has(path.slice(0, -1)) : vfs.has(path);
        if (exists) await store.save(path, vfs.get(path) ?? '');
        else await store.remove(path);
        if (exists && (vfs.get(path) ?? '').length > BIG_FILE) channel.send('refetch', { path });
      } catch (e) {
        $('saved').textContent = `Not saved: ${e.message}`;
        $('saved').className = 'error';
        pendingSaves--;
        return;
      }
      pendingSaves--;
      showSaved();
    });
  });

  // -------------------------------------------------------------- preview --
  let previewPath = null;
  function showPreview(path) {
    path ||= (active && /\.(html?|md|markdown)$/i.test(active) && active) || vfs.paths().find((p) => /\.html?$/i.test(p));
    $('preview').hidden = false;
    fit();
    if (!path || !vfs.has(path)) {
      previewPath = null;
      $('previewName').textContent = 'Preview';
      $('previewFrame').srcdoc = '<body style="font:15px system-ui;color:#667;padding:24px">Create an .html file to see it here.</body>';
      return;
    }
    previewPath = path;
    $('previewName').textContent = `Preview · ${path}`;
    if (isImage(path)) {
      const url = imageUrl(path, vfs.get(path));
      $('previewFrame').srcdoc = `<!doctype html><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#eef1f6"><img src="${url}" style="max-width:100%;max-height:100vh">`;
      return;
    }
    if (/\.(md|markdown)$/i.test(path)) {
      // Markdown: formatted in the same sandboxed frame (no access to this site).
      const mdDoc = new DOMParser().parseFromString(marked.parse(vfs.get(path)), 'text/html');
      inlineImages(mdDoc, path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
      const html = mdDoc.body.innerHTML;
      $('previewFrame').srcdoc =
        '<!doctype html><meta charset="utf-8"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:24px auto;padding:0 20px;color:#1c2333}' +
        'pre{background:#f4f6fb;padding:12px;border-radius:6px;overflow:auto}code{font:14px ui-monospace,Menlo,Consolas,monospace;background:#f4f6fb;padding:1px 4px;border-radius:4px}' +
        'pre code{padding:0}table{border-collapse:collapse}td,th{border:1px solid #dde2ee;padding:4px 10px}img{max-width:100%}blockquote{border-left:4px solid #dde2ee;margin:0;padding-left:14px;color:#667089}</style>' +
        html;
      return;
    }
    // Inline the page's own CSS/JS files so it can run in a sandboxed frame with no access to this site.
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const local = (ref) => {
      if (!ref || /^([a-z]+:|\/\/|#)/i.test(ref)) return null;
      const p = (ref.startsWith('/') ? ref.slice(1) : dir + ref).split(/[?#]/)[0].replace(/^\.\//, '');
      return vfs.has(p) ? vfs.get(p) : null;
    };
    const doc = new DOMParser().parseFromString(vfs.get(path), 'text/html');
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const css = local(link.getAttribute('href'));
      if (css !== null) {
        const style = doc.createElement('style');
        const cssPath = resolve(link.getAttribute('href'), dir) || '';
        style.dataset.ccDir = cssPath.includes('/') ? cssPath.slice(0, cssPath.lastIndexOf('/') + 1) : '';
        style.textContent = css;
        link.replaceWith(style);
      }
    }
    for (const script of doc.querySelectorAll('script[src]')) {
      const js = local(script.getAttribute('src'));
      if (js !== null) {
        script.removeAttribute('src');
        script.textContent = js;
      }
    }
    inlineImages(doc, dir);
    $('previewFrame').srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
  }

  // ---- images inside the preview ----
  // The preview is a sealed frame that can't reach workspace files by URL, so
  // pictures are put straight into the page: <img src>, CSS url(...), and images
  // a script loads (new Image(), img.src = 'player.png') all find them.
  const resolve = (ref, baseDir) => {
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
    const parts = (ref.startsWith('/') ? ref.slice(1) : baseDir + ref).split(/[?#]/)[0].split('/');
    const out = [];
    for (const seg of parts) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    try {
      return decodeURIComponent(out.join('/'));
    } catch {
      return out.join('/');
    }
  };
  const imageFor = (ref, baseDir) => {
    const p = resolve(ref, baseDir);
    return p && vfs.has(p) ? imageUrl(p, vfs.get(p)) : null;
  };
  const rewriteCss = (css, baseDir) =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
      const url = imageFor(ref.trim(), baseDir);
      return url ? `url("${url}")` : m;
    });

  function inlineImages(doc, dir) {
    for (const el of doc.querySelectorAll('img[src], source[src], input[type=image][src], video[poster], link[rel~=icon][href]')) {
      const attr = el.hasAttribute('poster') ? 'poster' : el.tagName === 'LINK' ? 'href' : 'src';
      const url = imageFor(el.getAttribute(attr), dir);
      if (url) el.setAttribute(attr, url);
    }
    for (const el of doc.querySelectorAll('[srcset]')) {
      el.setAttribute(
        'srcset',
        el
          .getAttribute('srcset')
          .split(',')
          .map((part) => {
            const [ref, ...rest] = part.trim().split(/\s+/);
            return [imageFor(ref, dir) || ref, ...rest].join(' ');
          })
          .join(', '),
      );
    }
    for (const el of doc.querySelectorAll('[background]')) {
      const url = imageFor(el.getAttribute('background'), dir);
      if (url) el.setAttribute('background', url);
    }
    for (const style of doc.querySelectorAll('style')) style.textContent = rewriteCss(style.textContent, style.dataset.ccDir ?? dir);
    for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', rewriteCss(el.getAttribute('style'), dir));
    // Images a script loads by name: give the page a table of workspace pictures.
    const pictures = {};
    let total = 0;
    for (const p of vfs.paths()) {
      if (!isImage(p) || total > 8_000_000) continue;
      const url = imageUrl(p, vfs.get(p));
      if (!url) continue;
      pictures[p] = url;
      total += url.length;
    }
    if (Object.keys(pictures).length && doc.querySelector('script')) {
      const patch = doc.createElement('script');
      patch.textContent = `(() => {
  const PICS = ${JSON.stringify(pictures).replace(/</g, '\\u003c')}, DIR = ${JSON.stringify(dir)};
  const find = (v) => {
    if (typeof v !== 'string' || /^([a-z][a-z0-9+.-]*:|\\/\\/)/i.test(v)) return v;
    const out = [];
    for (const s of (v.startsWith('/') ? v.slice(1) : DIR + v).split(/[?#]/)[0].split('/')) s === '..' ? out.pop() : s && s !== '.' && out.push(s);
    return PICS[out.join('/')] || v;
  };
  for (const C of [HTMLImageElement, HTMLSourceElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, 'src');
    Object.defineProperty(C.prototype, 'src', { get() { return d.get.call(this); }, set(v) { d.set.call(this, find(v)); }, configurable: true });
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) { return setAttr.call(this, n, /^(src|href|poster)$/i.test(n) ? find(v) : v); };
})();`;
      doc.head.prepend(patch);
    }
  }
  $('previewBtn').onclick = () => ($('preview').hidden ? showPreview() : (($('preview').hidden = true), fit()));
  $('previewClose').onclick = () => (($('preview').hidden = true), fit());

  // ------------------------------------------------------------- terminal --
  const term = new Terminal({
    fontSize: prefs.fontSize || 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: 5000,
    // light terminal, colours like VS Code's light theme
    theme: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#1f2328',
      selectionBackground: '#add6ff',
      black: '#1f2328',
      red: '#cd3131',
      green: '#107c10',
      yellow: '#949800',
      blue: '#0451a5',
      magenta: '#bc05bc',
      cyan: '#0598bc',
      white: '#555555',
      brightBlack: '#6e7781',
      brightRed: '#cd3131',
      brightGreen: '#14ce14',
      brightYellow: '#b5ba00',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#a5a5a5',
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('terminal'));
  const fit = () => {
    try {
      fitAddon.fit();
    } catch {}
  };
  fit();
  new ResizeObserver(fit).observe($('terminal'));

  const noChannel = { ready: Promise.resolve(), on() {}, send() {}, track() {}, untrack() {}, onPresence() {}, close() {} };
  const channel = isStarter ? noChannel : backend.channel(`ws:${wsId}`);
  const classChannel = isStarter ? noChannel : backend.channel(`class:${info.classId}`);
  try {
    await Promise.all([channel.ready, classChannel.ready]);
  } catch (e) {
    $('termnote').textContent = 'Live connection unavailable';
    console.error(e);
  }

  // Run a file or folder in `session` (or show it, for web pages). A folder runs
  // its main file: main.py, __main__.py, app.py, index.html, main.js or index.js.
  const runPath = (session, path, isDir) => {
    if (!session || path == null) return;
    let file = path;
    if (isDir) {
      file = entryFor(vfs, path);
      if (!file) {
        session.print(`\r\nThe folder ${path}/ has nothing to run. Add a main.py, index.html or main.js to it.\r\n`);
        return;
      }
    }
    const how = commandFor(file);
    if (how instanceof Error) session.print(`\r\n${how.message}\r\n`);
    else if (how === 'preview') showPreview(/\.css$/i.test(file) ? undefined : file);
    // paths are relative to the terminal's folder, so use the full path if it has moved
    else session.runCommand(`${how} ${quote(session.cwd ? '/' + file : file)}`);
  };
  // TypeScript -> JavaScript with the editor's built-in compiler.
  async function compileTs(path) {
    const ts = monaco.typescript || monaco.languages.typescript;
    const model = modelFor(path);
    const getWorker = await ts.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    const output = await worker.getEmitOutput(model.uri.toString());
    const js = output.outputFiles.find((f) => /\.js$/.test(f.name));
    if (!js) throw new Error('no JavaScript was produced');
    return js.text;
  }
  const runTarget = () => (selected ? { path: selected.path, dir: selected.dir } : { path: active, dir: false });
  setupWorkbench();
  const runActive = (session) => {
    const t = runTarget();
    runPath(session, t.path, t.dir);
  };
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => $('run').click());

  // A path from a person or the other side. A trailing "/" (a folder) is allowed.
  const badName = (path) =>
    !path ||
    path.length > 200 ||
    /[\x00-\x1f\\]/.test(path) ||
    path.replace(/\/$/, '').split('/').some((x) => !x || x === '.' || x === '..');
  const clean = (name) => name.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  // New things go in the selected folder, or next to the open file.
  const baseDir = () => (selected?.dir ? selected.path : active?.includes('/') ? active.slice(0, active.lastIndexOf('/')) : '');
  const taken = (path) => vfs.has(path) || vfs.isDir(path);

  $('newFile').onclick = () => {
    const base = baseDir();
    const name = prompt('New file name (for example game.py, app.js or index.html):', base ? base + '/' : '');
    if (!name) return;
    const path = clean(name);
    if (badName(path) || path === base) return alert('That file name is not allowed.');
    if (vfs.isDir(path)) return alert('A folder with that name already exists.');
    if (!vfs.has(path)) vfs.set(path, '');
    openFile(path);
    editor.focus();
  };
  $('newFolder').onclick = () => {
    const base = baseDir();
    const name = prompt('New folder name:', base ? base + '/' : '');
    if (!name) return;
    const path = clean(name);
    if (badName(path) || path === base) return alert('That folder name is not allowed.');
    if (taken(path)) return alert('Something with that name already exists.');
    vfs.mkdir(path);
    select(path, true);
    renderFiles();
  };
  $('renameFile').onclick = () => {
    const target = selected?.dir ? selected : active ? { path: active, dir: false } : null;
    if (!target) return;
    const path = clean(prompt(`Rename ${target.dir ? 'folder' : 'file'} to:`, target.path) || '');
    if (!path || path === target.path) return;
    if (badName(path)) return alert('That name is not allowed.');
    if (taken(path)) return alert('Something with that name already exists.');
    if (target.dir) {
      if (path.startsWith(target.path + '/')) return alert('A folder cannot be moved into itself.');
      const reopen = active?.startsWith(target.path + '/') ? path + active.slice(target.path.length) : null;
      vfs.renameDir(target.path, path);
      if (reopen) openFile(reopen);
      select(path, true);
      renderFiles();
    } else {
      vfs.set(path, vfs.get(target.path));
      openFile(path);
      vfs.delete(target.path);
    }
  };
  $('deleteFile').onclick = () => {
    if (selected?.dir) {
      const n = vfs.paths().filter((p) => p.startsWith(selected.path + '/')).length;
      if (!confirm(`Delete the folder ${selected.path}/${n ? ` and the ${n} file${n === 1 ? '' : 's'} in it` : ''}?`)) return;
      vfs.rmdir(selected.path);
      select(active, false);
      renderFiles();
    } else if (active && confirm(`Delete ${active}?`)) vfs.delete(active);
  };

  // ------------------------------------------------------------ workbench --
  // Status bar, text size, word wrap, format, resizable panels, search,
  // quick open, keyboard shortcuts, terminal buttons, download as .zip.
  function setupWorkbench() {
    // text size: editor and terminal together
    const setFont = (size) => {
      size = Math.max(10, Math.min(28, size));
      prefs.fontSize = size;
      savePrefs();
      editor.updateOptions({ fontSize: size });
      term.options.fontSize = size;
      $('fontSize').textContent = size + 'px';
      fit();
    };
    $('fontSize').textContent = (prefs.fontSize || 14) + 'px';
    $('fontUp').onclick = () => setFont((prefs.fontSize || 14) + 1);
    $('fontDown').onclick = () => setFont((prefs.fontSize || 14) - 1);

    const setWrap = (on) => {
      prefs.wrap = on;
      savePrefs();
      editor.updateOptions({ wordWrap: on ? 'on' : 'off' });
      $('wrapBtn').textContent = `Wrap: ${on ? 'on' : 'off'}`;
    };
    setWrap(!!prefs.wrap);
    $('wrapBtn').onclick = () => setWrap(!prefs.wrap);
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => setWrap(!prefs.wrap));

    $('formatBtn').onclick = async () => {
      const action = editor.getModel() && editor.getAction('editor.action.formatDocument');
      if (!action?.isSupported()) {
        $('saved').textContent = 'Format works for JavaScript, TypeScript, HTML, CSS and JSON';
        return;
      }
      await action.run();
      editor.focus();
    };

    editor.onDidChangeCursorPosition(updateStatus);
    editor.onDidChangeModel(updateStatus);

    // terminal buttons work in every mode: they act like pressing the keys
    $('termStop').onclick = () => {
      term.input('\x03');
      term.focus();
    };
    $('termClear').onclick = () => {
      term.clear();
      term.focus();
    };

    // ---- resizable panels ----
    const root = document.documentElement.style;
    const sizes = prefs.sizes || {};
    const applySizes = () => {
      if (sizes.side) root.setProperty('--side-w', sizes.side + 'px');
      if (sizes.terminal) root.setProperty('--term-h', sizes.terminal + 'px');
      if (sizes.preview) root.setProperty('--preview-w', sizes.preview + 'px');
    };
    applySizes();
    for (const g of document.querySelectorAll('[data-resize]')) {
      g.addEventListener('pointerdown', (down) => {
        down.preventDefault();
        const which = g.dataset.resize;
        const start = { x: down.clientX, y: down.clientY };
        const from = {
          side: $('side').offsetWidth,
          terminal: $('terminal').offsetHeight,
          preview: $('preview').offsetWidth,
        }[which];
        g.classList.add('dragging');
        document.body.classList.add('resizing');
        g.setPointerCapture(down.pointerId);
        const move = (ev) => {
          const dx = ev.clientX - start.x;
          const dy = ev.clientY - start.y;
          if (which === 'side') sizes.side = Math.max(120, Math.min(innerWidth * 0.5, from + dx));
          if (which === 'terminal') sizes.terminal = Math.max(60, Math.min(innerHeight - 200, from - dy));
          if (which === 'preview') sizes.preview = Math.max(200, Math.min(innerWidth * 0.75, from - dx));
          applySizes();
          fit();
        };
        const up = () => {
          g.classList.remove('dragging');
          document.body.classList.remove('resizing');
          g.removeEventListener('pointermove', move);
          prefs.sizes = sizes;
          savePrefs();
        };
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerup', up, { once: true });
      });
    }
    // the preview's handle shows with the preview
    new MutationObserver(() => ($('previewGutter').hidden = $('preview').hidden)).observe($('preview'), { attributes: true, attributeFilter: ['hidden'] });

    // ---- sidebar: files / search ----
    const showView = (view) => {
      $('filesView').hidden = view !== 'files';
      $('searchView').hidden = view !== 'search';
      $('viewFiles').classList.toggle('active', view === 'files');
      $('viewSearch').classList.toggle('active', view === 'search');
      if (view === 'search') {
        $('searchInput').focus();
        $('searchInput').select();
        runSearch();
      }
    };
    $('viewFiles').onclick = () => showView('files');
    $('viewSearch').onclick = () => showView('search');

    let searchTimer = null;
    function runSearch() {
      const q = $('searchInput').value;
      const matchCase = $('searchCase').checked;
      const list = $('searchResults');
      if (!q) {
        list.replaceChildren();
        $('searchSummary').textContent = 'Type to search every file in this workspace.';
        return;
      }
      const needle = matchCase ? q : q.toLowerCase();
      let hits = 0;
      let files = 0;
      const rows = [];
      for (const path of vfs.paths()) {
        const text = vfs.get(path);
        if (isDataUrl(text)) continue;
        const lines = text.split('\n');
        const found = [];
        lines.forEach((line, i) => {
          const at = (matchCase ? line : line.toLowerCase()).indexOf(needle);
          if (at >= 0 && hits < 500) found.push({ line, n: i + 1, at }), hits++;
        });
        if (!found.length) continue;
        files++;
        const head = document.createElement('li');
        head.className = 'file';
        head.textContent = `${path} (${found.length})`;
        rows.push(head);
        for (const f of found) {
          const li = document.createElement('li');
          li.className = 'hit';
          const ln = document.createElement('span');
          ln.className = 'ln';
          ln.textContent = f.n;
          const startAt = Math.max(0, f.at - 20);
          const mark = document.createElement('mark');
          mark.textContent = f.line.slice(f.at, f.at + q.length);
          li.append(ln, (startAt ? '…' : '') + f.line.slice(startAt, f.at).trimStart(), mark, f.line.slice(f.at + q.length, f.at + q.length + 80));
          li.title = `${path}:${f.n}`;
          li.onclick = () => {
            if (isTeacher) $('follow').checked = false;
            openFile(path);
            editor.setSelection(new monaco.Range(f.n, f.at + 1, f.n, f.at + 1 + q.length));
            editor.revealLineInCenter(f.n);
            editor.focus();
          };
          rows.push(li);
        }
      }
      list.replaceChildren(...rows);
      $('searchSummary').textContent = hits ? `${hits}${hits >= 500 ? '+' : ''} result${hits === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}` : 'No results.';
    }
    $('searchInput').oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 150);
    };
    $('searchCase').onchange = runSearch;
    vfs.onChange(() => {
      if (!$('searchView').hidden && $('searchInput').value) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 500);
      }
    });

    // ---- quick open (Ctrl+P) ----
    let picks = [];
    let pick = 0;
    const score = (path, q) => {
      // every typed letter must appear in order; earlier and in the file name scores higher
      const p = path.toLowerCase();
      let i = 0;
      let s = 0;
      for (const ch of q.toLowerCase()) {
        const j = p.indexOf(ch, i);
        if (j < 0) return -1;
        s += j - i;
        i = j + 1;
      }
      return s + (p.split('/').pop().includes(q.toLowerCase()) ? 0 : 50) + path.length / 100;
    };
    const drawPalette = () => {
      const q = $('paletteInput').value.trim();
      picks = vfs
        .paths()
        .map((p) => [p, q ? score(p, q) : 0])
        .filter(([, sc]) => sc >= 0)
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(0, 50)
        .map(([p]) => p);
      pick = Math.min(pick, Math.max(0, picks.length - 1));
      $('paletteList').replaceChildren(
        ...(picks.length
          ? picks.map((p, i) => {
              const li = document.createElement('li');
              li.className = i === pick ? 'on' : '';
              const name = document.createElement('span');
              name.textContent = p.split('/').pop();
              const dir = document.createElement('span');
              dir.className = 'dir';
              dir.textContent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
              li.append(name, dir);
              li.onmousedown = (ev) => {
                ev.preventDefault();
                choose(p);
              };
              return li;
            })
          : [Object.assign(document.createElement('li'), { className: 'none', textContent: 'No matching files' })]),
      );
      $('paletteList').children[pick]?.scrollIntoView({ block: 'nearest' });
    };
    const closePalette = () => {
      $('palette').hidden = true;
      editor.focus();
    };
    const choose = (p) => {
      $('palette').hidden = true;
      if (isTeacher) $('follow').checked = false;
      openFile(p);
      editor.focus();
    };
    const openPalette = () => {
      $('palette').hidden = false;
      $('paletteInput').value = '';
      pick = 0;
      drawPalette();
      $('paletteInput').focus();
    };
    $('paletteInput').oninput = () => {
      pick = 0;
      drawPalette();
    };
    $('paletteInput').onkeydown = (ev) => {
      if (ev.key === 'ArrowDown') pick = Math.min(pick + 1, picks.length - 1);
      else if (ev.key === 'ArrowUp') pick = Math.max(pick - 1, 0);
      else if (ev.key === 'Enter') return picks[pick] && choose(picks[pick]);
      else if (ev.key === 'Escape') return closePalette();
      else return;
      ev.preventDefault();
      drawPalette();
    };
    $('palette').onmousedown = (ev) => ev.target === $('palette') && closePalette();

    // ---- shortcuts help ----
    $('helpBtn').onclick = () => ($('help').hidden = false);
    $('helpClose').onclick = () => ($('help').hidden = true);
    $('help').onmousedown = (ev) => ev.target === $('help') && ($('help').hidden = true);

    // ---- download the workspace as a .zip ----
    $('downloadZip').onclick = () => {
      const enc = new TextEncoder();
      const entries = [];
      for (const d of vfs.allDirs()) entries.push({ name: d + '/', data: new Uint8Array() });
      for (const [path, content] of vfs.entries()) {
        let data;
        if (isDataUrl(content)) {
          const bin = atob(content.slice(content.indexOf(',') + 1));
          data = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        } else data = enc.encode(content);
        entries.push({ name: path, data });
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(makeZip(entries));
      a.download = `${info.className}-${info.studentName}`.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') + '.zip';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };

    // ---- keyboard shortcuts (before the browser's own: Ctrl+S, Ctrl+P, ...) ----
    window.addEventListener(
      'keydown',
      (ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        if (!mod && !(ev.altKey && ev.key.toLowerCase() === 'w')) {
          if (ev.key === 'Escape' && !$('help').hidden) $('help').hidden = true;
          return;
        }
        const k = ev.key.toLowerCase();
        let handled = true;
        if (k === 's' && !ev.shiftKey) {
          flushAll();
          showSaved();
        } else if (k === 'p' && !ev.shiftKey) openPalette();
        else if (k === 'f' && ev.shiftKey) showView('search');
        else if (k === 'e' && ev.shiftKey) showView('files');
        else if (k === '`' || ev.code === 'Backquote') {
          if (document.activeElement?.closest('#terminal')) editor.focus();
          else term.focus();
        } else if ((k === 'w' && mod && !ev.shiftKey) || (k === 'w' && ev.altKey)) {
          if (active) closeTab(active);
        } else if (k === '=' || k === '+') setFont((prefs.fontSize || 14) + 1);
        else if (k === '-') setFont((prefs.fontSize || 14) - 1);
        else handled = false;
        if (handled) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      { capture: true },
    );
  }

  function updateStatus() {
    const model = editor.getModel();
    if (!model || $('editor').hidden) {
      $('cursorPos').textContent = '';
      $('langName').textContent = active && isImage(active) ? 'Picture' : '';
      return;
    }
    const pos = editor.getPosition();
    $('cursorPos').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : '';
    const id = model.getLanguageId();
    const lang = monaco.languages.getLanguages().find((l) => l.id === id);
    $('langName').textContent = id === 'plaintext' ? 'Plain text' : lang?.aliases?.[0] || id;
  }

  // Upload images and files: button, or drag them onto the file list.
  async function addUploads(fileList) {
    const base = baseDir();
    const problems = [];
    let last = null;
    for (const file of fileList) {
      const path = (base ? base + '/' : '') + file.name.replace(/[\\/]/g, '_');
      if (badName(path)) {
        problems.push(`${file.name}: that name is not allowed`);
        continue;
      }
      if (vfs.isDir(path) && !vfs.has(path)) {
        problems.push(`${file.name}: a folder has that name`);
        continue;
      }
      if (vfs.has(path) && !confirm(`${path} already exists. Replace it?`)) continue;
      try {
        const { content } = await readUpload(file);
        vfs.set(path, content);
        if (!last || (isImage(path) && !isImage(last))) last = path; // show the first picture
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (last) openFile(last);
    if (problems.length) alert(problems.join('\n'));
  }
  $('upload').onclick = () => $('uploadInput').click();
  $('uploadInput').onchange = async () => {
    await addUploads([...$('uploadInput').files]);
    $('uploadInput').value = '';
  };
  $('side').addEventListener('dragover', (ev) => {
    if (![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();
    $('side').classList.add('dropping');
  });
  $('side').addEventListener('dragleave', () => $('side').classList.remove('dropping'));
  $('side').addEventListener('drop', (ev) => {
    ev.preventDefault();
    $('side').classList.remove('dropping');
    if (ev.dataTransfer.files.length) addUploads([...ev.dataTransfer.files]);
  });

  // Edits arriving from the other person (student <-> teacher).
  channel.on('file', ({ path, content }) => {
    if (typeof path !== 'string' || badName(path)) return;
    vfs.set(path, String(content ?? ''), 'remote');
    if (!active) openFile(path, { announce: false });
  });
  channel.on('unlink', ({ path }) => vfs.delete(String(path), 'remote'));
  channel.on('refetch', async ({ path }) => {
    if (typeof path !== 'string' || badName(path)) return;
    try {
      const f = (await store.list()).find((x) => x.path === path);
      if (f) vfs.set(path, f.content, 'remote');
    } catch {}
  });

  if (isStarter) starterMode();
  else if (isTeacher) teacherMode();
  else studentMode();
  openFile(vfs.has('main.py') ? 'main.py' : vfs.paths()[0] || null, { announce: false });

  // -------------------------------------------------------------- student --
  function studentMode() {
    let scrollback = '';
    let outBuf = '';
    let flushTimer = null;
    let closed = false;
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
      window.addEventListener(ev, touch, { capture: true, passive: true });
    }

    const write = (data) => {
      term.write(data);
      scrollback = (scrollback + data).slice(-SCROLLBACK_BYTES);
      outBuf += data;
      flushTimer ||= setTimeout(() => {
        flushTimer = null;
        // keep each live message comfortably small
        for (let i = 0; i < outBuf.length; i += 30_000) channel.send('out', { d: outBuf.slice(i, i + 30_000) });
        outBuf = '';
      }, 60);
    };

    const session = new Session({ write, vfs, onPreview: showPreview, compileTs, ...shellIdentity });
    term.onData((d) => session.input(d));
    // The snapshot already holds everything written so far, so drop output still waiting to be sent.
    const snapshot = () => {
      clearTimeout(flushTimer);
      flushTimer = null;
      outBuf = '';
      channel.send('snapshot', { term: scrollback, active });
    };

    channel.on('hello', snapshot);
    channel.on('in', ({ d }) => {
      if (closed || typeof d !== 'string') return;
      touch(); // the teacher working here counts as activity
      session.input(d);
    });
    classChannel.track({ workspaceId: wsId });

    $('run').onclick = () => {
      runActive(session);
      term.focus();
    };
    // The teacher pressed Run: run it here, where the student's terminal lives.
    channel.on('run', ({ path, dir }) => {
      if (closed || typeof path !== 'string' || !(dir ? vfs.isDir(path) : vfs.has(path))) return;
      touch();
      runPath(session, path, !!dir);
    });
    channel.on('file', ({ path, content }) => {
      if (typeof path !== 'string' || badName(path)) return;
      touch();
      vfs.set(path, String(content ?? ''), 'remote');
    });

    function close() {
      if (closed) return;
      closed = true;
      session.dispose();
      channel.send('bye', {});
      classChannel.untrack();
      editor.updateOptions({ readOnly: true });
      $('idle').textContent = '';
      overlay(
        'This workspace has closed',
        `Workspaces close after ${IDLE_MINUTES} minutes without activity. Your files are saved — reopen it to keep working.`,
        'Reopen workspace',
        () => location.reload(),
      );
    }

    setInterval(() => {
      if (closed) return;
      const left = IDLE_MS - (Date.now() - lastActivity);
      if (left <= 0) return close();
      const el = $('idle');
      el.classList.toggle('warn', left < 5 * 60_000);
      el.textContent = left < 5 * 60_000 ? `Closing in ${Math.ceil(left / 60_000)} min — press a key or move the mouse to stay` : '';
    }, 5000);

    window.addEventListener('pagehide', () => {
      if (!closed) channel.send('bye', {});
    });

    session.start();
    snapshot();
    term.focus();
  }

  // -------------------------------------------------------------- starter --
  function starterMode() {
    const session = new Session({ write: (d) => term.write(d), vfs, onPreview: showPreview, compileTs, ...shellIdentity });
    term.onData((d) => session.input(d));
    $('run').onclick = () => {
      runActive(session);
      term.focus();
    };
    $('termnote').textContent = 'Try your starter code here. Students don\u2019t see this terminal.';
    session.start();
  }

  // -------------------------------------------------------------- teacher --
  // Teachers and admins. When the student has the workspace open, the
  // terminal is the student's (live, both can type). When the student is not
  // there, the terminal runs in the teacher's own browser so they can still
  // run the code. Either way the teacher can edit files.
  function teacherMode() {
    const live = $('live');
    live.hidden = false;
    let online = false;
    let local = null; // the teacher's own terminal session while the student is away
    let localTimer = null;

    const setOnline = (on) => {
      online = on;
      live.className = on ? 'pill on' : 'pill';
      live.textContent = on ? 'Live' : 'Student not here';
      $('termnote').textContent = on
        ? 'You are in the student\u2019s terminal'
        : 'The student does not have this workspace open. This terminal runs in your browser.';
    };
    const startLocal = () => {
      clearTimeout(localTimer);
      if (local || online) return;
      term.reset();
      local = new Session({ write: (d) => term.write(d), vfs, onPreview: showPreview, compileTs, ...shellIdentity });
      local.start();
    };
    const stopLocal = () => {
      clearTimeout(localTimer);
      local?.dispose();
      local = null;
    };

    setOnline(false);
    $('termnote').textContent = 'Connecting to the student\u2019s workspace...';
    term.write('\x1b[2mLooking for the student...\x1b[0m\r\n');
    localTimer = setTimeout(startLocal, 3000); // no answer: the student is not here

    const follow = (path) => {
      if ($('follow').checked && path && vfs.has(path)) openFile(path, { announce: false });
    };
    let studentActive = null;
    $('follow').onchange = () => follow(studentActive);

    channel.on('snapshot', async ({ term: text, active: path }) => {
      stopLocal();
      setOnline(true);
      term.reset();
      term.write(String(text || ''));
      // the student may have changed files while we were not listening
      try {
        const fresh = await store.list();
        const seen = new Set(fresh.map((f) => f.path));
        for (const f of fresh) vfs.set(f.path, f.content, 'remote');
        for (const p of vfs.paths()) if (!seen.has(p)) vfs.delete(p, 'remote');
        for (const d of [...vfs.dirs]) if (!seen.has(d + '/')) vfs.delete(d + '/', 'remote');
      } catch {}
      studentActive = path;
      follow(path);
      if (!active) openFile(vfs.paths()[0] || null, { announce: false });
    });
    channel.on('out', ({ d }) => {
      if (online) term.write(String(d));
      else channel.send('hello', {}); // the student is back: ask for the full picture
    });
    channel.on('active', ({ path }) => {
      studentActive = path;
      follow(path);
    });
    const wentAway = () => {
      if (!online) return;
      setOnline(false);
      term.write('\r\n\x1b[2m[the student closed the workspace]\x1b[0m\r\n');
      localTimer = setTimeout(startLocal, 1500);
    };
    channel.on('bye', wentAway);
    // Closing the tab does not always get a goodbye out; presence catches that.
    classChannel.onPresence((states) => {
      if (!states.some((s) => s.workspaceId === wsId)) wentAway();
    });

    term.onData((d) => {
      if (online) channel.send('in', { d });
      else local?.input(d);
    });
    $('run').onclick = () => {
      if (online) channel.send('run', runTarget());
      else runActive(local);
      term.focus();
    };
    channel.send('hello', {});
  }
}

const quote = (p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p);

if (demoMode) document.body.classList.add('demo');
main().catch((e) => {
  console.error(e);
  fatal(e.message || String(e));
});
