// Picks the data layer: Supabase when configured, otherwise the in-browser demo.
//
// Both implementations expose the same async API:
//   init() -> user | null                user = { id, displayName, role: 'admin' | 'teacher' | 'student' }
//   signUp({ email, password, displayName }) -> user   (always a student)
//   signIn({ email, password }) -> user
//   signOut()
//   listStaff() -> [{ id, displayName, email, role, status: 'invited' | 'active' }]   admin only
//   inviteStaff({ email, displayName, role }) -> { demoLink? }                      admin only, emails an invite
//   resendInvite(id) -> { sent: 'invite' | 'reset', demoLink? }                     admin only
//   removeStaff(id)                                                                 admin only
//   invitedUser() -> { email, displayName } | null      on set-password.html, from the email link
//   setPassword(password)                               on set-password.html; signs the user in
//   listClasses()        teacher/admin: [{ id, name, joinCode, studentCount }]
//                        student: [{ id, name, teacherName, workspaceId }]
//   createClass(name) -> { id }
//   deleteClass(id)
//   getRoster(classId) -> { class: { id, name, joinCode }, students: [{ workspaceId, studentId, displayName }] }
//   listStarterFiles(classId) / saveStarterFile(classId, path, content) / deleteStarterFile(classId, path)
//                        the class's model workspace; teacher/admin only
//   copyStarterToStudents(classId) -> { files, students }   adds missing starter files to every student
//   listAnnouncements(classId) -> [{ id, classId, body, createdAt, authorName }]   newest first; class members
//   postAnnouncement(classId, body) -> { id, classId, body, createdAt }            teacher/admin
//   deleteAnnouncement(id)                                                          teacher/admin
//   joinClass(code)      a new student starts with a copy of the starter files
//   removeStudent(workspaceId)
//   getWorkspace(id) -> { id, classId, className, studentId, studentName, role: 'student' | 'teacher' }
//   listFiles(workspaceId) -> [{ path, content }]
//   saveFile(workspaceId, path, content)
//   deleteFile(workspaceId, path)
//   channel(name) -> live channel, see below
//
// A live channel relays messages between everyone allowed on it:
//   await ch.ready
//   ch.on(event, (payload) => {})
//   ch.send(event, payload)
//   ch.track(state)            announce "I am here" (presence)
//   ch.onPresence((states) => {})
//   ch.close()

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

export const demoMode = !SUPABASE_URL || !SUPABASE_ANON_KEY;

const mod = demoMode ? await import('./backend-local.js') : await import('./backend-supabase.js');
export const backend = demoMode ? mod.create() : mod.create(SUPABASE_URL, SUPABASE_ANON_KEY);
