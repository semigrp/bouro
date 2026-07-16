import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CommandOptions, ContextQueryV1, RelationType, ResourceRefV1 } from "./schema.js";
import { OBJECT_SHAPES, RELATION_SHAPES, currentOntologyRelease, normalizeList } from "./schema.js";
import {
  createClaim,
  createConcept,
  createContextBundle,
  createDemo,
  createExperiment,
  createHypothesis,
  createProcedure,
  createQuestion,
  defaultVaultPath,
  getHead,
  getRevision,
  loadStore,
  makeDecision,
  registerEvidence,
  resolveRef,
  reviseKnowledge,
  saveStore,
  statusReport,
  validateStore,
  addRelation,
  type RegisterEvidenceCommandV1,
} from "./vault.js";

type Writer = { write(value: string): unknown };

export type CliIo = {
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  /** Environment for vault resolution; defaults to process.env at the entry point. */
  env?: Record<string, string | undefined>;
};

type Command = (options: CommandOptions, io: CliIo) => Promise<void> | void;

const COMMANDS = new Map<string, Command>([
  ["init", initCommand],
  ["doctor", doctorCommand],
  ["status", statusCommand],
  ["ontology", ontologyCommand],
  ["concept", conceptCommand],
  ["claim", claimCommand],
  ["question", questionCommand],
  ["hypothesis", hypothesisCommand],
  ["experiment", experimentCommand],
  ["procedure", procedureCommand],
  ["evidence", evidenceCommand],
  ["decision", decisionCommand],
  ["relate", relateCommand],
  ["revise", reviseCommand],
  ["context", contextCommand],
  ["find", findCommand],
  ["show", showCommand],
  ["history", historyCommand],
  ["audit", auditCommand],
  ["demo", demoCommand],
  ["help", helpCommand],
]);

export async function runCli(argv: string[], io: CliIo): Promise<void> {
  const commandName = argv[0] ?? "help";
  const command = COMMANDS.get(commandName);
  if (!command) throw new Error(`Unknown command: ${commandName}\nRun negura help.`);
  const remaining = commandName === "evidence" && argv[1] === "register" ? argv.slice(2) : argv.slice(1);
  const parsed = parseArgs(remaining);
  if (parsed.help) return helpCommand({}, io);
  await command(parsed, io);
}

async function initCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const vault = getVaultPath(options, io);
  const store = await loadStore(vault);
  await saveStore(vault, store);
  writeJson(io, { ok: true, vault, schema: store.schema, ontology: store.ontology });
}

async function doctorCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const vault = getVaultPath(options, io);
  const store = await loadStore(vault);
  const validation = validateStore(store);
  writeJson(io, {
    ok: validation.ok,
    vault,
    validation,
    report: validation.ok ? statusReport(store) : null,
  });
  if (!validation.ok) process.exitCode = 1;
}

async function statusCommand(options: CommandOptions, io: CliIo): Promise<void> {
  writeJson(io, statusReport(await loadStore(getVaultPath(options, io))));
}

function ontologyCommand(_options: CommandOptions, io: CliIo): void {
  writeJson(io, {
    release: currentOntologyRelease(),
    objectShapes: OBJECT_SHAPES,
    relationShapes: RELATION_SHAPES,
  });
}

async function conceptCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createConcept(store, {
      title: required(options.title, "title"),
      statement: required(options.statement, "statement"),
      aliases: normalizeList(options.alias),
      sensitivity: sensitivity(options.sensitivity),
    }),
  );
}

async function claimCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createClaim(store, {
      title: required(options.title, "title"),
      statement: required(options.statement, "statement"),
      concept: optionalString(options.concept),
    }),
  );
}

async function questionCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createQuestion(store, {
      title: required(options.title, "title"),
      question: required(options.question, "question"),
      closureRule: required(options["closure-rule"], "closure-rule"),
      evidenceRequirements: normalizeList(options["evidence-requirement"]),
      concept: optionalString(options.concept),
    }),
  );
}

async function hypothesisCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createHypothesis(store, {
      title: required(options.title, "title"),
      claim: required(options.claim, "claim"),
      question: required(options.question, "question"),
      closesWhen: required(options["closes-when"], "closes-when"),
    }),
  );
}

async function experimentCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createExperiment(store, {
      title: required(options.title, "title"),
      question: required(options.question, "question"),
      hypotheses: normalizeList(options.hypothesis),
      successCriteria: normalizeList(options.success),
      failureCriteria: normalizeList(options.failure),
      evidenceRequirements: normalizeList(options["evidence-requirement"]),
      procedure: options.procedure ? resolveRef(store, String(options.procedure)) : undefined,
    }),
  );
}

