/** Privileged coordinator. No model-controlled command, executable or filesystem path. */
import { spawn, execFileSync, type SpawnOptions } from 'node:child_process';
import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, existsSync, chownSync, readdirSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TurnAudience } from './turn-audience.js';
import { pendingPatch, gitBytes, identity, safeEnv, execution } from './code-patch.js';
export interface ApprovalContext { ownerMessageText?: string; isAutonomous?: boolean; audience?: TurnAudience; }
export function approved(ctx?: ApprovalContext): boolean {
  const text = ctx?.ownerMessageText?.trim().toLowerCase() || '';
  return ctx?.audience?.kind !== 'guest' && ctx?.isAutonomous === false && !/\b(?:no|not|don't|dont|never|stop|cancel|wait|hold|later|yet)\b/.test(text) && /^(?:deploy|let['’]?s deploy|ship it|(?:put|push) it live)[.!\s]*$/.test(text);
}
const reply = (value: object, ok = true) => ({ ok, result: JSON.stringify(value) });
function requestKey(branch: unknown, hash: unknown) {
  if (typeof branch !== 'string' || !/^codex\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(branch)) throw new Error('Invalid codex branch');
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid diff_sha256');
  return hash;
}
function trustedDirectory(path: string): void {
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    if (st.isSymbolicLink() || st.uid !== 0 || ((st.mode & 0o022) && !(st.mode & 0o1000))) throw new Error('Privileged directory ancestry is writable or untrusted');
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function stateDir(create = false) {
  const path = process.env.BYTELIGHT_CODE_STATE_DIR || '/var/lib/virelle-code';
  if (!path.startsWith('/') || resolve(path) !== path) throw new Error('Absolute canonical state directory required');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  trustedDirectory(path);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o777) !== 0o700 || realpathSync(path) !== path) throw new Error('State directory must be root-owned 0700 without symlinks');
  return path;
}
function atomic(path: string, value: object) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
}
export async function deployCodeStatus(args: Record<string, unknown>) {
  try {
    const key = requestKey(args.branch, args.diff_sha256);
    const value = JSON.parse(readFileSync(join(stateDir(), `${key}.json`), 'utf8'));
    if (value.branch !== args.branch) throw new Error('Branch mismatch');
    if (value.status === 'pending') {
      try {
        const lock = JSON.parse(readFileSync(join(stateDir(), 'deploy.lock'), 'utf8'));
        let alive = false;
        if (Number.isInteger(lock.pid) && lock.pid > 0) { try { process.kill(lock.pid, 0); alive = true; } catch {} }
        value.worker = { ...lock, alive };
        if (!alive) value.next = 'Worker is not running. Administrator must inspect the request, backup, source, artifacts and database before recovering this lock. Do not blindly remove it.';
      } catch { value.next = 'Pending result has no readable lock; administrator inspection required.'; }
    }
    return reply(value);
  } catch (e) { return reply({ error: String(e) }, false); }
}
export async function deployCode(args: Record<string, unknown>, ctx?: ApprovalContext) {
  if (!approved(ctx) || args.confirmation !== 'DEPLOY') return reply({ error: 'Live owner deployment approval required' }, false);
  try {
    const key = requestKey(args.branch, args.diff_sha256);
    if (process.env.BYTELIGHT_CODE_DEPLOYMENT_ENABLED !== 'true') throw new Error('Code deployment is disabled by the owner');
    if (process.getuid?.() !== 0) throw new Error('Root coordinator required');
    const cfg = configuration();
    if (gitBytes(cfg.dev, ['rev-parse', '--show-toplevel']).toString().trim() !== cfg.dev || gitBytes(cfg.prod, ['rev-parse', '--show-toplevel']).toString().trim() !== cfg.prod) throw new Error('Git workspace root mismatch');
    const snapshot = pendingPatch(cfg.dev);
    if (gitBytes(cfg.dev, ['branch', '--show-current']).toString().trim() !== args.branch || snapshot.diff_sha256 !== key) throw new Error('Branch/fingerprint mismatch');
    validateFiles(snapshot.files);
    const dir = stateDir(true);
    if (existsSync(join(dir, `${key}.json`))) {
      const previous = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
      if (previous.branch !== args.branch) throw new Error('Existing request branch mismatch');
      return reply({ ...previous, next: 'This fingerprint already has a request. Read deploy_code_status; never replay it.' });
    }
    const lock = join(dir, 'deploy.lock');
    // A lock is deliberately never auto-unlinked: a dead coordinator may have a live worker or touched production.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, state: 'starting', key }), { flag: 'wx', mode: 0o600 });
    try {
      writeFileSync(join(dir, `${key}.patch`), snapshot.patch, { mode: 0o600 });
      atomic(join(dir, `${key}.request`), { branch: args.branch, diff_sha256: key, head: gitBytes(cfg.dev, ['rev-parse', 'HEAD']).toString().trim() });
      atomic(join(dir, `${key}.json`), { status: 'pending', branch: args.branch, diff_sha256: key });
      const worker = fileURLToPath(new URL('./code-deployment-worker.js', import.meta.url));
      trustedDirectory(dirname(worker));
      const workerStat = lstatSync(worker);
      if (!workerStat.isFile() || workerStat.uid !== 0 || (workerStat.mode & 0o022)) throw new Error('Worker must be trusted root-owned compiled code');
      await startDetachedWorker(worker, key, dir);
      // Worker records its own PID; a fast worker must not race a parent lock rewrite.
    } catch (e) { atomic(join(dir, `${key}.json`), { status: 'failed', branch: args.branch, diff_sha256: key, error: String(e) }); cleanStartingLock(dir, key); throw e; }
    return reply({ status: 'pending', branch: args.branch, diff_sha256: key, next: 'Read deploy_code_status on the next turn.' });
  } catch (e) { return reply({ error: String(e) }, false); }
}
export function cleanStartingLock(dir: string, key: string) {
  const path = join(dir, 'deploy.lock');
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (lock.key === key && lock.state === 'starting' && lock.pid === process.pid) rmSync(path);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export function workerReady(key: string, dir = stateDir()) {
  if (!/^[a-f0-9]{64}$/.test(key) || process.getuid?.() !== 0) throw new Error('Invalid ready worker');
  const lock = JSON.parse(readFileSync(join(dir, 'deploy.lock'), 'utf8'));
  if (lock.key !== key || lock.state !== 'starting') throw new Error('Worker starting lock mismatch');
  atomic(join(dir, `${key}.ready`), { key, pid: process.pid });
}
export async function startDetachedWorker(worker: string, key: string, dir: string,
  start: (file: string, args: string[], options: SpawnOptions) => { once(event: string, listener: (...args: any[]) => void): unknown; unref(): void } = spawn,
  timeoutMs = 5000) {
  let failure: unknown;
  const child = start(process.execPath, [worker, '--launch', key], { detached: true, stdio: 'ignore', env: workerEnv(), cwd: dir });
  // Install both listeners immediately; an early exit must not race a later listener.
  child.once('error', e => { failure = e; });
  child.once('exit', code => { if (code !== 0) failure = new Error('Worker bootstrap failed'); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (failure) throw failure;
    const ready = join(dir, `${key}.ready`);
    if (existsSync(ready)) {
      const fd = openSync(ready, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o077) || st.size > 1024) throw new Error('Unsafe worker handshake');
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        if (value.key !== key || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid === process.pid) throw new Error('Invalid worker handshake');
      } finally { closeSync(fd); }
      return;
    }
    const result = join(dir, `${key}.json`);
    if (existsSync(result) && JSON.parse(readFileSync(result, 'utf8')).status === 'failed') throw new Error('Worker failed before ready');
    if (Date.now() >= deadline) throw new Error('Worker ready handshake timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
export async function waitForReparent(parent: number, current = () => process.ppid, pause = () => new Promise<void>(r => setTimeout(r, 20))) {
  const deadline = Date.now() + 5000;
  while (parent !== 1 && current() === parent) {
    if (Date.now() >= deadline) throw new Error('Worker did not detach from launcher');
    await pause();
  }
}
export function workerEnv() {
  const env = safeEnv();
  for (const name of ['WORKSPACE', 'PRODUCTION', 'STATE_DIR', 'STAGING_DIR', 'BACKUP_DIR', 'HEALTH_URL', 'PM2_APP', 'SQLITE_PATH']) {
    const k = `BYTELIGHT_CODE_${name}`; if (process.env[k]) env[k] = process.env[k];
  }
  for (const k of ['BYTELIGHT_BUILD_UID', 'BYTELIGHT_BUILD_GID', 'BYTELIGHT_CODEX_UID', 'BYTELIGHT_CODEX_GID']) env[k] = process.env[k];
  return env;
}
function configuration() {
  const get = (name: string) => { const p = process.env[`BYTELIGHT_CODE_${name}`]; if (!p || !p.startsWith('/') || resolve(p) !== p || realpathSync(p) !== p) throw new Error(`Canonical existing ${name} required`); return p; };
  const dev = get('WORKSPACE'), prod = get('PRODUCTION'), staging = get('STAGING_DIR'), backup = get('BACKUP_DIR'), state = stateDir();
  const paths = [dev, prod, staging, backup, state];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + '/') || paths[j].startsWith(paths[i] + '/')) throw new Error('Deployment directories must be disjoint');
  if (dev === '/root/production' || dev.startsWith('/root/production/')) throw new Error('Unsafe development directory');
  const builder = identity('BYTELIGHT_BUILD');
  const coder = identity('BYTELIGHT_CODEX');
  if (coder.gid === builder.gid || coder.uid === builder.uid || lstatSync(dev).uid !== coder.uid) throw new Error('Separate builder and Codex identities required');
  for (const p of [staging, backup, state, prod]) { trustedDirectory(p); const st = lstatSync(p); if (st.uid !== 0 || (st.mode & 0o022)) throw new Error('Privileged directory is writable by another identity'); }
  const app = process.env.BYTELIGHT_CODE_PM2_APP;
  const health = process.env.BYTELIGHT_CODE_HEALTH_URL;
  if (!app || !/^[a-zA-Z0-9_-]+$/.test(app) || !health || !/^http:\/\/127\.0\.0\.1:\d+\/api\/health$/.test(health)) throw new Error('Fixed PM2 app and loopback health URL required');
  const sqlite = process.env.BYTELIGHT_CODE_SQLITE_PATH;
  if (!sqlite || !sqlite.startsWith(prod + '/') || resolve(sqlite) !== sqlite) throw new Error('Fixed SQLite path required');
  return { dev, prod, staging, backup, state, builder, app, health, sqlite };
}
export function validateFiles(files: string[]) {
  if (!files.length) throw new Error('Empty patch');
  for (const p of files) if (p.startsWith('/') || p.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.bl-') || part === '.build-home') || /(^|\/)dist(\/|$)/.test(p) || /^packages\/frontend\/build(?:\/|$)/.test(p) || /(^|\/)code-(?:deployment(?:-worker)?|patch)\.(?:ts|js)$/.test(p) || /(^|\/)(?:package[^/]*\.json|npm-shrinkwrap\.json|[^/]*lock[^/]*|[^/]*\.(?:sh|bash|zsh|ksh|fish|ps1|bat|cmd)|scripts|\.github|\.npmrc|\.yarnrc[^/]*|pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json|bunfig\.toml|binding\.gyp|[^/]*config\.[^/]+|Makefile|Dockerfile)(\/|$)/i.test(p)) throw new Error(`Manual maintenance required: ${p}`);
}
const artifacts = ['packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'];
/** Anchor every traversal to an open directory fd; a builder cannot swap an ancestor for a symlink. */
function safeArtifactCopy(source: string, target: string): void {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o755 });
      for (const name of readdirSync(`/proc/self/fd/${fd}`)) safeArtifactCopy(`/proc/self/fd/${fd}/${name}`, join(target, name));
    } else if (st.isFile() && st.nlink === 1) {
      writeFileSync(target, readFileSync(fd), { mode: 0o644, flag: 'wx' });
    } else throw new Error('Unsafe staged artifact');
  } finally { closeSync(fd); }
}
function sealArtifact(stage: string, path: string, target: string): void {
  const fds: number[] = [];
  try {
    let anchor = stage;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const fd = openSync(anchor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      fds.push(fd); anchor = `/proc/self/fd/${fd}/${part}`;
    }
    const fd = openSync(anchor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    fds.push(fd);
    safeArtifactCopy(`/proc/self/fd/${fd}/${parts.at(-1)}`, target);
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
export interface DeploymentBoundary { configuration?(): ReturnType<typeof configuration>; chown?(path: string, uid: number, gid: number): void; snapshot?(cwd: string): ReturnType<typeof pendingPatch>; git?(cwd: string, args: string[]): Buffer; promote?(source: string, target: string): void; run(file: string, args: string[], cwd: string, options?: { uid: number; gid: number; env: NodeJS.ProcessEnv }): string | Buffer | void; health(url: string): Promise<void>; }
const boundary: DeploymentBoundary = {
  run(file, args, cwd, options) { const cmd = execution(file, args, options); return execFileSync(cmd.file, cmd.args, { cwd, env: options?.env || safeEnv('/root'), timeout: 20 * 60_000, stdio: 'pipe' }); },
  async health(url) { const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' }); if (!r.ok) throw new Error('Health check failed'); },
};
export async function runDeployment(key: string, io: DeploymentBoundary = boundary) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid worker key');
  const cfg = (io.configuration || configuration)(), dir = cfg.state;
  const snapshot = io.snapshot || pendingPatch;
  const git = io.git || gitBytes;
  const req = JSON.parse(readFileSync(join(dir, `${key}.request`), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'deploy.lock'), 'utf8'));
  if (lock.key !== key) throw new Error('Worker lock mismatch');
  atomic(join(dir, 'deploy.lock'), { pid: process.pid, key, state: 'running' });
  const result: Record<string, unknown> = { ...req, status: 'failed', validation: false, build: false, restart: false, health: false, rollback: null };
  const stage = join(cfg.staging, key), backup = join(cfg.backup, `${Date.now()}-${key}`);
  let touched = false;
  const prior: { path: string; existed: boolean }[] = [];
  const run = (f: string, a: string[], cwd = cfg.prod) => io.run(f, a, cwd);
  async function stableHealth() {
    let consecutive = 0, error: unknown, previous = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const list = JSON.parse(String(run('/usr/bin/pm2', ['jlist']) || 'null'));
        const matches = Array.isArray(list) ? list.filter(p => p.name === cfg.app) : [];
        const app = matches[0], restarts = app?.pm2_env?.restart_time;
        if (matches.length !== 1 || app.pm2_env?.status !== 'online' || !Number.isSafeInteger(app.pid) || app.pid <= 0 || !Number.isSafeInteger(restarts) || restarts < 0) throw new Error('PM2 application must be uniquely online with valid PID/restart count');
        const current = `${app.pid}:${restarts}`;
        if (current !== previous) consecutive = 0;
        previous = current;
        await io.health(cfg.health);
        if (++consecutive === 3) return { pid: app.pid as number, restarts: restarts as number };
      } catch (e) { consecutive = 0; previous = ''; error = e; }
      if (io === boundary) await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Consecutive PM2/health checks failed: ${String(error)}`);
  }

  try {
    const snap = snapshot(cfg.dev);
    if (snap.diff_sha256 !== key || git(cfg.dev, ['branch', '--show-current']).toString().trim() !== req.branch || git(cfg.dev, ['rev-parse', 'HEAD']).toString().trim() !== req.head) throw new Error('Development snapshot changed');
    validateFiles(snap.files);
    if (!snap.patch.equals(readFileSync(join(dir, `${key}.patch`)))) throw new Error('Request patch mismatch');
    mkdirSync(stage, { mode: 0o700 });
    // Archive trusts committed public HEAD content; pending private paths are rejected.
    const archive = git(cfg.dev, ['archive', req.head]);
    // Only fixed data files are written while root owns the new, inaccessible directory.
    const tar = join(stage, '.bl-source.tar'), patch = join(stage, '.bl-source.patch');
    writeFileSync(tar, archive, { mode: 0o644, flag: 'wx' });
    writeFileSync(patch, snap.patch, { mode: 0o644, flag: 'wx' });
    // Upstream intentionally ignores package-lock.json. Pending manifest/lockfile edits
    // are forbidden, so reuse production's root-owned lock for a deterministic npm ci.
    const productionLock = join(cfg.prod, 'package-lock.json');
    trustedDirectory(dirname(productionLock));
    const lockStat = lstatSync(productionLock);
    if (!lockStat.isFile() || lockStat.uid !== 0 || (lockStat.mode & 0o022) || lockStat.nlink !== 1) throw new Error('Trusted production package lock required');
    writeFileSync(join(stage, 'package-lock.json'), readFileSync(productionLock), { mode: 0o644, flag: 'wx' });
    const home = join(stage, '.build-home'); mkdirSync(home);
    (io.chown || chownSync)(home, cfg.builder.uid, cfg.builder.gid);
    (io.chown || chownSync)(stage, cfg.builder.uid, cfg.builder.gid);
    const options = { ...cfg.builder, env: { ...safeEnv(home), npm_config_cache: join(home, '.npm') } };
    io.run('/usr/bin/tar', ['-xf', tar, '-C', stage], stage, options);
    io.run('/usr/bin/git', ['apply', '--binary', patch], stage, options);
    io.run('/usr/bin/npm', ['ci', '--ignore-scripts'], stage, options);
    io.run('/usr/bin/npm', ['rebuild', 'better-sqlite3', 'esbuild', '--ignore-scripts=false'], stage, options);
    io.run('/usr/bin/node', ['--import', 'tsx', 'packages/backend/src/services/code-deployment.test.ts'], stage, options);
    io.run('/usr/bin/npm', ['run', 'build'], stage, options);
    // Seal artifacts into root-only storage before promotion. No child remains able to alter the sealed copy.
    const sealed = join(dir, `${key}.artifacts`);
    mkdirSync(sealed, { mode: 0o700 });
    for (const path of artifacts) sealArtifact(stage, path, join(sealed, path));
    result.build = true;
    atomic(join(dir, `${key}.json`), { ...result, status: 'pending', phase: 'built' });
    if (snapshot(cfg.dev).diff_sha256 !== key) throw new Error('Development diff changed during build');
    await stableHealth();
    if (git(cfg.prod, ['rev-parse', 'HEAD']).toString().trim() !== req.head || git(cfg.prod, ['status', '--porcelain', '--untracked-files=no']).toString().trim()) throw new Error('Production baseline mismatch or tracked changes');
    run('/usr/bin/git', ['apply', '--check', '--binary', join(dir, `${key}.patch`)]);
    // Build/test code is untrusted even when source manifests are unchanged. Never
    // replace the root coordinator's executable modules with builder-produced bytes.
    for (const name of ['code-deployment.js', 'code-deployment-worker.js', 'code-patch.js']) {
      const relative = join('packages/backend/dist/services', name);
      const source = join(cfg.prod, relative);
      trustedDirectory(dirname(source));
      const st = lstatSync(source);
      if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || st.nlink !== 1) throw new Error('Untrusted installed coordinator module');
      const target = join(sealed, relative);
      rmSync(target, { force: true });
      writeFileSync(target, readFileSync(source), { mode: 0o644, flag: 'wx' });
    }
    result.validation = true;
    mkdirSync(backup, { mode: 0o700 }); result.backup = backup;
    for (const path of [...snap.files, ...artifacts]) {
      const target = join(cfg.prod, path);
      let cursor = cfg.prod;
      for (const part of path.split('/')) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Production symlink forbidden'); }
      const existed = existsSync(target); prior.push({ path, existed });
      if (existed) { mkdirSync(dirname(join(backup, path)), { recursive: true }); if (artifacts.includes(path)) safeArtifactCopy(target, join(backup, path)); else cpSync(target, join(backup, path), { recursive: true }); }
    }
    atomic(join(backup, 'source-state.json'), { prior });
    // SQLite online backup through the fixed system utility, never through edited application code.
    run('/usr/bin/sqlite3', [cfg.sqlite, `.backup '${join(backup, 'database.sqlite').replace(/'/g, "''")}'`]);
    atomic(join(dir, `${key}.json`), { ...result, status: 'pending', phase: 'backup_complete' });
    touched = true;
    run('/usr/bin/pm2', ['stop', cfg.app]);
    run('/usr/bin/git', ['apply', '--binary', join(dir, `${key}.patch`)]);
    for (const path of artifacts) { rmSync(join(cfg.prod, path), { recursive: true, force: true }); if (io.promote) io.promote(join(dir, `${key}.artifacts`, path), join(cfg.prod, path)); else safeArtifactCopy(join(dir, `${key}.artifacts`, path), join(cfg.prod, path)); }
    run('/usr/bin/pm2', ['restart', cfg.app]); result.restart = true;
    await stableHealth(); result.health = true; result.status = 'deployed';
  } catch (e) {
    result.error = String(e);
    if (touched) {
      try {
        run('/usr/bin/pm2', ['stop', cfg.app]);
        for (const { path, existed } of prior) { rmSync(join(cfg.prod, path), { recursive: true, force: true }); if (existed) { if (artifacts.includes(path)) safeArtifactCopy(join(backup, path), join(cfg.prod, path)); else cpSync(join(backup, path), join(cfg.prod, path), { recursive: true }); } }
        run('/usr/bin/sqlite3', [cfg.sqlite, `.restore '${join(backup, 'database.sqlite').replace(/'/g, "''")}'`]);
        run('/usr/bin/pm2', ['restart', cfg.app]); await stableHealth();
        result.status = 'rolled_back'; result.rollback = { ok: true };
      } catch (rollbackError) {
        let stopped = false;
        try { run('/usr/bin/pm2', ['stop', cfg.app]); stopped = true; } catch {}
        result.status = 'recovery_required'; result.rollback = { ok: false, stopped, error: String(rollbackError) };
      }
    }
  } finally {
    result.next = result.status === 'deployed' ? 'Deployment complete; no commit or push performed.' : 'Review persisted diagnostics before any further deployment.';
    atomic(join(dir, `${key}.json`), result);
    if (result.status !== 'recovery_required') {
      rmSync(stage, { recursive: true, force: true });
      rmSync(join(dir, `${key}.artifacts`), { recursive: true, force: true });
      rmSync(join(dir, 'deploy.lock'), { force: true });
    }
  }
}
