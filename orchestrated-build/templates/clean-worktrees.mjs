#!/usr/bin/env node
// Run from any checkout. Without --apply it fetches nothing and writes nothing, so it reads the base as last fetched.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

function usage() {
  process.stderr.write('usage: node clean-worktrees.mjs [--apply --notes <dir>] [--port <n>] [--base <ref>]\n');
  process.exit(64);
}

let options;
try {
  options = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      notes: { type: 'string' },
      port: { type: 'string' },
      base: { type: 'string', default: 'origin/main' },
    },
  }).values;
} catch {
  usage();
}
const { apply, base, port } = options;
if (apply && !options.notes) usage();
if (port !== undefined && !(/^\d+$/.test(port) && Number(port) <= 65535)) usage();

// A git hook's GIT_DIR would point every check at the hook's own worktree, not the one being judged.
for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n')) delete process.env[name];

// --no-optional-locks: a plain status refreshes the index, and a dry run writes nothing. The -c flags read past caches that can hide an edit.
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.checkStat=default', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

function succeeds(cwd, ...args) {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

// Native, because only it settles letter case, which lsof reports as it is on disk. The notes folder may not exist yet.
function real(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.join(real(path.dirname(target)), path.basename(target));
  }
}

const inside = (target, folder) => target === folder || target.startsWith(folder + path.sep);

function listWorktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain', '-z')
    .split('\0\0')
    .filter(Boolean)
    .map((record) => {
      const fields = record.split('\0');
      const listed = fields[0].slice('worktree '.length);
      return {
        path: listed,
        real: real(listed),
        locked: fields.find((field) => /^locked( |$)/.test(field)),
      };
    });
}