async function procedureCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    createProcedure(store, {
      title: required(options.title, "title"),
      purpose: required(options.purpose, "purpose"),
      inputs: normalizeList(options.input),
      outputs: normalizeList(options.output),
      preconditions: normalizeList(options.precondition),
      postconditions: normalizeList(options.postcondition),
      invariants: normalizeList(options.invariant),
      verification: normalizeList(options.verification),
      implementations: implementationRefs(options),
    }),
  );
}

async function evidenceCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const inputPath = required(options.input, "input");
  const command = JSON.parse(await readFile(inputPath, "utf8")) as RegisterEvidenceCommandV1;
  await mutate(options, io, (store) => registerEvidence(store, command));
}

async function decisionCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const hypothesisStatus = optionalString(options["hypothesis-status"]);
  if (
    hypothesisStatus &&
    !["confirmed", "refuted", "inconclusive"].includes(hypothesisStatus)
  ) {
    throw new Error("--hypothesis-status must be confirmed, refuted, or inconclusive");
  }
  await mutate(options, io, (store) =>
    makeDecision(store, {
      title: required(options.title, "title"),
      question: required(options.question, "question"),
      evidence: normalizeList(options.evidence),
      outcome: required(options.outcome, "outcome"),
      rationale: required(options.rationale, "rationale"),
      hypothesis: optionalString(options.hypothesis),
      hypothesisStatus: hypothesisStatus as "confirmed" | "refuted" | "inconclusive" | undefined,
      revises: optionalString(options.revises),
    }),
  );
}

async function relateCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) =>
    addRelation(
      store,
      required(options.type, "type") as RelationType,
      resolveRef(store, required(options.from, "from")),
      resolveRef(store, required(options.to, "to")),
    ),
  );
}

async function reviseCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const attributes = options.attributes
    ? (JSON.parse(String(options.attributes)) as Record<string, never>)
    : undefined;
  await mutate(options, io, (store) =>
    reviseKnowledge(store, required(options.id, "id"), {
      title: optionalString(options.title),
      status: optionalString(options.status),
      sensitivity: sensitivity(options.sensitivity),
      attributes,
      observedAt: optionalString(options["observed-at"]),
      validFrom: optionalString(options["valid-from"]),
      validTo: optionalString(options["valid-to"]),
    }),
  );
}

async function contextCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) => {
    const asOf = optionalString(options["as-of"]);
    const query: ContextQueryV1 = {
      schema: "negura.context-query/v1",
      roots: normalizeList(options.root).map((id) => resolveRef(store, id, asOf)),
      purpose: required(options.purpose, "purpose"),
      ...(asOf ? { asOf } : {}),
      ...(options["token-budget"] ? { tokenBudget: Number(options["token-budget"]) } : {}),
      ...(options["max-resources"] ? { maxResources: Number(options["max-resources"]) } : {}),
      ...(options.sensitivity
        ? { allowedSensitivities: normalizeList(options.sensitivity) as Array<"public" | "internal" | "restricted"> }
        : {}),
    };
    return createContextBundle(store, query);
  });
}

async function findCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const store = await loadStore(getVaultPath(options, io));
  const kind = required(options.kind, "kind");
  const title = required(options.title, "title");
  const includeInactive = options["include-inactive"] === true;
  const inactive = new Set(["superseded", "closed", "refuted"]);
  for (const ref of Object.values(store.heads)) {
    if (ref.type !== kind) continue;
    const revision = getRevision(store, ref);
    if (revision.title !== title) continue;
    if (!includeInactive && inactive.has(revision.status)) continue;
    writeJson(io, { found: true, revision });
    return;
  }
  writeJson(io, { found: false, kind, title });
}

async function showCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const store = await loadStore(getVaultPath(options, io));
  const id = required(options.id, "id");
  if (id.startsWith("CTX-")) {
    const bundle = store.contextBundles[id];
    if (!bundle) throw new Error(`Context bundle not found: ${id}`);
    writeJson(io, bundle);
    return;
  }
  const revision = options.version
    ? getRevision(store, {
        system: "negura",
        type: getHead(store, id).kind,
        id,
        version: String(options.version),
      })
    : getHead(store, id);
  const relations = Object.values(store.relations).filter(
    (relation) => relation.from.id === id || relation.to.id === id,
  );
  writeJson(io, { revision, relations });
}

