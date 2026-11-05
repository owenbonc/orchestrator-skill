// Run: node --test orchestrated-build/templates/clean-worktrees.test.mjs
// Every case runs the real script on a throwaway repo with a bare origin, never on the repo holding this file.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./clean-worktrees.mjs', import.meta.url));
const REPORT = 'report body\n';
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realLsof = execFileSync('sh', ['-c', 'PATH="$PATH:/usr/sbin:/usr/bin" command -v lsof'], { encoding: 'utf8' }).trim();

// A run from a git hook inherits GIT_DIR, which would point these commands at the real repo.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  PATH: `${process.env.PATH}:${path.dirname(realLsof)}`,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const roots = [];
const children = [];
after(() => {
  for (const child of children) child.kill();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'clean-worktrees-')));
  roots.push(root);
  const repo = {
    root,
    origin: path.join(root, 'origin.git'),
    main: path.join(root, 'main'),
    notes: path.join(root, 'notes'),
    wts: path.join(root, 'wts'),
  };
  git(root, 'init', '-q', '--bare', '-b', 'main', repo.origin);
  git(root, 'init', '-q', '-b', 'main', repo.main);
  git(repo.main, 'remote', 'add', 'origin', repo.origin);
  writeFileSync(path.join(repo.main, '.gitignore'), 'node_modules/\nbuild/\ndata/\n.env\n');
  writeFileSync(path.join(repo.main, 'tracked.txt'), 'tracked\n');
  git(repo.main, 'add', '.');
  git(repo.main, 'commit', '-qm', 'base');
  git(repo.main, 'push', '-q', 'origin', 'main');
  return repo;
}

function addWorktree(repo, name, base = 'origin/main') {
  const wt = path.join(repo.wts, name);
  git(repo.main, 'worktree', 'add', '-q', '-b', name.replaceAll('/', '-'), wt, base);
  return wt;
}

