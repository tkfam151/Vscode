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

/* global Terminal, FitAddon, monaco, require */

import { backend, demoMode } from './backend.js';
import { IDLE_MINUTES } from '../config.js';
import { VFS } from './vfs.js';
import { Session } from './shell.js';

const $ = (id) => document.getElementById(id);
const wsId = new URLSearchParams(location.search).get('ws');
const IDLE_MS = IDLE_MINUTES * 60_000;
const SCROLLBACK_BYTES = 60_000;
const STARTER = 'print("Hello from ClassCode!")\n';

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
  if (!user || !wsId) return location.replace('./');
  const info = await backend.getWorkspace(wsId);
  const isTeacher = info.role === 'teacher';

  document.title = `${info.studentName} · ${info.className}`;
  $('who').textContent = `${info.className} · ${info.studentName}`;
  $('teacherBadge').hidden = !isTeacher;
  $('followWrap').hidden = !isTeacher;

  // ---------------------------------------------------------------- files --
  const vfs = new VFS();
  const stored = await backend.listFiles(wsId);
  for (const f of stored) vfs.files.set(f.path, f.content);
  if (!isTeacher && !stored.length) {
    vfs.files.set('main.py', STARTER);
    backend.saveFile(wsId, 'main.py', STARTER).catch(() => {});
  }

  // --------------------------------------------------------------- editor --
  await new Promise((resolve) => {
    require.config({ paths: { vs: 'vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], resolve);
  });
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const editor = monaco.editor.create($('editor'), {
    model: null,
    theme: dark.matches ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    scrollBeyondLastLine: false,
  });
  dark.addEventListener('change', () => monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs'));

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

  function openFile(path, { announce = true } = {}) {
    if (path && !vfs.has(path)) path = null;
    active = path;
    editor.setModel(path ? modelFor(path) : null);
    $('filename').textContent = path || 'No file open';
    renderFiles();
    if (announce && !isTeacher) channel.send('active', { path });
    if (!$('preview').hidden && path && /\.html?$/i.test(path)) showPreview(path);
  }

  function renderFiles() {
    const ul = $('files');
    ul.replaceChildren(
      ...vfs.paths().map((p) => {
        const li = document.createElement('li');
        const depth = p.split('/').length - 1;
        li.textContent = p.split('/').pop();
        li.title = p;
        li.style.paddingLeft = 12 + depth * 12 + 'px';
        if (depth) {
          const dir = document.createElement('span');
          dir.className = 'dir';
          dir.textContent = p.slice(0, p.lastIndexOf('/') + 1);
          li.prepend(dir);
        }
        if (p === active) li.className = 'active';
        li.onclick = () => {
          if (isTeacher) $('follow').checked = false;
          openFile(p);
        };
        return li;
      }),
    );
  }

  // Keep editor models, the file list, storage and the teacher in step with the files.
  const saveTimers = new Map();
  const sendTimers = new Map();
  let pendingSaves = 0;
  const showSaved = () => ($('saved').textContent = pendingSaves ? 'Saving…' : 'Saved');

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
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => (timers.delete(key), fn()), ms));
  };

  vfs.onChange((path, content, source) => {
    const model = models.get(path);
    if (content === null) {
      model?.dispose();
      models.delete(path);
      if (active === path) openFile(vfs.paths()[0] || null);
    } else if (model && source !== 'editor' && model.getValue() !== content) {
      applyRemote(model, content);
    }
    renderFiles();
    if (!$('preview').hidden) later(sendTimers, '\0preview', 400, () => showPreview(previewPath));
    // Changes that came from the other person are already saved and shared by them.
    if (source === 'remote') return;

    later(sendTimers, path, 200, () =>
      content === null ? channel.send('unlink', { path }) : channel.send('file', { path, content: vfs.get(path) ?? '' }),
    );
    if (!saveTimers.has(path)) pendingSaves++;
    showSaved();
    later(saveTimers, path, 700, async () => {
      try {
        if (vfs.has(path)) await backend.saveFile(wsId, path, vfs.get(path));
        else await backend.deleteFile(wsId, path);
      } catch (e) {
        $('saved').textContent = `Not saved: ${e.message}`;
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
    path ||= (active && /\.html?$/i.test(active) && active) || vfs.paths().find((p) => /\.html?$/i.test(p));
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
    $('previewFrame').srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
  }
  $('previewBtn').onclick = () => ($('preview').hidden ? showPreview() : (($('preview').hidden = true), fit()));
  $('previewClose').onclick = () => (($('preview').hidden = true), fit());

  // ------------------------------------------------------------- terminal --
  const term = new Terminal({
    fontSize: 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#11141c' },
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

  const channel = backend.channel(`ws:${wsId}`);
  const classChannel = backend.channel(`class:${info.classId}`);
  try {
    await Promise.all([channel.ready, classChannel.ready]);
  } catch (e) {
    $('termnote').textContent = 'Live connection unavailable';
    console.error(e);
  }

  // Run the open file in `session` (or show it, for web pages).
  const runActive = (session) => {
    if (!active || !session) return;
    if (/\.py$/i.test(active)) session.runCommand(`python ${quote(active)}`);
    else if (/\.(js|mjs)$/i.test(active)) session.runCommand(`node ${quote(active)}`);
    else if (/\.(html?|css)$/i.test(active)) showPreview(/\.html?$/i.test(active) ? active : undefined);
    else session.print(`\r\nDon't know how to run ${active}. Run .py, .js or .html files.\r\n`);
  };
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => $('run').click());

  const badName = (path) =>
    !path || path.length > 200 || /[\x00-\x1f\\]/.test(path) || path.split('/').some((x) => !x || x === '.' || x === '..');
  $('newFile').onclick = () => {
    const name = prompt('New file name (for example game.py, app.js or index.html):');
    if (!name) return;
    const path = name.trim().replace(/^\/+/, '');
    if (badName(path)) return alert('That file name is not allowed.');
    if (!vfs.has(path)) vfs.set(path, '');
    openFile(path);
    editor.focus();
  };
  $('renameFile').onclick = () => {
    if (!active) return;
    const path = prompt('Rename file to:', active)?.trim().replace(/^\/+/, '');
    if (!path || path === active) return;
    if (vfs.has(path)) return alert('A file with that name already exists.');
    if (badName(path)) return alert('That file name is not allowed.');
    const old = active;
    vfs.set(path, vfs.get(old));
    openFile(path);
    vfs.delete(old);
  };
  $('deleteFile').onclick = () => {
    if (active && confirm(`Delete ${active}?`)) vfs.delete(active);
  };

  // Edits arriving from the other person (student <-> teacher).
  channel.on('file', ({ path, content }) => {
    if (typeof path !== 'string' || badName(path)) return;
    vfs.set(path, String(content ?? ''), 'remote');
    if (!active) openFile(path, { announce: false });
  });
  channel.on('unlink', ({ path }) => vfs.delete(String(path), 'remote'));

  if (isTeacher) teacherMode();
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

    const session = new Session({ write, vfs, onPreview: showPreview });
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
    channel.on('run', ({ path }) => {
      if (closed || typeof path !== 'string' || !vfs.has(path)) return;
      touch();
      const keep = active;
      active = path;
      runActive(session);
      active = keep;
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
      local = new Session({ write: (d) => term.write(d), vfs, onPreview: showPreview });
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
        const fresh = await backend.listFiles(wsId);
        const seen = new Set(fresh.map((f) => f.path));
        for (const f of fresh) vfs.set(f.path, f.content, 'remote');
        for (const p of vfs.paths()) if (!seen.has(p)) vfs.delete(p, 'remote');
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
      if (online) channel.send('run', { path: active });
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
