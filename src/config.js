import path from 'node:path';

const env = process.env;
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  // Control plane (dashboard + API)
  host: env.HOST || '0.0.0.0',
  port: int(env.PORT, 8080),
  // Hostname/IP students use to reach this machine. Defaults to whatever is in the browser's address bar.
  publicHost: env.PUBLIC_HOST || null,
  dataDir: path.resolve(env.DATA_DIR || './data'),

  // Workspaces
  idleMs: int(env.IDLE_TIMEOUT_MINUTES, 60) * 60_000,
  portStart: int(env.WORKSPACE_PORT_START, 9000),
  portCount: int(env.WORKSPACE_PORT_COUNT, 200),
  driver: env.WORKSPACE_DRIVER || 'docker', // 'docker' | 'process'
  startTimeoutMs: int(env.WORKSPACE_START_TIMEOUT_SECONDS, 120) * 1000,

  // docker driver
  image: env.WORKSPACE_IMAGE || 'codercom/code-server:latest',
  memory: env.WORKSPACE_MEMORY || '1g',
  cpus: env.WORKSPACE_CPUS || '1',
  pidsLimit: int(env.WORKSPACE_PIDS_LIMIT, 512),
  network: env.WORKSPACE_NETWORK || 'classcode-net',

  // process driver (development only, no isolation between students)
  codeServerBin: env.CODE_SERVER_BIN || 'code-server',

  // Optional HTTPS (strongly recommended: VS Code needs a secure context for clipboard and webviews)
  tlsCert: env.TLS_CERT || null,
  tlsKey: env.TLS_KEY || null,

  // If set, creating a teacher account requires this code
  teacherSignupCode: env.TEACHER_SIGNUP_CODE || null,
};

config.scheme = config.tlsCert && config.tlsKey ? 'https' : 'http';