function write(dir, file, content = REPORT) {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function commit(dir, file = 'work.txt') {
  write(dir, file, 'work\n');
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', `add ${file}`);
}

function occupy(cwd) {
  children.push(spawn('sleep', ['600'], { cwd, stdio: 'ignore' }));
}

function run(repo, args = [], { cwd = repo.main, nodeArgs = [], extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
}

const apply = (repo, args = [], options) => run(repo, ['--apply', '--notes', repo.notes, ...args], options);

// A folder of fake commands for PATH: { name: sh body }.
function fakes(repo, scripts) {
  const dir = mkdtempSync(path.join(repo.root, 'fakes-'));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function lineFor(result, prefix, wt) {
  const start = `${prefix} ${wt}`;
  return result.stdout.split('\n').find((line) => line === start || line.startsWith(`${start}: `) || line.startsWith(`${start} (`));
}

function assertStayed(result, wt, why) {
  const line = lineFor(result, 'stayed', wt);
  assert.ok(line, `no "stayed" line for ${wt} in:\n${result.stdout}\n${result.stderr}`);
  assert.match(line, why);
  assert.equal(existsSync(wt), true, `${wt} was removed`);
}

function assertRemoved(result, wt) {
  assert.ok(lineFor(result, 'removed', wt), `no "removed" line for ${wt} in:\n${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(wt), false, `${wt} is still there`);
}

function assertFile(file, content = REPORT) {
  assert.ok(existsSync(file), `${file} is gone`);
  assert.ok(readFileSync(file).equals(Buffer.from(content)), `${file} changed`);
}

// Every path under dir with its type, mode, mtime and content: any write shows.
function snapshot(dir, found = {}) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    const stamp = `${stat.mode}:${stat.mtimeMs}`;
    if (stat.isSymbolicLink()) found[file] = `${stamp}:${readlinkSync(file)}`;
    else if (stat.isDirectory()) {
      found[file] = stamp;
      snapshot(file, found);
    } else found[file] = `${stamp}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  }
  return found;
}

describe('an apply across every case', () => {
  let repo;
  let result;
  let second;
  let notesAfterFirst;
  let branchesBefore;
  let gitLog;
  const wt = {};

  before(() => {
    repo = makeRepo();
    write(repo.main, 'main-note.txt');
    write(repo.main, 'data/app.db');
    write(repo.main, '.env', 'SECRET=1\n');
    const outside = path.join(repo.root, 'outside');
    write(outside, 'keep.txt');

    for (const name of ['unmerged', 'pushed-elsewhere', 'modified', 'staged', 'locked', 'in-use', 'in-subfolder', 'café']) {
      wt[name] = addWorktree(repo, name);
      write(wt[name], 'report.md');
    }
    commit(wt.unmerged);
    commit(wt['pushed-elsewhere']);
    git(wt['pushed-elsewhere'], 'push', '-q', 'origin', 'pushed-elsewhere');
    write(wt.modified, 'tracked.txt', 'changed\n');
    write(wt.staged, 'new.txt');
    git(wt.staged, 'add', 'new.txt');
    git(repo.main, 'worktree', 'lock', '--reason', 'held by a test', wt.locked);
    occupy(wt['in-use']);
    write(wt['in-subfolder'], 'build/sub/out.txt');
    occupy(path.join(wt['in-subfolder'], 'build/sub'));

    wt.lockedPlain = addWorktree(repo, 'locked-plain');
    write(wt.lockedPlain, 'report.md');
    git(repo.main, 'worktree', 'lock', wt.lockedPlain);

    wt.caller = addWorktree(repo, 'caller');

    wt.conflict = addWorktree(repo, 'conflict');
    write(wt.conflict, 'a.txt');
    write(wt.conflict, 'b.txt');
    write(path.join(repo.notes, 'conflict'), 'b.txt', 'different\n');

    wt.symlink = addWorktree(repo, 'symlink');
    write(wt.symlink, 'plain.txt');
    symlinkSync(path.join(outside, 'keep.txt'), path.join(wt.symlink, 'link'));

    wt['nested-repo'] = addWorktree(repo, 'nested-repo');
    write(wt['nested-repo'], 'vendor/file.txt');
    git(path.join(wt['nested-repo'], 'vendor'), 'init', '-q');

    wt.held = addWorktree(repo, 'held');
    wt.heldInner = addWorktree(repo, 'held/build/inner');
    commit(wt.heldInner);

    wt.pair = addWorktree(repo, 'pair');
    wt.pairInner = addWorktree(repo, 'pair/build/inner');

    wt.staleOuter = addWorktree(repo, 'stale-outer');
    wt.staleInner = addWorktree(repo, 'stale-outer/build/inner');
    rmSync(wt.staleInner, { recursive: true });

    wt.gone = addWorktree(repo, 'gone');
    rmSync(wt.gone, { recursive: true });

    wt.clean = addWorktree(repo, 'clean');

    wt['with-report'] = addWorktree(repo, 'with-report');
    write(wt['with-report'], 'report.md');
    write(wt['with-report'], 'reports/deep/data.bin', BINARY);

    wt['already-copied'] = addWorktree(repo, 'already-copied');
    write(wt['already-copied'], 'report.md');
    write(path.join(repo.notes, 'already-copied'), 'report.md');

    wt.ignored = addWorktree(repo, 'ignored');
    write(wt.ignored, 'node_modules/pkg/index.js');
    write(wt.ignored, 'build/out.txt');
    symlinkSync(path.join(repo.main, '.env'), path.join(wt.ignored, '.env'));
    symlinkSync(outside, path.join(wt.ignored, 'node_modules/linked'));

    branchesBefore = git(repo.main, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    const log = path.join(repo.root, 'git.log');
    const spy = fakes(repo, { git: `printf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"` });
    const options = { cwd: wt.caller, extraEnv: { PATH: `${spy}:${env.PATH}` } };
    result = apply(repo, [], options);
    notesAfterFirst = snapshot(repo.notes);
    gitLog = readFileSync(log, 'utf8');
    second = apply(repo, [], options);
  });

  const refusals = {
    unmerged: /is not in origin\/main/,
    'pushed-elsewhere': /is not in origin\/main/,
    modified: /a tracked file is modified or staged/,
    staged: /a tracked file is modified or staged/,
    locked: /it is locked held by a test/,
    'in-use': /a process has its cwd there/,
    'in-subfolder': /a process has its cwd there/,
    'café': /lsof/,
  };
  for (const [name, why] of Object.entries(refusals)) {
    it(`keeps ${name} and leaves its untracked report where it is`, () => {
      assertStayed(result, wt[name], why);
      assertFile(path.join(wt[name], 'report.md'));
      assert.equal(existsSync(path.join(repo.notes, name)), false, 'its report was copied');
    });
  }

  it('keeps the checkout it was called from', () => {
    assertStayed(result, wt.caller, /the checkout this ran from/);
  });

  it('keeps a worktree locked with no reason, naming the lock and moving nothing', () => {
    assertStayed(result, wt.lockedPlain, /: it is locked$/);
    assertFile(path.join(wt.lockedPlain, 'report.md'));
    assert.equal(existsSync(path.join(repo.notes, 'locked-plain')), false, 'its report was copied');
  });

  it('keeps the main checkout, with its untracked and ignored files', () => {
    assertStayed(result, repo.main, /the main checkout/);
    assertFile(path.join(repo.main, 'main-note.txt'));
    assertFile(path.join(repo.main, 'data/app.db'));
    assert.equal(existsSync(path.join(repo.notes, 'main')), false);
  });

  it('keeps a worktree whose target already differs, deleting and copying nothing', () => {
    assertStayed(result, wt.conflict, /already exists with different content/);
    assertFile(path.join(wt.conflict, 'a.txt'));
    assertFile(path.join(wt.conflict, 'b.txt'));
    assertFile(path.join(repo.notes, 'conflict/b.txt'), 'different\n');
    assert.equal(existsSync(path.join(repo.notes, 'conflict/a.txt')), false);
  });

  it('keeps a worktree with an untracked symlink, deleting and copying nothing', () => {
    assertStayed(result, wt.symlink, /untracked link is not a plain file/);
    assert.equal(lstatSync(path.join(wt.symlink, 'link')).isSymbolicLink(), true);
    assertFile(path.join(wt.symlink, 'plain.txt'));
    assert.equal(existsSync(path.join(repo.notes, 'symlink')), false);
  });

  it('keeps a worktree with an untracked nested repo', () => {
    assertStayed(result, wt['nested-repo'], /is not a plain file/);
    assertFile(path.join(wt['nested-repo'], 'vendor/file.txt'));
  });

  it('keeps a worktree that holds another one, which would go with it', () => {
    assertStayed(result, wt.held, /another worktree is inside it/);
    assertStayed(result, wt.heldInner, /is not in origin\/main/);
  });

  it('removes a merged pair, inner first', () => {
    assertRemoved(result, wt.pairInner);
    assertRemoved(result, wt.pair);
  });

  it('removes a worktree whose inner worktree lost its folder before the run', () => {
    assertRemoved(result, wt.staleOuter);
  });

  it('reports a worktree whose folder is gone and leaves its entry, since it never prunes', () => {
    assert.ok(lineFor(result, 'stayed', wt.gone)?.includes('its folder is gone'));
    assert.match(git(repo.main, 'worktree', 'list'), /wts\/gone/);
  });

  it('removes a merged, clean worktree', () => {
    assertRemoved(result, wt.clean);
  });

  it('copies every untracked report byte for byte, then removes the worktree', () => {
    assertRemoved(result, wt['with-report']);
    assertFile(path.join(repo.notes, 'with-report/report.md'));
    assertFile(path.join(repo.notes, 'with-report/reports/deep/data.bin'), BINARY);
  });

  it('counts an identical file already in the notes as copied', () => {
    assertRemoved(result, wt['already-copied']);
    assertFile(path.join(repo.notes, 'already-copied/report.md'));
  });

  it('lets regenerable ignored files and links go with the worktree, uncopied, without following links', () => {
    assertRemoved(result, wt.ignored);
    assert.equal(existsSync(path.join(repo.notes, 'ignored')), false);
    assertFile(path.join(repo.main, '.env'), 'SECRET=1\n');
    assertFile(path.join(repo.root, 'outside/keep.txt'));
  });

  it('never forces, prunes or touches a branch', () => {
    const commands = gitLog.trim().split('\n');
    const removals = commands.filter((command) => command.includes('worktree remove'));
    assert.ok(removals.length > 0);
    for (const removal of removals) assert.match(removal, /worktree remove [^-\s]\S*$/);
    for (const command of commands) assert.doesNotMatch(command, /--force| worktree prune| branch | update-ref | gc | reset | clean /);
  });

  it('keeps every branch', () => {
    assert.equal(git(repo.main, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), branchesBefore);
  });

  it('exits zero, naming the checks it made', () => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Main checkout HEAD unchanged/);
  });

  it('gives the same outcome on a second run', () => {
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /^removed /m);
    const stayed = ({ stdout }) => stdout.split('\n').filter((line) => line.startsWith('stayed '));
    assert.deepEqual(stayed(second), stayed(result));
    assert.deepEqual(snapshot(repo.notes), notesAfterFirst);
  });
});

describe('ignored files', () => {
  const folders = ['node_modules', '.next', 'dist', 'build', 'out', '.turbo', '.cache', '.vite', 'coverage', 'test-results', 'playwright-report', '__pycache__'];
  const files = ['app.tsbuildinfo', '.DS_Store'];
  let repo;
  let dry;
  let result;
  const wt = {};

  before(() => {
    repo = makeRepo();
    const exclude = [...folders.map((name) => `${name}/`), ...files, 'clone/', 'distribution/', 'app.tsbuildinfo.bak'];
    write(repo.main, '.git/info/exclude', `${exclude.join('\n')}\n`);
    for (const name of folders) {
      wt[name] = addWorktree(repo, `regen-${name}`);
      write(wt[name], `pkg/deep/${name}/file`);
    }
    for (const name of files) {
      wt[name] = addWorktree(repo, `regen-${name}`);
      write(wt[name], `pkg/deep/${name}`);
    }
    wt.env = addWorktree(repo, 'env');
    write(wt.env, '.env', 'SECRET=1\n');
    wt.db = addWorktree(repo, 'db');
    write(wt.db, 'data/app.db');
    wt.clone = addWorktree(repo, 'clone');
    git(repo.root, 'clone', '-q', repo.origin, path.join(wt.clone, 'clone'));
    commit(path.join(wt.clone, 'clone'));
    wt.nested = addWorktree(repo, 'nested');
    write(wt.nested, 'reports/.env', 'SECRET=1\n');
    write(wt.nested, 'reports/report.md');
    wt.alone = addWorktree(repo, 'alone');
    write(wt.alone, 'papers/.env', 'SECRET=1\n');
    wt.lookalike = addWorktree(repo, 'lookalike');
    write(wt.lookalike, 'distribution/file');
    wt.suffix = addWorktree(repo, 'suffix');
    write(wt.suffix, 'app.tsbuildinfo.bak');

    dry = run(repo);
    result = apply(repo);
  });

  for (const name of [...folders, ...files]) {
    it(`lets a regenerable ${name} go, at any depth`, () => {
      assert.ok(lineFor(dry, 'would remove', wt[name]), dry.stdout);
      assertRemoved(result, wt[name]);
      assert.equal(existsSync(path.join(repo.notes, `regen-${name}`)), false);
    });
  }

  for (const [what, name, kept] of [
    ['a real .env', 'env', '.env'],
    ['a database', 'db', 'data/'],
    ['an ignored clone with an unpushed commit', 'clone', 'clone/'],
    ['an ignored file beside an untracked one', 'nested', 'reports/.env'],
    ['an ignored file alone in an untracked folder', 'alone', 'papers/.env'],
    ['a folder only named like a regenerable one', 'lookalike', 'distribution/'],
    ['a file only named like a regenerable one', 'suffix', 'app.tsbuildinfo.bak'],
  ]) {
    it(`keeps a worktree holding ${what}, naming it in both modes and moving nothing`, () => {
      const why = new RegExp(`: ignored ${kept.replaceAll('.', '\\.')} is not regenerable$`);
      assert.match(lineFor(dry, 'stayed', wt[name]) ?? '', why, dry.stdout);
      assertStayed(result, wt[name], why);
      assert.equal(existsSync(path.join(repo.notes, name)), false);
    });
  }
});

describe('a paused or hidden state', () => {
  // The worktrees sit on main, where tracked.txt holds y; side holds z, on a commit no base holds.
  const attempt = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const edit = (dir, content) => {
    write(dir, 'tracked.txt', content);
    git(dir, 'commit', '-qam', content);
  };
  const pauses = {
    'a rebase stopped at an edit': ['rebase-merge', (wt) => attempt(wt, '-c', 'sequence.editor=sed -i.bak 1s/pick/edit/', 'rebase', '-i', 'HEAD~1')],
    'a failed git am, holding its patch': ['rebase-apply', (wt, repo) => attempt(wt, 'am', path.join(repo.root, 'z.patch'))],
    'a merge': ['MERGE_HEAD', (wt) => attempt(wt, 'merge', 'side')],
    'a bisect': ['BISECT_LOG', (wt) => attempt(wt, 'bisect', 'start')],
    'a cherry-pick': ['CHERRY_PICK_HEAD', (wt) => attempt(wt, 'cherry-pick', 'side')],
    'a revert': ['REVERT_HEAD', (wt) => attempt(wt, 'revert', '--no-edit', 'HEAD~1')],
  };
  let repo;
  let result;
  let lostCommit;
  const wt = {};

  before(() => {
    repo = makeRepo();
    wt.side = addWorktree(repo, 'side');
    edit(wt.side, 'z\n');
    write(repo.root, 'z.patch', git(wt.side, 'format-patch', '-1', '--stdout'));
    edit(repo.main, 'x\n');
    edit(repo.main, 'y\n');
    git(repo.main, 'push', '-q', 'origin', 'main');

    for (const [name, [, pause]] of Object.entries(pauses)) {
      wt[name] = addWorktree(repo, name.replaceAll(' ', '-').replaceAll(',', ''));
      pause(wt[name], repo);
      write(wt[name], 'report.md');
    }

    wt.movedAway = addWorktree(repo, 'moved-away');
    git(wt.movedAway, 'checkout', '-q', '--detach');
    commit(wt.movedAway, 'lost.txt');
    lostCommit = git(wt.movedAway, 'rev-parse', 'HEAD');
    git(wt.movedAway, 'checkout', '-q', '--detach', 'origin/main');

    wt.movedAwayKept = addWorktree(repo, 'moved-away-kept');
    git(wt.movedAwayKept, 'checkout', '-q', '--detach');
    commit(wt.movedAwayKept);
    git(wt.movedAwayKept, 'branch', 'keeps-it');
    git(wt.movedAwayKept, 'checkout', '-q', '--detach', 'origin/main');

    wt.resetAway = addWorktree(repo, 'reset-away');
    commit(wt.resetAway, 'reset.txt');
    git(wt.resetAway, 'reset', '-q', '--hard', 'origin/main');

    wt.skipWorktree = addWorktree(repo, 'skip-worktree');
    git(wt.skipWorktree, 'update-index', '--skip-worktree', 'tracked.txt');
    write(wt.skipWorktree, 'tracked.txt', 'edited\n');

    wt.assumeUnchanged = addWorktree(repo, 'assume-unchanged');
    git(wt.assumeUnchanged, 'update-index', '--assume-unchanged', 'tracked.txt');
    write(wt.assumeUnchanged, 'tracked.txt', 'edited\n');

    result = apply(repo);
  });

  for (const [name, [state]] of Object.entries(pauses)) {
    it(`keeps a worktree with ${name}, moving nothing`, () => {
      assertStayed(result, wt[name], new RegExp(`: ${state} says an operation is paused there$`));
      assertFile(path.join(wt[name], 'report.md'));
    });
  }

  it('keeps a detached worktree that moved away from a commit no ref reaches', () => {
    assertStayed(result, wt.movedAway, new RegExp(`its HEAD reflog holds ${lostCommit.slice(0, 7)}, which no ref reaches`));
  });

  it('removes a detached worktree whose moved-away commit a branch still reaches', () => {
    assertRemoved(result, wt.movedAwayKept);
  });

  it('removes a branch worktree that reset a commit away, since the branch reflog outlives it', () => {
    assertRemoved(result, wt.resetAway);
  });

  for (const [flag, name] of [
    ['--skip-worktree', 'skipWorktree'],
    ['--assume-unchanged', 'assumeUnchanged'],
  ]) {
    it(`keeps a worktree with an edit hidden by ${flag}`, () => {
      assertStayed(result, wt[name], /tracked\.txt is flagged so git hides its edits/);
      assertFile(path.join(wt[name], 'tracked.txt'), 'edited\n');
    });
  }
});

describe('a dry run', () => {
  let repo;
  let result;
  let snapshotBefore;
  let snapshotAfter;
  const wt = {};

  before(() => {
    repo = makeRepo();
    wt.clean = addWorktree(repo, 'clean');
    wt.report = addWorktree(repo, 'report');
    write(wt.report, 'report.md');
    wt.unmerged = addWorktree(repo, 'unmerged');
    commit(wt.unmerged);
    wt.conflict = addWorktree(repo, 'conflict');
    write(wt.conflict, 'b.txt');
    write(path.join(repo.notes, 'conflict'), 'b.txt', 'different\n');
    // A stale stat makes a plain git status rewrite the index.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(path.join(wt.clean, 'tracked.txt'), past, past);
    // A commit the local refs lack, so a fetch would write.
    const other = path.join(repo.root, 'other');
    git(repo.root, 'clone', '-q', repo.origin, other);
    commit(other, 'elsewhere.txt');
    git(other, 'push', '-q', 'origin', 'main');

    snapshotBefore = snapshot(repo.root);
    result = run(repo, ['--notes', repo.notes]);
    snapshotAfter = snapshot(repo.root);
  });

  it('writes nothing, not even a fetch or a refreshed index', () => {
    assert.deepEqual(snapshotAfter, snapshotBefore);
  });

  it('reports what would go and what would stay', () => {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(lineFor(result, 'would remove', wt.clean), result.stdout);
    assert.ok(lineFor(result, 'would remove', wt.report)?.includes('1 untracked'), result.stdout);
    assert.ok(lineFor(result, 'stayed', wt.unmerged)?.includes('is not in origin/main'), result.stdout);
    assert.ok(lineFor(result, 'stayed', wt.conflict)?.includes('already exists with different content'), result.stdout);
    assert.ok(existsSync(wt.clean));
  });

  it('creates no notes folder when the one named does not exist', () => {
    const missing = path.join(repo.root, 'no-such-notes');
    run(repo, ['--notes', missing]);
    assert.equal(existsSync(missing), false);
  });

  it('needs no notes folder', () => {
    const plain = run(repo);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(lineFor(plain, 'would remove', wt.report), plain.stdout);
  });

  it('says what an apply then does to nested worktrees', () => {
    const nested = makeRepo();
    const inIgnored = [addWorktree(nested, 'in-ignored'), addWorktree(nested, 'in-ignored/build/inner')];
    const inUntracked = [addWorktree(nested, 'in-untracked'), addWorktree(nested, 'in-untracked/sub/inner')];
    const held = addWorktree(nested, 'held');
    commit(addWorktree(nested, 'held/build/inner'));
    const paths = (output, prefix) =>
      output.stdout
        .split('\n')
        .filter((line) => line.startsWith(`${prefix} `))
        .map((line) => line.slice(prefix.length + 1))
        .sort();
    const dry = run(nested);
    const done = apply(nested);
    assert.deepEqual(paths(dry, 'would remove'), [...inIgnored, ...inUntracked].sort());
    assert.deepEqual(paths(done, 'removed'), [...inIgnored, ...inUntracked].sort());
    assert.deepEqual(paths(dry, 'stayed'), paths(done, 'stayed'));
    assert.ok(lineFor(dry, 'stayed', held)?.includes('another worktree is inside it'), dry.stdout);
    assert.match(dry.stdout, /^Would remove 4; 3 stayed\.$/m);
  });
});

describe('arguments', () => {
  it('refuses --apply without --notes, removing nothing', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    const result = run(repo, ['--apply']);
    assert.equal(result.status, 64);
    assert.ok(existsSync(wt));
  });

  it('refuses a flag it does not know, removing nothing', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    const result = apply(repo, ['--force']);
    assert.equal(result.status, 64);
    assert.ok(existsSync(wt));
  });

  it('refuses a port that is not one before it removes anything', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    for (const port of ['nope', '99999']) {
      const result = apply(repo, ['--port', port]);
      assert.equal(result.status, 64);
    }
    assert.ok(existsSync(wt));
  });

  it('refuses a base that does not exist, removing nothing', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    const result = apply(repo, ['--base', 'origin/nope']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin\/nope/);
    assert.ok(existsSync(wt));
  });
});

