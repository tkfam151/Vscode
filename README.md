# ClassCode

A coding classroom that runs on **GitHub Pages + Supabase**. No server to rent or look after.

- **Teachers** create an account, create classes, and get a join code for each class.
- **Students** create an account, join with the code, and get their own workspace: a VS Code-style editor, a terminal, and a web-page preview.
- **Teachers watch any student's terminal live**, see their files update as they type, and can type into the student's terminal themselves.
- **Workspaces close after 1 hour without activity.** The student has to reopen it each time; their files are kept.

Students can run:

| | How |
| --- | --- |
| **Python** | `python main.py`, an interactive `python` prompt, `input()`, reading and writing files |
| **JavaScript** | `node app.js` |
| **Web pages** | HTML/CSS/JS with a live preview pane |
| **Shell basics** | `ls`, `cd`, `cat`, `mkdir`, `rm`, `mv`, `cp`, `echo > file`, `clear`, `help` |

## What this is not

The terminal runs inside the student's own browser tab. It is **not a real Linux machine**: there is no `apt`, `git`, `gcc`, Java, or other system software, and programs cannot open network servers. If you need that, use the server version in this repository instead — see [SERVER.md](SERVER.md). It needs a Linux server but gives every student the real VS Code and a real Linux terminal.

## Try it first (no setup)

Until you add Supabase details, the site runs in **demo mode**: accounts and files are stored in your browser only. Open the site in two tabs, sign up as a teacher in one and a student in the other, and you can try everything, including the live teacher view.

## Setup

### 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a new project (the free plan is enough to start).
2. Open **SQL Editor**, paste in the whole of [`supabase/schema.sql`](supabase/schema.sql), and press **Run**.
3. Open **Authentication → Sign In / Providers → Email** and turn **Confirm email** off.
   With it on, Supabase's built-in mailer only sends a few emails per hour, so a class signing up together would get stuck. (If you want confirmation emails, set up your own SMTP provider in Supabase instead.)
4. Open **Realtime → Settings** and turn **Allow public access** off, so live channels can only be used by people the database rules allow.
5. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. Add your project details to the site

Edit [`docs/config.js`](docs/config.js):

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

Both values are meant to be public. What each person can see or change is enforced by the rules in `schema.sql`, not by keeping the key secret. Never put the **service_role** key here.

### 3. Turn on GitHub Pages

In the repository on GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, choose your branch and the **`/docs`** folder, and save. After a minute the site is live at `https://<your-username>.github.io/<repository>/`.

Give that address to your students.

## How it works

```
GitHub Pages   serves the site (editor, terminal, Python runtime) as plain files
Supabase       accounts, classes, saved files, and the live relay between student and teacher
Browser        runs the student's code
```

- **Running code**: Python runs through [Pyodide](https://pyodide.org) (Python compiled for the browser), JavaScript runs in a browser worker, and web pages render in a sandboxed frame that cannot touch the rest of the site.
- **Live view**: the student's tab sends terminal output and file edits over a private Supabase Realtime channel. The teacher's tab shows them and sends keystrokes back. Only the student and the teacher of that class can join a workspace's channel.
- **Idle close**: the workspace page watches for keyboard, mouse and touch input (the teacher typing also counts). After `IDLE_MINUTES` (set in `docs/config.js`, default 60) the session ends and a "Reopen workspace" button appears. Closing the tab also closes the workspace.
- **Files** are saved to Supabase as the student types: up to 200 files per workspace, 256 KB each, text only.

## Things to know

- **Use Chrome or Edge.** Python's `input()` relies on a browser feature that Firefox and Safari may not have yet. Everything else works in any modern browser.
- **Extra Python packages** (`numpy`, `pandas`, `matplotlib`, or `pip install <name>`) are downloaded from the Pyodide CDN (`cdn.jsdelivr.net`) the first time they are imported. If your school network blocks that address, only the standard library is available. This download path could not be tested in the build environment, so try `import numpy` once before relying on it.
- **Anyone who finds the site can sign up as a teacher.** A teacher account only controls its own classes, so this does not expose other classes, but it does use your Supabase quota. To lock it down, turn off sign-ups in Supabase once your accounts exist.
- **A student's code runs on the student's own device.** A slow laptop means slow programs, and Ctrl+C stops a runaway program by restarting Python.
- **Teachers can read files and use the terminal, not edit files directly** in the editor. Use the terminal (`echo`, running code) or ask the student.
- **Supabase free plan limits** apply (database size, simultaneous live connections, messages per month). A typical single class is well inside them; check Supabase's pricing page if you plan to run many classes at once.

## Repository layout

| Path | What |
| --- | --- |
| `docs/` | The GitHub Pages site |
| `docs/config.js` | Supabase details and the idle timeout |
| `docs/js/` | Dashboard, workspace page, terminal/shell, Python worker, data layers |
| `docs/vendor/` | Bundled libraries: Monaco editor, xterm.js, Pyodide, supabase-js |
| `supabase/schema.sql` | Tables, access rules and functions |
| `server.js`, `src/`, `public/`, `test/` | The separate server version ([SERVER.md](SERVER.md)) |
