// Smoke test: an empty nest box + a verb stream -> genesis -> adjudication ->
// sync -> lint -> pack -> pruning. The whole meta-loop on a synthetic fukuro.db.
import { execSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'cli', 'subako.ts');
const TMP = join(HERE, '.tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// --- synthetic event stream (fukuro.db shape) ---
const dbPath = join(TMP, 'events.db');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT, kind TEXT, loop_id TEXT, data TEXT)');
const ins = db.prepare('INSERT INTO events (ts, kind, loop_id, data) VALUES (?, ?, ?, ?)');
const old = '2026-01-01T00:00:00.000Z'; // older than any --silence window
const now = '2026-07-01T00:00:00.000Z';
ins.run(now, 'hypothesis_opened', 'loop-a', JSON.stringify({ id: 'H-1' }));
ins.run(now, 'hypothesis_opened', 'loop-a', JSON.stringify({ id: 'H-2' }));
ins.run(now, 'hypothesis_closed', 'loop-a', JSON.stringify({ id: 'H-2' }));
ins.run(now, 'loop_start', 'loop-a', '{}');
ins.run(now, 'tick', 'loop-a', '{}');
ins.run(now, 'loop_end', 'loop-a', '{}');
ins.run(now, 'stop_line_hit', 'loop-a', JSON.stringify({ line: 'push-without-gate' }));
ins.run(now, 'stop_line_hit', 'loop-a', JSON.stringify({ line: 'push-without-gate' }));
ins.run(now, 'stop_line_hit', 'loop-a', JSON.stringify({ line: 'push-without-gate' }));
ins.run(old, 'ancient_thing', 'loop-z', '{}'); // silent verb for pruning
ins.run(now, null, 'loop-a', '{}'); // NULL kind row must not crash anything
ins.run(now, 'hypothesis_opened', 'loop-a', JSON.stringify({ id: 42 })); // numeric id
ins.run(now, 'hypothesis_opened', 'loop-a', JSON.stringify({ id: 'H 3' }));  // both slugify to 'h-3'
ins.run(now, 'hypothesis_opened', 'loop-a', JSON.stringify({ id: 'H_3' }));
db.close();