describe('the base', () => {
  it('removes nothing when the fetch fails', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    write(wt, 'report.md');
    git(repo.main, 'remote', 'set-url', 'origin', path.join(repo.root, 'no-such-origin'));
    const result = apply(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fetch/);
    assert.ok(existsSync(path.join(wt, 'report.md')));
    assert.equal(existsSync(repo.notes), false);
  });

  it('fetches first, so work merged on the remote since the last fetch counts', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'merged-remotely');
    commit(wt);
    git(wt, 'push', '-q', 'origin', 'HEAD:main');
    git(repo.main, 'update-ref', 'refs/remotes/origin/main', git(repo.main, 'rev-parse', 'main'));
    assertRemoved(apply(repo), wt);
  });

  it('keeps a commit in a local base that never reached the remote', () => {
    const repo = makeRepo();
    const clean = addWorktree(repo, 'clean');
    commit(repo.main, 'local.txt');
    const wt = addWorktree(repo, 'local-only', 'main');
    const result = apply(repo, ['--base', 'main']);
    assertStayed(result, wt, /is not on origin/);
    assertRemoved(result, clean);
  });

  it('does not take another remote for origin', () => {
    const repo = makeRepo();
    const fork = path.join(repo.root, 'fork.git');
    git(repo.root, 'init', '-q', '--bare', '-b', 'main', fork);
    git(repo.main, 'remote', 'add', 'fork', fork);
    commit(repo.main, 'local.txt');
    git(repo.main, 'push', '-q', 'fork', 'main');
    const wt = addWorktree(repo, 'on-the-fork', 'main');
    assertStayed(apply(repo, ['--base', 'main']), wt, /is not on origin/);
  });

  it('judges a commit that lands during the fetch', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'landed');
    git(wt, 'checkout', '-q', '--detach');
    const body = `"${realGit}" "$@"\nstatus=$?\ncase "$*" in *" fetch origin"*) "${realGit}" -C "${wt}" commit -q --allow-empty -m landed;; esac\nexit $status`;
    const result = apply(repo, [], { extraEnv: { PATH: `${fakes(repo, { git: body })}:${env.PATH}` } });
    assertStayed(result, wt, /is not in origin\/main/);
  });

  it('judges each worktree itself when a git hook hands the script its GIT_DIR', () => {
    const repo = makeRepo();
    const caller = addWorktree(repo, 'caller');
    const wt = addWorktree(repo, 'ahead');
    git(wt, 'checkout', '-q', '--detach');
    commit(wt);
    const result = apply(repo, [], { cwd: caller, extraEnv: { GIT_DIR: git(caller, 'rev-parse', '--absolute-git-dir') } });
    assertStayed(result, wt, /is not in origin\/main/);
  });
});

