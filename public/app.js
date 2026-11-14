// ClassCode dashboard (no framework: a tiny hyperscript helper and hash routing).

const root = document.getElementById('app');
let me = null;
let cfg = { idleMinutes: 60, teacherCodeRequired: false };
let pollTimer = null;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && me) {
    me = null;
    render();
  }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function poll(fn, ms = 5000) {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) fn().catch(() => {});
  }, ms);
}

const errorBox = () => h('p', { class: 'error', role: 'alert', hidden: true });
function showError(box, e) {
  box.textContent = e.message;
  box.hidden = false;
}

function statusPill(ws) {
  if (ws.state === 'running') {
    const idle = Math.floor((ws.idleMs || 0) / 60000);
    return h('span', { class: 'pill on' }, idle < 1 ? 'Open · active' : `Open · idle ${idle} min`);
  }
  if (ws.state === 'starting') return h('span', { class: 'pill wait' }, 'Starting…');
  if (ws.state === 'stopping') return h('span', { class: 'pill wait' }, 'Closing…');
  return h('span', { class: 'pill' }, ws.lastStopReason === 'idle' ? 'Closed (inactive)' : 'Closed');
}

const openLink = (workspaceId, label, cls = 'btn primary') =>
  h('a', { class: cls, href: `/open.html?ws=${workspaceId}`, target: '_blank', rel: 'noopener' }, label);

// ------------------------------------------------------------------ auth --

function authView() {
  let mode = 'login';
  let role = 'student';
  const container = h('div', { class: 'center' });

  const draw = () => {
    const err = errorBox();
    const signup = mode === 'signup';
    const form = h(
      'form',
      {
        class: 'card auth',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const f = new FormData(form);
          const button = form.querySelector('button[type=submit]');
          button.disabled = true;
          try {
            const payload = Object.fromEntries(f.entries());
            if (signup) payload.role = role;
            const data = await api('POST', signup ? '/api/signup' : '/api/login', payload);
            me = data.user;
            location.hash = '';
            render();
          } catch (e) {
            showError(err, e);
            button.disabled = false;
          }
        },
      },
      h('h1', {}, 'ClassCode'),
      h('p', { class: 'muted' }, 'VS Code in the browser for your class.'),
      signup &&
        h(
          'div',
          { class: 'seg' },
          ['student', 'teacher'].map((r) =>
            h(
              'button',
              { type: 'button', class: role === r ? 'active' : '', onclick: () => ((role = r), draw()) },
              r === 'student' ? "I'm a student" : "I'm a teacher",
            ),
          ),
        ),
      signup && h('label', {}, 'Your name', h('input', { name: 'displayName', required: true, maxlength: 60, autocomplete: 'name' })),
      h('label', {}, 'Username', h('input', { name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none' })),
      h(
        'label',
        {},
        'Password',
        h('input', {
          name: 'password',
          type: 'password',
          required: true,
          minlength: signup ? 8 : null,
          autocomplete: signup ? 'new-password' : 'current-password',
        }),
      ),
      signup &&
        role === 'teacher' &&
        cfg.teacherCodeRequired &&
        h('label', {}, 'Teacher sign-up code', h('input', { name: 'teacherCode', required: true, autocomplete: 'off' })),
      err,
      h('button', { type: 'submit', class: 'btn primary wide' }, signup ? 'Create account' : 'Sign in'),
      h(
        'p',
        { class: 'muted switch' },
        signup ? 'Already have an account? ' : 'New here? ',
        h('a', { href: '#', onclick: (ev) => (ev.preventDefault(), (mode = signup ? 'login' : 'signup'), draw()) }, signup ? 'Sign in' : 'Create an account'),
      ),
    );
    container.replaceChildren(form);
  };
  draw();
  return container;
}

// ---------------------------------------------------------------- layout --

function page(...content) {
  return h(
    'div',
    {},
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#' }, 'ClassCode'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${me.displayName} · ${me.role}`),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            await api('POST', '/api/logout').catch(() => {});
            me = null;
            location.hash = '';
            render();
          },
        },
        'Sign out',
      ),
    ),
    h('main', {}, content),
  );
}

// --------------------------------------------------------------- student --

