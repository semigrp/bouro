#!/usr/bin/env node
// subako（巣箱）— a meta-system for growing your own ontology.
//
// A nest box is not a nest: what we ship is the empty box — a T-box contract,
// a type-genesis protocol, and schema-driven sync / lint / pack. The nest (your
// types, your instances) is built by your own verbs, and only adjudicated —
// never authored — by you.
//
// Laws (see README):
//   1. Verbs first, nouns later — a type is born from recurring event kinds.
//   2. Humans adjudicate; machines write (proposals are file moves away).
//   3. The store is a product of the system, never the product we ship.
//   4. Types are pruned when their verbs go silent.
//   5. The system carries its own falsification (injection telemetry).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

// ---------- args ----------
const [, , cmd, ...rest] = process.argv;
const opt = (name: string, fallback?: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const has = (name: string): boolean => rest.includes(`--${name}`);
const DIR = () => {
  const d = opt('dir', process.env.SUBAKO);
  if (!d) { console.error('subako: --dir <instance> or $SUBAKO required'); process.exit(2); }
  return d!;
};
const DB = () => opt('db', process.env.FUKURO_DB ?? join(process.env.HOME ?? '', '.fukuro', 'fukuro.db'))!;

// ---------- frontmatter ----------
interface Doc { slug: string; path: string; fm: Record<string, string>; body: string }
function parse(path: string): Doc {
  const raw = readFileSync(path, 'utf8');
  const fmRaw = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const fm: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const kv = line.match(/^(\S[^:]*):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim().replace(/^"|"$/g, '');
  }
  return { slug: basename(path).replace(/\.md$/, ''), path, fm, body: raw.replace(/^---\n[\s\S]*?\n---\n?/, '') };
}
const list = (dir: string): Doc[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parse(join(dir, f))) : [];
const csv = (s?: string): string[] =>
  (s ?? '').replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);

// ---------- schemas (the T-box) ----------
// _schema/<type>.md — see docs/SCHEMA-CONTRACT.md. Key fields:
//   defines, verbs (csv), derive (none|ledger|lifecycle|registry), id-source,
//   open-verbs / close-verbs (csv), match-field, inject-when (k=v csv), required (csv)
const schemas = (dir: string): Doc[] => list(join(dir, '_schema')).filter((s) => s.fm.defines);
const instances = (dir: string, type: string): Doc[] => list(join(dir, type));

// ---------- events ----------
interface Ev { id: number; ts: string; kind: string; loop_id: string | null; data: any }
function events(dbPath: string): Ev[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { console.error(`subako: cannot open event db: ${dbPath} (set --db or $FUKURO_DB)`); process.exit(2); }
  return (db.prepare('SELECT id, ts, kind, loop_id, data FROM events ORDER BY id').all() as any[])
    .filter((r) => typeof r.kind === 'string' && r.kind)
    .map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : {} }));
}
const idOf = (e: Ev, source: string): string | null => {
  if (source === 'loop_id') return e.loop_id;
  const v = source.split('.').reduce((o: any, k) => o?.[k], { data: e.data } as any);
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v ? v : null;
};
const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unnamed';

// ---------- init ----------
function cmdInit(): void {
  const dir = opt('dir') ?? rest.find((r) => !r.startsWith('--')) ?? process.cwd();
  mkdirSync(join(dir, '_schema', 'proposed'), { recursive: true });
  mkdirSync(join(dir, '_telemetry'), { recursive: true });
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      '# my ontology (grown by subako)', '',
      'This directory is a nest built inside a [subako](https://github.com/semigrp/subako) nest box.',
      'It starts with **zero types** — run `subako genesis` after your event stream has verbs,',
      'then adjudicate proposals by moving them from `_schema/proposed/` into `_schema/`.', '',
    ].join('\n'));
  }
  console.error(`subako init: ${dir} (_schema/ is empty by design — types are born from your verbs)`);
}