// Every cwd lsof can see, or null when it can't be trusted: a working lsof always sees this process's own.
function processCwds() {
  let output;
  try {
    output = execFileSync('lsof', ['-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const cwds = output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
  return cwds.includes(process.cwd()) ? cwds : null;
}

const sameBytes = (a, b) => readFileSync(a).equals(readFileSync(b));
const say = (line) => process.stdout.write(`${line}\n`);

const callerDir = process.cwd();
const worktrees = listWorktrees(callerDir);
const [main, ...linked] = worktrees;
const mainHead = git(main.real, 'rev-parse', 'HEAD').trim();
const caller = git(callerDir, 'rev-parse', '--show-toplevel').trim();
const notes = options.notes && real(options.notes);
const worktreeHolding = (target) => worktrees.find((wt) => inside(target, wt.real));
const notesHolder = notes && worktreeHolding(notes);
if (notesHolder) {
  process.stderr.write(`--notes ${notes} is inside the checkout ${notesHolder.path}, so nothing was removed.\n`);
  process.exit(1);
}

if (apply) {
  try {
    git(callerDir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'fetch', 'origin');
  } catch (error) {
    process.stderr.write(`git fetch origin failed, so nothing was removed: ${error.stderr ?? error.message}\n`);
    process.exit(1);
  }
} else {
  say(`Dry run against ${base} as last fetched; --apply fetches first, so it may remove more.`);
}
if (!succeeds(callerDir, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`)) {
  process.stderr.write(`${base} is not a commit here, so nothing was removed.\n`);
  process.exit(1);
}

const copyPath = (wt, file) => path.join(notes, path.basename(wt.path), file);
const REGENERABLE = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  '.vite',
  'coverage',
  'test-results',
  'playwright-report',
  '__pycache__',
  '.DS_Store',
  'hook.cache.json',
  'next-env.d.ts',
]);
const regenerable = (file) => REGENERABLE.has(path.basename(file)) || file.endsWith('.tsbuildinfo');
const UNFINISHED = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'BISECT_LOG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'index.lock'];
const gitPath = (wt, name) => path.resolve(wt.real, git(wt.real, 'rev-parse', '--git-path', name).trim());

function whatGoesOrThrowWhyItStays(wt) {
  if (wt.real === caller) throw new Error('it is the checkout this ran from');
  if (!existsSync(wt.real)) throw new Error('its folder is gone');
  if (wt.locked) throw new Error(`it is ${wt.locked}`);
  const head = git(wt.real, 'rev-parse', 'HEAD').trim();
  const short = head.slice(0, 7);
  if (!succeeds(callerDir, 'merge-base', '--is-ancestor', head, base)) throw new Error(`HEAD ${short} is not in ${base}`);
  // shortcut: a branch deleted on the remote still counts until a prune; ask the remote itself if local bases become routine.
  if (!git(callerDir, 'for-each-ref', '--count=1', '--contains', head, 'refs/remotes/origin').trim()) {
    throw new Error(`HEAD ${short} is not on origin`);
  }
  for (const state of UNFINISHED) {
    if (existsSync(gitPath(wt, state))) throw new Error(`${state} says an operation is unfinished there`);
  }
  if (existsSync(gitPath(wt, 'modules'))) throw new Error('it holds submodules, which git refuses to remove');
  // A branch's reflog outlives the worktree; its HEAD reflog and refs/worktree/*, which --all would count, don't.
  // shortcut: reflogs go on the command line, so past ARG_MAX git can't start and every worktree stays; use --stdin if that bites.
  const reflog = (...refs) => git(wt.real, 'log', '-g', '--format=%H', ...refs).split('\n').filter(Boolean);
  const reached = ['--branches', '--tags', '--remotes', ...reflog('--branches')];
  const orphan = git(wt.real, 'rev-list', '--max-count=1', ...reflog('HEAD'), '--not', ...reached).trim();
  if (orphan) throw new Error(`its HEAD reflog holds ${orphan.slice(0, 7)}, which no branch, tag or remote reaches`);
  const status = git(wt.real, 'status', '--porcelain', '-z', '--untracked-files=all')
    .split('\0')
    .filter(Boolean);
  if (status.some((entry) => !entry.startsWith('?? '))) throw new Error('a tracked file is modified or staged');
  const untracked = status.map((entry) => entry.slice(3)).filter((file) => !going.has(path.resolve(wt.real, file)));
  const hidden = git(wt.real, 'ls-files', '-v', '-z').split('\0').find((entry) => entry && !entry.startsWith('H '));
  if (hidden) throw new Error(`${hidden.slice(2)} is flagged so git hides its edits`);
  // git's own removal would take these with the worktree when they sit in an ignored folder.
  if (linked.some((other) => other !== wt && !going.has(other.real) && inside(other.real, wt.real) && existsSync(other.real))) {
    throw new Error('another worktree is inside it');
  }
  const ignored = git(wt.real, 'ls-files', '-oi', '--exclude-standard', '--directory', '-z').split('\0').filter(Boolean);
  // git also lists an untracked folder holding only ignored paths, beside those paths.
  const parents = new Set(ignored.map((file) => `${path.dirname(file)}/`));
  const dropped = ignored.filter((file) => !parents.has(file));
  const lost = dropped.find((file) => !regenerable(file) && !lstatSync(path.join(wt.real, file)).isSymbolicLink());
  if (lost) throw new Error(`ignored ${lost} is not regenerable`);
  for (const file of dropped) {
    const dotGits = execFileSync('find', [path.resolve(wt.real, file), '-name', '.git', '-print0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const repo = dotGits.split('\0').find((dotGit) => dotGit && !going.has(path.dirname(dotGit)));
    if (repo) throw new Error(`ignored ${file} holds ${path.relative(wt.real, repo)}`);
  }
  for (const file of untracked) {
    const original = path.join(wt.real, file);
    const stat = lstatSync(original);
    if (!stat.isFile()) throw new Error(`untracked ${file} is not a plain file`);
    if (!notes) continue;
    const copy = copyPath(wt, file);
    const holder = worktreeHolding(real(path.dirname(copy)));
    if (holder) throw new Error(`the copy of ${file} would sit inside ${holder.path}`);
    const existing = lstatSync(copy, { throwIfNoEntry: false });
    if (existing?.ino === stat.ino && existing.dev === stat.dev) throw new Error(`${copy} is ${file} itself`);
    if (existing && !(existing.isFile() && sameBytes(original, copy))) {
      throw new Error(`${copy} already exists with different content`);
    }
  }
  // lsof escapes other characters in what it prints, so a path holding one could never match.
  if (!/^[\x20-\x5b\x5d-\x7e]+$/.test(wt.real)) throw new Error("can't tell whether a process is using it: lsof escapes its path");
  const cwds = processCwds();
  if (!cwds) throw new Error("can't tell whether a process is using it: lsof failed");
  if (cwds.some((cwd) => inside(cwd, wt.real))) throw new Error('a process has its cwd there');
  return { untracked, dropped };
}

function moveToNotes(wt, files) {
  for (const file of files) {
    const original = path.join(wt.real, file);
    const copy = copyPath(wt, file);
    if (existsSync(copy)) {
      if (!sameBytes(original, copy)) throw new Error(`${copy} already exists with different content`);
      continue;
    }
    mkdirSync(path.dirname(copy), { recursive: true });
    // Renamed into place, so a run killed mid-copy leaves no stub at the copy's name to refuse on later.
    const partial = `${copy}.${process.pid}.partial`;
    copyFileSync(original, partial);
    if (!sameBytes(original, partial)) throw new Error(`the copy of ${file} differs from it`);
    renameSync(partial, copy);
  }
  for (const file of files) rmSync(path.join(wt.real, file));
  if (files.length > 0) say(`moved ${files.length} untracked from ${wt.path} to ${copyPath(wt, '')}`);
}

const portAnswers = () =>
  new Promise((resolve) => {
    // shortcut: a TCP connect, so a hung app that still accepts connections passes; send a request if that bites.
    const socket = connect({ port: Number(port), host: 'localhost', timeout: 5000 });
    const finish = (answered) => {
      socket.destroy();
      resolve(answered);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

say(`stayed ${main.path}: it is the main checkout`);
const going = new Set();
let stayed = 1;
for (const wt of [...linked].sort((a, b) => b.real.length - a.real.length)) {
  try {
    const { untracked, dropped } = whatGoesOrThrowWhyItStays(wt);
    if (apply) {
      moveToNotes(wt, untracked);
      git(callerDir, 'worktree', 'remove', wt.path);
      say(`removed ${wt.path}`);
    } else {
      say(`would remove ${wt.path}${untracked.length > 0 ? ` (moving ${untracked.length} untracked to the notes first)` : ''}`);
    }
    if (dropped.length > 0) say(`${apply ? 'dropped' : 'would drop'} ignored from ${wt.path}: ${dropped.join(', ')}`);
    going.add(wt.real);
  } catch (error) {
    stayed += 1;
    say(`stayed ${wt.path}: ${(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}
say(`${apply ? 'Removed' : 'Would remove'} ${going.size}; ${stayed} stayed.`);

let healthy = true;
function alarm(message) {
  healthy = false;
  process.stderr.write(`!!! ${message}\n`);
}
const headNow = git(main.real, 'rev-parse', 'HEAD').trim();
if (headNow === mainHead) say(`Main checkout HEAD unchanged at ${mainHead.slice(0, 7)}.`);
else alarm(`MAIN CHECKOUT HEAD MOVED from ${mainHead} to ${headNow}`);
if (port !== undefined) {
  if (await portAnswers()) say(`Port ${port} answers.`);
  else alarm(`NOTHING ANSWERS ON PORT ${port}`);
}
if (!healthy) process.exit(1);
