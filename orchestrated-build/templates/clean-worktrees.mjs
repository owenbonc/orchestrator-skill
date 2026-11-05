#!/usr/bin/env node
// Usage: node clean-worktrees.mjs [--apply --notes <dir>] [--port <n>] [--base <ref>]
// Run from any checkout. Without --apply it fetches nothing and writes nothing, so it reads the base as last fetched.
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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

// --no-optional-locks: a plain status refreshes the index, and a dry run writes nothing.
const git = (cwd, ...args) =>
  execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
        head: fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length),
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

/** The untracked files to save before removing this worktree; throws why it stays instead. */
function assess(wt) {
  if (wt.real === caller) throw new Error('it is the checkout this ran from');
  if (!existsSync(wt.real)) throw new Error('its folder is gone');
  if (wt.locked) throw new Error(`it is ${wt.locked}`);
  const short = wt.head.slice(0, 7);
  if (!succeeds(callerDir, 'merge-base', '--is-ancestor', wt.head, base)) throw new Error(`HEAD ${short} is not in ${base}`);
  // shortcut: a branch deleted on the remote still counts until a prune; ask the remote itself if local bases become routine.
  if (!git(callerDir, 'for-each-ref', '--count=1', '--contains', wt.head, 'refs/remotes/origin').trim()) {
    throw new Error(`HEAD ${short} is not on origin`);
  }
  const status = git(wt.real, 'status', '--porcelain', '-z', '--untracked-files=all')
    .split('\0')
    .filter(Boolean);
  const untracked = status.filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
  if (untracked.length < status.length) throw new Error('a tracked file is modified or staged');
  // git's own removal would take these with the worktree when they sit in an ignored folder.
  if (linked.some((other) => other !== wt && inside(other.real, wt.real) && existsSync(other.real))) {
    throw new Error('another worktree is inside it');
  }
  if (notes && inside(notes, wt.real)) throw new Error('the notes folder is inside it');
  for (const file of untracked) {
    const original = path.join(wt.real, file);
    if (!lstatSync(original).isFile()) throw new Error(`untracked ${file} is not a plain file`);
    if (!notes) continue;
    const copy = copyPath(wt, file);
    const existing = lstatSync(copy, { throwIfNoEntry: false });
    if (existing && !(existing.isFile() && sameBytes(original, copy))) {
      throw new Error(`${copy} already exists with different content`);
    }
  }
  // lsof escapes other characters in what it prints, so a path holding one could never match.
  if (!/^[\x20-\x5b\x5d-\x7e]+$/.test(wt.real)) throw new Error("can't tell whether a process is using it: lsof escapes its path");
  const cwds = processCwds();
  if (!cwds) throw new Error("can't tell whether a process is using it: lsof failed");
  if (cwds.some((cwd) => inside(cwd, wt.real))) throw new Error('a process has its cwd there');
  return untracked;
}

function moveToNotes(wt, files) {
  for (const file of files) {
    const copy = copyPath(wt, file);
    mkdirSync(path.dirname(copy), { recursive: true });
    if (!existsSync(copy)) copyFileSync(path.join(wt.real, file), copy, constants.COPYFILE_EXCL);
  }
  for (const file of files) {
    if (!sameBytes(path.join(wt.real, file), copyPath(wt, file))) throw new Error(`the copy of ${file} differs from it`);
  }
  for (const file of files) rmSync(path.join(wt.real, file));
  if (files.length > 0) say(`moved ${files.length} untracked from ${wt.path} to ${path.dirname(copyPath(wt, 'file'))}`);
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
let gone = 0;
let stayed = 1;
// Deepest first, so a worktree inside another goes before the one that holds it.
for (const wt of [...linked].sort((a, b) => b.real.length - a.real.length)) {
  // Anything thrown keeps the worktree, so a refusal and a failed command end the same way.
  try {
    const untracked = assess(wt);
    if (apply) {
      moveToNotes(wt, untracked);
      git(callerDir, 'worktree', 'remove', wt.path);
      say(`removed ${wt.path}`);
    } else {
      say(`would remove ${wt.path}${untracked.length > 0 ? ` (moving ${untracked.length} untracked to the notes first)` : ''}`);
    }
    gone += 1;
  } catch (error) {
    stayed += 1;
    say(`stayed ${wt.path}: ${(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}
say(`${apply ? 'Removed' : 'Would remove'} ${gone}; ${stayed} stayed.`);

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