describe('the process check', () => {
  for (const [name, scripts] of [
    ['is missing', { git: `exec "${realGit}" "$@"` }],
    ['fails', { git: `exec "${realGit}" "$@"`, lsof: 'exit 1' }],
    ['succeeds but lists nothing', { git: `exec "${realGit}" "$@"`, lsof: 'exit 0' }],
    ['prints a cwd that is not its own', { git: `exec "${realGit}" "$@"`, lsof: "echo 'n/some/other/folder'" }],
  ]) {
    it(`keeps the worktree when lsof ${name}`, () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, 'clean');
      write(wt, 'report.md');
      const result = apply(repo, [], { extraEnv: { PATH: fakes(repo, scripts) } });
      assertStayed(result, wt, /can't tell whether a process is using it/);
      assert.ok(existsSync(path.join(wt, 'report.md')));
      assert.equal(existsSync(repo.notes), false);
    });
  }

  it('compares real paths, so a registered path through a link still matches', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'in-use');
    const caller = addWorktree(repo, 'caller');
    const link = path.join(repo.root, 'link');
    symlinkSync(repo.wts, link);
    for (const name of ['in-use', 'caller']) {
      writeFileSync(path.join(repo.main, '.git/worktrees', name, 'gitdir'), `${path.join(link, name, '.git')}\n`);
    }
    occupy(wt);
    const result = apply(repo, [], { cwd: caller });
    assertStayed(result, path.join(link, 'in-use'), /a process has its cwd there/);
    assertStayed(result, path.join(link, 'caller'), /the checkout this ran from/);
  });

  it('settles letter case, so a registered path in another case still matches', (t) => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'in-use');
    const shouted = path.join(path.dirname(repo.root), path.basename(repo.root).toUpperCase());
    if (!existsSync(shouted)) return t.skip('a case-sensitive disk');
    writeFileSync(path.join(repo.main, '.git/worktrees/in-use/gitdir'), `${path.join(shouted, 'wts/in-use/.git')}\n`);
    occupy(wt);
    assertStayed(apply(repo), path.join(shouted, 'wts/in-use'), /a process has its cwd there/);
  });

  it('keeps the checkout it was called from, even from a folder under it', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'caller');
    write(wt, 'sub/file.txt');
    assertStayed(apply(repo, [], { cwd: path.join(wt, 'sub') }), wt, /: it is the checkout this ran from$/);
  });

  it('keeps a worktree whose path lsof would print escaped, a backslash included', () => {
    const repo = makeRepo();
    const wt = path.join(repo.root, 'back\\slash');
    git(repo.main, 'worktree', 'add', '-q', '-b', 'back-slash', wt, 'origin/main');
    assertStayed(apply(repo), wt, /lsof escapes its path/);
  });

  it('does not mistake a sibling with a longer name for the worktree', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    occupy(addWorktree(repo, 'clean-longer'));
    const result = apply(repo);
    assertRemoved(result, wt);
    assertStayed(result, `${wt}-longer`, /a process has its cwd there/);
  });
});

