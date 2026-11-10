/**
 * Bounded coding delegation for API-model companion lanes.
 *
 * Gemini/OpenRouter remains the conversational orchestrator. When the owner
 * clearly asks for a code change or code investigation, the model may call
 * `delegate_code`; this module gives that one task to Codex CLI in a separate
 * development clone. It never operates on the live production checkout and
 * never commits, pushes, merges, or deploys.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const DEFAULT_WORKSPACE = '/root/virelle-workspace';
const MAX_TASK_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 24_000;
const CODEX_TIMEOUT_MS = 20 * 60 * 1_000;
let codingTurnActive = false;

export interface CodeDelegationRequest {
  task: string;
  mode?: 'inspect' | 'edit';
  continue_existing?: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function command(file: string, args: string[], cwd: string, timeout = 30_000): Promise<CommandResult> {
  const { stdout = '', stderr = '' } = await execFileAsync(file, args, {
    cwd,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** Codex waits for any piped stdin before starting. Spawn with stdin ignored so
 * it receives EOF immediately; execFile's default open pipe can hang forever. */
async function codexCommand(args: string[], cwd: string, timeout = CODEX_TIMEOUT_MS): Promise<CommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('codex', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise({ stdout, stderr });
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) child.kill('SIGTERM');
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) child.kill('SIGTERM');
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`Codex exited with ${code ?? signal ?? 'unknown'}: ${stderr.slice(-2000)}`));
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Codex timed out after ${Math.round(timeout / 1000)} seconds`));
    }, timeout);
  });
}

function short(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function taskSlug(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return slug || 'change';
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await command('git', args, cwd)).stdout.trim();
}

async function prepareEditBranch(cwd: string, task: string, continueExisting: boolean): Promise<string> {
  const status = await git(cwd, ['status', '--porcelain']);
  const current = await git(cwd, ['branch', '--show-current']);

  if (status) {
    if (continueExisting && current.startsWith('codex/')) return current;
    throw new Error(
      `The coding workspace already has unreviewed changes on ${current || 'a detached branch'}. ` +
      'Ask to continue that change with continue_existing:true, or review/deploy/reset it first.',
    );
  }

  // Start every new edit from the local main branch. Updating from GitHub is
  // deliberately outside Codex's hands and fails closed if main diverged.
  if (current !== 'main') await git(cwd, ['switch', 'main']);
  await git(cwd, ['fetch', 'origin', 'main']);
  await git(cwd, ['merge', '--ff-only', 'origin/main']);

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const branch = `codex/${stamp}-${taskSlug(task)}`;
  await git(cwd, ['switch', '-c', branch]);
  return branch;
}

export async function delegateCodeTask(raw: CodeDelegationRequest): Promise<{ ok: boolean; result: string }> {
  const task = typeof raw.task === 'string' ? raw.task.trim() : '';
  const mode = raw.mode === 'inspect' ? 'inspect' : 'edit';
  const continueExisting = raw.continue_existing === true;

  if (!task) return { ok: false, result: JSON.stringify({ ok: false, error: 'task is required' }) };
  if (task.length > MAX_TASK_CHARS) {
    return { ok: false, result: JSON.stringify({ ok: false, error: `task exceeds ${MAX_TASK_CHARS} characters` }) };
  }
  if (process.env.BYTELIGHT_CODE_DELEGATION_ENABLED !== 'true') {
    return { ok: false, result: JSON.stringify({ ok: false, error: 'Coding delegation is disabled by the owner.' }) };
  }

  if (codingTurnActive) {
    return { ok: false, result: JSON.stringify({ ok: false, error: 'A Codex coding task is already running. Wait for it to finish.' }) };
  }

  const workspace = resolve(process.env.BYTELIGHT_CODE_WORKSPACE || DEFAULT_WORKSPACE);
  codingTurnActive = true;
  let outputFile = '';
  try {
    const inside = await git(workspace, ['rev-parse', '--show-toplevel']);
    if (resolve(inside) !== workspace) throw new Error(`Coding workspace mismatch: expected ${workspace}, got ${inside}`);

    const branch = mode === 'edit'
      ? await prepareEditBranch(workspace, task, continueExisting)
      : await git(workspace, ['branch', '--show-current']);

    const tmpDir = '/tmp/bytelight-code-delegation';
    await mkdir(tmpDir, { recursive: true });
    outputFile = `${tmpDir}/last-${process.pid}-${Date.now()}.md`;

    const policy = mode === 'inspect'
      ? 'READ-ONLY INVESTIGATION. Do not modify any file.'
      : 'IMPLEMENTATION. You may edit files in this workspace and run relevant tests/builds.';
    const prompt = [
      'You are the coding specialist temporarily delegated by the Virelle companions.',
      `Task from the owner: ${task}`,
      '',
      policy,
      'Operate only inside the current Git workspace.',
      'Never read or modify .env, bytelight.yaml, data/, memory-vault/, SSH files, credentials, or secret-bearing files.',
      'Never commit, push, merge, deploy, restart production, or change Git remotes.',
      'Do not overwrite or discard pre-existing work.',
      'For implementation: make the smallest coherent change and run focused tests plus the build/typecheck when practical.',
      'End with a concise report: summary, changed files, validation run, and any open concern.',
    ].join('\n');

    const args = [
      'exec',
      '--ephemeral',
      '--color', 'never',
      '--output-last-message', outputFile,
      '--sandbox', mode === 'inspect' ? 'read-only' : 'workspace-write',
      '--cd', workspace,
      prompt,
    ];
    const codex = await codexCommand(args, workspace, CODEX_TIMEOUT_MS);
    let report = '';
    try { report = await readFile(outputFile, 'utf8'); } catch { report = codex.stdout || codex.stderr; }

    const status = await git(workspace, ['status', '--short']);
    const diffStat = mode === 'edit' ? await git(workspace, ['diff', '--stat']) : '';
    const diff = mode === 'edit' ? await git(workspace, ['diff', '--', ':!package-lock.json']) : '';

    return {
      ok: true,
      result: JSON.stringify({
        ok: true,
        mode,
        branch,
        report: short(report, 12_000),
        status: short(status, 4_000),
        diffStat: short(diffStat, 4_000),
        diff: short(diff, 20_000),
        next: mode === 'edit'
          ? 'Explain the result to the owner. Do not claim it is deployed. The owner must approve review/deployment.'
          : 'Explain the findings; no files were changed.',
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, result: JSON.stringify({ ok: false, error: message }) };
  } finally {
    codingTurnActive = false;
    if (outputFile) await rm(outputFile, { force: true }).catch(() => undefined);
  }
}
