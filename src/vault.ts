import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  type Attributes,
  type AuditEvent,
  type ContextBundle,
  type ContextQueryV1,
  type ContextSelection,
  type JsonValue,
  KINDS,
  type Kind,
  type KnowledgeRelation,
  type KnowledgeRevision,
  OBJECT_SHAPES,
  PREFIX_BY_KIND,
  type Provenance,
  RELATION_SHAPES,
  RELATION_TYPES,
  STATUS_TRANSITIONS,
  type RelationType,
  type ResourceRefV1,
  STORE_SCHEMA,
  type Sensitivity,
  type Store,
  assertKnownKind,
  currentOntologyRelease,
  digestJson,
  emptyStore,
  normalizeList,
  nowIso,
  ontologyRef,
  refForRevision,
  revisionKey,
} from "./schema.js";

export { emptyStore } from "./schema.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export type CreateKnowledgeInput = {
  id?: string;
  kind: Kind;
  title: string;
  status?: string;
  sensitivity?: Sensitivity;
  attributes: Attributes;
  provenance?: Partial<Provenance>;
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
};

export type ReviseKnowledgeInput = {
  title?: string;
  status?: string;
  sensitivity?: Sensitivity;
  attributes?: Attributes;
  provenance?: Partial<Provenance>;
  observedAt?: string;
  validFrom?: string;
  validTo?: string;
};

export type EvidenceAssessment = {
  claim: ResourceRefV1;
  stance: "supports" | "contradicts" | "inconclusive";
  confidence?: number;
  rationale: string;
};

export type RegisterEvidenceCommandV1 = {
  schema: "negura.register-evidence/v1";
  source: string;
  sourceEventId: string;
  evidence: {
    title: string;
    observation: string;
    observedAt?: string;
    sensitivity?: Sensitivity;
    generatedBy?: ResourceRefV1;
    derivedFrom?: ResourceRefV1[];
    attributedTo?: ResourceRefV1[];
    assessments?: EvidenceAssessment[];
  };
};

export type RegisterEvidenceResult = {
  evidence: KnowledgeRevision;
  assertions: KnowledgeRevision[];
  replayed: boolean;
};

export type StatusReport = {
  ontology: ReturnType<typeof currentOntologyRelease>;
  headCounts: Record<string, number>;
  revisionCount: number;
  relationCount: number;
  contextBundleCount: number;
  unresolvedQuestions: Array<{ id: string; title: string }>;
  unresolvedHypotheses: Array<{ id: string; title: string }>;
  legacy: { objects: number; edges: number; events: number } | null;
};

const LOCAL_ACTOR: ResourceRefV1 = {
  system: "negura",
  type: "actor",
  id: "local-cli",
};

export function defaultVaultPath(cwd: string): string {
  return resolve(cwd, "vault", "store.json");
}

