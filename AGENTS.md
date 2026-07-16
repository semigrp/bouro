# AGENTS.md

Operating notes for AI agents working with a subako nest (`$SUBAKO`).

## The contract you must respect

1. **Never author a type by hand.** If a meaning seems to deserve a type, check
   `subako lint` — if its verbs recur, `subako genesis` will draft the proposal. If the
   verbs don't exist yet, the type doesn't either; emit the events first.
2. **Never author instances for derived types.** `ledger`/`lifecycle` instances come from
   `subako sync`; `registry`/`none` instances come from human adjudication or external
   producers (e.g. junro). Your job is to fill in *meaning* on files that already exist,
   and to flag `裁定待ち` items to the human.
3. **Adjudication is the human's file move.** Do not move files out of
   `_schema/proposed/` yourself; surface them.
4. **Fix the stream, not the file.** If a derived value looks wrong, the event log is
   wrong — backfill it (e.g. `fukuro log-event --at`); never hand-edit derived keys.

## Session routine

- Session start: the pack (if wired as a SessionStart hook: `subako pack --hook`) is your
  standing context — treat injected stop-lines and unenforced norms as binding.
- Session end / return path: run `subako sync`, then `subako lint`; report proposals and
  prune candidates to the human.

## Setup from a fresh clone

```
node cli/subako.ts           # help
node test/smoke.mjs          # verify (synthetic event db under test/.tmp)
subako init <dir>            # hang an empty box
```

Zero dependencies; Node ≥ 24 runs the TypeScript directly. Nothing in this repository
requires private context; nests are private by construction and live elsewhere.
