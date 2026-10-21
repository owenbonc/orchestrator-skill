#!/usr/bin/env node
// PreToolUse hook: the owner's live app runs from the main checkout, so no session edits files or
// moves branches there; work happens in .claude/worktrees/. Wire it in .claude/settings.json:
//   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
//       "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/scripts/guard-main-checkout.mjs" } ] } ] } }
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cwd = input.cwd ?? process.cwd();
const args = input.tool_input ?? {};

let main;
try {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  main = path.dirname(common.trim());
} catch {
  process.exit(0);
}

function inMain(target) {
  const rel = path.relative(main, path.resolve(cwd, target));
  return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith(path.join('.claude', 'worktrees'));
}

const editing =
  ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name) &&
  inMain(args.file_path ?? args.notebook_path ?? '');
// shortcut: reads the command's own directory only, so `git -C <main> commit` from elsewhere passes; parse -C if that bites.
const movesBranch =
  input.tool_name === 'Bash' &&
  inMain('.') &&
  /\bgit\b[^;&|]*\b(commit|checkout|switch|reset|merge|rebase|pull|push|stash|restore|clean|cherry-pick|revert)\b/.test(
    args.command ?? '',
  );

if (editing || movesBranch) {
  process.stderr.write(
    `The owner's live app runs from ${main}: edit and commit in a worktree under .claude/worktrees/ instead (reading is fine).\n`,
  );
  process.exit(2);
}
