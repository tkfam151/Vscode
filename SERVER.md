# ClassCode — server version (real VS Code and Linux terminals)

This is the self-hosted version: it needs your own Linux server, and in return every student gets the real VS Code with a real Linux terminal. For the version that runs on GitHub Pages with no server, see [README.md](README.md).

A self-hosted classroom platform that gives every student their own VS Code in the browser, served straight from your server's IP address.

- **Teachers** create an account, create classes, and get a join code for each class.
- **Students** create an account, join a class with the code, and get their own private VS Code (editor + terminal) for that class.
- **Teachers can open any student's workspace** in their classes — same files, same environment, with their own terminal in it.
- **Workspaces close after 1 hour without activity.** The student (or teacher) has to reopen it from the dashboard each time it closes. Files are kept between sessions.

Each workspace is a [code-server](https://github.com/coder/code-server) instance running in its own Docker container.

## Run it

Requirements: Linux server, Node.js 22.13+, Docker. There are no npm dependencies to install.

```bash
npm start
```

The first start builds the workspace image (`classcode-workspace`, from the `workspace-image` folder); this takes a few minutes and needs internet access. You can also build it ahead of time with `docker build -t classcode-workspace workspace-image`.

Then browse to `http://<server-ip>:8080`.

Open these ports in your firewall:

| Port | Purpose |
| --- | --- |
| `8080` | Dashboard (sign in, classes) |
| `9000–9199` | One port per running workspace, e.g. `http://<server-ip>:9000` |

The user running `npm start` must be allowed to use Docker.

## What students' terminals can do

Each student's workspace is a real Linux computer (a Docker container) with:

- **Node.js 22 and npm**: `npm i icoa-cli`, `npx icoa`, or `npm i -g icoa-cli` and then just `icoa`. Global installs go into the student's home folder, so they need no `sudo` and are still there next time.
- **Python 3 and pip**: `pip install requests` installs for that student (into `~/.local`) and is kept.
- **git, curl, compilers** (`build-essential`), `zip`/`unzip`, `nano`.
- **Homebrew**, if the student wants it, with the official command:

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```

  Homebrew is installed into `/home/linuxbrew`, which has its own volume per student, so it's still there when the workspace is reopened. New terminals pick up `brew` automatically. Homebrew downloads several hundred MB, so the first install takes a while.
- `sudo` without a password, inside the student's own container only.

Students need internet access from the server for npm, pip and Homebrew: `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `github.com`, `ghcr.io` and `raw.githubusercontent.com`.

## How it works

```
browser ──► :8080            dashboard + API (accounts, classes, start/stop)
browser ──► :9000, :9001 …   one authenticated proxy port per running workspace
                 │
                 └──► 127.0.0.1:<private port> ──► student's container (code-server)
```

- Opening a workspace starts the student's container, picks a free port, and sends the browser there with a one-time link. Only that student and the class's teacher can get a link.
- The workspace page tracks real input (keys, mouse, touch). An open-but-untouched tab does not count as activity. After the idle timeout the container is stopped and the port closes; the page shows a "Reopen workspace" button.
- Files live in a Docker volume per student per class (`classcode-ws-<id>`), mounted at `/home/coder`, and Homebrew in a second one (`classcode-ws-<id>-brew`) mounted at `/home/linuxbrew`. Removing a student from a class or deleting the class deletes both.
- Stopping the server (Ctrl+C / SIGTERM) closes all running workspaces.

## Configuration

Set these as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Dashboard port |
| `HOST` | `0.0.0.0` | Address to listen on |
| `PUBLIC_HOST` | (from browser) | IP/hostname to put in workspace links, if different from what users type |
| `IDLE_TIMEOUT_MINUTES` | `60` | Close a workspace after this long without activity |
| `WORKSPACE_PORT_START` | `9000` | First workspace port |
| `WORKSPACE_PORT_COUNT` | `200` | Number of ports = max workspaces open at once |
| `WORKSPACE_IMAGE` | `classcode-workspace:latest` | Container image for workspaces (built automatically from `workspace-image/`; set `codercom/code-server:latest` for the plain image without Node.js/Python) |
| `WORKSPACE_MEMORY` | `2g` | Memory limit per workspace (npm and Homebrew need room) |
| `WORKSPACE_CPUS` | `1` | CPU limit per workspace |
| `WORKSPACE_PIDS_LIMIT` | `512` | Process limit per workspace |
| `TEACHER_SIGNUP_CODE` | (none) | If set, creating a teacher account requires this code |
| `TLS_CERT`, `TLS_KEY` | (none) | Paths to a certificate and key; serves everything over HTTPS |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |
| `WORKSPACE_DRIVER` | `docker` | `process` runs code-server directly on the host (development only, no isolation) |
| `CODE_SERVER_BIN` | `code-server` | Binary used by the `process` driver |

Rough sizing: budget `WORKSPACE_MEMORY` per student who has a workspace open at the same time.

To give students more tools (Java, Go, …), add them to `workspace-image/Dockerfile` and rebuild with `docker build -t classcode-workspace workspace-image` (running workspaces pick it up the next time they open).

## Things to know before putting it in front of a class

- **Use HTTPS if you can.** Over plain `http://<ip>`, passwords travel unencrypted and browsers disable some VS Code features (clipboard access, webviews such as Markdown preview). The editor and terminal work either way. Set `TLS_CERT`/`TLS_KEY` to enable HTTPS; the same certificate is used for the dashboard and every workspace port.
- **Set `TEACHER_SIGNUP_CODE`** on a server reachable from the internet. Otherwise anyone can create a teacher account (they would only control their own classes, but could still start containers on your server).
- **Students have root inside their own container** (the stock code-server image has passwordless `sudo`) and outbound internet access. Containers are resource-limited and cannot reach each other, but treat the server as one that runs untrusted code.
- A teacher and a student in the same workspace share files and can each open terminals; they do not see each other's keystrokes inside one terminal.

## Development

```bash
npm test        # end-to-end tests of accounts, classes, access control, the proxy and idle shutdown
```

Layout:

- `server.js` – entry point
- `src/api.js` – dashboard API and static files
- `src/workspaces.js` – workspace lifecycle, per-workspace proxy, idle reaper
- `src/drivers.js` – Docker and local-process launchers
- `src/shell.html` – the page that wraps VS Code and reports activity
- `src/db.js` – SQLite schema and queries
- `public/` – dashboard UI
