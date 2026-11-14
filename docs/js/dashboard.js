// Sign-in, classes and rosters.

import { backend, demoMode } from './backend.js';
import { IDLE_MINUTES } from '../config.js';

const root = document.getElementById('app');
let me = null;
let cleanup = () => {};

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

const errorBox = () => h('p', { class: 'error', role: 'alert', hidden: true });
function showError(box, e) {
  box.textContent = e.message;
  box.hidden = false;
}

const workspaceUrl = (id) => `workspace.html?ws=${encodeURIComponent(id)}`;

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
          const f = Object.fromEntries(new FormData(form).entries());
          const button = form.querySelector('button[type=submit]');
          button.disabled = true;
          try {
            me = signup ? await backend.signUp({ ...f, role }) : await backend.signIn(f);
            if (!me) throw new Error('Your account has no profile yet. Ask your teacher to check the Supabase setup.');
            render();
          } catch (e) {
            showError(err, e);
            button.disabled = false;
          }
        },
      },
      h('h1', {}, 'ClassCode'),
      h('p', { class: 'muted' }, 'Write and run code in your browser, together with your class.'),
      signup &&
        h(
          'div',
          { class: 'seg' },
          ['student', 'teacher'].map((r) =>
            h('button', { type: 'button', class: role === r ? 'active' : '', onclick: () => ((role = r), draw()) }, r === 'student' ? "I'm a student" : "I'm a teacher"),
          ),
        ),
      signup && h('label', {}, 'Your name', h('input', { name: 'displayName', required: true, maxlength: 60, autocomplete: 'name' })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h(
        'label',
        {},
        'Password',
        h('input', { name: 'password', type: 'password', required: true, minlength: signup ? 8 : null, autocomplete: signup ? 'new-password' : 'current-password' }),
      ),
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
            await backend.signOut().catch(() => {});
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
    const classes = await backend.listClasses();
    list.replaceChildren(
      ...(classes.length
        ? classes.map((c) =>
            h(
              'div',
              { class: 'card' },
              h('h3', {}, c.name),
              h('p', { class: 'muted' }, `Teacher: ${c.teacherName}`),
              h('a', { class: 'btn primary', href: workspaceUrl(c.workspaceId) }, 'Open workspace'),
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
          await backend.joinClass(input.value);
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
  return page(
    h('h2', {}, 'My classes'),
    h('p', { class: 'muted' }, `Your workspace closes after ${IDLE_MINUTES} minutes without activity. Your files are kept — just open it again.`),
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
    const classes = await backend.listClasses();
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
          const created = await backend.createClass(input.value);
          location.hash = `#/class/${created.id}`;
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
  let students = [];
  let online = new Set();

  const draw = () => {
    empty.hidden = students.length > 0;
    body.replaceChildren(
      ...students.map((s) => {
        const on = online.has(s.workspaceId);
        return h(
          'tr',
          {},
          h('td', {}, h('strong', {}, s.displayName)),
          h('td', {}, h('span', { class: on ? 'pill on' : 'pill' }, on ? 'Open now' : 'Closed')),
          h(
            'td',
            { class: 'actions' },
            h('a', { class: 'btn primary small', href: workspaceUrl(s.workspaceId) }, on ? 'Watch live' : 'View files'),
            h(
              'button',
              {
                class: 'btn small danger',
                onclick: async () => {
                  if (!confirm(`Remove ${s.displayName} from this class? Their files for this class will be deleted.`)) return;
                  try {
                    await backend.removeStudent(s.workspaceId);
                    await load();
                  } catch (e) {
                    showError(err, e);
                  }
                },
              },
              'Remove',
            ),
          ),
        );
      }),
    );
  };

  const load = async () => {
    const data = await backend.getRoster(classId);
    title.textContent = data.class.name;
    code.textContent = data.class.joinCode;
    students = data.students;
    draw();
  };

  // Who has their workspace open right now, plus a slow refresh for new joiners.
  const channel = backend.channel(`class:${classId}`);
  channel.ready
    .then(() =>
      channel.onPresence((states) => {
        online = new Set(states.map((s) => s.workspaceId).filter(Boolean));
        draw();
      }),
    )
    .catch(() => {});
  const timer = setInterval(() => !document.hidden && load().catch(() => {}), 10_000);
  cleanup = () => {
    clearInterval(timer);
    channel.close();
  };

  load().catch((e) => showError(err, e));
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
              await backend.deleteClass(classId);
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
  cleanup();
  cleanup = () => {};
  let view;
  if (!me) view = authView();
  else if (me.role === 'student') view = studentHome();
  else {
    const m = /^#\/class\/([\w-]+)$/.exec(location.hash);
    view = m ? teacherClass(m[1]) : teacherHome();
  }
  root.replaceChildren(view);
}

document.getElementById('demo').hidden = !demoMode;
window.addEventListener('hashchange', render);
try {
  me = await backend.init();
} catch (e) {
  console.error(e);
}
render();