describe('copying', () => {
  it('moves a name with spaces, quotes, a newline or non-ASCII', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'odd-names');
    const names = ['my report.md', 'say "hi".md', 'two\nlines.md', 'résumé.md'];
    for (const name of names) write(wt, name);
    assertRemoved(apply(repo), wt);
    for (const name of names) assertFile(path.join(repo.notes, 'odd-names', name));
  });

  it('keeps a worktree when --notes is its parent, whose copy would be the original', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'at-parent');
    write(wt, 'report.md');
    const result = run(repo, ['--apply', '--notes', repo.wts]);
    assertStayed(result, wt, /the copy of report\.md would sit inside it/);
    assert.doesNotMatch(result.stdout, /^moved /m);
    assertFile(path.join(wt, 'report.md'));
  });

  it('keeps a worktree whose folder in the notes links back into it', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'linked-back');
    write(wt, 'report.md');
    mkdirSync(repo.notes);
    symlinkSync(wt, path.join(repo.notes, 'linked-back'));
    const result = apply(repo);
    assertStayed(result, wt, /the copy of report\.md would sit inside it/);
    assertFile(path.join(wt, 'report.md'));
  });

  it('keeps a worktree whose copy in the notes is a hard link to the original', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'hard-linked');
    write(wt, 'report.md');
    mkdirSync(path.join(repo.notes, 'hard-linked'), { recursive: true });
    linkSync(path.join(wt, 'report.md'), path.join(repo.notes, 'hard-linked/report.md'));
    assertStayed(apply(repo), wt, /is report\.md itself/);
    assertFile(path.join(wt, 'report.md'));
  });

  it('keeps a worktree whose copy in the notes is a symlink to the original', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'sym-linked');
    write(wt, 'report.md');
    mkdirSync(path.join(repo.notes, 'sym-linked'), { recursive: true });
    symlinkSync(path.join(wt, 'report.md'), path.join(repo.notes, 'sym-linked/report.md'));
    assertStayed(apply(repo), wt, /already exists with different content/);
    assertFile(path.join(wt, 'report.md'));
  });

  it('keeps a worktree holding a populated submodule, moving nothing', () => {
    const repo = makeRepo();
    const library = path.join(repo.root, 'library');
    git(repo.root, 'init', '-q', '-b', 'main', library);
    commit(library, 'library.txt');
    git(repo.main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
    git(repo.main, 'commit', '-qm', 'add a submodule');
    git(repo.main, 'push', '-q', 'origin', 'main');
    const wt = addWorktree(repo, 'with-submodule');
    git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    write(wt, 'report.md');
    const result = apply(repo);
    assertStayed(result, wt, /: it holds submodules, which git refuses to remove$/);
    assert.doesNotMatch(result.stdout, /^moved /m);
    assertFile(path.join(wt, 'report.md'));
    assert.equal(existsSync(path.join(repo.notes, 'with-submodule')), false);
  });

  it('finishes a move killed mid-copy on the next run', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'killed');
    write(wt, 'report.md');
    const preload = write(
      repo.root,
      'killed.mjs',
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.copyFileSync = (from, to) => {
  fs.writeFileSync(to, 'stub');
  process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
`,
    );
    assert.equal(apply(repo, [], { nodeArgs: ['--import', preload] }).signal, 'SIGKILL');
    assertFile(path.join(wt, 'report.md'));
    assertRemoved(apply(repo), wt);
    assertFile(path.join(repo.notes, 'killed/report.md'));
  });

  it('keeps every original when one copy comes out different', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'corrupt');
    write(wt, 'a.txt');
    write(wt, 'b.txt');
    const preload = write(
      repo.root,
      'corrupt.mjs',
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { copyFileSync } = fs;
fs.copyFileSync = (from, to, mode) => {
  copyFileSync(from, to, mode);
  if (to.includes('b.txt')) fs.writeFileSync(to, 'corrupted');
};
syncBuiltinESMExports();
`,
    );
    const result = apply(repo, [], { nodeArgs: ['--import', preload] });
    assertStayed(result, wt, /differs/);
    assertFile(path.join(wt, 'a.txt'));
    assertFile(path.join(wt, 'b.txt'));
    assert.equal(existsSync(path.join(repo.notes, 'corrupt/b.txt')), false, 'a bad copy took its final name');
  });

  it('keeps the worktree when a copy cannot be made', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'blocked');
    write(wt, 'report.md');
    write(repo.notes, 'blocked', 'a file where the folder belongs\n');
    assertStayed(apply(repo), wt, /./);
    assertFile(path.join(wt, 'report.md'));
  });

  it('keeps a worktree that holds the notes folder, which would go with it', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'holds-notes');
    write(wt, 'report.md');
    const result = run(repo, ['--apply', '--notes', path.join(wt, 'build/notes')]);
    assertStayed(result, wt, /the notes folder is inside it/);
    assertFile(path.join(wt, 'report.md'));
  });

  it('reports a worktree git refuses to remove as stayed, with its report safe in the notes', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'refused');
    write(wt, 'report.md');
    const body = `case "$*" in *"worktree remove"*) echo 'fatal: refused by the test' >&2; exit 128;; esac\nexec "${realGit}" "$@"`;
    const result = apply(repo, [], { extraEnv: { PATH: `${fakes(repo, { git: body })}:${env.PATH}` } });
    assertStayed(result, wt, /refused by the test/);
    assert.match(result.stdout, /^moved 1 untracked from .*refused to /m);
    assert.equal(result.status, 0, result.stderr);
    assertFile(path.join(repo.notes, 'refused/report.md'));
  });
});

describe('the checks after an apply', () => {
  it('fails loudly when the main checkout HEAD moved during the run', () => {
    const repo = makeRepo();
    addWorktree(repo, 'clean');
    const lsof = `"${realGit}" -C "${repo.main}" commit -q --allow-empty -m moved\nexec "${realLsof}" "$@"`;
    const result = apply(repo, [], { extraEnv: { PATH: `${fakes(repo, { lsof })}:${env.PATH}` } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MAIN CHECKOUT HEAD MOVED/);
  });

  it('passes when the port answers', async () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'clean');
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const result = apply(repo, ['--port', String(port)]);
    server.close();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Port ${port} answers`));
    assertRemoved(result, wt);
  });

  it('fails loudly when the port is closed', async () => {
    const repo = makeRepo();
    addWorktree(repo, 'clean');
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    const result = apply(repo, ['--port', String(port)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`NOTHING ANSWERS ON PORT ${port}`));
  });
});