// ---------- genesis (the meta core) ----------
// Group event kinds by stem, find recurring verbs no type covers, and draft a
// schema proposal. Adjudication is a file move: _schema/proposed/ -> _schema/.
const LIFE_SUFFIX = ['opened', 'closed', 'start', 'end', 'started', 'ended', 'hit', 'applied', 'passed', 'failed', 'created', 'delivered'];
const stemOf = (kind: string): string => {
  const parts = kind.split('_');
  return parts.length > 1 && LIFE_SUFFIX.includes(parts[parts.length - 1]) ? parts.slice(0, -1).join('_') : kind;
};
function cmdGenesis(): void {
  const dir = DIR();
  const evs = events(DB());
  const covered = new Set(schemas(dir).flatMap((s) => csv(s.fm.verbs)));
  const threshold = Number(opt('threshold', '3'));

  const byStem = new Map<string, Map<string, number>>();
  for (const e of evs) {
    if (covered.has(e.kind)) continue;
    const stem = stemOf(e.kind);
    if (!byStem.has(stem)) byStem.set(stem, new Map());
    const m = byStem.get(stem)!;
    m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
  }
  let proposed = 0;
  for (const [stem, kinds] of byStem) {
    const total = [...kinds.values()].reduce((a, b) => a + b, 0);
    if (total < threshold) continue;
    const names = [...kinds.keys()];
    const opens = names.filter((k) => /(opened|start|started|created)$/.test(k));
    const closes = names.filter((k) => /(closed|end|ended|delivered)$/.test(k));
    const derive = opens.length && closes.length ? 'lifecycle' : names.some((k) => /_hit$/.test(k)) ? 'registry' : 'ledger';
    const type = slugify(stem.replaceAll('_', '-'));
    const out = join(dir, '_schema', 'proposed', `${type}.md`);
    if (existsSync(out) || existsSync(join(dir, '_schema', `${type}.md`))) continue;
    mkdirSync(join(dir, '_schema', 'proposed'), { recursive: true });
    writeFileSync(out, [
      '---', 'type: schema', `defines: ${type}`, `verbs: ${names.join(', ')}`, `derive: ${derive}`,
      ...(derive === 'lifecycle' ? [`open-verbs: ${opens.join(', ')}`, `close-verbs: ${closes.join(', ')}`, 'id-source: data.id'] : []),
      ...(derive === 'registry' ? ['match-field: data.line', 'inject-when: status=active', 'required: status'] : []),
      ...(derive === 'ledger' ? ['id-source: loop_id'] : []),
      ...(derive === 'lifecycle' ? ['inject-when: status=open', 'required: status'] : []),
      '---', '', `# ${type}（提案 — 裁定待ち）`, '',
      `動詞 ${names.join(' / ')} が計 ${total} 回出現しているが、対応する名詞型がない。`,
      '', '**裁定**: この型を認めるなら、この節を人間向けの型の意味・裁定基準に書き換え、',
      'ファイルを `_schema/` 直下へ移す。認めないなら削除する（動詞は unnamed のまま lint が数え続ける）。', '',
    ].join('\n'));
    console.error(`genesis: proposed _schema/proposed/${type}.md (${names.join(', ')} — ${total} events)`);
    proposed++;
  }

  // pruning proposals: covered types whose verbs went silent
  const days = Number(opt('silence', '90'));
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  for (const s of schemas(dir)) {
    const verbs = new Set(csv(s.fm.verbs));
    const recent = evs.some((e) => verbs.has(e.kind) && e.ts >= cutoff);
    const ever = evs.some((e) => verbs.has(e.kind));
    if (!recent) console.error(`genesis: prune candidate — ${s.fm.defines} (${ever ? `no events in ${days}d` : 'no events ever'}) — 裁定: retire or keep`);
  }
  console.error(`subako genesis: ${proposed} proposal(s)`);
}

// ---------- lint ----------
function cmdLint(): void {
  const dir = DIR();
  const evs = events(DB());
  const errors: string[] = []; const warns: string[] = [];
  const covered = new Set<string>();
  const DERIVES = ['ledger', 'lifecycle', 'registry', 'none'];
  for (const s of schemas(dir)) {
    if (s.fm.type !== 'schema') errors.push(`_schema/${s.slug}: type: schema がない（契約必須キー）`);
    if (!DERIVES.includes(s.fm.derive ?? ''))
      errors.push(`_schema/${s.slug}: derive が不正（${s.fm.derive ?? 'なし'}）— ledger|lifecycle|registry|none のいずれか`);
    if (!s.fm.verbs && !s.fm['born-of'])
      errors.push(`_schema/${s.slug}: verbs も born-of もない（法則1: 出自なき型は存在できない）`);
    for (const v of csv(s.fm.verbs)) covered.add(v);
    const required = csv(s.fm.required);
    for (const inst of instances(dir, s.fm.defines)) {
      for (const k of required) if (!inst.fm[k]) errors.push(`${s.fm.defines}/${inst.slug}: required key '${k}' がない`);
    }
    if (s.fm.verbs && !evs.some((e) => csv(s.fm.verbs).includes(e.kind)))
      warns.push(`_schema/${s.slug}: 動詞 ${s.fm.verbs} のイベントが一度も無い（構造先行の疑い）`);
  }
  const unnamed = new Map<string, number>();
  for (const e of evs) if (!covered.has(e.kind)) unnamed.set(stemOf(e.kind), (unnamed.get(stemOf(e.kind)) ?? 0) + 1);
  for (const [stem, n] of [...unnamed].sort((a, b) => b[1] - a[1]).slice(0, 5))
    if (n >= 3) warns.push(`unnamed verbs: ${stem} 系 ${n} events — \`subako genesis\` で型候補を提案できる`);
  for (const p of list(join(dir, '_schema', 'proposed'))) warns.push(`proposal 裁定待ち: _schema/proposed/${p.slug}.md`);
  for (const w of warns) console.error(`warn  ${w}`);
  for (const e of errors) console.error(`error ${e}`);
  console.error(`subako lint: ${errors.length} error(s), ${warns.length} warning(s)`);
  if (errors.length) process.exit(1);
}

