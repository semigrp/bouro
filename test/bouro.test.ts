import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  KINDS,
  OBJECT_SHAPES,
  RELATION_SHAPES,
  RELATION_TYPES,
  STATUS_TRANSITIONS,
  currentOntologyRelease,
  digestJson,
  refForRevision,
} from "../src/schema.js";
import {
  addRelation,
  createClaim,
  createConcept,
  createContextBundle,
  createDemo,
  createQuestion,
  emptyStore,
  getHead,
  loadStore,
  makeDecision,
  migrateStore,
  registerEvidence,
  reviseKnowledge,
  saveStore,
  validateStore,
} from "../src/vault.js";
import { runCli } from "../src/cli.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: unknown) => {
  addSchema(schema: unknown): void;
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: unknown };
};
const addFormats = require("ajv-formats").default as (ajv: object) => void;

test("ontology release pins the active object and relation shapes", () => {
  const release = currentOntologyRelease();
  assert.equal(release.version, "1.0.0");
  assert.equal(
    release.shapeDigest,
    digestJson({
      objects: OBJECT_SHAPES,
      relations: RELATION_SHAPES,
      statusTransitions: STATUS_TRANSITIONS,
    }),
  );
  assert.ok(OBJECT_SHAPES.assertion.requiredAttributes.includes("evidence"));
});

