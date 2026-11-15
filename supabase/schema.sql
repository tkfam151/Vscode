-- ClassCode database setup for Supabase.
-- Paste this whole file into the Supabase SQL Editor and press Run. Safe to run more than once.
--
-- After your own account exists (sign up on the site like a student), make it
-- the first admin by running this once, with your email:
--
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@yourschool.org');

-- ---------------------------------------------------------------- tables --

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  role text not null check (role in ('admin', 'teacher', 'student')),
  created_at timestamptz not null default now()
);
-- Projects set up with an earlier version of this file only allowed teacher/student.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'teacher', 'student'));

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  join_code text not null unique,
  created_at timestamptz not null default now()
);

-- One enrollment = one student workspace. The enrollment id is the workspace id.
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (class_id, student_id)
);

create table if not exists public.files (
  workspace_id uuid not null references public.enrollments (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 200),
  content text not null default '' check (octet_length(content) <= 262144),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, path)
);

-- A class's starter files (the teacher's model workspace). Each student gets
-- a copy when they join the class.
create table if not exists public.class_files (
  class_id uuid not null references public.classes (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 200),
  content text not null default '' check (octet_length(content) <= 262144),
  updated_at timestamptz not null default now(),
  primary key (class_id, path)
);

alter table public.profiles enable row level security;
alter table public.class_files enable row level security;
alter table public.classes enable row level security;
alter table public.enrollments enable row level security;
alter table public.files enable row level security;

-- --------------------------------------------------------------- helpers --
-- "security definer" functions run with the table owner's rights, so they can
-- look things up without tripping over the row rules below. Each one checks
-- auth.uid() (the signed-in user) itself.

-- Create the profile row when an account is created. Every new account starts
-- as a student: people who sign up on the website can only be students.
-- Teacher and admin accounts are created by an admin through the admin-users
-- Edge Function (supabase/functions/admin-users), which upgrades the role
-- right after sending the invite email.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 60);
begin
  if v_name = '' then v_name := left(split_part(coalesce(new.email, 'user'), '@', 1), 60); end if;
  insert into public.profiles (id, display_name, role) values (new.id, v_name, 'student')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists classcode_on_auth_user_created on auth.users;
