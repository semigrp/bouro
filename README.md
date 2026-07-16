# Bouro

Bouro is a local-first, ontology-backed knowledge graph and epistemic ledger for AI-agent loops.
It owns durable meaning, evidence, and decisions. It does not execute work or analyze execution
telemetry.

## System boundary

| Concern | Source of truth |
| --- | --- |
| Source code, prompts, workflows, binary artifacts | Repository or artifact store |
| Work, Plan, Task, Run, Attempt, Gate, workspace | Ouro |
| Concept, Claim, Question, Hypothesis | Bouro |
| ExperimentDefinition and ProcedureDefinition | Bouro |
| Procedure implementation | Repository; Bouro stores a pinned reference |
| Evidence meaning, provenance, and assessed Claim | Bouro |
| Raw trace, eval result, and source material | Producing system; Bouro stores a pinned reference |
| Execution telemetry, baseline, Finding, improvement effect | Fukuro |

Ouro queries Bouro for a version-pinned ContextBundle and registers Evidence using an idempotent
command. Ouro exports execution telemetry to Fukuro. Fukuro may propose an improvement issue or
explicit knowledge-promotion command, but it never changes Bouro knowledge implicitly.

See [ADR 0001](docs/adr/0001-bouro-boundary-and-ontology.md).

## Active ontology

The active knowledge kinds are:

- Concept, Claim, Question, Hypothesis
- ExperimentDefinition and ProcedureDefinition
- Evidence and Assertion
- Decision

`Claim` is a proposition. `Assertion` is a situated assessment of that Claim: stance, Evidence,
actor, time, and rationale. This allows multiple agents or runs to disagree without overwriting a
single truth value.

Run, routing, permission tier, retry, timeout, and workspace are not active Bouro objects. The v1
migration isolates those records in `legacy` instead of deleting them.

## Guarantees

- Every knowledge update creates an immutable revision and advances a separate head.
- Persistent references pin a logical version; artifact references may also pin a SHA-256 digest.
- The ontology release has its own version and shape digest, separate from object revisions.
- Object and relation shapes enforce allowed statuses, required fields, and edge directions.
- Evidence requires `generatedBy` or `derivedFrom` provenance.
- Decisions require Evidence.
- Knowledge records separate recorded time from observed/valid time.
- ContextBundle selection is deterministic, version-pinned, time-aware, token-bounded, and filtered
  by sensitivity.
- Evidence registration is idempotent by `(source, sourceEventId)` and rejects a conflicting replay
  payload for the same key.
- Store replacement is atomic, and unknown store formats are rejected instead of being treated as
  an empty legacy store.
- `doctor` returns non-zero for structural, provenance, reference, or digest violations.

## Quick start

```bash
cd /Users/semigrp/dev/bouro
pnpm install
pnpm test
pnpm run demo
pnpm run doctor
```

The default vault is `vault/store.json`. Override it with `--vault <path>`.

## CLI

```bash
node dist/bin/bouro.js ontology
node dist/bin/bouro.js concept \
  --title "Pinned context" \
  --statement "Version-pinned context makes an Ouro run reproducible."
node dist/bin/bouro.js context \
  --root CON-0001 \
  --purpose "prepare Ouro replay" \
  --token-budget 4000
node dist/bin/bouro.js evidence register \
  --input ./register-evidence-command.json
node dist/bin/bouro.js show --id CON-0001
node dist/bin/bouro.js history --id CON-0001
node dist/bin/bouro.js audit --limit 20
```

Use `bouro help` for all object creation and relation commands.

## Contracts

Contracts are owned by Bouro as the receiver:

- `contracts/resource-ref.v1.schema.json`
- `contracts/register-evidence.v1.schema.json`
- `contracts/context-query.v1.schema.json`

Files under `contracts/fixtures` are schema-validation examples. Replace their example ResourceRefs
with references returned by the active Bouro and Ouro stores before sending them to the CLI.

There is no integration repository, shared npm package, event broker, distributed transaction, or
cross-database write. The only cross-system convention is the embedded `ResourceRefV1` shape.

## Storage

The JSON vault stores immutable knowledge revisions, version-pinned relations, ContextBundles,
idempotency keys, and a knowledge-mutation audit log. Writes use a same-directory temporary file
and atomic rename. It does not store raw traces, Ouro execution state, Fukuro metrics, or repository
contents.

The storage API is intentionally isolated from the ontology model. JSON is the initial local-first
backend; a graph database is not required by the current query and scale requirements.

## Validation

```bash
pnpm test
pnpm run doctor
```

The acceptance suite covers ontology release integrity, immutable revision history, relation
shapes, Evidence provenance and idempotency, Assertion creation, deterministic historical context,
sensitivity filtering, identity conflicts, v1 legacy isolation, persistence, and corrupt-vault
rejection.

The design sufficiency rubric and remaining non-blocking work are documented in
[DESIGN-SUFFICIENCY.md](docs/DESIGN-SUFFICIENCY.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
