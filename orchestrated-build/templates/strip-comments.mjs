#!/usr/bin/env node
// Usage, from inside the repo under review: node strip-comments.mjs <base-ref> <out-dir>
// Copies every file the branch changed since <base-ref> into <out-dir> with its comments removed, for
// the review's blind pass: a comment that claims what the code does anchors the reviewer on the claim.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = /\.(m|c)?[jt]sx?$/;

/** `source` with the spans `[start, end)` cut out; a line left holding nothing else goes whole. */
export function cut(source, spans) {
  let out = source;
  for (const { start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const next = out.indexOf('\n', end);
    const lineEnd = next === -1 ? out.length : next;
    if (out.slice(lineStart, start).trim() === '' && out.slice(end, lineEnd).trim() === '') {
      out = out.slice(0, lineStart) + out.slice(next === -1 ? lineEnd : lineEnd + 1);
    } else {
      let from = start;
      while (from > lineStart && (out[from - 1] === ' ' || out[from - 1] === '\t')) from--;
      out = out.slice(0, from) + out.slice(end);
    }
  }
  return out;
}

/** Comment spans from the repo's own parser: oxc (rolldown, which Vite 8 ships), else TypeScript ≤ 6. */
export function commentFinder(root) {
  const places = [root, ...['apps', 'packages'].flatMap((dir) => subdirs(path.join(root, dir)))];
  for (const place of places) {
    const require = createRequire(path.join(place, 'package.json'));
    for (const via of [null, 'vite']) {
      try {
        const from = via ? createRequire(require.resolve(via)) : require;
        const { parseSync } = from('rolldown/experimental');
        return (source, fileName) => parseSync(fileName, source).comments;
      } catch {}
    }
    try {
      const ts = require('typescript');
      if (ts.createSourceFile) return (source, fileName) => typescriptComments(ts, source, fileName);
    } catch {}
  }
  throw new Error('Found neither rolldown (Vite 8) nor a TypeScript with its JS API in this repo');
}

function subdirs(dir) {
  return existsSync(dir)
    ? execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter(Boolean).map((d) => path.join(dir, d))
    : [];
}

function typescriptComments(ts, source, fileName) {
  const kind = /x$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const spans = new Map();
  const visit = (node) => {
    for (const ranges of [ts.getLeadingCommentRanges(source, node.pos), ts.getTrailingCommentRanges(source, node.end)]) {
      for (const { pos, end } of ranges ?? []) spans.set(pos, { start: pos, end });
    }
    node.forEachChild(visit);
  };
  visit(file);
  return [...spans.values()];
}

/** The source without its comments, or null for a file the blind pass leaves out. */
export function stripComments(source, fileName, findComments) {
  if (SCRIPT.test(fileName)) return cut(source, findComments(source, fileName));
  if (fileName.endsWith('.css')) return source.replace(/\/\*[\s\S]*?\*\//g, '');
  if (fileName.endsWith('.html')) return source.replace(/<!--[\s\S]*?-->/g, '');
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, out] = process.argv.slice(2);
  if (!base || !out) {
    process.stderr.write('usage: node strip-comments.mjs <base-ref> <out-dir>\n');
    process.exit(64);
  }
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const find = commentFinder(root);
  const changed = git(['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`]).split('\n').filter(Boolean);
  const skipped = [];
  for (const file of changed) {
    const stripped = stripComments(readFileSync(path.join(root, file), 'utf8'), file, find);
    if (stripped === null) {
      skipped.push(file);
      continue;
    }
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), stripped);
  }
  process.stdout.write(`${changed.length - skipped.length} files stripped into ${out}\n`);
  // Docs and data stay out of the blind pass; the reviewer reads SPEC from the repo.
  if (skipped.length) process.stdout.write(`not copied: ${skipped.join(', ')}\n`);
}
