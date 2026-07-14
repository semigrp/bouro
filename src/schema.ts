import { createHash } from "node:crypto";

export const STORE_VERSION = 2;
export const STORE_SCHEMA = "boros.store/v2" as const;
export const ONTOLOGY_ID = "boros-core";
export const ONTOLOGY_VERSION = "1.0.0";

export const KINDS = {
  concept: "concept",
  claim: "claim",
  question: "question",
  hypothesis: "hypothesis",
  experiment: "experiment",
  procedure: "procedure",
  evidence: "evidence",
  assertion: "assertion",
  decision: "decision",
} as const;

export type Kind = (typeof KINDS)[keyof typeof KINDS];

export const PREFIX_BY_KIND = {
  concept: "CON",
  claim: "CLM",
  question: "QST",
  hypothesis: "HYP",
  experiment: "EXP",
  procedure: "PROC",
  evidence: "EVD",
  assertion: "AST",
  decision: "DEC",
} as const satisfies Record<Kind, string>;

export const RELATION_TYPES = {
  defines: "defines",
  raises: "raises",
  candidateAnswer: "candidate_answer",
  tests: "tests",
  assesses: "assesses",
  usesEvidence: "uses_evidence",
  resolves: "resolves",
  basedOn: "based_on",
  revises: "revises",
  promotesTo: "promotes_to",
  broader: "broader",
  related: "related",
  exactMatch: "exact_match",
  closeMatch: "close_match",
} as const;

export type RelationType = (typeof RELATION_TYPES)[keyof typeof RELATION_TYPES];
export type Sensitivity = "public" | "internal" | "restricted";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Attributes = Record<string, JsonValue>;

export type ResourceRefV1 = {
  system: string;
  type: string;
  id: string;
  version?: string;
  uri?: string;
  digest?: `sha256:${string}`;
};

export type Provenance = {
  attributedTo: ResourceRefV1[];
  generatedBy?: ResourceRefV1;
  derivedFrom: ResourceRefV1[];
};

export type TemporalRecord = {
  recordedAt: string;
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
};

export type KnowledgeRevision = {
  schema: "boros.knowledge-revision/v1";
  id: string;
  kind: Kind;
  version: string;
  title: string;
  status: string;
  sensitivity: Sensitivity;
  attributes: Attributes;
  provenance: Provenance;
  temporal: TemporalRecord;
  supersedes?: ResourceRefV1;
};

export type KnowledgeRelation = {
  schema: "boros.knowledge-relation/v1";
  id: string;
  type: RelationType;
  from: ResourceRefV1;
  to: ResourceRefV1;
  attributes: Attributes;
  provenance: Provenance;
  temporal: TemporalRecord;
};

export type AuditEvent = {
  id: string;
  type: string;
  subject: ResourceRefV1;
  occurredAt: string;
  data: Attributes;
};

export type OntologyRelease = {
  schema: "boros.ontology-release/v1";
  id: string;
  version: string;
  releasedAt: string;
  shapeDigest: `sha256:${string}`;
  compatibleStoreVersion: number;
};

export type ContextQueryV1 = {
  schema: "boros.context-query/v1";
  roots: ResourceRefV1[];
  purpose: string;
  asOf?: string;
  tokenBudget?: number;
  maxResources?: number;
  includeKinds?: Kind[];
  allowedSensitivities?: Sensitivity[];
};

export type ContextSelection = {
  resource: ResourceRefV1;
  score: number;
  reasons: string[];
};

export type ContextBundle = {
  schema: "boros.context-bundle/v1";
  id: string;
  createdAt: string;
  ontology: ResourceRefV1;
  query: ContextQueryV1;
  selections: ContextSelection[];
  omitted: number;
  estimatedTokens: number;
  policyDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
};

export type LegacyPartition = {
  migratedFrom: "boros.store/v1";
  objects: unknown[];
  edges: unknown[];
  events: unknown[];
};

export type Store = {
  schema: typeof STORE_SCHEMA;
  version: number;
  createdAt: string;
  updatedAt: string;
  ontology: OntologyRelease;
  counters: Record<string, number>;
  revisions: Record<string, KnowledgeRevision>;
  heads: Record<string, ResourceRefV1>;
  relations: Record<string, KnowledgeRelation>;
  contextBundles: Record<string, ContextBundle>;
  idempotency: Record<string, ResourceRefV1>;
  audit: AuditEvent[];
  legacy?: LegacyPartition;
};

export type ObjectShape = {
  requiredAttributes: string[];
  statuses: string[];
};

export const OBJECT_SHAPES = {
  concept: {
    requiredAttributes: ["statement", "preferredLabel", "aliases"],
    statuses: ["active", "superseded"],
  },
  claim: {
    requiredAttributes: ["statement"],
    statuses: ["draft", "asserted", "superseded"],
  },
  question: {
    requiredAttributes: ["question", "closureRule", "evidenceRequirements"],
    statuses: ["open", "closed", "superseded"],
  },
  hypothesis: {
    requiredAttributes: ["claim", "closesWhen"],
    statuses: ["open", "confirmed", "refuted", "inconclusive", "superseded"],
  },
  experiment: {
    requiredAttributes: [
      "question",
      "hypotheses",
      "successCriteria",
      "failureCriteria",
      "evidenceRequirements",
    ],
    statuses: ["draft", "approved", "superseded"],
  },
  procedure: {
    requiredAttributes: [
      "purpose",
      "inputs",
      "outputs",
      "preconditions",
      "postconditions",
      "invariants",
      "verification",
      "implementations",
    ],
    statuses: ["draft", "approved", "superseded"],
  },
  evidence: {
    requiredAttributes: ["observation"],
    statuses: ["final", "superseded"],
  },
  assertion: {
    requiredAttributes: ["claim", "stance", "evidence", "rationale"],
    statuses: ["active", "superseded"],
  },
  decision: {
    requiredAttributes: ["question", "evidence", "outcome", "rationale"],
    statuses: ["final", "superseded"],
  },
} as const satisfies Record<Kind, ObjectShape>;