// ---------- sync (schema-driven derivation) ----------
// slugify は非可逆なので、異なる id が同じ slug に潰れたら hash suffix で分離する。
// 実体の同一性は導出キー id: が持つ（slug はファイル名にすぎない）。
// slugId は id と別に渡せる（ループ帰属で衝突する id をループ名前置スラグに逃がすため）。
function instancePath(dir: string, type: string, id: string, slugId: string = id): string {
  const base = slugify(slugId);
  const p = join(dir, type, `${base}.md`);
  if (existsSync(p)) {
    const ex = parse(p);
    if (ex.fm.id && ex.fm.id !== id)
      return join(dir, type, `${base}-${createHash('sha256').update(id).digest('hex').slice(0, 6)}.md`);
  }
  return p;
}
// 実体の同一性は (loop_id, id) の複合キー — 別ループの同一 id を1実体に融合しない。
// スラグは id がストア全体で一意なら素の id のまま；別ループに同一 id が現れて衝突する
// 場合だけ、衝突した全実体をループ名前置スラグ（<loop>-<id>）に逃がす。
interface IdentityGroup { key: string; loopId: string | null; id: string; events: Ev[] }
function groupByIdentity(mine: Ev[], idSource: string): IdentityGroup[] {
  const groups = new Map<string, IdentityGroup>();
  for (const e of mine) {
    const id = idOf(e, idSource);
    if (!id) continue;
    const key = `${e.loop_id ?? ' '}${id}`;
    const g = groups.get(key) ?? { key, loopId: e.loop_id, id, events: [] };
    g.events.push(e);
    groups.set(key, g);
  }
  return [...groups.values()];
}
function slugIdsFor(groups: IdentityGroup[]): Map<string, string> {
  const loopsById = new Map<string, Set<string>>();
  for (const g of groups) {
    const s = loopsById.get(g.id) ?? new Set<string>();
    s.add(g.loopId ?? ' ');
    loopsById.set(g.id, s);
  }
  const slugIds = new Map<string, string>();
  for (const g of groups) {
    const collides = (loopsById.get(g.id)?.size ?? 0) > 1;
    slugIds.set(g.key, collides && g.loopId ? `${g.loopId}-${g.id}` : g.id);
  }
  return slugIds;
}
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function upsertDerived(path: string, type: string, title: string, derived: Record<string, string | number>): void {
  if (!existsSync(path)) {
    writeFileSync(path, [
      '---', `type: ${type}`, ...Object.entries(derived).map(([k, v]) => `${k}: ${v}`), '---', '',
      `# ${title}`, '', 'イベントログから逆生成。意味づけは裁定で追記する。', '',
    ].join('\n'));
    return;
  }
  // 法則2: 機械が触ってよいのは frontmatter ブロック内の導出キーだけ。本文は不可侵。
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) {
    writeFileSync(path, `---\ntype: ${type}\n${Object.entries(derived).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n` + raw);
    return;
  }
  let fm = m[1];
  for (const [k, v] of Object.entries(derived)) {
    const re = new RegExp(`^${escRe(k)}:.*$`, 'm');
    fm = re.test(fm) ? fm.replace(re, `${k}: ${v}`) : fm + `\n${k}: ${v}`;
  }
  writeFileSync(path, raw.slice(0, m.index!) + `---\n${fm}\n---` + raw.slice(m.index! + m[0].length));
}
function cmdSync(): void {
  const dir = DIR();
  const evs = events(DB());
  let touched = 0;
  for (const s of schemas(dir)) {
    const type = s.fm.defines;
    const verbs = new Set(csv(s.fm.verbs));
    const mine = evs.filter((e) => verbs.has(e.kind));
    if (s.fm.derive === 'ledger') {
      const groups = groupByIdentity(mine, s.fm['id-source'] ?? 'loop_id');
      const slugIds = slugIdsFor(groups);
      mkdirSync(join(dir, type), { recursive: true });
      for (const g of groups) {
        const es = g.events;
        upsertDerived(instancePath(dir, type, g.id, slugIds.get(g.key)), type, g.id,
          { id: g.id, events: es.length, 'first-event': es[0].ts, 'last-event': es[es.length - 1].ts });
        touched++;
      }
    } else if (s.fm.derive === 'lifecycle') {
      const opens = new Set(csv(s.fm['open-verbs'])); const closes = new Set(csv(s.fm['close-verbs']));
      const groups = groupByIdentity(mine, s.fm['id-source'] ?? 'data.id');
      const slugIds = slugIdsFor(groups);
      mkdirSync(join(dir, type), { recursive: true });
      for (const g of groups) {
        const es = g.events;
        const last = [...es].reverse().find((e) => opens.has(e.kind) || closes.has(e.kind));
        upsertDerived(instancePath(dir, type, g.id, slugIds.get(g.key)), type, g.id,
          { id: g.id, status: last && closes.has(last.kind) ? 'closed' : 'open', events: es.length, 'last-event': es[es.length - 1].ts });
        touched++;
      }
    } else if (s.fm.derive === 'registry') {
      // Registry instances are adjudicated by hand; sync only updates hit counts.
      const field = (s.fm['match-field'] ?? 'data.line').replace(/^data\./, '');
      for (const inst of instances(dir, type)) {
        const keys = new Set([inst.slug, ...csv(inst.fm.aliases), (inst.body.match(/^# (.+)$/m)?.[1] ?? '').trim()].filter(Boolean));
        const hits = mine.filter((e) => keys.has(String(e.data?.[field] ?? ''))).length;
        upsertDerived(inst.path, type, inst.slug, { hits });
        touched++;
      }
    }
  }
  console.error(`subako sync: ${touched} instance(s) derived/updated`);
}

// ---------- pack (schema-driven injection) ----------
function cmdPack(): void {
  const dir = DIR();
  const limit = Number(opt('limit', '2500'));
  const lines: string[] = ['<subako-pack>', `オントロジー（${dir}）からの自動注入。正本はこのディレクトリ。`];
  const injected: string[] = [];
  for (const s of schemas(dir)) {
    const cond = csv(s.fm['inject-when']).map((c) => c.split('=').map((x) => x.trim()));
    if (!cond.length) continue;
    const hit = instances(dir, s.fm.defines).filter((i) => cond.every(([k, v]) => (i.fm[k] ?? '') === v));
    if (!hit.length) continue;
    lines.push('', `## ${s.fm.defines}（${csv(s.fm['inject-when']).join(', ')}）`);
    for (const i of hit) {
      const first = i.body.split('\n').find((l) => l.startsWith('**')) ?? i.body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
      lines.push(`- [${s.fm.defines}/${i.slug}.md] ${first.trim()}`);
      injected.push(`${s.fm.defines}/${i.slug}`);
    }
  }
  lines.push('', '</subako-pack>');
  let pack = lines.join('\n');
  if (pack.length > limit)
    pack = pack.slice(0, limit) + `\n…（上限 ${limit} 字で切詰め。全 ${injected.length} 実体中の先頭のみ表示 — --limit で調整）\n</subako-pack>`;
  try {
    mkdirSync(join(dir, '_telemetry'), { recursive: true });
    appendFileSync(join(dir, '_telemetry', 'injections.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), session: process.env.CLAUDE_CODE_SESSION_ID ?? null, injected,
    }) + '\n');
  } catch { /* telemetry must not block injection */ }
  if (has('hook')) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: pack } }));
  else console.log(pack);
}

const HELP = `subako — a meta-system for growing your own ontology (init / genesis / lint / sync / pack)

  subako init [dir]                    scaffold an EMPTY nest box (zero types, by law)
  subako genesis [--db --dir]          recurring uncovered verbs -> _schema/proposed/ drafts
                                       (--threshold 3 = law-1 の「反復」の定義)
                                       + prune candidates for silent types (--silence 90)
  subako lint    [--db --dir]          types without verbs = error; unnamed verbs = warn
  subako sync    [--db --dir]          schema-driven verb->noun derivation (ledger/lifecycle/registry)
  subako pack    [--dir] [--hook]      schema-driven injection slice (+ injection telemetry)
                                       (--limit 2500 字で切詰め。超過時は末尾に明示)

  $SUBAKO   instance directory   $FUKURO_DB   event stream (default ~/.fukuro/fukuro.db)
  Adjudication is a file move: _schema/proposed/<type>.md -> _schema/<type>.md
`;

switch (cmd) {
  case 'init': cmdInit(); break;
  case 'genesis': cmdGenesis(); break;
  case 'lint': cmdLint(); break;
  case 'sync': cmdSync(); break;
  case 'pack': cmdPack(); break;
  default: console.log(HELP);
}
