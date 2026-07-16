# subako（巣箱）

> A nest box is not a nest. You hang an empty box; **the bird builds its own nest inside.**
> subako is a meta-system for growing your own ontology — it ships the box
> (a T-box contract, a type-genesis protocol, schema-driven tools) and never the nest
> (your types, your instances, your meanings).

Two predecessors of this repository shipped finished ontologies — a nine-type epistemic
schema with versioned releases — and both starved: most types were never written to, the
store was never read, and nobody noticed when it silently became unreachable. Meanwhile a
living ontology next door grew from three types to four in a week, each type born from
observed events and adjudicated by a human. The conclusion is this repository's thesis:

**You cannot ship an ontology. You can only ship the process that grows one.**

## The laws

1. **Verbs first, nouns later.** A type may exist only when its corresponding verbs
   (event kinds) recur in your stream. `subako init` therefore scaffolds **zero types**.
2. **Humans adjudicate; machines write.** Types are proposed by `subako genesis` from
   uncovered recurring verbs; instances are derived by `subako sync` or proposed by
   producers (e.g. [junro](https://github.com/semigrp/junro)). Adjudication is a file
   move: `_schema/proposed/<type>.md` → `_schema/<type>.md`. You never author from scratch.
3. **The store is a product of the system, never the product we ship.** Instance content
   (often confidential) lives in your own directory (`$SUBAKO`), outside this repository.
4. **Types are pruned when their verbs go silent.** `genesis` also proposes retirements
   (`--silence 90`). An ontology metabolizes; it does not only grow.
5. **The system carries its own falsification.** `pack` logs every injection to
   `_telemetry/injections.jsonl`. If injected slices never change a decision, your
   ontology is dead weight — prune it, or delete subako.

## The mechanism

```
your verbs (fukuro.db) ──▶ subako genesis ──▶ _schema/proposed/<type>.md
                                                   │  (you move the file = adjudication)
                                                   ▼
                          subako sync  ──▶ <type>/<instance>.md   (derived, re-derivable)
                          subako lint  ──▶ verbless types = error; unnamed verbs = warn
                          subako pack  ──▶ session-start injection slice (+ telemetry)
```

### T-box contract (`_schema/<type>.md`)

```markdown
---
type: schema
defines: hypothesis
verbs: hypothesis_opened, hypothesis_closed     # the reason this type may exist
derive: lifecycle        # ledger | lifecycle | registry | none
id-source: data.id       # where instance identity comes from
open-verbs: hypothesis_opened
close-verbs: hypothesis_closed
inject-when: status=open # pack condition (frontmatter k=v)
required: status         # lint-enforced instance keys
---
# hypothesis
（人間向けの型の意味・裁定基準）
```

Derivation archetypes, chosen from what actually survived in practice:
`ledger` (one instance per subject, counts + first/last), `lifecycle` (status from
open/close verb pairs), `registry` (hand-adjudicated instances, machine-counted `hits:`),
`none` (instances arrive from external producers; subako only lints and injects).
Full spec: [docs/SCHEMA-CONTRACT.md](docs/SCHEMA-CONTRACT.md).

`sync` is non-destructive: it creates missing instance files and updates only derived
frontmatter keys — your adjudication notes in the body are never touched.

## Division of labor

| Concern | Lives in |
|---|---|
| Verbs (events) | [fukuro](https://github.com/semigrp/fukuro) (`$FUKURO_DB`) |
| Human corrections → norm instances | [junro](https://github.com/semigrp/junro) (a producer) |
| Enforcement of grown norms | [ouro](https://github.com/semigrp/ouro) / your hooks |
| The nest (types + instances) | **your directory** (`$SUBAKO`) — never this repo |
| The box (contract, genesis, lint, sync, pack) | subako |

## What subako is not

- **Not a knowledge base or RAG.** It stores nothing of yours and retrieves by injection
  rules you adjudicated, not by similarity.
- **Not a universal schema.** There are no built-in types. Two users of the same box grow
  different nests, because their verbs differ.
- **Not a writing tool.** If you find yourself authoring entities by hand, the write path
  is wrong — fix the producer, don't type harder.

## Quick start

```sh
subako init ~/my-nest            # empty box (zero types, by law)
export SUBAKO=~/my-nest
subako genesis                   # verbs -> type proposals（「反復」の定義は --threshold、既定3回）
mv ~/my-nest/_schema/proposed/loop.md ~/my-nest/_schema/loop.md    # adjudicate
subako sync && subako lint && subako pack
```

Zero dependencies, Node ≥ 24 (direct TypeScript execution).

## Status

v0.3 — the second refounding of this repository, and the one that finally obeys its own
family's principle («structures survive only where their write path is automatic»).
The mechanism is extracted from a living instance that grew 3 → 4 types verb-first in one
week of measured practice. History of the failures is preserved in
[docs/adr/](docs/adr/) — including this repository's own two deaths.

## License

[Apache-2.0](LICENSE)
