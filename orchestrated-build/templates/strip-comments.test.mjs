// Run from a repo with Vite 8 or TypeScript ≤ 6 installed: node --test <skill>/templates/strip-comments.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentFinder, cut, stripComments } from './strip-comments.mjs';

const find = commentFinder(process.cwd());

test('removes every comment from TSX and keeps the code, its types and its other lines', () => {
  const source = `/** Approves only what Owen saw. */
export function approve(id: string): boolean {
  // never writes before Approve

  return id.length > 0; /* trailing */
}
const view = <p class="x">{/* note */}http://example.com</p>;
`;
  assert.equal(
    stripComments(source, 'a.tsx', find),
    `export function approve(id: string): boolean {

  return id.length > 0;
}
const view = <p class="x">{}http://example.com</p>;
`,
  );
});

test('keeps strings, template literals and regexes that look like comments', () => {
  const source = "const u = 'http://127.0.0.1'; const t = `/* ${u} */`; const r = /\\/\\*x/; // é 🚀 note\n";
  assert.equal(
    stripComments(source, 'a.ts', find),
    "const u = 'http://127.0.0.1'; const t = `/* ${u} */`; const r = /\\/\\*x/;\n",
  );
});

test('finds comments after multi-byte characters at the right place', () => {
  const source = "const e = 'é 🚀 ü'; // one\nconst f = 1; /* two */\n";
  assert.equal(stripComments(source, 'a.ts', find), "const e = 'é 🚀 ü';\nconst f = 1;\n");
});

test('cuts two comments on one line and the line they leave empty', () => {
  assert.equal(cut('a\n/* x */ /* y */\nb', [{ start: 2, end: 9 }, { start: 10, end: 17 }]), 'a\nb');
});

test('strips CSS and HTML comments, and leaves other files out', () => {
  assert.equal(stripComments('a { color: red; /* why */ }', 'a.css', find), 'a { color: red;  }');
  assert.equal(stripComments('<p><!-- why -->x</p>', 'a.html', find), '<p>x</p>');
  assert.equal(stripComments('# Title', 'SPEC.md', find), null);
});
