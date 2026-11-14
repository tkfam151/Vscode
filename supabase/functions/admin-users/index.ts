// ClassCode admin-users Edge Function.
//
// Lets an admin create teacher (or admin) accounts. The new teacher gets an
// email with a link to set their own password. Sending that email and setting
// roles needs Supabase's service-role key, which must never be put in the
// website, so this part runs on Supabase instead of GitHub Pages.
//
// Request (POST, JSON, sent by the signed-in admin's browser):
//   { action: 'invite', email, displayName, role: 'teacher' | 'admin', redirectTo }
//   { action: 'resend', id, redirectTo }   new invite, or a password-reset email if they already set one
//   { action: 'remove', id }               delete the account and everything it owns
//
// Deploy: see "Deploy the admin-users function" in README.md.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function friendly(message: string) {
  if (/already (been )?registered|already exists/i.test(message)) return 'That email already has an account';
  if (/rate limit/i.test(message)) return 'Too many emails sent recently. Wait a while, or set up your own email (SMTP) provider in Supabase.';
  if (/error sending/i.test(message)) return 'Supabase could not send the email. Check the SMTP settings in Supabase.';
  return message;
}

// Projects on Supabase's newer API keys may provide secret keys as JSON instead.
function newSecretKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return keys.default ?? Object.values(keys)[0];
  } catch {
    return undefined;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || newSecretKey();
    if (!url || !serviceKey) fail(500, 'The function is missing SUPABASE_URL or a secret (service-role) key');
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    // Who is asking? Only admins may continue.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: caller } = await admin.auth.getUser(token);
    if (!caller?.user) fail(401, 'Please sign in again');
    const { data: me } = await admin.from('profiles').select('role').eq('id', caller.user.id).maybeSingle();
    if (me?.role !== 'admin') fail(403, 'Only admins can manage teacher accounts');

    const body = await req.json().catch(() => ({}));
    const redirectTo = typeof body.redirectTo === 'string' && /^https?:\/\//.test(body.redirectTo) ? body.redirectTo : undefined;

    // A teacher/admin account other than the caller's own.
    const staffAccount = async (id: unknown) => {
      if (typeof id !== 'string' || !id) fail(400, 'Missing account id');
      const { data: profile } = await admin.from('profiles').select('id, display_name, role').eq('id', id).maybeSingle();
      if (!profile || !['teacher', 'admin'].includes(profile.role)) fail(404, 'Teacher account not found');
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error || !data?.user) fail(404, 'Teacher account not found');
      return { profile, user: data.user };
    };

    if (body.action === 'invite') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const displayName = String(body.displayName ?? '').trim().slice(0, 60);
      const role = body.role === 'admin' ? 'admin' : 'teacher';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address');
      if (!displayName) fail(400, "Enter the teacher's name");

      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { display_name: displayName }, redirectTo });
      if (error) fail(400, friendly(error.message));
      // The database made this a student account; raise it to teacher/admin.
      const { error: roleError } = await admin.from('profiles').update({ role, display_name: displayName }).eq('id', data.user.id);
      if (roleError) {
        await admin.auth.admin.deleteUser(data.user.id);
        fail(500, roleError.message);
      }
      return json(200, { id: data.user.id });
    }

    if (body.action === 'resend') {
      const { profile, user } = await staffAccount(body.id);
      // Not yet confirmed: send the invite again. Already confirmed (they used
      // the link, or set a password): send a password-reset email instead,
      // which opens the same "set your password" page.
      const { error } = user.email_confirmed_at
        ? await admin.auth.resetPasswordForEmail(user.email!, { redirectTo })
        : await admin.auth.admin.inviteUserByEmail(user.email!, { data: { display_name: profile.display_name }, redirectTo });
      if (error) fail(400, friendly(error.message));
      return json(200, { sent: user.email_confirmed_at ? 'reset' : 'invite' });
    }

    if (body.action === 'remove') {
      if (body.id === caller.user.id) fail(400, "You can't remove your own account");
      const { user } = await staffAccount(body.id);
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) fail(400, error.message);
      return json(200, {});
    }

    fail(400, 'Unknown action');
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status === 500) console.error(e);
    return json(status, { error: (e as Error).message || 'Something went wrong' });
  }
});