test("receiver-owned JSON Schemas validate contract fixtures", async () => {
  const contracts = fileURLToPath(new URL("../../contracts/", import.meta.url));
  const resourceSchema = JSON.parse(await readFile(join(contracts, "resource-ref.v1.schema.json"), "utf8"));
  const evidenceSchema = JSON.parse(await readFile(join(contracts, "register-evidence.v1.schema.json"), "utf8"));
  const contextSchema = JSON.parse(await readFile(join(contracts, "context-query.v1.schema.json"), "utf8"));
  const evidenceFixture = JSON.parse(
    await readFile(join(contracts, "fixtures", "register-evidence.valid.json"), "utf8"),
  );
  const contextFixture = JSON.parse(
    await readFile(join(contracts, "fixtures", "context-query.valid.json"), "utf8"),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(resourceSchema);
  const validateEvidence = ajv.compile(evidenceSchema);
  const validateContext = ajv.compile(contextSchema);
  assert.equal(validateEvidence(evidenceFixture), true, JSON.stringify(validateEvidence.errors));
  assert.equal(validateContext(contextFixture), true, JSON.stringify(validateContext.errors));
  assert.equal(
    validateEvidence({
      schema: "bouro.register-evidence/v1",
      source: "ouro",
      sourceEventId: "EVT-BAD",
      evidence: { title: "bad", observation: "missing provenance", derivedFrom: [] },
    }),
    false,
  );
});

test("demo creates a valid epistemic loop without execution-state objects", () => {
  const store = emptyStore("2026-07-14T00:00:00.000Z");
  const created = createDemo(store);
  assert.equal(validateStore(store).ok, true);
  assert.equal(getHead(store, created.question.id).status, "closed");
  assert.equal(getHead(store, created.hypothesis.id).status, "confirmed");
  assert.ok("selections" in created.bundle);
  assert.equal(created.bundle.ontology.version, "1.0.0");
  assert.ok(created.bundle.selections.every((item) => item.resource.version));
  assert.equal(
    Object.values(store.revisions).some((revision) => ["run", "artifact"].includes(revision.kind)),
    false,
  );
});

test("revision is immutable and supersession advances only the head", async () => {
  const store = emptyStore();
  const concept = createConcept(store, {
    title: "Original label",
    statement: "The original meaning remains addressable.",
  });
  await delay(3);
  const revised = reviseKnowledge(store, concept.id, {
    title: "Revised label",
    attributes: { preferredLabel: "Revised label" },
  });
  assert.equal(store.revisions[`${concept.id}@1`].title, "Original label");
  assert.equal(revised.version, "2");
  assert.equal(revised.supersedes?.version, "1");
  assert.equal(store.heads[concept.id].version, "2");
  assert.equal(validateStore(store).ok, true);
});

test("shape validation rejects invalid relation directions and evidence-free decisions", () => {
  const store = emptyStore();
  const concept = createConcept(store, { title: "C", statement: "Meaning" });
  const claim = createClaim(store, { title: "Claim", statement: "Testable" });
  assert.throws(
    () => addRelation(store, RELATION_TYPES.tests, refForRevision(concept), refForRevision(claim)),
    /Invalid tests relation/,
  );
  const question = createQuestion(store, {
    title: "Q",
    question: "Is it true?",
    closureRule: "Evidence-backed decision",
  });
  assert.throws(
    () =>
      makeDecision(store, {
        title: "Unsupported",
        question: question.id,
        evidence: [],
        outcome: "adopted",
        rationale: "No evidence",
      }),
    /at least one Evidence/,
  );
});

test("evidence registration is idempotent and creates a provenance-backed assertion", () => {
  const store = emptyStore();
  const claim = createClaim(store, { title: "Claim", statement: "Pinned inputs replay." });
  const command = {
    schema: "bouro.register-evidence/v1" as const,
    source: "ouro",
    sourceEventId: "EVT-001",
    evidence: {
      title: "Replay result",
      observation: "Every input resolved.",
      generatedBy: { system: "ouro", type: "run", id: "RUN-1", version: "1" },
      assessments: [
        {
          claim: refForRevision(claim),
          stance: "supports" as const,
          confidence: 0.9,
          rationale: "Direct replay",
        },
      ],
    },
  };
  const first = registerEvidence(store, command);
  const second = registerEvidence(store, command);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(first.evidence.id, second.evidence.id);
  assert.equal(Object.values(store.revisions).filter((item) => item.kind === KINDS.evidence).length, 1);
  assert.equal(first.assertions[0].attributes.stance, "supports");
  assert.throws(
    () =>
      registerEvidence(store, {
        ...command,
        evidence: { ...command.evidence, observation: "A conflicting replay payload." },
      }),
    /Idempotency key reused with different Evidence command/,
  );
  assert.equal(validateStore(store).ok, true);
});

test("invalid Evidence assessments fail before mutating the store", () => {
  const store = emptyStore();
  assert.throws(
    () =>
      registerEvidence(store, {
        schema: "bouro.register-evidence/v1",
        source: "ouro",
        sourceEventId: "EVT-INVALID-ASSESSMENT",
        evidence: {
          title: "Must roll back",
          observation: "The Claim reference does not exist.",
          generatedBy: { system: "ouro", type: "run", id: "RUN-1", version: "1" },
          assessments: [
            {
              claim: { system: "bouro", type: "claim", id: "CLM-404", version: "1" },
              stance: "supports",
              rationale: "Invalid target",
            },
          ],
        },
      }),
    /Knowledge revision not found/,
  );
  assert.equal(Object.keys(store.revisions).length, 0);
  assert.equal(Object.keys(store.idempotency).length, 0);
});

test("evidence without a source is rejected", () => {
  const store = emptyStore();
  assert.throws(
    () =>
      registerEvidence(store, {
        schema: "bouro.register-evidence/v1",
        source: "ouro",
        sourceEventId: "EVT-EMPTY",
        evidence: { title: "Unknown", observation: "No provenance" },
      }),
    /generatedBy or derivedFrom/,
  );
});

test("context bundles are deterministic, pinned, time-aware, and access filtered", async () => {
  const store = emptyStore();
  const publicConcept = createConcept(store, {
    title: "Replay context",
    statement: "Replay uses pinned context.",
    sensitivity: "public",
  });
  const oldTimestamp = publicConcept.temporal.recordedAt;
  await delay(3);
  reviseKnowledge(store, publicConcept.id, {
    title: "Replay context v2",
    sensitivity: "public",
  });
  createConcept(store, {
    title: "Restricted replay secret",
    statement: "Must not enter an internal context bundle.",
    sensitivity: "restricted",
  });
  const query = {
    schema: "bouro.context-query/v1" as const,
    roots: [{ system: "bouro", type: "concept", id: publicConcept.id }],
    purpose: "replay context",
    asOf: oldTimestamp,
    tokenBudget: 2_000,
    allowedSensitivities: ["public" as const],
  };
  const first = createContextBundle(store, query);
  const second = createContextBundle(store, query);
  assert.equal(first.id, second.id);
  assert.equal(first.digest, second.digest);
  assert.equal(first.selections.find((item) => item.resource.id === publicConcept.id)?.resource.version, "1");
  assert.equal(
    first.selections.some((item) => getHead(store, item.resource.id).sensitivity === "restricted"),
    false,
  );
  assert.equal(validateStore(store).ok, true);
  first.ontology.version = "stale-release";
  assert.equal(
    validateStore(store).errors.some((error) => error.includes("does not pin the store ontology release")),
    true,
  );
});

test("context excludes future relations and matches Japanese purpose terms", async () => {
  const store = emptyStore();
  const root = createConcept(store, {
    title: "Root concept",
    statement: "The context starts here.",
    sensitivity: "public",
  });
  const futureNeighbor = createConcept(store, {
    title: "Future neighbor",
    statement: "This object is only connected in the future.",
    sensitivity: "public",
  });
  const japaneseMatch = createConcept(store, {
    title: "再現可能な文脈",
    statement: "固定された参照から同じ文脈を構築する。",
    sensitivity: "public",
  });
  const asOf = new Date(Date.now() + 1_000).toISOString();
  const relation = addRelation(
    store,
    RELATION_TYPES.broader,
    refForRevision(root),
    refForRevision(futureNeighbor),
  );
  relation.temporal.recordedAt = new Date(Date.now() + 60_000).toISOString();

  const bundle = createContextBundle(store, {
    schema: "bouro.context-query/v1",
    roots: [refForRevision(root)],
    purpose: "再現可能",
    asOf,
    allowedSensitivities: ["public"],
  });

  assert.equal(bundle.selections.some((item) => item.resource.id === root.id), true);
  assert.equal(bundle.selections.some((item) => item.resource.id === japaneseMatch.id), true);
  assert.equal(bundle.selections.some((item) => item.resource.id === futureNeighbor.id), false);
});

test("context query rejects invalid temporal and budget constraints", () => {
  const store = emptyStore();
  const root = createConcept(store, { title: "Root", statement: "Root" });
  const base = {
    schema: "bouro.context-query/v1" as const,
    roots: [refForRevision(root)],
    purpose: "root",
  };
  assert.throws(() => createContextBundle(store, { ...base, asOf: "not-a-date" }), /Invalid context asOf/);
  assert.throws(() => createContextBundle(store, { ...base, maxResources: 0 }), /positive integer/);
  assert.throws(() => createContextBundle(store, { ...base, tokenBudget: 1.5 }), /positive integer/);
});

test("terminal evidence revisions and duplicate question decisions are rejected", () => {
  const store = emptyStore();
  const { evidence } = registerEvidence(store, {
    schema: "bouro.register-evidence/v1",
    source: "ouro",
    sourceEventId: "EVT-TERMINAL",
    evidence: {
      title: "Terminal evidence",
      observation: "Immutable once registered.",
      generatedBy: { system: "ouro", type: "run", id: "RUN-1", version: "1" },
    },
  });
  assert.throws(
    () => reviseKnowledge(store, evidence.id, { title: "Mutated evidence" }),
    /Invalid evidence status transition: final -> final/,
  );

  const question = createQuestion(store, {
    title: "Single resolution",
    question: "Can this be resolved twice?",
    closureRule: "Exactly one evidence-backed Decision",
  });
  makeDecision(store, {
    title: "First decision",
    question: question.id,
    evidence: [evidence.id],
    outcome: "adopted",
    rationale: "The evidence is sufficient.",
  });
  assert.throws(
    () =>
      makeDecision(store, {
        title: "Second decision",
        question: question.id,
        evidence: [evidence.id],
        outcome: "rejected",
        rationale: "This must not be accepted.",
      }),
    /Question is not open/,
  );
});

test("identity relations reject exact and hierarchical claims for the same pair", () => {
  const store = emptyStore();
  const first = createConcept(store, { title: "A", statement: "A" });
  const second = createConcept(store, { title: "B", statement: "B" });
  addRelation(store, RELATION_TYPES.broader, refForRevision(first), refForRevision(second));
  assert.throws(
    () => addRelation(store, RELATION_TYPES.exactMatch, refForRevision(first), refForRevision(second)),
    /conflicts/,
  );
});

test("v1 migration isolates Run objects and incompatible execution edges", () => {
  const migrated = migrateStore({
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    objects: {
      "CON-0001": {
        id: "CON-0001",
        kind: "concept",
        title: "Legacy concept",
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        attributes: { statement: "Preserve meaning" },
      },
      "RUN-0001": {
        id: "RUN-0001",
        kind: "run",
        title: "Legacy run",
        status: "open",
        attributes: { permissionTier: "R1" },
      },
    },
    edges: [{ from: "RUN-0001", to: "CON-0001", type: "uses" }],
    events: [{ id: "EVT-0001", type: "procedure_run_started" }],
  });
  assert.equal(getHead(migrated, "CON-0001").kind, KINDS.concept);
  assert.equal(migrated.legacy?.objects.length, 1);
  assert.equal(migrated.legacy?.edges.length, 1);
  assert.equal(migrated.legacy?.events.length, 1);
  assert.equal(validateStore(migrated).ok, true);
  assert.throws(() => migrateStore({}), /Unsupported Bouro store schema or version/);
});

test("store can be saved and loaded without losing revisions or context digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bouro-store-"));
  try {
    const path = join(dir, "vault", "store.json");
    const store = emptyStore();
    createDemo(store);
    await saveStore(path, store);
    const loaded = await loadStore(path);
    assert.equal(validateStore(loaded).ok, true);
    assert.equal(Object.keys(loaded.revisions).length, Object.keys(store.revisions).length);
    assert.match(await readFile(path, "utf8"), /bouro\.store\/v2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI demo writes a valid Bouro vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bouro-cli-"));
  const writes: string[] = [];
  try {
    await runCli(["demo"], {
      cwd: dir,
      stdout: { write: (value) => writes.push(value) },
      stderr: { write: () => {} },
    });
    const output = JSON.parse(writes.join(""));
    assert.equal(output.ok, true);
    const loaded = await loadStore(join(dir, "vault", "store.json"));
    assert.equal(validateStore(loaded).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor rejects a corrupt v2 vault with a non-zero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bouro-doctor-"));
  try {
    const path = join(dir, "store.json");
    const store = emptyStore();
    store.heads["CON-9999"] = {
      system: "bouro",
      type: "concept",
      id: "CON-9999",
      version: "1",
    };
    await writeFile(path, JSON.stringify(store), "utf8");
    const bin = fileURLToPath(new URL("../bin/bouro.js", import.meta.url));
    const result = spawnSync(process.execPath, [bin, "doctor", "--vault", path], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Knowledge revision not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