async function historyCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const store = await loadStore(getVaultPath(options, io));
  const id = required(options.id, "id");
  const revisions = Object.values(store.revisions)
    .filter((revision) => revision.id === id)
    .sort((left, right) => Number(left.version) - Number(right.version));
  if (revisions.length === 0) throw new Error(`Knowledge object not found: ${id}`);
  writeJson(io, { id, revisions });
}

async function auditCommand(options: CommandOptions, io: CliIo): Promise<void> {
  const store = await loadStore(getVaultPath(options, io));
  const limit = Number(options.limit ?? 20);
  writeJson(io, { events: store.audit.slice(-limit) });
}

async function demoCommand(options: CommandOptions, io: CliIo): Promise<void> {
  await mutate(options, io, (store) => {
    const created = createDemo(store);
    return {
      created: Object.fromEntries(
        Object.entries(created).map(([key, value]) => [key, value.id]),
      ),
    };
  });
}

function helpCommand(_options: CommandOptions, io: CliIo): void {
  io.stdout.write(`${basename(process.argv[1] ?? "negura")} commands:

  init | doctor | status | ontology | audit [--limit 20]
  concept --title <text> --statement <text> [--alias <text> ...]
  claim --title <text> --statement <text> [--concept <CON-id>]
  question --title <text> --question <text> --closure-rule <text> [--concept <CON-id>]
  hypothesis --title <text> --claim <CLM-id> --question <QST-id> --closes-when <text>
  experiment --title <text> --question <QST-id> --hypothesis <HYP-id> --success <text>
  procedure --title <text> --purpose <text> [--implementation-uri <uri> --implementation-version <version>]
  evidence register --input <negura.register-evidence/v1.json>
  decision --title <text> --question <QST-id> --evidence <EVD-id> --outcome <text> --rationale <text>
  relate --type <relation> --from <id> --to <id>
  revise --id <id> [--status <status>] [--attributes <json>]
  context --root <id> --purpose <text> [--as-of <iso>] [--token-budget 4000]
  find --kind <kind> --title <exact title> [--include-inactive]
  show --id <id> [--version <n>] | history --id <id>
  demo

Global:
  --vault <path>  Use a specific Negura JSON vault. Resolution order:
                  --vault, then $NEGURA_VAULT, then <cwd>/vault/store.json.
`);
}

async function mutate(
  options: CommandOptions,
  io: CliIo,
  fn: (store: Awaited<ReturnType<typeof loadStore>>) => unknown,
): Promise<void> {
  const vault = getVaultPath(options, io);
  const store = await loadStore(vault);
  const result = fn(store);
  const validation = validateStore(store);
  if (!validation.ok) throw new Error(`Store validation failed: ${validation.errors.join("; ")}`);
  await saveStore(vault, store);
  writeJson(io, { ok: true, result, validation });
}

function parseArgs(argv: string[]): CommandOptions {
  const options: CommandOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "help") {
      options.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    const current = options[key];
    options[key] = current == null
      ? next
      : Array.isArray(current)
        ? [...current, next]
        : [String(current), next];
  }
  return options;
}

function implementationRefs(options: CommandOptions): ResourceRefV1[] {
  const uris = normalizeList(options["implementation-uri"]);
  if (uris.length === 0) return [];
  const version = required(options["implementation-version"], "implementation-version");
  const digest = optionalString(options["implementation-digest"]);
  return uris.map((uri) => ({
    system: uri.startsWith("https://github.com/") ? "github" : "artifact",
    type: "procedure_artifact",
    id: uri,
    uri,
    version,
    ...(digest ? { digest: digest as `sha256:${string}` } : {}),
  }));
}

function sensitivity(value: unknown): "public" | "internal" | "restricted" | undefined {
  if (value == null) return undefined;
  const parsed = String(value);
  if (!["public", "internal", "restricted"].includes(parsed)) {
    throw new Error("sensitivity must be public, internal, or restricted");
  }
  return parsed as "public" | "internal" | "restricted";
}

/** Vault resolution order: --vault flag, then $NEGURA_VAULT, then <cwd>/vault/store.json. */
function getVaultPath(options: CommandOptions, io: CliIo): string {
  if (typeof options.vault === "string") return options.vault;
  const fromEnv = (io.env ?? process.env).NEGURA_VAULT;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return defaultVaultPath(io.cwd);
}

function required(value: unknown, name: string): string {
  if (value == null || value === "") throw new Error(`Missing required option --${name}`);
  return String(value);
}

function optionalString(value: unknown): string | undefined {
  return value == null || value === "" ? undefined : String(value);
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
