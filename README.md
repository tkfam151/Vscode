# ClassCode

A coding classroom that runs on **GitHub Pages + Supabase**. No server to rent or look after.

- **Admins** create teacher accounts. The teacher gets an email with a link and chooses their own password. Nobody can sign up as a teacher on the website.
- **Teachers** create classes and get a join code for each class.
- **Teachers message the whole class**: a message typed on the class page pops up on every student's screen right away, or the next time they open their workspace, and shows on their dashboard. Teachers can delete a message for everyone.
- **Each class has a model workspace**: starter files the teacher writes (and can try out in their own terminal). Every student who joins the class gets their own copy. A button also gives the files to students who joined earlier; it only adds files a student doesn't have, so it never overwrites a student's work.
- **Students** create their own account, join with the code, and get their own workspace: a VS Code-style editor, a terminal, and a web-page preview.
- **Teachers watch any student's terminal live**, can type into it, and can **edit the student's files and press Run**. When the student isn't there, the teacher can still open the workspace, edit and run the code (it runs in the teacher's own browser).
- **Admins can open every class and every student's workspace**, with the same abilities as the class's teacher.
- **Workspaces close after 1 hour without activity.** The student has to reopen it each time; their files are kept.

Students can write any language (the editor colours 80+ languages, including Java, C, C++, C#, Go, Rust, Ruby and PHP). These run in the browser:

| Language | Run with |
| --- | --- |
| **Python** | **Run**, `python main.py`, an interactive `python` prompt, `input()`, reading and writing files, `pip install` |
| **JavaScript** | **Run**, `node app.js` |
| **TypeScript** | **Run**, `node app.ts` (compiled by the editor's built-in TypeScript) |
| **HTML / CSS / JS web pages** | **Run** or `preview` shows the page in the preview pane |
| **Pictures (JPG, PNG, GIF, WebP, SVG...)** | Upload with the ⬆ button or drag them onto the file list. Click one to view it. Web pages can use them with `<img src="cat.jpg">`, CSS `url(...)`, or from JavaScript (`img.src = 'player.png'`), and Markdown with `![](cat.jpg)`. Python reads and writes them as real image files. Photos bigger than 1600 px are scaled down on upload; pictures can be up to about 2 MB. |
| **Markdown** | **Run** or `preview notes.md` shows it formatted |
| **SQL (SQLite)** | **Run** on a `.sql` file prints result tables; `sqlite` opens an interactive `sqlite>` prompt. Each run starts with an empty database. |
| **Lua** | **Run**, `lua game.lua` (Lua 5.3; `io.read` input isn't supported) |
| **Shell scripts** | **Run**, `bash build.sh`: runs the terminal commands below, one per line |
| **Packages** | `pip install NAME` (also `-r requirements.txt`, `pip list`, `uninstall`, `freeze`, `show`) and `npm install NAME` (also `npm init`, `uninstall`, `ls`, `run`, `start`, `test`). pip remembers packages in `requirements.txt` and npm in `package.json`, so they come back automatically next time. JavaScript can `require()` or `import` installed packages. |
| **A Mac-style terminal** | `alice@SISB ~ %` prompt (teachers and admins see `mslee@SISBADMIN ~ %`), Tab completion, history, pipes (`cat nums.txt \| sort -n \| head`), `&&` `\|\|` `;`, redirects (`> >> <`), `*.py` wildcards, `$VARIABLES` and `$?`, and `ls -la`, `cd`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `tree`, `sort`, `uniq`, `mkdir -p`, `cp -r`, `mv`, `rm -r`, `history`, `export`, `which`, `open`, `code FILE`… Programs can read typed or piped input (`echo 5 \| python double.py`). |
| **Internet from the terminal** | `curl` (GET, POST, `-H`, `-d`, `--json`, `-X`, `-i`, `-I`, `-o`, `-O`, `-f`, `-s`, `-w`) and `wget URL`. These are real web requests, so they work with sites that let web pages read them, which most public APIs do (for example `curl https://api.github.com/users/octocat`). Pictures downloaded with `-o` or `wget` appear in the file list. |
| **Folders** | Make folders with the 📁 button or `mkdir`. Select a folder and press **Run** (or type `run folder`) to run its main file: `main.py`, `__main__.py`, `app.py`, `index.html`, `main.js`, `index.js`, `main.ts`, `main.lua`, `main.sql` or `main.sh`. Python runs inside that folder, so files next to each other can import each other. |

Java, C, C++, C#, Go, Rust, Ruby, PHP and other compiled languages can be written and saved but not run here: pressing Run explains that. They need the server version ([SERVER.md](SERVER.md)).

**About packages:** pip and npm download real packages from the internet (PyPI through Pyodide, and npm through the jsDelivr CDN), so the school network must allow `pypi.org`, `files.pythonhosted.org` and `cdn.jsdelivr.net`. In the browser, pip can install pure-Python packages plus the science packages Pyodide provides (numpy, pandas, matplotlib, scikit-learn, …), and npm packages work when they run in a browser (lodash, dayjs, date, maths and text libraries, validators, …). Packages that need a real computer, such as web servers (express), database drivers or anything with compiled parts, don't. Tools like git, apt, brew, gcc and java show a clear "not available here" message. For a real Linux terminal with everything, use the server version.

## School logo and name

Set these in [`docs/config.js`](docs/config.js):

```js
export const SCHOOL_NAME = 'SISB';
export const SCHOOL_LOGO = 'logo.png';   // a file in the docs folder
export const APP_NAME = 'ClassCode';
```

The SISB logo is already included as `docs/logo.png`. Because the logo shows the school name, the header shows it next to just the app name ("ClassCode"). To replace it on GitHub: open the repository, go into the `docs` folder, choose **Add file → Upload files**, drop in the logo, name it `logo.png`, and commit to the branch your Pages site uses. Upload your logo to the `docs` folder with that file name (PNG, SVG or JPG; a square or wide logo about 200px tall works well). It appears on the sign-in screen, in every page header and as the browser-tab icon. Until the file is there, the name is shown as text.

## The workspace

A light, VS Code-style layout (one light theme, whatever the computer's setting):

- **Tabs** for open files; close with × or middle-click.
- **Files and Search** panels: search every file at once, then click a result to jump to that line.
- **Quick open** a file by typing part of its name (**Ctrl+P**).
- **Status bar**: line and column, language, save state, **Format** (tidies JavaScript, TypeScript, HTML, CSS and JSON), word wrap, and text size **A− / A+** (editor and terminal together).
- **Drag the dividers** to resize the file list, the terminal and the preview. Text size, wrap and panel sizes are remembered on that computer.
- **Terminal buttons**: **Stop** a running program and **Clear** the screen.
- **Download** the whole workspace as a `.zip` (⬇ in the file list).
- **Keyboard shortcuts** (the ⌨ button lists them all): Ctrl+Enter run, Ctrl+S save now, Ctrl+Shift+F search, Shift+Alt+F format, Ctrl+/ comment lines, Alt+Z wrap, Ctrl+\` jump between editor and terminal, F1 every editor command.

## What this is not

The terminal runs inside the student's own browser tab. It is **not a real Linux machine**: there is no `apt`, `git`, `gcc`, Java, or other system software, and programs cannot open network servers. If you need that, use the server version in this repository instead — see [SERVER.md](SERVER.md). It needs a Linux server but gives every student the real VS Code and a real Linux terminal.

## Try it first (no setup)

Until you add Supabase details, the site runs in **demo mode**: accounts and files are stored in your browser only, and no emails are sent. The first account you create becomes the admin. From **Manage teachers** you can invite a teacher; demo mode shows the "set password" link on screen instead of emailing it. Use a second tab as the teacher and a third as a student to try the live view.

## Setup

You need a free [Supabase](https://supabase.com) account and an email-sending account (see step 3).

### 1. Create the Supabase project and database

1. Create a new project in Supabase (the free plan is enough to start).
2. Open **SQL Editor**, paste in the whole of [`supabase/schema.sql`](supabase/schema.sql), and press **Run**. (If you set up an earlier version, run it again: it updates in place.)
3. Open **Authentication → Sign In / Providers → Email** and turn **Confirm email** off, so students can sign in straight after signing up.
4. Open **Realtime → Settings** and turn **Allow public access** off, so live channels can only be used by people the database rules allow.
5. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. Add your project details to the site and turn on GitHub Pages

Edit [`docs/config.js`](docs/config.js):

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

Both values are meant to be public: what each person can see or change is enforced by `schema.sql`. Never put the **service_role** key in the site.

Then in the repository on GitHub: **Settings → Pages → Deploy from a branch**, choose your branch and the **`/docs`** folder, and save. The site appears at `https://<your-username>.github.io/<repository>/`.

### 3. Set up email (needed for teacher invites)

Supabase's built-in email only delivers to the members of your Supabase project and only a few per hour, so invites to your teachers would not arrive. Use your own email provider:

1. Get SMTP details from an email service (for example Resend, Brevo, SendGrid, Amazon SES, or your school's Google Workspace / Microsoft 365 mail).
2. In Supabase open **Authentication → Emails → SMTP Settings**, turn on **custom SMTP**, and enter the host, port, username, password and sender address.
3. Open **Authentication → URL Configuration**. Set **Site URL** to your Pages address (`https://<your-username>.github.io/<repository>/`) and add `https://<your-username>.github.io/<repository>/set-password.html` under **Redirect URLs**. The invite link only works with this in place.
4. Optional: in **Authentication → Emails → Templates**, edit the **Invite user** email (for example "You've been added as a teacher on ClassCode").

### 4. Deploy the admin-users function

Creating teacher accounts and sending invites needs Supabase's secret service-role key, so it runs on Supabase as an Edge Function, not in the website. Either:

- **In the Supabase dashboard:** **Edge Functions → Deploy a new function → Via Editor**, name it exactly `admin-users`, replace the example code with the contents of [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts), and deploy.
- **Or with the Supabase CLI:** `supabase functions deploy admin-users --project-ref <your-project-ref>` from this repository.

The function reads the project URL and secret key that Supabase provides to every function; there is nothing else to configure. It checks for itself that the caller is an admin, so in the function's **Details** you can turn **Verify JWT with legacy secret** off. Do that if the admin page reports "Invalid JWT" or "Unauthorized" (projects using the newer `sb_publishable_…` keys need it off).

### 5. Make yourself the first admin

1. Open the site and create an account with your own email (it starts as a student account).
2. In Supabase's **SQL Editor**, run this with your email:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@yourschool.org');
```

3. Sign out and back in. You'll see **Manage teachers**, where you invite your teachers (and, if you want, other admins).

## How it works

```
GitHub Pages   serves the site (editor, terminal, Python runtime) as plain files
Supabase       accounts, classes, saved files, and the live relay between student and teacher
Browser        runs the student's code
```

- **Running code**: Python runs through [Pyodide](https://pyodide.org) (Python compiled for the browser); JavaScript and TypeScript run in a Node.js-like runner (`require`/`import`, npm packages, `fs`, `path`, `readline`, `process`); Lua and SQLite have their own runners. Each program runs in a background worker, so Stop (Ctrl+C) always works. Web pages render in a sealed preview frame that can't reach the rest of the site; files a page names that aren't in the workspace simply fail to load, as they would on a real web server.
- **Live view**: the student's tab sends terminal output and file edits over a private Supabase Realtime channel. The teacher's tab shows them and sends back keystrokes, file edits and Run. Only the student, the class's teacher and admins can join a workspace's channel.
- **Model workspace**: starter files live in their own table (`class_files`). When a student joins, the database copies them into the student's workspace in the same step. Later changes to the model don't change students' copies; use **Give to students already in the class** to add new files to everyone.
- **Accounts**: everyone who signs up on the site is a student. The `admin-users` function invites teachers by email and gives them the teacher role; the "set password" link lands on `set-password.html`. On **Manage teachers** an admin can resend an invite, send a password-reset email to a teacher who has forgotten theirs, or remove a teacher (which also deletes that teacher's classes and the students' work in them).
- **Idle close**: the workspace page watches for keyboard, mouse and touch input (the teacher typing also counts). After `IDLE_MINUTES` (set in `docs/config.js`, default 60) the session ends and a "Reopen workspace" button appears. Closing the tab also closes the workspace.
- **Files** are saved to Supabase as the student types: up to 200 files and folders per workspace, text files up to 256 KB and pictures up to about 2 MB each.
- **Class messages** are stored in the `announcements` table and sent live over the class's channel; only that class's teacher (or an admin) can post or delete them, and only its students can read them.

## Things to know

- **Use Chrome or Edge.** Python's `input()` relies on a browser feature that Firefox and Safari may not have yet. Everything else works in any modern browser.
- **Packages need the internet.** Python's science packages (`numpy`, `pandas`, `matplotlib`, …) load from `cdn.jsdelivr.net` the first time they're imported, `pip install` downloads from `pypi.org` and `files.pythonhosted.org`, and npm packages come from `cdn.jsdelivr.net`. If the school network blocks those addresses, only the built-in libraries work. Try `pip install cowsay` and `npm install lodash` once on your network to check.
- **Anyone who finds the site can create a student account.** Without a join code it can't see any class, but it does use your Supabase quota.
- **Students can't reset a forgotten password themselves yet.** An admin can send password resets to teachers from **Manage teachers**; for a student, delete their account in Supabase (**Authentication → Users**) and have them sign up again, or set a new password there.
- **A student's code runs on the student's own device.** A slow laptop means slow programs, and Ctrl+C stops a runaway program by restarting Python.
- **When a teacher and student type in the same file at once**, both edits are kept, but if they type on the same line at the same moment the result can be jumbled. In practice, take turns on a line.
- **Supabase free plan limits** apply (database size, simultaneous live connections, messages per month). A typical single class is well inside them; check Supabase's pricing page if you plan to run many classes at once.

## Repository layout

| Path | What |
| --- | --- |
| `docs/` | The GitHub Pages site |
| `docs/config.js` | Supabase details, idle timeout, school name and logo |
| `docs/logo.png` | The school logo |
| `docs/js/` | Dashboard, workspace page, terminal (`shell.js`), program runners (`py-worker.js`, `node-worker.js`, `lua-worker.js`), data layers |
| `docs/vendor/` | Bundled libraries: Monaco editor, xterm.js, Pyodide, supabase-js, marked, sql.js, Fengari (see `docs/vendor/README.md`) |
| `supabase/schema.sql` | Tables, access rules and functions |
| `supabase/functions/admin-users/` | Edge Function: invite, resend and remove teacher accounts |
| `server.js`, `src/`, `public/`, `test/` | The separate server version ([SERVER.md](SERVER.md)) |