export async function loadStore(path: string): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return migrateStore(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

export async function saveStore(path: string, store: Store): Promise<void> {
  store.updatedAt = nowIso();
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function nextId(store: Store, prefix: string): string {
  store.counters[prefix] = (store.counters[prefix] ?? 0) + 1;
  return `${prefix}-${String(store.counters[prefix]).padStart(4, "0")}`;
}

export function createKnowledge(store: Store, input: CreateKnowledgeInput): KnowledgeRevision {
  assertKnownKind(input.kind);
  const id = input.id ?? nextId(store, PREFIX_BY_KIND[input.kind]);
  if (store.heads[id]) throw new Error(`Knowledge object already exists: ${id}`);
  const timestamp = nowIso();
  const revision: KnowledgeRevision = {
    schema: "negura.knowledge-revision/v1",
    id,
    kind: input.kind,
    version: "1",
    title: input.title,
    status: input.status ?? OBJECT_SHAPES[input.kind].statuses[0],
    sensitivity: input.sensitivity ?? "internal",
    attributes: input.attributes,
    provenance: normalizeProvenance(input.provenance),
    temporal: {
      recordedAt: timestamp,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.validTo ? { validTo: input.validTo } : {}),
    },
  };
  assertValidRevision(revision);
  store.revisions[revisionKey(id, "1")] = revision;
  store.heads[id] = refForRevision(revision);
  recordAudit(store, "knowledge_created", refForRevision(revision), { kind: input.kind });
  return revision;
}

export function reviseKnowledge(
  store: Store,
  id: string,
  input: ReviseKnowledgeInput,
): KnowledgeRevision {
  const current = getHead(store, id);
  const nextStatus = input.status ?? current.status;
  const allowedTransitions = STATUS_TRANSITIONS[current.kind][current.status] ?? [];
  if (!allowedTransitions.includes(nextStatus)) {
    throw new Error(
      `Invalid ${current.kind} status transition: ${current.status} -> ${nextStatus}`,
    );
  }
  const version = String(Number(current.version) + 1);
  const currentRef = refForRevision(current);
  const revision: KnowledgeRevision = {
    ...current,
    version,
    title: input.title ?? current.title,
    status: nextStatus,
    sensitivity: input.sensitivity ?? current.sensitivity,
    attributes: { ...current.attributes, ...(input.attributes ?? {}) },
    provenance: normalizeProvenance(input.provenance, currentRef),
    temporal: {
      recordedAt: nowIso(),
      ...(input.observedAt ?? current.temporal.observedAt
        ? { observedAt: input.observedAt ?? current.temporal.observedAt }
        : {}),
      ...(input.validFrom ?? current.temporal.validFrom
        ? { validFrom: input.validFrom ?? current.temporal.validFrom }
        : {}),
      ...(input.validTo ?? current.temporal.validTo
        ? { validTo: input.validTo ?? current.temporal.validTo }
        : {}),
    },
    supersedes: currentRef,
  };
  assertValidRevision(revision);
  store.revisions[revisionKey(id, version)] = revision;
  store.heads[id] = refForRevision(revision);
  recordAudit(store, "knowledge_revised", refForRevision(revision), {
    supersedes: jsonRef(currentRef),
  });
  return revision;
}

export function addRelation(
  store: Store,
  type: RelationType,
  from: ResourceRefV1,
  to: ResourceRefV1,
  attributes: Attributes = {},
  provenance?: Partial<Provenance>,
): KnowledgeRelation {
  const fromRevision = getRevision(store, requirePinned(from));
  const toRevision = getRevision(store, requirePinned(to));
  const shape = RELATION_SHAPES[type];
  if (!shape) throw new Error(`Unknown relation type: ${type}`);
  if (
    !(shape.from as readonly Kind[]).includes(fromRevision.kind) ||
    !(shape.to as readonly Kind[]).includes(toRevision.kind)
  ) {
    throw new Error(
      `Invalid ${type} relation: ${fromRevision.kind} -> ${toRevision.kind}`,
    );
  }
  assertNoIdentityConflict(store, type, from, to);
  const relation: KnowledgeRelation = {
    schema: "negura.knowledge-relation/v1",
    id: nextId(store, "REL"),
    type,
    from,
    to,
    attributes,
    provenance: normalizeProvenance(provenance),
    temporal: { recordedAt: nowIso() },
  };
  store.relations[relation.id] = relation;
  recordAudit(store, "relation_created", relationRef(relation), {
    type,
    from: jsonRef(from),
    to: jsonRef(to),
  });
  return relation;
}

export function getRevision(store: Store, ref: ResourceRefV1): KnowledgeRevision {
  if (ref.system !== "negura") throw new Error(`Cannot resolve non-Negura ref: ${ref.system}`);
  if (!ref.version) throw new Error(`Persistent knowledge reference must pin version: ${ref.id}`);
  const revision = store.revisions[revisionKey(ref.id, ref.version)];
  if (!revision) throw new Error(`Knowledge revision not found: ${ref.id}@${ref.version}`);
  if (ref.type !== revision.kind) {
    throw new Error(`Reference type mismatch for ${ref.id}: ${ref.type} != ${revision.kind}`);
  }
  return revision;
}

export function getHead(store: Store, id: string): KnowledgeRevision {
  const ref = store.heads[id];
  if (!ref) throw new Error(`Knowledge object not found: ${id}`);
  return getRevision(store, ref);
}

export function resolveRef(store: Store, id: string, asOf?: string): ResourceRefV1 {
  if (!asOf) return requirePinned(store.heads[id] ?? missingObject(id));
  const candidates = Object.values(store.revisions)
    .filter((revision) => revision.id === id && isVisibleAt(revision, asOf))
    .sort(compareRevisionDescending);
  if (candidates.length === 0) throw new Error(`No revision for ${id} at ${asOf}`);
  return refForRevision(candidates[0]);
}

export function createConcept(
  store: Store,
  input: { title: string; statement: string; aliases?: string[]; sensitivity?: Sensitivity },
): KnowledgeRevision {
  return createKnowledge(store, {
    kind: KINDS.concept,
    title: input.title,
    sensitivity: input.sensitivity,
    attributes: {
      statement: input.statement,
      preferredLabel: input.title,
      aliases: input.aliases ?? [],
    },
  });
}

export function createClaim(
  store: Store,
  input: { title: string; statement: string; concept?: string },
): KnowledgeRevision {
  const claim = createKnowledge(store, {
    kind: KINDS.claim,
    title: input.title,
    status: "asserted",
    attributes: { statement: input.statement },
  });
  if (input.concept) {
    addRelation(store, RELATION_TYPES.defines, resolveRef(store, input.concept), refForRevision(claim));
  }
  return claim;
}

export function createQuestion(
  store: Store,
  input: {
    title: string;
    question: string;
    closureRule: string;
    evidenceRequirements?: string[];
    concept?: string;
  },
): KnowledgeRevision {
  const question = createKnowledge(store, {
    kind: KINDS.question,
    title: input.title,
    attributes: {
      question: input.question,
      closureRule: input.closureRule,
      evidenceRequirements: input.evidenceRequirements ?? [],
    },
  });
  if (input.concept) {
    addRelation(store, RELATION_TYPES.raises, resolveRef(store, input.concept), refForRevision(question));
  }
  return question;
}

export function createHypothesis(
  store: Store,
  input: { title: string; claim: string; question: string; closesWhen: string },
): KnowledgeRevision {
  const claim = resolveRef(store, input.claim);
  if (getRevision(store, claim).kind !== KINDS.claim) throw new Error("Hypothesis claim must be a Claim");
  const hypothesis = createKnowledge(store, {
    kind: KINDS.hypothesis,
    title: input.title,
    attributes: { claim: jsonRef(claim), closesWhen: input.closesWhen },
  });
  addRelation(
    store,
    RELATION_TYPES.candidateAnswer,
    resolveRef(store, input.question),
    refForRevision(hypothesis),
  );
  return hypothesis;
}

export function createExperiment(
  store: Store,
  input: {
    title: string;
    question: string;
    hypotheses: string[];
    successCriteria: string[];
    failureCriteria?: string[];
    evidenceRequirements?: string[];
    procedure?: ResourceRefV1;
  },
): KnowledgeRevision {
  if (input.hypotheses.length === 0) throw new Error("Experiment needs at least one hypothesis");
  const question = resolveRef(store, input.question);
  const hypotheses = input.hypotheses.map((id) => resolveRef(store, id));
  const experiment = createKnowledge(store, {
    kind: KINDS.experiment,
    title: input.title,
    status: "approved",
    attributes: {
      question: jsonRef(question),
      hypotheses: hypotheses.map(jsonRef),
      successCriteria: input.successCriteria,
      failureCriteria: input.failureCriteria ?? [],
      evidenceRequirements: input.evidenceRequirements ?? [],
      ...(input.procedure ? { procedure: jsonRef(input.procedure) } : {}),
    },
  });
  for (const hypothesis of hypotheses) {
    addRelation(store, RELATION_TYPES.tests, refForRevision(experiment), hypothesis);
  }
  return experiment;
}

export function createProcedure(
  store: Store,
  input: {
    title: string;
    purpose: string;
    inputs?: string[];
    outputs?: string[];
    preconditions?: string[];
    postconditions?: string[];
    invariants?: string[];
    verification?: string[];
    implementations?: ResourceRefV1[];
  },
): KnowledgeRevision {
  return createKnowledge(store, {
    kind: KINDS.procedure,
    title: input.title,
    status: input.implementations?.length ? "approved" : "draft",
    attributes: {
      purpose: input.purpose,
      inputs: input.inputs ?? [],
      outputs: input.outputs ?? [],
      preconditions: input.preconditions ?? [],
      postconditions: input.postconditions ?? [],
      invariants: input.invariants ?? [],
      verification: input.verification ?? [],
      implementations: (input.implementations ?? []).map(jsonRef),
    },
  });
}

export function registerEvidence(
  store: Store,
  command: RegisterEvidenceCommandV1,
): RegisterEvidenceResult {
  if (command.schema !== "negura.register-evidence/v1") {
    throw new Error(`Unsupported evidence command: ${String(command.schema)}`);
  }
  if (!command.source?.trim() || !command.sourceEventId?.trim()) {
    throw new Error("Evidence command needs source and sourceEventId");
  }
  const commandDigest = digestJson(command);
  const idempotencyKey = `${command.source}\u0000${command.sourceEventId}`;
  const existing = store.idempotency[idempotencyKey];
  if (existing) {
    const evidence = getRevision(store, existing);
    const existingDigest = evidence.attributes.registrationCommandDigest;
    if (typeof existingDigest === "string" && existingDigest !== commandDigest) {
      throw new Error(`Idempotency key reused with different Evidence command: ${command.sourceEventId}`);
    }
    const assertions = outgoing(store, evidence.id, RELATION_TYPES.usesEvidence, true)
      .map((relation) => getRevision(store, relation.from));
    return { evidence, assertions, replayed: true };
  }
  const generatedBy = command.evidence.generatedBy;
  const derivedFrom = command.evidence.derivedFrom ?? [];
  if (!generatedBy && derivedFrom.length === 0) {
    throw new Error("Evidence needs generatedBy or derivedFrom provenance");
  }
  for (const ref of [
    ...(generatedBy ? [generatedBy] : []),
    ...derivedFrom,
    ...(command.evidence.attributedTo ?? []),
  ]) {
    assertIngressRef(store, ref);
  }
  const preparedAssessments = (command.evidence.assessments ?? []).map((assessment) => {
    const claim = getRevision(store, requirePinned(assessment.claim));
    if (claim.kind !== KINDS.claim) throw new Error("Assertion target must be a Claim");
    if (!assessment.rationale?.trim()) throw new Error("Assertion rationale must be non-empty");
    if (!["supports", "contradicts", "inconclusive"].includes(assessment.stance)) {
      throw new Error(`Invalid Assertion stance: ${String(assessment.stance)}`);
    }
    if (
      assessment.confidence != null &&
      (!Number.isFinite(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 1)
    ) {
      throw new Error("Assertion confidence must be between 0 and 1");
    }
    return { assessment, claim };
  });
  const evidence = createKnowledge(store, {
    kind: KINDS.evidence,
    title: command.evidence.title,
    sensitivity: command.evidence.sensitivity,
    attributes: {
      observation: command.evidence.observation,
      registrationSource: command.source,
      registrationSourceEventId: command.sourceEventId,
      registrationCommandDigest: commandDigest,
    },
    observedAt: command.evidence.observedAt,
    provenance: {
      generatedBy,
      derivedFrom,
      attributedTo: command.evidence.attributedTo ?? [],
    },
  });
  const assertions = preparedAssessments.map(({ assessment, claim }) => {
    const assertion = createKnowledge(store, {
      kind: KINDS.assertion,
      title: `${assessment.stance}: ${claim.title}`,
      sensitivity: command.evidence.sensitivity,
      attributes: {
        claim: jsonRef(assessment.claim),
        stance: assessment.stance,
        evidence: [jsonRef(refForRevision(evidence))],
        rationale: assessment.rationale,
        ...(assessment.confidence == null ? {} : { confidence: assessment.confidence }),
      },
      provenance: {
        generatedBy,
        derivedFrom: [refForRevision(evidence)],
        attributedTo: command.evidence.attributedTo ?? [],
      },
      observedAt: command.evidence.observedAt,
    });
    addRelation(store, RELATION_TYPES.assesses, refForRevision(assertion), assessment.claim);
    addRelation(store, RELATION_TYPES.usesEvidence, refForRevision(assertion), refForRevision(evidence));
    return assertion;
  });
  store.idempotency[idempotencyKey] = refForRevision(evidence);
  recordAudit(store, "evidence_registered", refForRevision(evidence), {
    source: command.source,
    sourceEventId: command.sourceEventId,
  });
  return { evidence, assertions, replayed: false };
}

export function makeDecision(
  store: Store,
  input: {
    title: string;
    question: string;
    evidence: string[];
    outcome: string;
    rationale: string;
    hypothesis?: string;
    hypothesisStatus?: "confirmed" | "refuted" | "inconclusive";
    revises?: string;
  },
): KnowledgeRevision {
  if (input.evidence.length === 0) throw new Error("Decision needs at least one Evidence");
  const question = resolveRef(store, input.question);
  const questionRevision = getRevision(store, question);
  if (questionRevision.kind !== KINDS.question) throw new Error("Decision target must be Question");
  if (questionRevision.status !== "open") throw new Error(`Question is not open: ${questionRevision.id}`);
  if (
    Object.values(store.relations).some(
      (relation) => relation.type === RELATION_TYPES.resolves && relation.to.id === questionRevision.id,
    )
  ) {
    throw new Error(`Question already has a resolving Decision: ${questionRevision.id}`);
  }
  const evidence = input.evidence.map((id) => resolveRef(store, id));
  for (const ref of evidence) {
    if (getRevision(store, ref).kind !== KINDS.evidence) throw new Error("Decision evidence must be Evidence");
  }
  if (Boolean(input.hypothesis) !== Boolean(input.hypothesisStatus)) {
    throw new Error("Decision hypothesis and hypothesisStatus must be provided together");
  }
  const hypothesis = input.hypothesis ? resolveRef(store, input.hypothesis) : undefined;
  if (hypothesis && input.hypothesisStatus) {
    const revision = getRevision(store, hypothesis);
    if (revision.kind !== KINDS.hypothesis) throw new Error("Decision hypothesis must be Hypothesis");
    if (!(STATUS_TRANSITIONS.hypothesis[revision.status] ?? []).includes(input.hypothesisStatus)) {
      throw new Error(
        `Invalid hypothesis status transition: ${revision.status} -> ${input.hypothesisStatus}`,
      );
    }
  }
  const revises = input.revises ? resolveRef(store, input.revises) : undefined;
  if (revises) {
    const revision = getRevision(store, revises);
    if (!(RELATION_SHAPES.revises.to as readonly Kind[]).includes(revision.kind)) {
      throw new Error(`Decision cannot revise ${revision.kind}`);
    }
  }
  const decision = createKnowledge(store, {
    kind: KINDS.decision,
    title: input.title,
    attributes: {
      question: jsonRef(question),
      evidence: evidence.map(jsonRef),
      outcome: input.outcome,
      rationale: input.rationale,
    },
    provenance: { derivedFrom: evidence },
  });
  addRelation(store, RELATION_TYPES.resolves, refForRevision(decision), question);
  for (const ref of evidence) addRelation(store, RELATION_TYPES.basedOn, refForRevision(decision), ref);
  reviseKnowledge(store, input.question, {
    status: "closed",
    provenance: { derivedFrom: [refForRevision(decision)] },
  });
  if (hypothesis && input.hypothesisStatus) {
    reviseKnowledge(store, hypothesis.id, {
      status: input.hypothesisStatus,
      provenance: { derivedFrom: [refForRevision(decision), ...evidence] },
    });
  }
  if (revises) {
    addRelation(store, RELATION_TYPES.revises, refForRevision(decision), revises);
  }
  return decision;
}

export function createContextBundle(store: Store, query: ContextQueryV1): ContextBundle {
  if (query.schema !== "negura.context-query/v1") throw new Error("Unsupported context query schema");
  if (query.roots.length === 0) throw new Error("Context query needs at least one root");
  const asOf = query.asOf;
  if (asOf && !isValidTimestamp(asOf)) throw new Error(`Invalid context asOf timestamp: ${asOf}`);
  const allowed = query.allowedSensitivities ?? ["public", "internal"];
  const maxResources = query.maxResources ?? 30;
  const tokenBudget = query.tokenBudget ?? 4_000;
  if (!Number.isInteger(maxResources) || maxResources < 1) {
    throw new Error("Context maxResources must be a positive integer");
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) {
    throw new Error("Context tokenBudget must be a positive integer");
  }
  const includeKinds = query.includeKinds ? new Set(query.includeKinds) : null;
  const candidates = new Map<string, { revision: KnowledgeRevision; score: number; reasons: Set<string> }>();
  const queue: Array<{ ref: ResourceRefV1; depth: number }> = query.roots.map((root) => ({
    ref: root.version ? root : resolveRef(store, root.id, asOf),
    depth: 0,
  }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { ref, depth } = queue.shift()!;
    const pinned = ref.version ? ref : resolveRef(store, ref.id, asOf);
    const key = revisionKey(pinned.id, pinned.version!);
    if (visited.has(key) || depth > 3) continue;
    visited.add(key);
    const revision = getRevision(store, pinned);
    if (!isVisibleAt(revision, asOf) || !allowed.includes(revision.sensitivity)) continue;
    if (!includeKinds || includeKinds.has(revision.kind)) {
      const existing = candidates.get(key);
      const score = 100 - depth * 15 + textScore(revision, query.purpose);
      candidates.set(key, {
        revision,
        score: Math.max(existing?.score ?? 0, score),
        reasons: new Set([...(existing?.reasons ?? []), depth === 0 ? "query-root" : `graph-depth:${depth}`]),
      });
    }
    for (const relation of touching(store, revision.id).filter((item) => isRelationVisibleAt(item, asOf))) {
      const next = relation.from.id === revision.id ? relation.to : relation.from;
      queue.push({ ref: next, depth: depth + 1 });
    }
  }

  for (const revision of visibleHeads(store, asOf)) {
    if (!allowed.includes(revision.sensitivity) || (includeKinds && !includeKinds.has(revision.kind))) continue;
    const score = textScore(revision, query.purpose);
    if (score <= 0) continue;
    const key = revisionKey(revision.id, revision.version);
    const existing = candidates.get(key);
    candidates.set(key, {
      revision,
      score: Math.max(existing?.score ?? 0, score),
      reasons: new Set([...(existing?.reasons ?? []), "purpose-match"]),
    });
  }

  const ranked = [...candidates.values()].sort(
    (left, right) => right.score - left.score || left.revision.id.localeCompare(right.revision.id),
  );
  const selections: ContextSelection[] = [];
  let estimatedTokens = 0;
  for (const candidate of ranked) {
    const cost = estimateTokens(candidate.revision);
    if (selections.length >= maxResources || estimatedTokens + cost > tokenBudget) continue;
    estimatedTokens += cost;
    selections.push({
      resource: refForRevision(candidate.revision),
      score: candidate.score,
      reasons: [...candidate.reasons].sort(),
    });
  }
  const normalizedQuery: ContextQueryV1 = {
    ...query,
    roots: query.roots.map((root) => (root.version ? root : resolveRef(store, root.id, asOf))),
    tokenBudget,
    maxResources,
    allowedSensitivities: [...allowed].sort() as Sensitivity[],
  };
  const policyDigest = digestJson({
    allowedSensitivities: normalizedQuery.allowedSensitivities,
    includeKinds: normalizedQuery.includeKinds ?? null,
  });
  const payload = contextDigestPayload({
    ontology: ontologyRef(store.ontology),
    query: normalizedQuery,
    selections,
    omitted: ranked.length - selections.length,
    estimatedTokens,
    policyDigest,
  });
  const digest = digestJson(payload);
  const id = `CTX-${digest.slice("sha256:".length, "sha256:".length + 16).toUpperCase()}`;
  const existing = store.contextBundles[id];
  if (existing) return existing;
  const bundle: ContextBundle = {
    schema: "negura.context-bundle/v1",
    id,
    createdAt: nowIso(),
    ...payload,
    digest,
  };
  store.contextBundles[id] = bundle;
  recordAudit(store, "context_bundle_created", contextRef(bundle), {
    resourceCount: selections.length,
    digest,
  });
  return bundle;
}

export function statusReport(store: Store): StatusReport {
  const heads = Object.values(store.heads).map((ref) => getRevision(store, ref));
  const headCounts: Record<string, number> = {};
  for (const revision of heads) headCounts[revision.kind] = (headCounts[revision.kind] ?? 0) + 1;
  return {
    ontology: store.ontology,
    headCounts,
    revisionCount: Object.keys(store.revisions).length,
    relationCount: Object.keys(store.relations).length,
    contextBundleCount: Object.keys(store.contextBundles).length,
    unresolvedQuestions: heads
      .filter((item) => item.kind === KINDS.question && item.status === "open")
      .map(({ id, title }) => ({ id, title })),
    unresolvedHypotheses: heads
      .filter((item) => item.kind === KINDS.hypothesis && item.status === "open")
      .map(({ id, title }) => ({ id, title })),
    legacy: store.legacy
      ? {
          objects: store.legacy.objects.length,
          edges: store.legacy.edges.length,
          events: store.legacy.events.length,
        }
      : null,
  };
}

export function validateStore(store: Store): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (store.schema !== STORE_SCHEMA) errors.push(`Unsupported store schema: ${String(store.schema)}`);
  const expectedOntology = currentOntologyRelease();
  if (
    store.ontology.id !== expectedOntology.id ||
    store.ontology.version !== expectedOntology.version ||
    store.ontology.shapeDigest !== expectedOntology.shapeDigest ||
    store.ontology.compatibleStoreVersion !== expectedOntology.compatibleStoreVersion
  ) {
    errors.push("Ontology release does not match the active release");
  }
  for (const [key, revision] of Object.entries(store.revisions)) {
    if (key !== revisionKey(revision.id, revision.version)) errors.push(`Revision key mismatch: ${key}`);
    collectRevisionErrors(revision, errors);
    validateRevisionRefs(store, revision, errors);
  }
  for (const [id, ref] of Object.entries(store.heads)) {
    if (id !== ref.id) errors.push(`Head key mismatch: ${id}`);
    try {
      getRevision(store, ref);
    } catch (error) {
      errors.push(asMessage(error));
    }
  }
  for (const relation of Object.values(store.relations)) {
    try {
      const from = getRevision(store, relation.from);
      const to = getRevision(store, relation.to);
      const shape = RELATION_SHAPES[relation.type];
      if (!shape) throw new Error(`Unknown relation type: ${String(relation.type)}`);
      if (
        !(shape.from as readonly Kind[]).includes(from.kind) ||
        !(shape.to as readonly Kind[]).includes(to.kind)
      ) {
        errors.push(`Invalid ${relation.type} relation: ${from.kind} -> ${to.kind}`);
      }
      for (const [name, value] of Object.entries(relation.temporal)) {
        if (value && !isValidTimestamp(value)) {
          errors.push(`${relation.id} has invalid ${name} timestamp`);
        }
      }
    } catch (error) {
      errors.push(asMessage(error));
    }
  }
  validateIdentityRelations(store, errors);
  for (const ref of Object.values(store.heads)) {
    let revision: KnowledgeRevision;
    try {
      revision = getRevision(store, ref);
    } catch {
      continue;
    }
    if (
      revision.kind === KINDS.question &&
      revision.status === "closed" &&
      !Object.values(store.relations).some(
        (relation) => relation.type === RELATION_TYPES.resolves && relation.to.id === revision.id,
      )
    ) {
      errors.push(`${revision.id} is closed but has no resolving Decision`);
    }
    if (
      revision.kind === KINDS.hypothesis &&
      ["confirmed", "refuted", "inconclusive"].includes(revision.status) &&
      !revision.provenance.derivedFrom.some((item) => item.system === "negura" && item.type === KINDS.decision)
    ) {
      errors.push(`${revision.id}@${revision.version} conclusion has no Decision provenance`);
    }
  }
  for (const revision of Object.values(store.revisions)) {
    if (revision.kind === KINDS.decision) {
      const evidence = revision.attributes.evidence;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        errors.push(`${revision.id}@${revision.version} decision has no evidence`);
      }
    }
    if (revision.kind === KINDS.evidence) {
      if (!revision.provenance.generatedBy && revision.provenance.derivedFrom.length === 0) {
        errors.push(`${revision.id}@${revision.version} evidence has no provenance source`);
      }
    }
    if (revision.kind === KINDS.assertion) {
      const evidence = revision.attributes.evidence;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        errors.push(`${revision.id}@${revision.version} assertion has no evidence`);
      }
    }
  }
  for (const [id, bundle] of Object.entries(store.contextBundles)) {
    if (id !== bundle.id) errors.push(`Context bundle key mismatch: ${id}`);
    if (digestJson(bundle.ontology) !== digestJson(ontologyRef(store.ontology))) {
      errors.push(`${bundle.id} does not pin the store ontology release`);
    }
    if (digestJson(contextDigestPayload(bundle)) !== bundle.digest) {
      errors.push(`${bundle.id} context digest mismatch`);
    }
    const expectedPolicyDigest = digestJson({
      allowedSensitivities: bundle.query.allowedSensitivities ?? ["public", "internal"],
      includeKinds: bundle.query.includeKinds ?? null,
    });
    if (bundle.policyDigest !== expectedPolicyDigest) {
      errors.push(`${bundle.id} policy digest mismatch`);
    }
    const selected = new Set<string>();
    for (const selection of bundle.selections) {
      try {
        const revision = getRevision(store, selection.resource);
        const key = revisionKey(revision.id, revision.version);
        if (selected.has(key)) errors.push(`${bundle.id} selects ${key} more than once`);
        selected.add(key);
        if (!isVisibleAt(revision, bundle.query.asOf)) {
          errors.push(`${bundle.id} selects ${key} outside its asOf time`);
        }
        const allowed = bundle.query.allowedSensitivities ?? ["public", "internal"];
        if (!allowed.includes(revision.sensitivity)) {
          errors.push(`${bundle.id} selects disallowed sensitivity for ${key}`);
        }
      } catch (error) {
        errors.push(`${bundle.id}: ${asMessage(error)}`);
      }
    }
  }
  for (const [key, ref] of Object.entries(store.idempotency)) {
    try {
      if (getRevision(store, ref).kind !== KINDS.evidence) errors.push(`${key} does not refer to Evidence`);
    } catch (error) {
      errors.push(asMessage(error));
    }
  }
  if (store.legacy && store.legacy.objects.length > 0) {
    warnings.push(`${store.legacy.objects.length} legacy execution objects are isolated from active knowledge`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function createDemo(store: Store): Record<string, KnowledgeRevision | ContextBundle> {
  const concept = createConcept(store, {
    title: "Agent-legible verification",
    statement: "Agent runs improve when verification evidence is versioned and inspectable.",
    aliases: ["verifiable agent work"],
  });
  const claim = createClaim(store, {
    concept: concept.id,
    title: "Pinned context improves reproducibility",
    statement: "A version-pinned context bundle makes an agent run reproducible.",
  });
  const question = createQuestion(store, {
    concept: concept.id,
    title: "Does pinned context reproduce the run?",
    question: "Can a completed Ouro run recover every knowledge input by version?",
    closureRule: "Close after a replay resolves every pinned resource and artifact digest.",
    evidenceRequirements: ["context bundle", "replay result"],
  });
  const hypothesis = createHypothesis(store, {
    title: "All pinned resources resolve",
    claim: claim.id,
    question: question.id,
    closesWhen: "A replay resolves all resources with matching versions and digests.",
  });
  const procedure = createProcedure(store, {
    title: "Replay a pinned context",
    purpose: "Verify that an Ouro run can reproduce its Negura knowledge inputs.",
    inputs: ["ContextBundle"],
    outputs: ["replay report"],
    preconditions: ["all references are version pinned"],
    postconditions: ["every reference has a resolution result"],
    invariants: ["do not resolve latest in replay mode"],
    verification: ["compare bundle and replay digests"],
    implementations: [
      {
        system: "github",
        type: "file",
        id: "semigrp/negura:procedures/replay.ts",
        version: "demo-commit",
        digest: digestJson("demo procedure"),
      },
    ],
  });
  const experiment = createExperiment(store, {
    title: "Pinned context replay",
    question: question.id,
    hypotheses: [hypothesis.id],
    successCriteria: ["all resources resolve", "digest matches"],
    failureCriteria: ["a resource resolves only as latest", "digest differs"],
    evidenceRequirements: ["machine-readable replay report"],
    procedure: refForRevision(procedure),
  });
  const bundle = createContextBundle(store, {
    schema: "negura.context-query/v1",
    roots: [refForRevision(experiment)],
    purpose: "replay pinned context",
    tokenBudget: 4_000,
  });
  const registered = registerEvidence(store, {
    schema: "negura.register-evidence/v1",
    source: "ouro",
    sourceEventId: "EVT-DEMO-0001",
    evidence: {
      title: "Replay resolved the pinned bundle",
      observation: "Every knowledge revision resolved and the bundle digest matched.",
      observedAt: nowIso(),
      generatedBy: {
        system: "ouro",
        type: "experiment_run",
        id: "RUN-DEMO-0001",
        version: "1",
      },
      derivedFrom: [contextRef(bundle)],
      assessments: [
        {
          claim: refForRevision(claim),
          stance: "supports",
          confidence: 0.95,
          rationale: "The replay directly exercised the claim's reproducibility condition.",
        },
      ],
    },
  });
  const decision = makeDecision(store, {
    title: "Adopt pinned context bundles",
    question: question.id,
    evidence: [registered.evidence.id],
    outcome: "adopted",
    rationale: "The replay met the explicit closure rule.",
    hypothesis: hypothesis.id,
    hypothesisStatus: "confirmed",
    revises: concept.id,
  });
  return {
    concept,
    claim,
    question: getHead(store, question.id),
    hypothesis: getHead(store, hypothesis.id),
    procedure,
    experiment,
    bundle,
    evidence: registered.evidence,
    assertion: registered.assertions[0],
    decision,
  };
}

export function migrateStore(raw: unknown): Store {
  if (isV2Store(raw)) {
    raw.counters ??= {};
    for (const prefix of [...Object.values(PREFIX_BY_KIND), "REL", "EVT"]) raw.counters[prefix] ??= 0;
    raw.revisions ??= {};
    raw.heads ??= {};
    raw.relations ??= {};
    raw.contextBundles ??= {};
    raw.idempotency ??= {};
    raw.audit ??= [];
    return raw;
  }
  if (isRecord(raw) && raw.version === 1) return migrateV1(raw);
  throw new Error("Unsupported Negura store schema or version");
}

function migrateV1(raw: unknown): Store {
  const source = isRecord(raw) ? raw : {};
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : nowIso();
  const store = emptyStore(createdAt);
  const objects = isRecord(source.objects) ? Object.values(source.objects) : [];
  const edges = Array.isArray(source.edges) ? source.edges : [];
  const events = Array.isArray(source.events) ? source.events : [];
  store.legacy = { migratedFrom: "negura.store/v1", objects: [], edges: [], events: [...events] };
  const legacyKinds = new Map<string, string>();
  for (const item of objects) {
    if (isRecord(item) && typeof item.id === "string" && typeof item.kind === "string") {
      legacyKinds.set(item.id, item.kind);
    }
  }

  for (const rawObject of objects) {
    if (!isRecord(rawObject) || typeof rawObject.kind !== "string" || typeof rawObject.id !== "string") {
      store.legacy.objects.push(rawObject);
      continue;
    }
    if (rawObject.kind === "run" || rawObject.kind === "artifact" || !Object.hasOwn(PREFIX_BY_KIND, rawObject.kind)) {
      store.legacy.objects.push(rawObject);
      continue;
    }
    const kind = rawObject.kind as Kind;
    const attributes = isRecord(rawObject.attributes) ? sanitizeJsonRecord(rawObject.attributes) : {};
    const migratedAttributes = migrationAttributes(kind, attributes, rawObject.title);
    if (kind === KINDS.decision) {
      const questionId = legacyEdgeTarget(edges, rawObject.id, "resolves");
      const evidenceIds = legacyEdgeSources(edges, rawObject.id, "supports").filter(
        (id) => legacyKinds.get(id) === KINDS.evidence,
      );
      if (!questionId || evidenceIds.length === 0) {
        store.legacy.objects.push(rawObject);
        continue;
      }
      migratedAttributes.question = jsonRef({
        system: "negura",
        type: KINDS.question,
        id: questionId,
        version: "1",
      });
      migratedAttributes.evidence = evidenceIds.map((id) =>
        jsonRef({ system: "negura", type: KINDS.evidence, id, version: "1" }),
      );
    }
    if (kind === KINDS.experiment) {
      const questionId = legacyEdgeTarget(edges, rawObject.id, "tests");
      if (questionId) {
        migratedAttributes.question = jsonRef({
          system: "negura",
          type: KINDS.question,
          id: questionId,
          version: "1",
        });
      }
    }
    const revision: KnowledgeRevision = {
      schema: "negura.knowledge-revision/v1",
      id: rawObject.id,
      kind,
      version: "1",
      title: typeof rawObject.title === "string" ? rawObject.title : rawObject.id,
      status: migrateStatus(kind, rawObject.status),
      sensitivity: "internal",
      attributes: migratedAttributes,
      provenance: {
        attributedTo: [],
        derivedFrom: [{ system: "legacy", type: "store_object", id: rawObject.id }],
      },
      temporal: {
        recordedAt: typeof rawObject.createdAt === "string" ? rawObject.createdAt : createdAt,
      },
    };
    store.revisions[revisionKey(revision.id, revision.version)] = revision;
    store.heads[revision.id] = refForRevision(revision);
    const prefix = PREFIX_BY_KIND[kind];
    const sequence = Number(revision.id.match(/(\d+)$/)?.[1] ?? 0);
    store.counters[prefix] = Math.max(store.counters[prefix] ?? 0, sequence);
  }

  for (const edge of edges) {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.type !== "string") {
      store.legacy.edges.push(edge);
      continue;
    }
    const type = edge.type as RelationType;
    const fromRef = store.heads[edge.from];
    const toRef = store.heads[edge.to];
    const shape = RELATION_SHAPES[type];
    if (!fromRef || !toRef || !shape) {
      store.legacy.edges.push(edge);
      continue;
    }
    const fromKind = getRevision(store, fromRef).kind;
    const toKind = getRevision(store, toRef).kind;
    if (
      !(shape.from as readonly Kind[]).includes(fromKind) ||
      !(shape.to as readonly Kind[]).includes(toKind)
    ) {
      store.legacy.edges.push(edge);
      continue;
    }
    const relation: KnowledgeRelation = {
      schema: "negura.knowledge-relation/v1",
      id: nextId(store, "REL"),
      type,
      from: fromRef,
      to: toRef,
      attributes: isRecord(edge.attributes) ? sanitizeJsonRecord(edge.attributes) : {},
      provenance: {
        attributedTo: [],
        derivedFrom: [{ system: "legacy", type: "edge", id: `${edge.from}:${edge.type}:${edge.to}` }],
      },
      temporal: { recordedAt: typeof edge.createdAt === "string" ? edge.createdAt : createdAt },
    };
    store.relations[relation.id] = relation;
  }
  recordAudit(store, "store_migrated", ontologyRef(store.ontology), {
    from: "negura.store/v1",
    isolatedObjects: store.legacy.objects.length,
    isolatedEdges: store.legacy.edges.length,
  });
  return store;
}

function migrationAttributes(kind: Kind, attributes: Attributes, title: unknown): Attributes {
  switch (kind) {
    case KINDS.concept:
      return {
        ...attributes,
        statement: attributes.statement ?? String(title ?? "Migrated concept"),
        preferredLabel: String(title ?? "Migrated concept"),
        aliases: attributes.aliases ?? [],
      };
    case KINDS.claim:
      return { ...attributes, statement: attributes.statement ?? String(title ?? "Migrated claim") };
    case KINDS.question:
      return {
        ...attributes,
        question: attributes.question ?? String(title ?? "Migrated question"),
        closureRule: attributes.closureRule ?? "legacy decision required",
        evidenceRequirements: attributes.evidenceRequirements ?? [],
      };
    case KINDS.hypothesis:
      return {
        ...attributes,
        claim: attributes.claim ?? null,
        closesWhen: attributes.closesWhen ?? "legacy closure rule unavailable",
      };
    case KINDS.experiment:
      return {
        ...attributes,
        question: attributes.question ?? null,
        hypotheses: attributes.hypotheses ?? [],
        successCriteria: attributes.successCriteria ?? [],
        failureCriteria: attributes.failureCriteria ?? [],
        evidenceRequirements: attributes.evidenceRequirements ?? [],
      };
    case KINDS.procedure:
      return {
        ...attributes,
        purpose: attributes.purpose ?? String(title ?? "Migrated procedure"),
        inputs: attributes.inputs ?? [],
        outputs: attributes.outputs ?? [],
        preconditions: attributes.preconditions ?? [],
        postconditions: attributes.postconditions ?? [],
        invariants: attributes.invariants ?? [],
        verification: attributes.verification ?? [],
        implementations: attributes.implementations ?? [],
      };
    case KINDS.evidence:
      return { ...attributes, observation: attributes.observation ?? String(title ?? "Migrated evidence") };
    case KINDS.assertion:
      return {
        ...attributes,
        claim: attributes.claim ?? null,
        stance: attributes.stance ?? "inconclusive",
        evidence: attributes.evidence ?? [],
        rationale: attributes.rationale ?? "migrated assertion",
      };
    case KINDS.decision:
      return {
        ...attributes,
        question: attributes.question ?? null,
        evidence: attributes.evidence ?? [],
        outcome: attributes.outcome ?? "legacy",
        rationale: attributes.rationale ?? "migrated decision",
      };
  }
}

function legacyEdgeTarget(edges: unknown[], from: string, type: string): string | undefined {
  const edge = edges.find(
    (item) =>
      isRecord(item) && item.from === from && item.type === type && typeof item.to === "string",
  );
  return isRecord(edge) && typeof edge.to === "string" ? edge.to : undefined;
}

function legacyEdgeSources(edges: unknown[], to: string, type: string): string[] {
  return edges
    .filter(
      (item) =>
        isRecord(item) && item.to === to && item.type === type && typeof item.from === "string",
    )
    .map((item) => (item as Record<string, string>).from);
}

function migrateStatus(kind: Kind, value: unknown): string {
  const requested = typeof value === "string" ? value : "";
  const statuses = OBJECT_SHAPES[kind].statuses as readonly string[];
  if (statuses.includes(requested)) return requested;
  if (kind === KINDS.question && requested === "closed") return "closed";
  return statuses[0];
}

function assertValidRevision(revision: KnowledgeRevision): void {
  const errors: string[] = [];
  collectRevisionErrors(revision, errors);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function collectRevisionErrors(revision: KnowledgeRevision, errors: string[]): void {
  const prefix = `${String(revision.id)}@${String(revision.version)}`;
  if (revision.schema !== "negura.knowledge-revision/v1") {
    errors.push(`${prefix} has invalid knowledge revision schema`);
  }
  if (typeof revision.id !== "string" || revision.id.trim() === "") {
    errors.push(`${prefix} has an invalid id`);
  }
  if (!Number.isInteger(Number(revision.version)) || Number(revision.version) < 1) {
    errors.push(`${prefix} has an invalid version`);
  }
  if (typeof revision.title !== "string" || revision.title.trim() === "") {
    errors.push(`${prefix} has an empty title`);
  }
  if (!["public", "internal", "restricted"].includes(revision.sensitivity)) {
    errors.push(`${prefix} has invalid sensitivity ${String(revision.sensitivity)}`);
  }
  if (!Object.hasOwn(OBJECT_SHAPES, revision.kind)) {
    errors.push(`${prefix} has unknown kind ${String(revision.kind)}`);
    return;
  }
  const shape = OBJECT_SHAPES[revision.kind];
  if (!(shape.statuses as readonly string[]).includes(revision.status)) {
    errors.push(`${revision.id}@${revision.version} has invalid status ${revision.status}`);
  }
  for (const attribute of shape.requiredAttributes) {
    if (!Object.hasOwn(revision.attributes, attribute)) {
      errors.push(`${revision.id}@${revision.version} is missing attribute ${attribute}`);
    }
  }
  validateAttributeShapes(revision, errors);
  if (revision.temporal.validFrom && revision.temporal.validTo) {
    if (Date.parse(revision.temporal.validFrom) > Date.parse(revision.temporal.validTo)) {
      errors.push(`${revision.id}@${revision.version} has inverted validity interval`);
    }
  }
  for (const [name, value] of Object.entries(revision.temporal)) {
    if (value && !isValidTimestamp(value)) {
      errors.push(`${revision.id}@${revision.version} has invalid ${name} timestamp`);
    }
  }
  if (revision.supersedes && !revision.supersedes.version) {
    errors.push(`${revision.id}@${revision.version} has unpinned supersedes reference`);
  }
}

function validateAttributeShapes(revision: KnowledgeRevision, errors: string[]): void {
  const prefix = `${revision.id}@${revision.version}`;
  const requireString = (name: string) => {
    const value = revision.attributes[name];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${prefix} attribute ${name} must be a non-empty string`);
    }
  };
  const requireArray = (name: string) => {
    if (!Array.isArray(revision.attributes[name])) {
      errors.push(`${prefix} attribute ${name} must be an array`);
    }
  };
  switch (revision.kind) {
    case KINDS.concept:
      requireString("statement");
      requireString("preferredLabel");
      requireArray("aliases");
      break;
    case KINDS.claim:
      requireString("statement");
      break;
    case KINDS.question:
      requireString("question");
      requireString("closureRule");
      requireArray("evidenceRequirements");
      break;
    case KINDS.hypothesis:
      requireString("closesWhen");
      if (!isResourceRefValue(revision.attributes.claim)) {
        errors.push(`${prefix} attribute claim must be a ResourceRefV1`);
      }
      break;
    case KINDS.experiment: {
      requireArray("hypotheses");
      requireArray("successCriteria");
      requireArray("failureCriteria");
      requireArray("evidenceRequirements");
      if (!isResourceRefValue(revision.attributes.question)) {
        errors.push(`${prefix} attribute question must be a ResourceRefV1`);
      }
      if (
        revision.status === "approved" &&
        (!Array.isArray(revision.attributes.hypotheses) || revision.attributes.hypotheses.length === 0)
      ) {
        errors.push(`${prefix} approved Experiment needs at least one Hypothesis`);
      }
      if (
        revision.status === "approved" &&
        (!Array.isArray(revision.attributes.successCriteria) || revision.attributes.successCriteria.length === 0)
      ) {
        errors.push(`${prefix} approved Experiment needs success criteria`);
      }
      break;
    }
    case KINDS.procedure:
      requireString("purpose");
      for (const name of [
        "inputs",
        "outputs",
        "preconditions",
        "postconditions",
        "invariants",
        "verification",
        "implementations",
      ]) requireArray(name);
      if (
        revision.status === "approved" &&
        (!Array.isArray(revision.attributes.implementations) || revision.attributes.implementations.length === 0)
      ) {
        errors.push(`${prefix} approved Procedure needs an implementation artifact`);
      }
      break;
    case KINDS.evidence:
      requireString("observation");
      break;
    case KINDS.assertion:
      requireString("rationale");
      if (!isResourceRefValue(revision.attributes.claim)) {
        errors.push(`${prefix} attribute claim must be a ResourceRefV1`);
      }
      if (!Array.isArray(revision.attributes.evidence) || revision.attributes.evidence.length === 0) {
        errors.push(`${prefix} assertion needs Evidence references`);
      }
      if (!["supports", "contradicts", "inconclusive"].includes(String(revision.attributes.stance))) {
        errors.push(`${prefix} assertion has invalid stance`);
      }
      break;
    case KINDS.decision:
      requireString("outcome");
      requireString("rationale");
      if (!isResourceRefValue(revision.attributes.question)) {
        errors.push(`${prefix} attribute question must be a ResourceRefV1`);
      }
      if (!Array.isArray(revision.attributes.evidence) || revision.attributes.evidence.length === 0) {
        errors.push(`${prefix} decision needs Evidence references`);
      }
      break;
  }
}

function validateRevisionRefs(store: Store, revision: KnowledgeRevision, errors: string[]): void {
  const refs = [
    ...resourceRefsIn(revision.attributes),
    ...revision.provenance.derivedFrom,
    ...(revision.provenance.generatedBy ? [revision.provenance.generatedBy] : []),
    ...(revision.supersedes ? [revision.supersedes] : []),
  ];
  for (const ref of refs) validatePersistentRef(store, revision, ref, errors);
  const version = Number(revision.version);
  if (version > 1 && !revision.supersedes) {
    errors.push(`${revision.id}@${revision.version} has no supersedes reference`);
  }
  if (!revision.supersedes) return;
  try {
    const previous = getRevision(store, revision.supersedes);
    if (
      previous.id !== revision.id ||
      previous.kind !== revision.kind ||
      Number(previous.version) !== version - 1
    ) {
      errors.push(`${revision.id}@${revision.version} has an invalid supersedes chain`);
      return;
    }
    const allowed = STATUS_TRANSITIONS[previous.kind][previous.status] ?? [];
    if (!allowed.includes(revision.status)) {
      errors.push(
        `${revision.id}@${revision.version} has invalid status transition ${previous.status} -> ${revision.status}`,
      );
    }
  } catch (error) {
    errors.push(`${revision.id}@${revision.version}: ${asMessage(error)}`);
  }
}

function validatePersistentRef(
  store: Store,
  owner: KnowledgeRevision,
  ref: ResourceRefV1,
  errors: string[],
): void {
  const prefix = `${owner.id}@${owner.version}`;
  if (ref.system === "legacy") return;
  if (ref.system === "negura" && ref.type === "context_bundle") {
    if (!ref.version || !ref.digest) errors.push(`${prefix} has unpinned ContextBundle reference ${ref.id}`);
    const bundle = store.contextBundles[ref.id];
    if (!bundle) errors.push(`${prefix} references missing ContextBundle ${ref.id}`);
    else if (ref.digest !== bundle.digest) errors.push(`${prefix} has stale ContextBundle digest ${ref.id}`);
    return;
  }
  if (ref.system === "negura" && Object.values(KINDS).includes(ref.type as Kind)) {
    try {
      getRevision(store, ref);
    } catch (error) {
      errors.push(`${prefix}: ${asMessage(error)}`);
    }
    return;
  }
  if (!ref.version && !ref.digest && ref.type !== "actor") {
    errors.push(`${prefix} has unpinned persistent reference ${ref.system}:${ref.type}:${ref.id}`);
  }
}

function assertIngressRef(store: Store, ref: ResourceRefV1): void {
  if (!ref || !ref.system?.trim() || !ref.type?.trim() || !ref.id?.trim()) {
    throw new Error("Evidence provenance contains an invalid ResourceRefV1");
  }
  if (ref.digest && !/^sha256:[a-fA-F0-9]{64}$/.test(ref.digest)) {
    throw new Error(`Evidence provenance contains an invalid digest: ${ref.id}`);
  }
  if (ref.system === "negura" && ref.type === "context_bundle") {
    if (!ref.version || !ref.digest) throw new Error(`ContextBundle reference must be pinned: ${ref.id}`);
    const bundle = store.contextBundles[ref.id];
    if (!bundle) throw new Error(`ContextBundle not found: ${ref.id}`);
    if (bundle.digest !== ref.digest) throw new Error(`ContextBundle digest mismatch: ${ref.id}`);
    return;
  }
  if (ref.system === "negura" && ref.type === "ontology_release") {
    if (digestJson(ref) !== digestJson(ontologyRef(store.ontology))) {
      throw new Error(`OntologyRelease reference does not match the active store: ${ref.id}`);
    }
    return;
  }
  if (ref.system === "negura" && Object.values(KINDS).includes(ref.type as Kind)) {
    getRevision(store, requirePinned(ref));
    return;
  }
  if (ref.system === "negura") throw new Error(`Unknown Negura resource type: ${ref.type}`);
  if (ref.type !== "actor" && !ref.version && !ref.digest) {
    throw new Error(`External persistent reference must pin version or digest: ${ref.id}`);
  }
}

function resourceRefsIn(value: JsonValue): ResourceRefV1[] {
  if (Array.isArray(value)) return value.flatMap(resourceRefsIn);
  if (!value || typeof value !== "object") return [];
  if (isResourceRefValue(value)) return [value];
  return Object.values(value).flatMap(resourceRefsIn);
}

function isResourceRefValue(value: unknown): value is ResourceRefV1 {
  return (
    isRecord(value) &&
    typeof value.system === "string" &&
    typeof value.type === "string" &&
    typeof value.id === "string"
  );
}

function normalizeProvenance(
  value?: Partial<Provenance>,
  fallbackDerivedFrom?: ResourceRefV1,
): Provenance {
  const attributedTo = value?.attributedTo?.length ? value.attributedTo : [LOCAL_ACTOR];
  const derivedFrom = value?.derivedFrom ?? (fallbackDerivedFrom ? [fallbackDerivedFrom] : []);
  return {
    attributedTo,
    derivedFrom,
    ...(value?.generatedBy ? { generatedBy: value.generatedBy } : {}),
  };
}

function recordAudit(store: Store, type: string, subject: ResourceRefV1, data: Attributes): AuditEvent {
  const event: AuditEvent = {
    id: nextId(store, "EVT"),
    type,
    subject,
    occurredAt: nowIso(),
    data,
  };
  store.audit.push(event);
  return event;
}

function relationRef(relation: KnowledgeRelation): ResourceRefV1 {
  return { system: "negura", type: "knowledge_relation", id: relation.id, version: "1" };
}

function contextRef(bundle: ContextBundle): ResourceRefV1 {
  return {
    system: "negura",
    type: "context_bundle",
    id: bundle.id,
    version: "1",
    digest: bundle.digest,
  };
}

function jsonRef(ref: ResourceRefV1): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(ref).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function requirePinned(ref: ResourceRefV1): ResourceRefV1 {
  if (!ref?.version) throw new Error(`Reference must pin version: ${ref?.id ?? "unknown"}`);
  return ref;
}

function missingObject(id: string): never {
  throw new Error(`Knowledge object not found: ${id}`);
}

function touching(store: Store, id: string): KnowledgeRelation[] {
  return Object.values(store.relations).filter(
    (relation) => relation.from.id === id || relation.to.id === id,
  );
}

function outgoing(
  store: Store,
  id: string,
  type: RelationType,
  reverse = false,
): KnowledgeRelation[] {
  return Object.values(store.relations).filter((relation) => {
    if (relation.type !== type) return false;
    return reverse ? relation.to.id === id : relation.from.id === id;
  });
}

function isVisibleAt(revision: KnowledgeRevision, asOf?: string): boolean {
  if (!asOf) return true;
  const timestamp = Date.parse(asOf);
  if (Date.parse(revision.temporal.recordedAt) > timestamp) return false;
  if (revision.temporal.validFrom && Date.parse(revision.temporal.validFrom) > timestamp) return false;
  if (revision.temporal.validTo && Date.parse(revision.temporal.validTo) <= timestamp) return false;
  return true;
}

function isRelationVisibleAt(relation: KnowledgeRelation, asOf?: string): boolean {
  if (!asOf) return true;
  const timestamp = Date.parse(asOf);
  if (Date.parse(relation.temporal.recordedAt) > timestamp) return false;
  if (relation.temporal.validFrom && Date.parse(relation.temporal.validFrom) > timestamp) return false;
  if (relation.temporal.validTo && Date.parse(relation.temporal.validTo) <= timestamp) return false;
  return true;
}

function visibleHeads(store: Store, asOf?: string): KnowledgeRevision[] {
  if (!asOf) return Object.values(store.heads).map((ref) => getRevision(store, ref));
  const ids = new Set(Object.values(store.revisions).map((revision) => revision.id));
  const result: KnowledgeRevision[] = [];
  for (const id of ids) {
    const candidates = Object.values(store.revisions)
      .filter((revision) => revision.id === id && isVisibleAt(revision, asOf))
      .sort(compareRevisionDescending);
    if (candidates[0]) result.push(candidates[0]);
  }
  return result;
}

function compareRevisionDescending(left: KnowledgeRevision, right: KnowledgeRevision): number {
  return Number(right.version) - Number(left.version);
}

function textScore(revision: KnowledgeRevision, purpose: string): number {
  const terms = purpose
    .toLowerCase()
    .split(/[^\p{L}\p{N}_\-]+/u)
    .filter((term) => [...term].length > 1);
  if (terms.length === 0) return 0;
  const haystack = `${revision.title} ${JSON.stringify(revision.attributes)}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 5 : 0), 0);
}

function estimateTokens(revision: KnowledgeRevision): number {
  return Math.max(1, Math.ceil(JSON.stringify(revision).length / 4));
}

function contextDigestPayload(value: Pick<
  ContextBundle,
  "ontology" | "query" | "selections" | "omitted" | "estimatedTokens" | "policyDigest"
>) {
  return {
    ontology: value.ontology,
    query: value.query,
    selections: value.selections,
    omitted: value.omitted,
    estimatedTokens: value.estimatedTokens,
    policyDigest: value.policyDigest,
  };
}

function assertNoIdentityConflict(
  store: Store,
  type: RelationType,
  from: ResourceRefV1,
  to: ResourceRefV1,
): void {
  const identityTypes: RelationType[] = [
    RELATION_TYPES.exactMatch,
    RELATION_TYPES.closeMatch,
    RELATION_TYPES.broader,
    RELATION_TYPES.related,
  ];
  if (!identityTypes.includes(type)) return;
  const existing = Object.values(store.relations).filter(
    (relation) => relation.from.id === from.id && relation.to.id === to.id,
  );
  if (
    type === RELATION_TYPES.exactMatch &&
    existing.some((relation) => [RELATION_TYPES.broader, RELATION_TYPES.related].includes(relation.type as never))
  ) {
    throw new Error("exact_match conflicts with broader or related for the same concepts");
  }
  if (
    [RELATION_TYPES.broader, RELATION_TYPES.related].includes(type as never) &&
    existing.some((relation) => relation.type === RELATION_TYPES.exactMatch)
  ) {
    throw new Error(`${type} conflicts with exact_match for the same concepts`);
  }
}

function validateIdentityRelations(store: Store, errors: string[]): void {
  const relations = Object.values(store.relations);
  for (const exact of relations.filter((relation) => relation.type === RELATION_TYPES.exactMatch)) {
    if (
      relations.some(
        (relation) =>
          relation.from.id === exact.from.id &&
          relation.to.id === exact.to.id &&
          [RELATION_TYPES.broader, RELATION_TYPES.related].includes(relation.type as never),
      )
    ) {
      errors.push(`${exact.from.id} -> ${exact.to.id} has conflicting identity relations`);
    }
  }
}

function isV2Store(value: unknown): value is Store {
  return isRecord(value) && value.schema === STORE_SCHEMA;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonRecord(value: Record<string, unknown>): Attributes {
  return JSON.parse(JSON.stringify(value)) as Attributes;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