create trigger classcode_on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Teachers and admins can run classes.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('teacher', 'admin'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin');
$$;

-- The class's teacher, or any admin (admins can open every class).
create or replace function public.is_class_teacher(p_class uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.classes c where c.id = p_class and c.teacher_id = (select auth.uid()))
      or public.is_admin();
$$;

-- 'student' if the workspace is the caller's own, 'teacher' if it is in one of
-- their classes (or the caller is an admin), else null.
create or replace function public.workspace_role(p_ws uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
           when e.student_id = (select auth.uid()) then 'student'
           when c.teacher_id = (select auth.uid()) or public.is_admin() then 'teacher'
         end
  from public.enrollments e join public.classes c on c.id = e.class_id
  where e.id = p_ws;
$$;

-- Who may use a live channel. 'ws:<workspace id>' carries a student's terminal
-- and edits; 'class:<class id>' carries who-is-online.
create or replace function public.can_use_topic(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  if p_topic like 'ws:%' then
    return public.workspace_role(substring(p_topic from 4)::uuid) is not null;
  elsif p_topic like 'class:%' then
    v_id := substring(p_topic from 7)::uuid;
    return public.is_class_teacher(v_id)
        or exists (select 1 from public.enrollments e where e.class_id = v_id and e.student_id = (select auth.uid()));
  end if;
  return false;
exception when others then
  return false;
end $$;

-- ------------------------------------------------------------- row rules --

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "teacher reads own classes" on public.classes;
create policy "teacher reads own classes" on public.classes for select to authenticated
  using (public.is_class_teacher(id));

drop policy if exists "teacher deletes own classes" on public.classes;
create policy "teacher deletes own classes" on public.classes for delete to authenticated
  using (public.is_class_teacher(id));

drop policy if exists "read own or class enrollments" on public.enrollments;
create policy "read own or class enrollments" on public.enrollments for select to authenticated
  using (student_id = (select auth.uid()) or public.is_class_teacher(class_id));

drop policy if exists "teacher removes students" on public.enrollments;
create policy "teacher removes students" on public.enrollments for delete to authenticated
  using (public.is_class_teacher(class_id));

-- Files: the student, the class teacher and admins can read and change them.
drop policy if exists "read workspace files" on public.files;
create policy "read workspace files" on public.files for select to authenticated
  using (public.workspace_role(workspace_id) is not null);

drop policy if exists "student adds files" on public.files;
create policy "student adds files" on public.files for insert to authenticated
  with check (public.workspace_role(workspace_id) is not null);

drop policy if exists "student edits files" on public.files;
create policy "student edits files" on public.files for update to authenticated
  using (public.workspace_role(workspace_id) is not null)
  with check (public.workspace_role(workspace_id) is not null);

drop policy if exists "student deletes files" on public.files;
create policy "student deletes files" on public.files for delete to authenticated
  using (public.workspace_role(workspace_id) is not null);

-- Starter files: only the class's teacher (and admins).
drop policy if exists "teacher manages starter files" on public.class_files;
create policy "teacher manages starter files" on public.class_files for all to authenticated
  using (public.is_class_teacher(class_id))
  with check (public.is_class_teacher(class_id));

create or replace function public.limit_class_files() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.class_files f where f.class_id = new.class_id) >= 100 then
    raise exception 'A class can have at most 100 starter files';
  end if;
  return new;
end $$;

drop trigger if exists classcode_limit_class_files on public.class_files;
create trigger classcode_limit_class_files before insert on public.class_files
  for each row execute function public.limit_class_files();

-- Keep one workspace from filling the database.
create or replace function public.limit_workspace_files() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.files f where f.workspace_id = new.workspace_id) >= 200 then
    raise exception 'This workspace has reached its limit of 200 files';
  end if;
  return new;
end $$;

drop trigger if exists classcode_limit_files on public.files;
create trigger classcode_limit_files before insert on public.files
  for each row execute function public.limit_workspace_files();

-- Live channels (Supabase Realtime, private channels).
drop policy if exists "classcode live read" on realtime.messages;
create policy "classcode live read" on realtime.messages for select to authenticated
  using (public.can_use_topic((select realtime.topic())));

drop policy if exists "classcode live write" on realtime.messages;
create policy "classcode live write" on realtime.messages for insert to authenticated
  with check (public.can_use_topic((select realtime.topic())));

-- ---------------------------------------------------- functions the site calls --

create or replace function public.create_class(p_name text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_staff() then
    raise exception 'Only teachers can create classes';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Class name must be 1 to 80 characters';
  end if;
  if (select count(*) from public.classes c where c.teacher_id = (select auth.uid())) >= 100 then
    raise exception 'Class limit reached';
  end if;
  loop
    select string_agg(substr(v_alphabet, 1 + (get_byte(b, i) % 31), 1), '')
      into v_code
      from (select extensions.gen_random_bytes(8) as b) r, generate_series(0, 7) i;
    begin
      insert into public.classes (teacher_id, name, join_code) values ((select auth.uid()), v_name, v_code)
      returning id into v_id;
      exit;
    exception when unique_violation then
      -- extremely unlikely: try another code
    end;
  end loop;
  return json_build_object('id', v_id);
end $$;

create or replace function public.join_class(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_class public.classes;
  v_ws uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student') then
    raise exception 'Only students can join classes';
  end if;
  select * into v_class from public.classes c
   where c.join_code = regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  if not found then
    raise exception 'No class found with that code';
  end if;
  insert into public.enrollments (class_id, student_id) values (v_class.id, (select auth.uid()))
  on conflict (class_id, student_id) do nothing
  returning id into v_ws;
  -- New to this class: start with a copy of the teacher's starter files.
  if v_ws is not null then
    insert into public.files (workspace_id, path, content)
    select v_ws, cf.path, cf.content from public.class_files cf where cf.class_id = v_class.id;
  end if;
  return json_build_object('id', v_class.id, 'name', v_class.name);
end $$;

create or replace function public.my_classes() returns json
language sql stable security definer set search_path = '' as $$
  select case
    when public.is_staff() then (
      select coalesce(json_agg(json_build_object(
               'id', c.id, 'name', c.name, 'joinCode', c.join_code,
               'studentCount', (select count(*) from public.enrollments e where e.class_id = c.id),
               'teacherName', t.display_name, 'mine', c.teacher_id = (select auth.uid()))
             order by (c.teacher_id = (select auth.uid())) desc, c.created_at desc), '[]'::json)
      from public.classes c join public.profiles t on t.id = c.teacher_id
      where c.teacher_id = (select auth.uid()) or public.is_admin())
    else (
      select coalesce(json_agg(json_build_object(
               'id', c.id, 'name', c.name, 'teacherName', t.display_name, 'workspaceId', e.id)
             order by e.created_at desc), '[]'::json)
      from public.enrollments e
      join public.classes c on c.id = e.class_id
      join public.profiles t on t.id = c.teacher_id
      where e.student_id = (select auth.uid()))
  end;
$$;

create or replace function public.class_roster(p_class uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'class', json_build_object('id', c.id, 'name', c.name, 'joinCode', c.join_code),
    'students', (
      select coalesce(json_agg(json_build_object(
               'workspaceId', e.id, 'studentId', s.id, 'displayName', s.display_name)
             order by lower(s.display_name)), '[]'::json)
      from public.enrollments e join public.profiles s on s.id = e.student_id
      where e.class_id = c.id))
  from public.classes c
  where c.id = p_class and public.is_class_teacher(c.id);
$$;

create or replace function public.workspace_info(p_ws uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'id', e.id, 'classId', c.id, 'className', c.name,
    'studentId', s.id, 'studentName', s.display_name,
    'role', public.workspace_role(e.id))
  from public.enrollments e
  join public.classes c on c.id = e.class_id
  join public.profiles s on s.id = e.student_id
  where e.id = p_ws and public.workspace_role(e.id) is not null;
$$;

-- Give the starter files to students who are already in the class. Only adds
-- files a student doesn't have; never overwrites a student's own work.
create or replace function public.copy_starter_files(p_class uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_files int;
  v_students int;
begin
  if not public.is_class_teacher(p_class) then
    raise exception 'Class not found';
  end if;
  with added as (
    insert into public.files (workspace_id, path, content)
    select e.id, cf.path, cf.content
    from public.enrollments e join public.class_files cf on cf.class_id = e.class_id
    where e.class_id = p_class
    on conflict (workspace_id, path) do nothing
    returning workspace_id
  )
  select count(*), count(distinct workspace_id) into v_files, v_students from added;
  return json_build_object('files', v_files, 'students', v_students);
end $$;

-- Teacher and admin accounts, for the admin's "Manage teachers" page.
-- status is 'invited' until the person has set their password from the email.
create or replace function public.admin_list_staff() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can see this';
  end if;
  return (
    select coalesce(json_agg(json_build_object(
             'id', p.id, 'displayName', p.display_name, 'role', p.role, 'email', u.email,
             'status', case when coalesce(u.encrypted_password, '') = '' then 'invited' else 'active' end)
           order by p.role, lower(p.display_name)), '[]'::json)
    from public.profiles p join auth.users u on u.id = p.id
    where p.role in ('teacher', 'admin'));
end $$;

-- ---------------------------------------------------------------- grants --

grant select on public.profiles to authenticated;
grant select, delete on public.classes to authenticated;
grant select, delete on public.enrollments to authenticated;
grant select, insert, update, delete on public.files to authenticated;
grant select, insert, update, delete on public.class_files to authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.limit_workspace_files() from public, anon, authenticated;
revoke all on function public.limit_class_files() from public, anon, authenticated;
revoke all on function public.copy_starter_files(uuid) from public, anon;
grant execute on function public.copy_starter_files(uuid) to authenticated;
revoke all on function public.create_class(text) from public, anon;
revoke all on function public.join_class(text) from public, anon;
revoke all on function public.my_classes() from public, anon;
revoke all on function public.class_roster(uuid) from public, anon;
revoke all on function public.workspace_info(uuid) from public, anon;
revoke all on function public.admin_list_staff() from public, anon;
revoke all on function public.is_staff() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.admin_list_staff() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.create_class(text) to authenticated;
grant execute on function public.join_class(text) to authenticated;
grant execute on function public.my_classes() to authenticated;
grant execute on function public.class_roster(uuid) to authenticated;
grant execute on function public.workspace_info(uuid) to authenticated;
grant execute on function public.is_class_teacher(uuid) to authenticated;
grant execute on function public.workspace_role(uuid) to authenticated;
grant execute on function public.can_use_topic(text) to authenticated;
