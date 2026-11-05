// Run: node --test orchestrated-build/templates/clean-worktrees.test.mjs
// Every case runs the real script on a throwaway repo with a bare origin, never on the repo holding this file.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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

// A run from a git hook inherits GIT_DIR, which would point these commands at the real repo.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const realLsof = execFileSync('sh', ['-c', 'PATH="$PATH:/usr/sbin:/usr/bin" command -v lsof'], { encoding: 'utf8' }).trim();

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

// A folder of fakes that goes first on PATH: { name: sh body }.
function fakes(repo, scripts) {
  const dir = mkdtempSync(path.join(repo.root, 'fakes-'));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function lineFor(result, prefix, wt) {
  return result.stdout.split('\n').find((line) => line === `${prefix} ${wt}` || line.startsWith(`${prefix} ${wt}: `) || line.startsWith(`${prefix} ${wt} (`));
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

    wt.gone = addWorktree(repo, 'gone');
    rmSync(wt.gone, { recursive: true });

    wt.clean = addWorktree(repo, 'clean');

    wt['with-report'] = addWorktree(repo, 'with-report');
    write(wt['with-report'], 'report.md');
    write(wt['with-report'], 'reports/deep/data.bin', Buffer.from(Array.from({ length: 256 }, (_, i) => i)));

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
    const options = { cwd: wt.caller, extraEnv: { PATH: `${spy}:${process.env.PATH}:/usr/sbin` } };
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
      assert.equal(readFileSync(path.join(wt[name], 'report.md'), 'utf8'), REPORT);
      assert.equal(existsSync(path.join(repo.notes, name)), false, 'its report was copied');
    });
  }

  it('keeps the checkout it was called from', () => {
    assertStayed(result, wt.caller, /the checkout this ran from/);
  });

  it('keeps the main checkout, with its untracked and ignored files', () => {
    assertStayed(result, repo.main, /the main checkout/);
    assert.equal(readFileSync(path.join(repo.main, 'main-note.txt'), 'utf8'), REPORT);
    assert.equal(readFileSync(path.join(repo.main, 'data/app.db'), 'utf8'), REPORT);
    assert.equal(existsSync(path.join(repo.notes, 'main')), false);
  });

  it('keeps a worktree whose target already differs, deleting and copying nothing', () => {
    assertStayed(result, wt.conflict, /already exists with different content/);
    assert.equal(readFileSync(path.join(wt.conflict, 'a.txt'), 'utf8'), REPORT);
    assert.equal(readFileSync(path.join(wt.conflict, 'b.txt'), 'utf8'), REPORT);
    assert.equal(readFileSync(path.join(repo.notes, 'conflict/b.txt'), 'utf8'), 'different\n');
    assert.equal(existsSync(path.join(repo.notes, 'conflict/a.txt')), false);
  });

  it('keeps a worktree with an untracked symlink, deleting and copying nothing', () => {
    assertStayed(result, wt.symlink, /untracked link is not a plain file/);
    assert.equal(lstatSync(path.join(wt.symlink, 'link')).isSymbolicLink(), true);
    assert.equal(readFileSync(path.join(wt.symlink, 'plain.txt'), 'utf8'), REPORT);
    assert.equal(existsSync(path.join(repo.notes, 'symlink')), false);
  });

  it('keeps a worktree with an untracked nested repo', () => {
    assertStayed(result, wt['nested-repo'], /is not a plain file/);
    assert.equal(readFileSync(path.join(wt['nested-repo'], 'vendor/file.txt'), 'utf8'), REPORT);
  });

  it('keeps a worktree that holds another one, which would go with it', () => {
    assertStayed(result, wt.held, /another worktree is inside it/);
    assertStayed(result, wt.heldInner, /is not in origin\/main/);
  });

  it('removes a merged pair, inner first', () => {
    assertRemoved(result, wt.pairInner);
    assertRemoved(result, wt.pair);
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
    assert.equal(readFileSync(path.join(repo.notes, 'with-report/report.md'), 'utf8'), REPORT);
    assert.deepEqual(
      [...readFileSync(path.join(repo.notes, 'with-report/reports/deep/data.bin'))],
      Array.from({ length: 256 }, (_, i) => i),
    );
  });

  it('counts an identical file already in the notes as copied', () => {
    assertRemoved(result, wt['already-copied']);
    assert.equal(readFileSync(path.join(repo.notes, 'already-copied/report.md'), 'utf8'), REPORT);
  });

  it('lets ignored files go with the worktree, uncopied, without following links', () => {
    assertRemoved(result, wt.ignored);
    assert.equal(existsSync(path.join(repo.notes, 'ignored')), false);
    assert.equal(readFileSync(path.join(repo.main, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(readFileSync(path.join(repo.root, 'outside/keep.txt'), 'utf8'), REPORT);
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
});

describe('the process check', () => {
  for (const [name, scripts] of [
    ['is missing', { git: `exec "${realGit}" "$@"` }],
    ['fails', { git: `exec "${realGit}" "$@"`, lsof: 'exit 1' }],
    ['succeeds but lists nothing', { git: `exec "${realGit}" "$@"`, lsof: 'exit 0' }],
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
  if (to.endsWith('b.txt')) fs.writeFileSync(to, 'corrupted');
};
syncBuiltinESMExports();
`,
    );
    const result = apply(repo, [], { nodeArgs: ['--import', preload] });
    assertStayed(result, wt, /differs/);
    assert.equal(readFileSync(path.join(wt, 'a.txt'), 'utf8'), REPORT);
    assert.equal(readFileSync(path.join(wt, 'b.txt'), 'utf8'), REPORT);
  });

  it('keeps the worktree when a copy cannot be made', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'blocked');
    write(wt, 'report.md');
    write(repo.notes, 'blocked', 'a file where the folder belongs\n');
    assertStayed(apply(repo), wt, /./);
    assert.equal(readFileSync(path.join(wt, 'report.md'), 'utf8'), REPORT);
  });

  it('keeps a worktree that holds the notes folder, which would go with it', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'holds-notes');
    write(wt, 'report.md');
    const result = run(repo, ['--apply', '--notes', path.join(wt, 'build/notes')]);
    assertStayed(result, wt, /the notes folder is inside it/);
    assert.equal(readFileSync(path.join(wt, 'report.md'), 'utf8'), REPORT);
  });

  it('reports a worktree git refuses to remove as stayed, with its report safe in the notes', () => {
    const repo = makeRepo();
    const wt = addWorktree(repo, 'refused');
    write(wt, 'report.md');
    const body = `case "$*" in *"worktree remove"*) echo 'fatal: refused by the test' >&2; exit 128;; esac\nexec "${realGit}" "$@"`;
    const result = apply(repo, [], { extraEnv: { PATH: `${fakes(repo, { git: body })}:${process.env.PATH}:/usr/sbin` } });
    assertStayed(result, wt, /refused by the test/);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(repo.notes, 'refused/report.md'), 'utf8'), REPORT);
  });
});

describe('the checks after an apply', () => {
  it('fails loudly when the main checkout HEAD moved during the run', () => {
    const repo = makeRepo();
    addWorktree(repo, 'clean');
    const lsof = `"${realGit}" -C "${repo.main}" commit -q --allow-empty -m moved\nexec "${realLsof}" "$@"`;
    const result = apply(repo, [], { extraEnv: { PATH: `${fakes(repo, { lsof })}:${process.env.PATH}` } });
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