const nest = join(TMP, 'nest');
const run = (args) => {
  const r = spawnSync('node', [CLI, ...args, '--db', dbPath, '--dir', nest], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

// --- init: the box is empty by law ---
execSync(`node ${CLI} init ${nest}`);
assert.ok(existsSync(join(nest, '_schema', 'proposed')));
assert.strictEqual(readdirSync(join(nest, '_schema')).filter((f) => f.endsWith('.md')).length, 0, 'init must create zero types');

// --- genesis: recurring verbs -> proposals (lifecycle detected from opened/closed) ---
let r = run(['genesis']);
const proposed = readdirSync(join(nest, '_schema', 'proposed'));
assert.ok(proposed.includes('hypothesis.md'), `hypothesis proposal expected, got ${proposed}`);
const hyp = readFileSync(join(nest, '_schema', 'proposed', 'hypothesis.md'), 'utf8');
assert.match(hyp, /derive: lifecycle/, 'opened/closed pair must be detected as lifecycle');
assert.ok(proposed.includes('stop-line.md') || proposed.includes('stop_line.md'), `stop_line proposal expected, got ${proposed}`);

// --- lint before adjudication: unnamed verbs warned, no errors ---
r = run(['lint']);
assert.strictEqual(r.status, 0, `lint must pass on a legal nest: ${r.out}`);
assert.match(r.out, /proposal 裁定待ち/, 'pending proposals must be surfaced');

// --- adjudication is a file move ---
renameSync(join(nest, '_schema', 'proposed', 'hypothesis.md'), join(nest, '_schema', 'hypothesis.md'));

// --- sync: lifecycle instances derived with status ---
r = run(['sync']);
assert.ok(existsSync(join(nest, 'hypothesis', 'h-1.md')) && existsSync(join(nest, 'hypothesis', 'h-2.md')), 'instances derived');
const h1 = readFileSync(join(nest, 'hypothesis', 'h-1.md'), 'utf8');
const h2 = readFileSync(join(nest, 'hypothesis', 'h-2.md'), 'utf8');
assert.match(h1, /status: open/); assert.match(h2, /status: closed/);

// --- human annotation survives re-sync; body lines that LOOK like derived keys are inviolable ---
writeFileSync(join(nest, 'hypothesis', 'h-1.md'), h1 + '\n**裁定メモ**: これは残す。\nstatus: この行は本文であり機械が触ってはならない\n');
run(['sync']);
const h1b = readFileSync(join(nest, 'hypothesis', 'h-1.md'), 'utf8');
assert.match(h1b, /裁定メモ/, 're-sync must not clobber human content');
assert.match(h1b, /status: この行は本文であり機械が触ってはならない/, 'sync must never rewrite body lines (law 2)');
// numeric id derived; slug collision separated by hash suffix, identities kept via id:
assert.ok(existsSync(join(nest, 'hypothesis', '42.md')), 'numeric id must derive');
const h3s = readdirSync(join(nest, 'hypothesis')).filter((f) => f.startsWith('h-3'));
assert.strictEqual(h3s.length, 2, `slug collision must yield two files, got ${h3s}`);

// --- pack: inject-when status=open picks h-1 only; telemetry appended ---
r = run(['pack']);
assert.match(r.out, /hypothesis\/h-1\.md/);
assert.ok(!/h-2\.md/.test(r.out), 'closed instance must not be injected');
assert.ok(existsSync(join(nest, '_telemetry', 'injections.jsonl')));

// --- registry: adjudicate stop-line schema + one named line; sync counts hits ---
renameSync(join(nest, '_schema', 'proposed', proposed.find((f) => f.startsWith('stop'))),
  join(nest, '_schema', 'stop-line.md'));
mkdirSync(join(nest, 'stop-line'), { recursive: true });
writeFileSync(join(nest, 'stop-line', 'push-without-gate.md'),
  '---\ntype: stop-line\nstatus: active\n---\n\n# push-without-gate\n\n**定義**: ゲート未通過のpush。\n');
run(['sync']);
assert.match(readFileSync(join(nest, 'stop-line', 'push-without-gate.md'), 'utf8'), /hits: 3/);

// --- lint: verbless / missing type / bogus derive are errors ---
writeFileSync(join(nest, '_schema', 'bad.md'), '---\ndefines: bad\nverbs: x\nderive: bogus\n---\n\n# bad\n');
r = run(['lint']);
assert.strictEqual(r.status, 1, 'illegal schema must fail lint');
assert.match(r.out, /type: schema がない/);
assert.match(r.out, /derive が不正/);
rmSync(join(nest, '_schema', 'bad.md'));
// csv accepts YAML-ish bracket notation
writeFileSync(join(nest, '_schema', 'brackets.md'),
  '---\ntype: schema\ndefines: brackets\nverbs: [hypothesis_opened, hypothesis_closed]\nderive: none\n---\n\n# brackets\n');
r = run(['lint']);
assert.ok(!/brackets.*イベントが一度も無い/.test(r.out), 'bracket verbs must match events');
rmSync(join(nest, '_schema', 'brackets.md'));
// missing db -> friendly error, not a stack trace
const miss = spawnSync('node', [CLI, 'lint', '--db', join(TMP, 'nope.db'), '--dir', nest], { encoding: 'utf8' });
assert.strictEqual(miss.status, 2);
assert.match(miss.stderr, /cannot open event db/);

// --- pruning: a type whose verbs went silent is proposed for retirement ---
writeFileSync(join(nest, '_schema', 'ancient.md'),
  '---\ntype: schema\ndefines: ancient\nverbs: ancient_thing\nderive: ledger\nid-source: loop_id\n---\n\n# ancient\n');
r = run(['genesis']);
assert.match(r.out, /prune candidate — ancient/);

rmSync(TMP, { recursive: true, force: true });
console.log('smoke: ok');
