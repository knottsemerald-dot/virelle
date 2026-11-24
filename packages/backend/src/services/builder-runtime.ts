/** Runtime helpers owned by the optional Builder release feature. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { identity, safeEnv } from './process-tools.js';

function trustedDirectory(path: string): void {
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    if (st.isSymbolicLink() || st.uid !== 0 || ((st.mode & 0o022) && !(st.mode & 0o1000))) throw new Error('Release directory ancestry is writable or untrusted');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function stateDir() {
  const path = process.env.BYTELIGHT_CODE_STATE_DIR || '/var/lib/bytelight-code';
  if (!path.startsWith('/') || resolve(path) !== path) throw new Error('Absolute release state directory required');
  mkdirSync(path, { recursive: true, mode: 0o700 }); trustedDirectory(path);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new Error('Release state directory must be root-owned 0700');
  return path;
}
function atomic(path: string, value: object) { writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path); }
export function workerReady(key: string, dir = stateDir()) {
  if (!/^[a-f0-9]{64}$/.test(key) || process.getuid?.() !== 0) throw new Error('Invalid release worker');
  const lock = JSON.parse(readFileSync(join(dir, 'deploy.lock'), 'utf8'));
  if (lock.key !== key || lock.state !== 'starting') throw new Error('Release worker starting lock mismatch');
  atomic(join(dir, `${key}.ready`), { key, pid: process.pid });
}
export async function startDetachedWorker(worker: string, key: string, dir: string,
  start: (file: string, args: string[], options: SpawnOptions) => { once(event: string, listener: (...args: any[]) => void): unknown; unref(): void } = spawn,
  timeoutMs = 5000, launch?: { args: string[]; env: NodeJS.ProcessEnv }) {
  let failure: unknown;
  const child = start(process.execPath, [worker, ...(launch?.args || ['--builder-launch', key])], { detached: true, stdio: 'ignore', env: launch?.env || safeEnv(), cwd: dir });
  child.once('error', e => { failure = e; }); child.once('exit', code => { if (code !== 0) failure = new Error('Release worker bootstrap failed'); }); child.unref();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (failure) throw failure;
    const ready = join(dir, `${key}.ready`);
    if (existsSync(ready)) {
      const fd = openSync(ready, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const st = fstatSync(fd); const value = JSON.parse(readFileSync(fd, 'utf8')); if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o077) || value.key !== key || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Invalid release worker handshake'); }
      finally { closeSync(fd); }
      return;
    }
    if (Date.now() >= deadline) throw new Error('Release worker ready handshake timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
export async function waitForReparent(parent: number, current = () => process.ppid, pause = () => new Promise<void>(r => setTimeout(r, 20))) {
  const deadline = Date.now() + 5000;
  while (parent !== 1 && current() === parent) { if (Date.now() >= deadline) throw new Error('Worker did not detach'); await pause(); }
}
export function configuration(workspace?: string) {
  const get = (name: string) => { const p = process.env[`BYTELIGHT_CODE_${name}`]; if (!p || !p.startsWith('/') || resolve(p) !== p || realpathSync(p) !== p) throw new Error(`Canonical existing ${name} required`); return p; };
  const dev = workspace || get('WORKSPACE'), prod = get('PRODUCTION'), staging = get('STAGING_DIR'), backup = get('BACKUP_DIR'), state = stateDir();
  const builder = identity('BYTELIGHT_BUILD');
  const app = process.env.BYTELIGHT_CODE_PM2_APP, health = process.env.BYTELIGHT_CODE_HEALTH_URL, sqlite = process.env.BYTELIGHT_CODE_SQLITE_PATH;
  if (!app || !/^[a-zA-Z0-9_-]+$/.test(app) || !health || !/^http:\/\/127\.0\.0\.1:\d+\/api\/health$/.test(health) || !sqlite || !sqlite.startsWith(prod + '/')) throw new Error('Release runtime configuration incomplete');
  return { dev, prod, staging, backup, state, builder, app, health, sqlite };
}
export const protectedCompiledPaths = [
  'services/builder-deployment.js', 'services/builder-deployment-worker.js', 'services/builder-release-bundle.js', 'services/builder-release-dependencies.js', 'services/builder-release-ci.js',
  'services/process-tools.js', 'services/code-authorization.js', 'services/code-delegation.js', 'services/chat-tool-belt.js', 'services/agent.js', 'services/agent/turn-input.js',
  'services/turn-origin.js', 'services/turn-audience.js', 'services/mcp-bridge.js', 'services/mcp-belt-auth.js', 'middleware/auth.js', 'routes/api.js', 'config.js', 'services/ws.js',
].map(path => `packages/backend/dist/${path}`);
export async function stableDeploymentHealth(cfg: { app: string; health: string; prod?: string }, io: { run(file: string,args: string[],cwd?: string): unknown; health(url: string): Promise<void> }, pause = false) {
  let consecutive = 0, error: unknown, previous = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    try { const list = JSON.parse(String(io.run('/usr/bin/pm2', ['jlist'], cfg.prod || '/') || 'null')); const matches = Array.isArray(list) ? list.filter(p => p.name === cfg.app) : []; const app = matches[0], restarts = app?.pm2_env?.restart_time; if (matches.length !== 1 || app.pm2_env?.status !== 'online' || !Number.isSafeInteger(app.pid) || !Number.isSafeInteger(restarts)) throw new Error('Application health state invalid'); const current=`${app.pid}:${restarts}`; if(current!==previous)consecutive=0; previous=current; await io.health(cfg.health); if(++consecutive===3)return {pid:app.pid as number,restarts:restarts as number}; }
    catch(e){consecutive=0;previous='';error=e;} if(pause)await new Promise(r=>setTimeout(r,500));
  }
  throw new Error(`Consecutive release health checks failed: ${String(error)}`);
}
