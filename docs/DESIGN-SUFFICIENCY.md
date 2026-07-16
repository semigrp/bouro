# Design sufficiency

Target: 95/100 for the Negura design as the ontology-backed knowledge plane used by Ouro and Fukuro.
This is a design and executable-contract score, not a claim of production scale or operational
maturity.

| Axis | Score | Evidence |
| --- | ---: | --- |
| Bounded context and SoT | 20/20 | ADR 0001; Run/routing/permission removed from the active model; v1 execution objects isolated by migration |
| Ontology schema and constraints | 14/15 | Versioned `OntologyRelease` digesting object/relation shapes and lifecycle transitions; required-field, direction, cardinality, identity-conflict checks |
| Provenance and temporality | 15/15 | PROV-lite actor/generation/derivation; recorded/observed/valid time; source-backed Evidence and Assertion |
| Identity and versioning | 14/15 | Opaque ResourceRefV1; immutable revisions; ontology/object version separation; digest pinning; exact/close/broader/related semantics |
| Agent context query | 13/15 | Deterministic ContextBundle; `asOf` object and relation filtering; Unicode purpose selection; validated token/resource budgets; sensitivity policy; selection reasons and digest |
| Contradiction and explainability | 9/10 | First-class Assertion stance; competing assertions preserved; conflicting identity relations rejected; no hidden truth reduction |
| Ouro/Fukuro integration | 10/10 | Receiver-owned command/query contracts; conflict-detecting Evidence idempotency; prevalidated command references; no shared package, broker, distributed transaction, or direct DB write |
| **Total** | **95/100** | `pnpm test` and `pnpm run doctor` provide executable evidence; JSON replacement is atomic and unknown formats fail closed |

## Deliberately deferred

These items are not required to meet the current local-first use case and should be added only after
measured need:

- OWL/SHACL/SPARQL runtime and a dedicated graph database
- embedding or LLM-based retrieval before a context-query evaluation dataset exists
- automatic ontology induction or automatic Fukuro Finding promotion
- generalized probabilistic truth aggregation
- multi-writer entity merge/split workflow
- remote authorization service and multi-tenant policy engine

The next score increase should come from real Ouro/Fukuro golden-path data, not additional abstract
machinery. The first candidates are context retrieval evals, explicit inferred-relation derivation
records, and reviewed merge/split commands.
