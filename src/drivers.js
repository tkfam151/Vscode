// Workspace drivers: how a student's code-server instance is actually run.
//   docker  - one container per student, isolated from other students (use this in production)
//   process - a local code-server process per student (development only, NO isolation)
//
// A driver exposes:
//   init()            -> clean up anything left over from a previous run
//   start(id)         -> { host, port } where code-server listens (loopback only)
//   stop(id)          -> stop the instance, keep the student's files
//   destroy(id)       -> stop the instance and delete the student's files
//   folderFor(id)     -> the folder code-server should open

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createDriver(config) {
  if (config.driver === 'docker') return new DockerDriver(config);
  if (config.driver === 'process') return new ProcessDriver(config);
  throw new Error(`Unknown WORKSPACE_DRIVER "${config.driver}" (expected "docker" or "process")`);
}

class DockerDriver {
  folder = '/home/coder/project';

  constructor(config) {
    this.config = config;
  }

  name(id) {
    return `classcode-ws-${id}`;
  }

  folderFor() {
    return this.folder;
  }

  async docker(...args) {
    const { stdout } = await exec('docker', args, { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  }

  async init() {
    try {
      await this.docker('version', '--format', '{{.Server.Version}}');
    } catch (e) {
      throw new Error(`Cannot talk to Docker (is the daemon running and is this user allowed to use it?): ${e.stderr || e.message}`);
    }
    // Dedicated network with inter-container traffic disabled, so one student
    // cannot reach another student's (unauthenticated) code-server directly.
    try {
      await this.docker('network', 'inspect', this.config.network);
    } catch {
      await this.docker('network', 'create', '-o', 'com.docker.network.bridge.enable_icc=false', this.config.network);
    }
    const stale = await this.docker('ps', '-aq', '--filter', 'label=classcode=1');
    if (stale) await this.docker('rm', '-f', ...stale.split('\n'));
    await this.ensureImage();
  }

  // The default image (Node.js 22, npm, Python/pip, git, compilers, Homebrew's
  // needs) is built from ./workspace-image the first time the server starts.
  async ensureImage() {
    const image = this.config.image;
    try {
      await this.docker('image', 'inspect', image);
      return;
    } catch {}
    if (!/^classcode-workspace(:|$)/.test(image)) {
      // someone else's image: let docker pull it on first use
      return;
    }
    const dir = path.resolve(new URL('../workspace-image', import.meta.url).pathname);
    console.log(`[classcode] building the workspace image "${image}" (first start only; this takes a few minutes)...`);
    const proxyArgs = [];
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      if (process.env[k]) proxyArgs.push('--build-arg', `${k}=${process.env[k]}`);
    }
    await new Promise((resolve, reject) => {
      const p = spawn('docker', ['build', '-t', image, ...proxyArgs, dir], { stdio: ['ignore', 'inherit', 'inherit'] });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`building the workspace image failed (docker build exited with ${code}). Fix the error above, or set WORKSPACE_IMAGE=codercom/code-server:latest to use the plain image.`))));
    });
  }

  async start(id) {
    const name = this.name(id);
    await this.docker('rm', '-f', name).catch(() => {});
    const c = this.config;
    await this.docker(
      'run', '-d', '--rm',
      '--name', name,
      '--label', 'classcode=1',
      '--network', c.network,
      '-p', '127.0.0.1::8080', // loopback only: the only way in is through our authenticated proxy
      '--memory', c.memory,
      '--cpus', c.cpus,
      '--pids-limit', String(c.pidsLimit),
      '-v', `${name}:/home/coder`,
      '-v', `${name}-brew:/home/linuxbrew`, // Homebrew, if the student installs it
      '--entrypoint', 'sh',
      c.image,
      '-c',
      `mkdir -p ${this.folder} && exec /usr/bin/entrypoint.sh --auth none --bind-addr 0.0.0.0:8080 --disable-telemetry --disable-update-check ${this.folder}`,
    );
    const mapping = await this.docker('port', name, '8080/tcp'); // e.g. 127.0.0.1:32768
    const port = Number(mapping.split('\n')[0].split(':').pop());
    if (!port) throw new Error(`could not determine published port for ${name}: ${mapping}`);
    return { host: '127.0.0.1', port };
  }

  async stop(id) {
    await this.docker('rm', '-f', this.name(id)).catch(() => {});
  }

  async destroy(id) {
    await this.stop(id);
    await this.docker('volume', 'rm', '-f', this.name(id), `${this.name(id)}-brew`).catch(() => {});
  }
}

class ProcessDriver {
  procs = new Map();

  constructor(config) {
    this.config = config;
    this.root = path.join(config.dataDir, 'workspaces');
  }

  dir(id) {
    return path.join(this.root, String(id));
  }

  folderFor(id) {
    return path.join(this.dir(id), 'project');
  }

  async init() {
    console.warn('[classcode] WORKSPACE_DRIVER=process: students are NOT isolated from each other or from this machine. Development only.');
    fs.mkdirSync(this.root, { recursive: true });
  }

  async start(id) {
    await this.stop(id);
    const dir = this.dir(id);
    fs.mkdirSync(this.folderFor(id), { recursive: true });
    const port = await freePort();
    const child = spawn(
      this.config.codeServerBin,
      [
        '--auth', 'none',
        '--bind-addr', `127.0.0.1:${port}`,
        '--user-data-dir', path.join(dir, 'user-data'),
        '--extensions-dir', path.join(dir, 'extensions'),
        '--disable-telemetry',
        '--disable-update-check',
        this.folderFor(id),
      ],
      { stdio: 'ignore', detached: true, env: { ...process.env, PORT: undefined, HOME: dir } },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new Error(`could not start ${this.config.codeServerBin}: ${e.message}`)));
    });
    child.once('exit', () => {
      if (this.procs.get(id) === child) this.procs.delete(id);
    });
    this.procs.set(id, child);
    return { host: '127.0.0.1', port };
  }

  async stop(id) {
    const child = this.procs.get(id);
    if (!child) return;
    this.procs.delete(id);
    if (child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig); // whole process group, including terminals the student started
      } catch {}
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }

  async destroy(id) {
    await this.stop(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
