// Sign-in, classes and rosters.

import { backend, demoMode } from './backend.js';
import { IDLE_MINUTES } from '../config.js';
import { applyBrand } from './brand.js';
import { makeZip } from './zip.js';

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

const when = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const messageItem = (a, extra) =>
  h('li', { class: 'msg' }, h('div', { class: 'msg-head' }, h('strong', {}, a.authorName || me?.displayName || 'Teacher'), h('span', { class: 'muted small' }, when(a.createdAt)), extra), h('div', { class: 'msg-body' }, a.body));

// a teacher's own workspace in a class (made the first time)
async function openMyWorkspace(classId, button) {
  if (button) button.disabled = true;
  try {
    location.href = workspaceUrl(await backend.teacherWorkspace(classId));
  } catch (e) {
    if (button) button.disabled = false;
    alert(e.message);
  }
}

const workspaceUrl = (id) => `workspace.html?ws=${encodeURIComponent(id)}`;

// ------------------------------------------------------------------ auth --

function authView() {
  let mode = 'login';
  const container = h('div', { class: 'center' });

  const draw = () => {
    const err = errorBox();
    const signup = mode === 'signup';
    if (mode === 'forgot') return drawForgot();
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
            me = signup ? await backend.signUp(f) : await backend.signIn(f);
            if (!me) throw new Error('Your account has no profile yet. Ask your teacher to check the Supabase setup.');
            render();
          } catch (e) {
            showError(err, e);
            button.disabled = false;
          }
        },
      },
      h('h1', { class: 'brand-title' }, 'ClassCode'),
      h('p', { class: 'muted' }, signup ? 'Create a student account.' : 'Write and run code in your browser, together with your class.'),
      signup && h('label', {}, 'Your name', h('input', { name: 'displayName', required: true, maxlength: 60, autocomplete: 'name' })),
      h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h(
        'label',
        {},
        'Password',
        h('input', { name: 'password', type: 'password', required: true, minlength: signup ? 8 : null, autocomplete: signup ? 'new-password' : 'current-password' }),
      ),
      !signup && h('a', { href: '#', class: 'small forgot', onclick: (ev) => (ev.preventDefault(), (mode = 'forgot'), draw()) }, 'Forgot password?'),
      err,
      h('button', { type: 'submit', class: 'btn primary wide' }, signup ? 'Create account' : 'Sign in'),
      h(
        'p',
        { class: 'muted switch' },
        signup ? 'Already have an account? ' : 'New student? ',
        h('a', { href: '#', onclick: (ev) => (ev.preventDefault(), (mode = signup ? 'login' : 'signup'), draw()) }, signup ? 'Sign in' : 'Create an account'),
      ),
      h('p', { class: 'muted small' }, "Teachers: your school's admin creates your account and emails you a link to set your password."),
      signup && demoMode && h('p', { class: 'muted small' }, 'Demo mode: the first account created becomes the admin.'),
    );
    container.replaceChildren(form);
  };

  const drawForgot = () => {
    const err = errorBox();
    const done = h('div', { class: 'notice-box', hidden: true });
    const email = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' });
    const form = h(
      'form',
      {
        class: 'card auth',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const button = form.querySelector('button[type=submit]');
          button.disabled = true;
          err.hidden = true;
          try {
            const r = await backend.requestPasswordReset(email.value);
            done.replaceChildren(
              h('p', {}, `If ${email.value.trim()} has an account, an email with a link to choose a new password is on its way. Check the spam folder too.`),
              r?.demoLink && h('p', { class: 'small' }, 'Demo mode sends no email. Open this link: ', h('a', { href: r.demoLink }, 'choose a new password')),
            );
            done.hidden = false;
          } catch (e) {
            showError(err, e);
          }
          button.disabled = false;
        },
      },
      h('h1', { class: 'brand-title' }, 'ClassCode'),
      h('p', { class: 'muted' }, "Forgot your password? Enter your email and we'll send you a link to choose a new one."),
      h('label', {}, 'Email', email),
      err,
      done,
      h('button', { type: 'submit', class: 'btn primary wide' }, 'Send reset link'),
      h('p', { class: 'muted switch' }, h('a', { href: '#', onclick: (ev) => (ev.preventDefault(), (mode = 'login'), draw()) }, '← Back to sign in')),
    );
    container.replaceChildren(form);
    applyBrand(container);
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
      me.role === 'admin' && h('a', { class: 'navlink', href: '#' }, 'My classes'),
      me.role === 'admin' && h('a', { class: 'navlink', href: '#/admin' }, 'Manage teachers'),
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
    // each class card shows the teacher's latest message
    await Promise.all(classes.map(async (c) => (c.latest = (await backend.listAnnouncements(c.id, 1).catch(() => []))[0])));
    list.replaceChildren(
      ...(classes.length
        ? classes.map((c) =>
            h(
              'div',
              { class: 'card' },
              h('h3', {}, c.name),
              h('p', { class: 'muted' }, `Teacher: ${c.teacherName}`),
              c.latest && h('div', { class: 'latest' }, h('span', { class: 'small muted' }, `📢 ${c.latest.authorName} · ${when(c.latest.createdAt)}`), h('div', { class: 'msg-body' }, c.latest.body)),
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
              h('p', { class: 'muted' }, `${c.studentCount} student${c.studentCount === 1 ? '' : 's'}`, c.mine === false ? ` · ${c.teacherName}` : ''),
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
  const starterInfo = h('p', { class: 'small' });
  const copyBtn = h(
    'button',
    {
      class: 'btn',
      title: 'Adds any starter files a student is missing. Files a student already has are left as they are.',
      onclick: async () => {
        if (!confirm('Give the starter files to students already in this class?\n\nStudents get any starter files they don\'t have yet. Files they already have, including their own changes, are not touched.')) return;
        err.hidden = true;
        copyBtn.disabled = true;
        try {
          const r = await backend.copyStarterToStudents(classId);
          alert(r.files ? `Added ${r.files} new file${r.files === 1 ? "" : "s"} or folder${r.files === 1 ? "" : "s"} for ${r.students} student${r.students === 1 ? "" : "s"}.` : 'Every student already has all the starter files.');
        } catch (e) {
          showError(err, e);
        }
        copyBtn.disabled = false;
      },
    },
    'Give to students already in the class',
  );
  // ---- broadcast a message to everyone in the class ----
  const msgText = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Write a message to everyone in this class, e.g. "Open lesson3.py and finish the quiz before 10:30."' });
  const msgList = h('ul', { class: 'msgs' });
  const msgErr = errorBox();
  let messages = [];
  const drawMessages = () =>
    msgList.replaceChildren(
      ...(messages.length
        ? messages.map((a) =>
            messageItem(
              a,
              h(
                'button',
                {
                  class: 'btn small danger',
                  title: 'Delete this message for everyone',
                  onclick: async () => {
                    if (!confirm('Delete this message for everyone?')) return;
                    try {
                      await backend.deleteAnnouncement(a.id);
                      channel.send('unannounce', { id: a.id });
                      messages = messages.filter((m) => m.id !== a.id);
                      drawMessages();
                    } catch (e) {
                      showError(msgErr, e);
                    }
                  },
                },
                'Delete',
              ),
            ),
          )
        : [h('li', { class: 'muted small' }, 'No messages sent yet.')]),
    );
  const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, '📢 Send to class');
  const msgForm = h(
    'form',
    {
      class: 'broadcast',
      onsubmit: async (ev) => {
        ev.preventDefault();
        const text = msgText.value.trim();
        if (!text) return;
        msgErr.hidden = true;
        sendBtn.disabled = true;
        try {
          const a = { ...(await backend.postAnnouncement(classId, text)), authorName: me.displayName };
          channel.send('announce', a); // students with the class open see it at once
          messages = [a, ...messages];
          msgText.value = '';
          drawMessages();
        } catch (e) {
          showError(msgErr, e);
        }
        sendBtn.disabled = false;
      },
    },
    msgText,
    h('div', { class: 'row' }, sendBtn, h('span', { class: 'muted small' }, 'Students see it right away if their workspace is open, otherwise the next time they open it.')),
  );
  msgText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) msgForm.requestSubmit();
  });
  const loadMessages = async () => {
    messages = await backend.listAnnouncements(classId);
    drawMessages();
  };

  // ---- everyone's work in one .zip (a folder per student), e.g. for marking ----
  const zipBtn = h(
    'button',
    {
      class: 'btn',
      title: "Download every student's files for this class",
      onclick: async () => {
        err.hidden = true;
        zipBtn.disabled = true;
        const label = zipBtn.textContent;
        try {
          const enc = new TextEncoder();
          const entries = [];
          const used = new Set();
          let n = 0;
          for (const st of students) {
            zipBtn.textContent = `Collecting ${++n}/${students.length}…`;
            // a safe, unique folder name per student
            let folder = st.displayName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'student';
            for (let i = 2; used.has(folder.toLowerCase()); i++) folder = `${st.displayName} (${i})`;
            used.add(folder.toLowerCase());
            entries.push({ name: folder + '/', data: new Uint8Array() });
            for (const f of await backend.listFiles(st.workspaceId)) {
              let data;
              if (f.content.startsWith('data:')) data = Uint8Array.from(atob(f.content.slice(f.content.indexOf(',') + 1)), (c) => c.charCodeAt(0));
              else data = enc.encode(f.content);
              entries.push({ name: `${folder}/${f.path}`, data: f.path.endsWith('/') ? new Uint8Array() : data });
            }
          }
          const a = h('a', { href: URL.createObjectURL(makeZip(entries)), download: `${(title.textContent || 'class').replace(/[^\w.-]+/g, '_')}-work.zip` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (e) {
          showError(err, e);
        }
        zipBtn.textContent = label;
        zipBtn.disabled = !students.length;
      },
    },
    "⬇ Download all students' work (.zip)",
  );

  const title = h('h2', {}, 'Class');
  const code = h('code', { class: 'code big' });
  const body = h('tbody');
  const empty = h('p', { class: 'muted', hidden: true }, 'No students have joined yet. Share the join code above.');
  const err = errorBox();
  let students = [];
  let online = new Set();
  let hands = new Set();
  const plainTitle = () => document.title.replace(/^✋ \d+ · /, '');

  const draw = () => {
    empty.hidden = students.length > 0;
    document.title = (hands.size ? `✋ ${hands.size} · ` : '') + plainTitle();
    // raised hands first, then whoever is online
    const order = [...students].sort((a, b) => hands.has(b.workspaceId) - hands.has(a.workspaceId) || online.has(b.workspaceId) - online.has(a.workspaceId));
    body.replaceChildren(
      ...order.map((s) => {
        const on = online.has(s.workspaceId);
        const up = hands.has(s.workspaceId);
        return h(
          'tr',
          { class: up ? 'hand-up' : '' },
          h('td', {}, h('strong', {}, s.displayName)),
          h('td', {}, up ? h('span', { class: 'pill hand' }, '✋ Needs help') : h('span', { class: on ? 'pill on' : 'pill' }, on ? 'Open now' : 'Closed')),
          h(
            'td',
            { class: 'actions' },
            up &&
              h(
                'button',
                {
                  class: 'btn small',
                  title: "Lower the student's hand (they see that you've noticed)",
                  onclick: () => {
                    channel.send('lower-hand', { workspaceId: s.workspaceId });
                    hands.delete(s.workspaceId);
                    draw();
                  },
                },
                'Lower hand',
              ),
            h('a', { class: 'btn primary small', href: workspaceUrl(s.workspaceId) }, on ? 'Join live' : 'Open workspace'),
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
    if (!zipBtn.textContent.startsWith('Collecting')) zipBtn.disabled = !students.length;
    const starter = await backend.listStarterFiles(classId);
    const files = starter.filter((f) => !f.path.endsWith('/')).map((f) => f.path).sort();
    const folders = starter.length - files.length;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    starterInfo.textContent = starter.length
      ? `${plural(files.length, 'file')}${folders ? `, ${plural(folders, 'empty folder')}` : ''}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}`
      : 'No starter files yet. New students start with a one-line main.py.';
    copyBtn.disabled = !starter.length || !students.length;
    draw();
  };

  // Who has their workspace open right now, plus a slow refresh for new joiners.
  const channel = backend.channel(`class:${classId}`);
  channel.ready
    .then(() =>
      channel.onPresence((states) => {
        online = new Set(states.map((s) => s.workspaceId).filter(Boolean));
        hands = new Set(states.filter((s) => s.hand).map((s) => s.workspaceId));
        draw();
      }),
    )
    .catch(() => {});
  const timer = setInterval(() => !document.hidden && load().catch(() => {}), 10_000);
  cleanup = () => {
    clearInterval(timer);
    channel.close();
    document.title = plainTitle();
  };

  load().catch((e) => showError(err, e));
  loadMessages().catch((e) => showError(msgErr, e));
  return page(
    h('p', {}, h('a', { href: '#' }, '← All classes')),
    h(
      'div',
      { class: 'row spread' },
      title,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            title: 'Your own workspace in this class, for demos and trying things out. Students don\'t see it.',
            onclick: (ev) => openMyWorkspace(classId, ev.currentTarget),
          },
          '🧑‍🏫 My workspace',
        ),
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
    ),
    h('div', { class: 'card joinbox' }, h('span', {}, 'Students join with this code:'), code),
    h(
      'div',
      { class: 'card starter' },
      h('div', {}, h('h3', {}, 'Model workspace'), h('p', { class: 'muted' }, 'Starter files every student gets a copy of when they join this class.'), starterInfo),
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn primary', href: `workspace.html?starter=${encodeURIComponent(classId)}` }, 'Edit model workspace'),
        copyBtn,
      ),
    ),
    h('div', { class: 'card broadcast-card' }, h('h3', {}, 'Message the class'), msgForm, msgErr, msgList),
    err,
    h('div', { class: 'row spread roster-head' }, h('h3', {}, 'Students'), zipBtn),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Student'), h('th', {}, 'Workspace'), h('th', {}, ''))), body),
    empty,
  );
}

// ----------------------------------------------------------------- admin --

function adminView() {
  const err = errorBox();
  const notice = h('div', { class: 'card notice', hidden: true });
  const body = h('tbody');
  const name = h('input', { name: 'displayName', placeholder: 'Name', required: true, maxlength: 60, autocomplete: 'off' });
  const email = h('input', { name: 'email', type: 'email', placeholder: 'Email', required: true, autocomplete: 'off' });
  const role = h('select', { name: 'role' }, h('option', { value: 'teacher' }, 'Teacher'), h('option', { value: 'admin' }, 'Admin'));

  const tell = (text, link) => {
    notice.replaceChildren(
      h('span', {}, text),
      link && h('div', { class: 'small' }, 'Demo mode sends no email. Open this link to set the password: ', h('a', { href: link, target: '_blank', rel: 'noopener' }, 'set password')),
    );
    notice.hidden = false;
  };

  const act = (fn) => async (ev) => {
    const button = ev.currentTarget;
    err.hidden = true;
    button.disabled = true;
    try {
      await fn();
      await load();
    } catch (e) {
      showError(err, e);
    }
    button.disabled = false;
  };

  const load = async () => {
    const staff = await backend.listStaff();
    body.replaceChildren(
      ...staff.map((s) =>
        h(
          'tr',
          {},
          h('td', {}, h('strong', {}, s.displayName), h('div', { class: 'muted small' }, s.email)),
          h('td', {}, s.role === 'admin' ? 'Admin' : 'Teacher'),
          h('td', {}, h('span', { class: s.status === 'active' ? 'pill on' : 'pill wait' }, s.status === 'active' ? 'Active' : 'Invite sent')),
          h(
            'td',
            { class: 'actions' },
            s.id !== me.id &&
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: act(async () => {
                    const r = await backend.resendInvite(s.id);
                    tell(r.sent === 'reset' ? `Password reset email sent to ${s.email}.` : `Invite sent again to ${s.email}.`, r.demoLink);
                  }),
                },
                s.status === 'active' ? 'Send password reset' : 'Resend invite',
              ),
            s.id !== me.id &&
              h(
                'button',
                {
                  class: 'btn small danger',
                  onclick: act(async () => {
                    if (!confirm(`Remove ${s.displayName}'s account? Their classes, and every student's work in those classes, will be deleted.`)) return;
                    await backend.removeStaff(s.id);
                    tell(`${s.displayName}'s account was removed.`);
                  }),
                },
                'Remove',
              ),
          ),
        ),
      ),
    );
  };

  const form = h(
    'form',
    {
      class: 'row join',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.hidden = true;
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          const r = await backend.inviteStaff({ email: email.value, displayName: name.value, role: role.value });
          tell(`Invite sent to ${email.value.trim()}. They set their own password from the link in the email.`, r?.demoLink);
          form.reset();
          await load();
        } catch (e) {
          showError(err, e);
        }
        button.disabled = false;
      },
    },
    name,
    email,
    role,
    h('button', { class: 'btn primary', type: 'submit' }, 'Send invite'),
  );

  load().catch((e) => showError(err, e));
  return page(
    h('h2', {}, 'Teacher accounts'),
    h('p', { class: 'muted' }, 'Teachers cannot sign up on the website. Add them here: they get an email with a link to set their own password.'),
    form,
    err,
    notice,
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}, ''))), body),
  );
}

// ---------------------------------------------------------------- router --

function render() {
  cleanup();
  cleanup = () => {};
  let view;
  if (!me) view = authView();
  else if (me.role === 'student') view = studentHome();
  else if (me.role === 'admin' && location.hash === '#/admin') view = adminView();
  else {
    const m = /^#\/class\/([\w-]+)$/.exec(location.hash);
    view = m ? teacherClass(m[1]) : teacherHome();
  }
  root.replaceChildren(view);
  applyBrand(root);
}

document.getElementById('demo').hidden = !demoMode;
window.addEventListener('hashchange', render);
try {
  me = await backend.init();
} catch (e) {
  console.error(e);
}
render();
