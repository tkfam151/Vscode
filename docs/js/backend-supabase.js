// Supabase data layer. Tables, access rules and the functions called here are
// defined in supabase/schema.sql.

/* global supabase */

export function create(url, anonKey) {
  const sb = supabase.createClient(url, anonKey);

  const ok = ({ data, error }) => {
    if (error) throw new Error(friendly(error.message));
    return data;
  };

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const friendly = (msg) => {
    // the browser couldn't reach Supabase at all (no internet, wrong address in config.js, blocked or paused project)
    if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
      return `Can't reach the ClassCode server (${host}). Check the internet connection. If it keeps happening, the Supabase project may be paused, or SUPABASE_URL in config.js may be wrong.`;
    }
    if (/invalid login credentials/i.test(msg)) return 'Wrong email or password';
    if (/already registered/i.test(msg)) return 'That email already has an account';
    if (/email not confirmed/i.test(msg)) return 'Check your email and confirm your account first';
    return msg;
  };

  const setPasswordUrl = () => new URL('set-password.html', location.href).href.split(/[?#]/)[0];

  const adminCall = async (body) => {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    if (!error) return data;
    let message = error.message;
    try {
      message = (await error.context.json()).error || message;
    } catch {
      if (error.name === 'FunctionsFetchError' || error.context?.status === 404) {
        message = 'Could not reach the admin-users function. Has it been deployed to Supabase? (see README)';
      }
    }
    throw new Error(message);
  };

  const profile = async (authUser) => {
    if (!authUser) return null;
    const row = ok(await sb.from('profiles').select('id, display_name, role').eq('id', authUser.id).maybeSingle());
    return row ? { id: row.id, displayName: row.display_name, role: row.role } : null;
  };

  return {
    async init() {
      const { data } = await sb.auth.getSession();
      return profile(data.session?.user);
    },

    // Website sign-ups are always student accounts (enforced in schema.sql).
    async signUp({ email, password, displayName }) {
      const data = ok(await sb.auth.signUp({ email: email.trim(), password, options: { data: { display_name: displayName.trim() } } }));
      if (!data.session) throw new Error('Account created. Check your email to confirm it, then sign in.');
      return profile(data.user);
    },

    async signIn({ email, password }) {
      const data = ok(await sb.auth.signInWithPassword({ email: email.trim(), password }));
      return profile(data.user);
    },

    async signOut() {
      await sb.auth.signOut();
    },

    // ---- admin: teacher accounts (supabase/functions/admin-users) ----
    async listStaff() {
      return ok(await sb.rpc('admin_list_staff')) || [];
    },

    async inviteStaff({ email, displayName, role }) {
      return adminCall({ action: 'invite', email, displayName, role, redirectTo: setPasswordUrl() });
    },

    async resendInvite(id) {
      return adminCall({ action: 'resend', id, redirectTo: setPasswordUrl() });
    },

    async removeStaff(id) {
      return adminCall({ action: 'remove', id });
    },

    // ---- set-password page, opened from an invite or reset email ----
    async invitedUser() {
      const { data } = await sb.auth.getSession();
      const user = data.session?.user;
      if (!user) return null;
      const p = await profile(user);
      return { email: user.email, displayName: p?.displayName || user.email };
    },

    // "Forgot password?": Supabase emails a link to set-password.html
    async requestPasswordReset(email) {
      ok(await sb.auth.resetPasswordForEmail(String(email).trim(), { redirectTo: setPasswordUrl() }));
      return {};
    },

    async setPassword(password) {
      ok(await sb.auth.updateUser({ password }));
    },

    async listClasses() {
      return ok(await sb.rpc('my_classes')) || [];
    },

    async createClass(name) {
      return ok(await sb.rpc('create_class', { p_name: name }));
    },

    async deleteClass(id) {
      ok(await sb.from('classes').delete().eq('id', id));
    },

    async getRoster(classId) {
      const data = ok(await sb.rpc('class_roster', { p_class: classId }));
      if (!data) throw new Error('Class not found');
      return data;
    },

    // ---- announcements (teacher -> whole class) ----
    async listAnnouncements(classId, limit = 50) {
      return ok(await sb.rpc('class_announcements', { p_class: classId, p_limit: limit })) || [];
    },

    async postAnnouncement(classId, body) {
      const row = ok(await sb.from('announcements').insert({ class_id: classId, body }).select('id, class_id, body, created_at').single());
      return { id: row.id, classId: row.class_id, body: row.body, createdAt: row.created_at };
    },

    async deleteAnnouncement(id) {
      ok(await sb.from('announcements').delete().eq('id', id));
    },

    // ---- starter files (the teacher's model workspace for a class) ----
    async listStarterFiles(classId) {
      return ok(await sb.from('class_files').select('path, content').eq('class_id', classId));
    },

    async saveStarterFile(classId, path, content) {
      ok(await sb.from('class_files').upsert({ class_id: classId, path, content, updated_at: new Date().toISOString() }));
    },

    async deleteStarterFile(classId, path) {
      ok(await sb.from('class_files').delete().eq('class_id', classId).eq('path', path));
    },

    async copyStarterToStudents(classId) {
      return ok(await sb.rpc('copy_starter_files', { p_class: classId }));
    },

    async teacherWorkspace(classId) {
      return ok(await sb.rpc('teacher_workspace', { p_class: classId }));
    },

    async joinClass(code) {
      ok(await sb.rpc('join_class', { p_code: code }));
    },

    async removeStudent(workspaceId) {
      ok(await sb.from('enrollments').delete().eq('id', workspaceId));
    },

    async getWorkspace(id) {
      const data = ok(await sb.rpc('workspace_info', { p_ws: id }));
      if (!data) throw new Error('Workspace not found');
      return data;
    },

    async listFiles(workspaceId) {
      return ok(await sb.from('files').select('path, content').eq('workspace_id', workspaceId));
    },

    async saveFile(workspaceId, path, content) {
      ok(await sb.from('files').upsert({ workspace_id: workspaceId, path, content, updated_at: new Date().toISOString() }));
    },

    async deleteFile(workspaceId, path) {
      ok(await sb.from('files').delete().eq('workspace_id', workspaceId).eq('path', path));
    },

    channel(name) {
      // private: true -> Supabase checks the realtime rules in schema.sql before
      // letting anyone listen or send on this channel.
      const ch = sb.channel(name, { config: { private: true, broadcast: { self: false } } });
      const handlers = new Map();
      let presenceCb = null;
      ch.on('broadcast', { event: '*' }, ({ event, payload }) => handlers.get(event)?.(payload));
      ch.on('presence', { event: 'sync' }, () => presenceCb?.(Object.values(ch.presenceState()).flat()));
      const ready = (async () => {
        await sb.realtime.setAuth();
        await new Promise((resolve, reject) => {
          ch.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') resolve();
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(err || new Error('Could not connect to the live channel'));
          });
        });
      })();
      ready.catch(() => {});
      return {
        ready,
        on: (event, cb) => handlers.set(event, cb),
        send: (event, payload) => ch.send({ type: 'broadcast', event, payload }),
        track: (state) => ch.track(state),
        untrack: () => ch.untrack(),
        onPresence(cb) {
          presenceCb = cb;
          cb(Object.values(ch.presenceState()).flat());
        },
        close: () => sb.removeChannel(ch),
      };
    },
  };
}
