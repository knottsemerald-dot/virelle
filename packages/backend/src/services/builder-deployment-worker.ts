/** Detached worker for the optional Builder release feature. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builderReleaseReady, runBuilderRelease } from './builder-deployment.js';
import { waitForReparent } from './builder-runtime.js';
if (process.argv[2] === '--builder-launch') {
  const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--builder-run', process.argv[3], process.argv[4]], { detached: true, stdio: 'ignore', env: process.env, cwd: '/' });
  worker.once('error', () => { process.exitCode = 1; }); worker.unref();
} else if (process.argv[2] === '--builder-run') {
  const parent = process.ppid;
  void (async () => { await waitForReparent(parent); builderReleaseReady(process.argv[4], process.argv[3]); await runBuilderRelease(process.argv[4], process.argv[3]); })().catch(() => { process.exitCode = 1; });
} else process.exitCode = 1;