export const STATUS_TRANSITIONS: Record<Kind, Record<string, readonly string[]>> = {
  concept: {
    active: ["active", "superseded"],
    superseded: [],
  },
  claim: {
    draft: ["draft", "asserted", "superseded"],
    asserted: ["asserted", "superseded"],
    superseded: [],
  },
  question: {
    open: ["open", "closed", "superseded"],
    closed: ["closed", "superseded"],
    superseded: [],
  },
  hypothesis: {
    open: ["open", "confirmed", "refuted", "inconclusive", "superseded"],
    confirmed: ["confirmed", "open", "superseded"],
    refuted: ["refuted", "open", "superseded"],
    inconclusive: ["inconclusive", "open", "superseded"],
    superseded: [],
  },
  experiment: {
    draft: ["draft", "approved", "superseded"],
    approved: ["approved", "superseded"],
    superseded: [],
  },
  procedure: {
    draft: ["draft", "approved", "superseded"],
    approved: ["approved", "superseded"],
    superseded: [],
  },
  evidence: {
    final: ["superseded"],
    superseded: [],
  },
  assertion: {
    active: ["superseded"],
    superseded: [],
  },
  decision: {
    final: ["superseded"],
    superseded: [],
  },
};

export type RelationShape = {
  from: Kind[];
  to: Kind[];
};

export const RELATION_SHAPES = {
  defines: { from: [KINDS.concept], to: [KINDS.claim] },
  raises: { from: [KINDS.concept], to: [KINDS.question] },
  candidate_answer: { from: [KINDS.question], to: [KINDS.hypothesis] },
  tests: { from: [KINDS.experiment], to: [KINDS.hypothesis] },
  assesses: { from: [KINDS.assertion], to: [KINDS.claim] },
  uses_evidence: { from: [KINDS.assertion], to: [KINDS.evidence] },
  resolves: { from: [KINDS.decision], to: [KINDS.question] },
  based_on: { from: [KINDS.decision], to: [KINDS.evidence, KINDS.assertion] },
  revises: {
    from: [KINDS.decision],
    to: [KINDS.concept, KINDS.claim, KINDS.hypothesis, KINDS.experiment, KINDS.procedure],
  },
  promotes_to: { from: [KINDS.experiment], to: [KINDS.procedure] },
  broader: { from: [KINDS.concept], to: [KINDS.concept] },
  related: { from: [KINDS.concept], to: [KINDS.concept] },
  exact_match: { from: [KINDS.concept], to: [KINDS.concept] },
  close_match: { from: [KINDS.concept], to: [KINDS.concept] },
} as const satisfies Record<RelationType, RelationShape>;

export type CommandOptions = Record<string, string | string[] | boolean | undefined>;

export function emptyStore(now = nowIso()): Store {
  return {
    schema: STORE_SCHEMA,
    version: STORE_VERSION,
    createdAt: now,
    updatedAt: now,
    ontology: currentOntologyRelease(),
    counters: Object.fromEntries([
      ...Object.values(PREFIX_BY_KIND),
      "REL",
      "EVT",
    ].map((prefix) => [prefix, 0])),
    revisions: {},
    heads: {},
    relations: {},
    contextBundles: {},
    idempotency: {},
    audit: [],
  };
}

export function currentOntologyRelease(): OntologyRelease {
  return {
    schema: "boros.ontology-release/v1",
    id: ONTOLOGY_ID,
    version: ONTOLOGY_VERSION,
    releasedAt: "2026-07-14T00:00:00.000Z",
    shapeDigest: digestJson({
      objects: OBJECT_SHAPES,
      relations: RELATION_SHAPES,
      statusTransitions: STATUS_TRANSITIONS,
    }),
    compatibleStoreVersion: STORE_VERSION,
  };
}

export function ontologyRef(release = currentOntologyRelease()): ResourceRefV1 {
  return {
    system: "boros",
    type: "ontology_release",
    id: release.id,
    version: release.version,
    digest: release.shapeDigest,
  };
}

export function refForRevision(revision: KnowledgeRevision): ResourceRefV1 {
  return {
    system: "boros",
    type: revision.kind,
    id: revision.id,
    version: revision.version,
  };
}

export function revisionKey(id: string, version: string): string {
  return `${id}@${version}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function assertKnownKind(kind: string): asserts kind is Kind {
  if (!Object.hasOwn(PREFIX_BY_KIND, kind)) {
    throw new Error(`Unknown knowledge kind: ${kind}`);
  }
}

export function normalizeList(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.filter((item) => item !== "").map(String);
  return [String(value)];
}