function studentHome() {
  const list = h('div', { class: 'grid' });
  const err = errorBox();
  const input = h('input', { name: 'code', placeholder: 'Class code', required: true, autocomplete: 'off', autocapitalize: 'characters', class: 'code-input' });

  const load = async () => {
    const { classes } = await api('GET', '/api/classes');
    list.replaceChildren(
      ...(classes.length
        ? classes.map((c) =>
            h(
              'div',
              { class: 'card' },
              h('h3', {}, c.name),
              h('p', { class: 'muted' }, `Teacher: ${c.teacherName}`),
              h('p', {}, statusPill(c.workspace)),
              h(
                'div',
                { class: 'row' },
                openLink(c.workspaceId, c.workspace.state === 'stopped' ? 'Open VS Code' : 'Go to VS Code'),
                c.workspace.state === 'running' &&
                  h('button', { class: 'btn', onclick: () => api('POST', `/api/workspaces/${c.workspaceId}/stop`).then(load) }, 'Close'),
              ),
            ),
          )
        : [h('p', { class: 'muted' }, 'You have not joined a class yet. Ask your teacher for the class code.')]),
    );
  };

  const form = h(
    'form',
    {
      class: 'row join',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.hidden = true;
        try {
          await api('POST', '/api/join', { code: input.value });
          input.value = '';
          await load();
        } catch (e) {
          showError(err, e);
        }
      },
    },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Join class'),
  );

  load().catch((e) => showError(err, e));
  poll(load);
  return page(
    h('h2', {}, 'My classes'),
    h('p', { class: 'muted' }, `Your workspace closes after ${cfg.idleMinutes} minutes without activity. Your files are kept — just open it again.`),
    form,
    err,
    list,
  );
}

// --------------------------------------------------------------- teacher --

function teacherHome() {
  const list = h('div', { class: 'grid' });
  const err = errorBox();
  const input = h('input', { name: 'name', placeholder: 'New class name, e.g. Period 3 Python', required: true, maxlength: 80 });

  const load = async () => {
    const { classes } = await api('GET', '/api/classes');
    list.replaceChildren(
      ...(classes.length
        ? classes.map((c) =>
            h(
              'a',
              { class: 'card link', href: `#/class/${c.id}` },
              h('h3', {}, c.name),
              h('p', { class: 'muted' }, `${c.studentCount} student${c.studentCount === 1 ? '' : 's'}`),
              h('p', {}, 'Join code ', h('code', { class: 'code' }, c.joinCode)),
            ),
          )
        : [h('p', { class: 'muted' }, 'No classes yet. Create one, then give students its join code.')]),
    );
  };

  const form = h(
    'form',
    {
      class: 'row join',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.hidden = true;
        try {
          const data = await api('POST', '/api/classes', { name: input.value });
          location.hash = `#/class/${data.class.id}`;
        } catch (e) {
          showError(err, e);
        }
      },
    },
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Create class'),
  );

  load().catch((e) => showError(err, e));
  return page(h('h2', {}, 'My classes'), form, err, list);
}

function teacherClass(classId) {
  const title = h('h2', {}, 'Class');
  const code = h('code', { class: 'code big' });
  const body = h('tbody');
  const empty = h('p', { class: 'muted', hidden: true }, 'No students have joined yet. Share the join code above.');
  const err = errorBox();

  const act = (fn) => async () => {
    err.hidden = true;
    try {
      await fn();
      await load();
    } catch (e) {
      showError(err, e);
    }
  };

  const load = async () => {
    const data = await api('GET', `/api/classes/${classId}`);
    title.textContent = data.class.name;
    code.textContent = data.class.joinCode;
    empty.hidden = data.students.length > 0;
    body.replaceChildren(
      ...data.students.map((s) =>
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, s.displayName), h('div', { class: 'muted small' }, s.username)),
          h('td', {}, statusPill(s.workspace)),
          h(
            'td',
            { class: 'actions' },
            openLink(s.workspaceId, s.workspace.state === 'stopped' ? 'Start & open' : 'Open terminal', 'btn primary small'),
            s.workspace.state === 'running' &&
              h('button', { class: 'btn small', onclick: act(() => api('POST', `/api/workspaces/${s.workspaceId}/stop`)) }, 'Close'),
            h(
              'button',
              {
                class: 'btn small danger',
                onclick: act(async () => {
                  if (confirm(`Remove ${s.displayName} from this class? Their files for this class will be deleted.`)) {
                    await api('DELETE', `/api/workspaces/${s.workspaceId}`);
                  }
                }),
              },
              'Remove',
            ),
          ),
        ),
      ),
    );
  };

  load().catch((e) => showError(err, e));
  poll(load);
  return page(
    h('p', {}, h('a', { href: '#' }, '← All classes')),
    h(
      'div',
      { class: 'row spread' },
      title,
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm('Delete this class? Every student workspace in it will be deleted.')) return;
            try {
              await api('DELETE', `/api/classes/${classId}`);
              location.hash = '';
            } catch (e) {
              showError(err, e);
            }
          },
        },
        'Delete class',
      ),
    ),
    h('div', { class: 'card joinbox' }, h('span', {}, 'Students join with this code:'), code),
    err,
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Student'), h('th', {}, 'Workspace'), h('th', {}, ''))), body),
    empty,
  );
}

// ---------------------------------------------------------------- router --

function render() {
  clearInterval(pollTimer);
  let view;
  if (!me) view = authView();
  else if (me.role === 'student') view = studentHome();
  else {
    const m = /^#\/class\/(\d+)$/.exec(location.hash);
    view = m ? teacherClass(Number(m[1])) : teacherHome();
  }
  root.replaceChildren(view);
}

window.addEventListener('hashchange', render);
[cfg, { user: me }] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/me')]);
render();
