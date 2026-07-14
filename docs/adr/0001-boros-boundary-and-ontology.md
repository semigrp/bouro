# ADR 0001: Boros boundary and ontology architecture

- Status: Accepted
- Date: 2026-07-14

## Context

The original local execution OS mixed durable knowledge with Run state, routing, permissions, and
loop telemetry. Ouro now owns the outbound execution path and Fukuro owns the measured return path.
Boros needs a distinct model for reusable meaning, evidence, and decisions without becoming a
workflow engine, telemetry database, or copy of repository artifacts.

## Decision

Boros is an independent repository and bounded context. No integration-only repository is created.

### Sources of truth

- Repositories and artifact stores own content and immutable artifact bytes.
- External issue trackers own issue and PR state.
- Ouro owns Work, Plan, Task, Run, Attempt, Gate, workspace, retry, and timeout.
- Boros owns Concept, Claim, Question, Hypothesis, ExperimentDefinition, ProcedureDefinition,
  Evidence meaning and provenance, Assertion, and Decision.
- Fukuro owns ingested telemetry, baseline calculations, Findings, interventions, and improvement
  evaluation.

### TBox and ABox

The `OntologyRelease` is the TBox-equivalent release: object shapes, relation shapes, lifecycle
statuses, release version, and shape digest. Knowledge revisions and relations are ABox-equivalent
instances. A ContextBundle pins both the ontology release and instance revisions.

The initial implementation uses TypeScript declarations and deterministic shape validation. OWL,
SHACL, RDF, SPARQL, and a dedicated graph database are interoperability or scale options, not
runtime prerequisites.

### Claim and Assertion

A Claim is reusable propositional content. An Assertion records a situated stance toward a Claim:
`supports`, `contradicts`, or `inconclusive`. It must cite Evidence and retain actor, source,
recorded time, optional observed/valid time, and rationale. Boros does not collapse competing
Assertions into a hidden scalar truth value.

Hypothesis is a Claim under an explicit closure condition. Only a Boros command may change its
formal state. Fukuro observations never confirm or refute a Hypothesis directly.

### Revisions and time

Knowledge mutation creates a new immutable revision with a pinned `supersedes` reference. Logical
object versions and ontology release versions are separate. Recorded time is separate from observed
time and valid time, allowing historical `asOf` context and distinguishing correction from changed
world state.

### Identity

The canonical cross-system identity is `(system, type, id)`. `version` pins a logical revision;
`digest` pins artifact bytes; `uri` is only a locator. IDs are opaque outside their owner and are
never reused. Boros distinguishes exact match, close match, broader, and related relations and
rejects conflicting exact/hierarchical assertions for the same pair.

### Context query

Ouro requests context with roots, purpose, optional `asOf`, token budget, kind filter, and allowed
sensitivities. Boros returns an immutable ContextBundle containing the ontology release, pinned
resources, deterministic scores and selection reasons, omitted count, policy digest, and bundle
digest. Historical replay never resolves an implicit latest revision.

### Integration

- Ouro to Boros Evidence is an idempotent receiver-owned command.
- Ouro to Boros context retrieval is a receiver-owned query.
- Ouro to Fukuro execution telemetry is a Fukuro-owned event.
- Fukuro Finding promotion to Boros is an explicit command, never automatic synchronization.

Adapters live with the producer, own no database, and only project fields, validate the receiver
schema, create ResourceRefs, and remove secrets. Systems never write another system's database.

## Consequences

The active Boros graph cannot be used to schedule or resume Ouro execution. Raw traces and artifact
contents remain outside Boros. Knowledge is reproducible and explainable at the cost of explicit
revisions, provenance, and Evidence registration. Full logical inference remains bounded and must
be explainable before it is introduced.

## References

- W3C OWL 2 Primer: https://www.w3.org/TR/owl2-primer/
- W3C SHACL: https://www.w3.org/TR/shacl/
- W3C PROV-O: https://www.w3.org/TR/prov-o/
- W3C RDF 1.2 Concepts: https://www.w3.org/TR/rdf12-concepts/
- Wikibase data model: https://www.mediawiki.org/wiki/Wikibase/DataModel
- Graphiti temporal context graph: https://github.com/getzep/graphiti
- OpenAI self-improving agent loop: https://openai.com/index/building-self-improving-tax-agents-with-codex/
