# ADR 0002: Refound as a meta-system that grows ontologies; delete the knowledge engine

- Status: Accepted (supersedes ADR 0001)
- Date: 2026-07-17

## Context

This repository has died twice.

First as a local-first "ontology-backed knowledge graph and epistemic ledger": nine
entity types (concept / claim / question / hypothesis / experiment / procedure /
evidence / assertion / decision), a versioned ontology release with a shape digest, a
JSON heads/revisions store, and a distillation CLI. Measured outcome: writes happened on
two days (an initial registration and one distillation session); reads in real loops were
effectively zero; when an environment-variable defect made the store silently unreachable,
nobody noticed for days. Renaming it did not change its physics.

Meanwhile, a sibling instance grown the opposite way stayed alive: it started from three
types reverse-generated from an event ledger, was injected automatically at every session
start, and grew its fourth type (norm) the day a new verb — human corrections harvested
from transcripts — became observable. Its history is a working type-genesis protocol
executed by hand: observe recurring verbs → draft the type → human adjudicates.

## Decision

Ship the box, not the nest.

- **Delete** the knowledge engine: the nine-type universal schema, the JSON
  heads/revisions store, ontology releases and digests, the distillation CLI.
- **Ship** the meta-system only: the T-box contract (docs/SCHEMA-CONTRACT.md), the
  type-genesis protocol (`genesis`: uncovered recurring verbs → schema proposals;
  silent verbs → pruning proposals), and schema-driven `sync` / `lint` / `pack`.
- **Initial types: zero.** Law 1 (verbs first) applies to the first type too. Two users
  of the same box must be able to grow different nests.
- Instance content lives in the user's own directory (`$SUBAKO`) and never in this
  repository. Producers (junro, fukuro-adjacent hooks) write instances; humans adjudicate
  by file moves; `sync` re-derives.

## Consequences

- The write path is automatic end-to-end: verbs accumulate in the event ledger without
  ceremony; proposals are machine-drafted; the only human act is adjudication.
- A universal schema is given up. Cross-user interoperability, if ever needed, is a
  future contract between nests — not a prerequisite baked into the box.
- The prior stores remain in git history and in local archives; knowledge worth keeping
  is re-derived into markdown instances by the new pipeline rather than migrated
  wholesale.
- Falsification is built in (law 5): if injection telemetry shows the grown ontology
  never changes a decision, the correct response is pruning — or deleting subako.
