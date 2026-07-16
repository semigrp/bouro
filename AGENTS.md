# AGENTS.md

Operating notes for AI agents (and humans) working with Negura. Everything here is derivable from
this repository — no private context is required to reach the operational level described.

## What Negura is, in one paragraph

Negura is the local-first knowledge graph and epistemic ledger of a three-tool loop: an outbound
execution engine ([Ouro](https://github.com/semigrp/ouro)) runs pinned work, Negura owns durable
meaning (Concept / Claim / Question / Hypothesis / Evidence / Decision), and
[Fukuro](https://github.com/semigrp/fukuro) owns telemetry and baselines. Negura never executes
work and never aggregates metrics. See README's system-boundary table.

## Setup to operational level

```bash
git clone https://github.com/semigrp/negura && cd negura
pnpm install
pnpm test                      # all tests must pass before you rely on the CLI
npm link                       # puts `negura` on PATH

# one personal vault, reachable from anywhere (resolution: --vault > $NEGURA_VAULT > ./vault/store.json)
export NEGURA_VAULT="$HOME/path/of/your/choice/store.json"   # add to your shell profile
negura init
negura doctor                   # must print ok: true, errors: []
```

First-run knowledge scaffold (once per vault): create a root Concept for your agent's operating
principles, so later distillation has a home.

```bash
negura concept --title "operating principles" \
  --statement "Cross-cutting principles this agent repeatedly uses to justify decisions." \
  --alias "agent operating principles"
```

Optional integrations:

- **Ouro**: set `NEGURA_BIN=$(which negura)` so Ouro runs can query context and deliver Evidence.
- **Fukuro**: after registering a unit, `fukuro log-event concept_captured --data '{"negura_id":"CLM-n"}'`
  keeps the measurement side aware of distillation activity. Meaning lives here; counts live there.

## Conventions an agent must follow

1. **One source of truth per unit.** Before creating a Claim or Question, list existing ones and
   check for an equivalent (see `skills/distill.md` for a ready-made listing snippet). If an
   equivalent exists, update its statement (e.g. increment an occurrence note) instead of creating
   a duplicate.
2. **History is append-only; meaning changes by supersession.** When a principle evolves:
   register the new Claim, `negura relate --type revises --from CLM-new --to CLM-old`, then
   `negura revise --id CLM-old --status superseded`. Never rewrite an asserted statement into a
   different meaning.
3. **Questions carry their own exit.** A Question without a concrete closure rule ("closes when X
   happens") is not ready to register.
4. **Distillation is a judgment, not a hook.** Extracting Claims and Questions from a conversation
   is itself a decision — do it deliberately at session close (see `skills/distill.md`); never
   wire it to fire automatically on tool events.
5. **Statements stand alone.** A Claim must be intelligible to a reader who was not in the
   conversation it came from.
6. **Zero is a valid harvest.** Most sessions yield 0–3 units. Do not manufacture knowledge.

## What must never enter the vault

- Secrets, credentials, tokens.
- Personal data of third parties (names, reservation codes, contact details).
- Anything you would not want on the machine unencrypted — the vault is plaintext JSON.

The default vault path is gitignored, but treat the vault as local, private state: never commit or
publish it, and keep employer-confidential material out of anything you push from this repository.

## CLI cheat sheet

```bash
negura doctor | status | audit --limit 20
negura claim --title "..." --statement "..." --concept CON-n
negura question --title "..." --question "..." --closure-rule "..." --concept CON-n
negura relate --type revises --from CLM-new --to CLM-old
negura revise --id QST-n --status closed
negura context --root CON-n --purpose "..."         # version-pinned bundle for downstream use
negura show --id CLM-n | history --id CLM-n
```

Run `negura doctor` after any batch of writes; it must stay `ok: true`.
