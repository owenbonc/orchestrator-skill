import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const guard = fileURLToPath(new URL('./guard-main-checkout.mjs', import.meta.url));
// Real path, because git reports one and macOS's tmpdir sits behind a symlink.
const main = realpathSync(mkdtempSync(path.join(tmpdir(), 'guard-')));
const worktree = path.join(main, '.claude', 'worktrees', 'agent');
execFileSync('git', ['init', '-q', main]);
mkdirSync(worktree, { recursive: true });
afterAll(() => rmSync(main, { recursive: true, force: true }));

const exitCode = (input) =>
  spawnSync(process.execPath, [guard], { input: JSON.stringify({ cwd: main, ...input }) }).status;

describe('main-checkout guard', () => {
  it('refuses an edit in the main checkout', () => {
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(main, 'README.md') } };
    expect(exitCode(edit)).toBe(2);
  });

  it('allows an edit in a worktree', () => {
    const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(worktree, 'README.md') } };
    expect(exitCode(edit)).toBe(0);
  });

  it('refuses a commit from the main checkout and allows one from a worktree', () => {
    const commit = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } };
    expect(exitCode(commit)).toBe(2);
    expect(exitCode({ ...commit, cwd: worktree })).toBe(0);
  });

  it('allows reading git history in the main checkout', () => {
    expect(exitCode({ tool_name: 'Bash', tool_input: { command: 'git log --oneline' } })).toBe(0);
  });

  it('refuses stopping processes by name from anywhere, and allows stopping one by its port', () => {
    const bash = (command, cwd) => exitCode({ tool_name: 'Bash', tool_input: { command }, cwd });
    expect(bash('pkill node', tmpdir())).toBe(2);
    for (const byName of [
      'pkill -f next-server',
      'lsof -ti tcp:3135; killall node',
      'cd apps/web && pkill node',
      'echo stopping\npkill node',
      'sudo -n pkill node',
      '/usr/bin/pkill node',
      'PKILL node',
      'timeout 5 killall node',
      'env FORCE=1 nohup pkill node',
      'echo node | xargs pkill',
      'bash -c "pkill node"',
      'if true; then pkill node; fi',
      'kill $(pgrep -f next-server)',
      'pgrep -f next-server | xargs kill',
    ]) {
      expect(bash(byName, worktree), byName).toBe(2);
    }
    for (const allowed of [
      'lsof -ti tcp:3135 | xargs kill',
      'grep -rn pkill scripts',
      'pgrep -f next-server',
      'git commit -m "The guard refuses pkill and killall"',
    ]) {
      expect(bash(allowed, worktree), allowed).toBe(0);
    }
  });
});
