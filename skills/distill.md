# skill: distill — turn conversations into vault knowledge

A portable, harness-agnostic regime for extracting epistemic units from an AI-agent session and
registering them in a Negura vault. Copy this file into your harness's skill directory (or
equivalent) and adapt the trigger wording; the procedure itself has no harness dependencies.

## When to fire

1. At session close (when you write your session summary or daily notes), ask once: *did this
   session state a new principle, apply one, or leave an operational question unresolved?*
2. Mid-session, when the human states something principle-shaped ("always do X", "as a rule…"),
   note it as a candidate and register at close.
3. On explicit request.

Never fire automatically from tool events: extraction is a judgment, and automated firing
produces noise. (The measurement sibling documents the same rule as "what not to hook".)

## What qualifies

| Conversation content | Unit | Register? |
|---|---|---|
| A principle reusable beyond this session's context | **Claim** | yes, under your operating-principles Concept |
| An unresolved operational question with a statable exit | **Question** | yes — `--closure-rule` is mandatory |
| A one-off decision plus its rationale | Decision | not standalone — if it applied an existing Claim, update that Claim's occurrence note; if it implies a new principle, evaluate that as a Claim |
| Domain/product questions | — | no — they belong to your project tracker, not the principles vault |
| References and raw traces | Evidence | keep the pointer in the Claim's statement for now; formal `evidence register` wiring is optional |

## Procedure

1. **Extract** candidates, each compressed to one self-contained sentence (keep the original's
   key words).
2. **Dedup** against the live vault (one source of truth per unit):

   ```bash
   python3 - <<'PY' | grep -i "<keyword>"
   import json, os
   s = json.load(open(os.environ["NEGURA_VAULT"]))
   for hid, ref in s["heads"].items():
       if ref.get("type") in ("claim", "question"):
           rev = s["revisions"].get(f'{hid}@{ref.get("version", "1")}', {})
           if rev.get("status") not in ("superseded", "closed"):
               print(hid, "|", rev.get("title", ""), "|", str(rev.get("attributes", {}).get("statement", ""))[:70])
   PY
   ```

3. **Equivalent exists** → do not create; update the existing statement's occurrence note:
   `negura revise --id CLM-n --attributes '{"statement":"<same principle, occurrence count and source appended>"}'`
4. **Principle evolved** → new Claim → `negura relate --type revises --from CLM-new --to CLM-old`
   → `negura revise --id CLM-old --status superseded`.
5. **New** →

   ```bash
   negura claim --title "<short name>" \
     --statement "<one sentence; append occurrence count and session/source pointer>" \
     --concept <your operating-principles CON-id>
   negura question --title "<name>" --question "<one sentence>" \
     --closure-rule "<what closes it>" --concept <CON-id>
   ```

6. **Measure** (if Fukuro is installed): `fukuro log-event concept_captured --data '{"negura_id":"CLM-n","title":"..."}'`
7. **Close Questions** when their closure rule fires: `negura revise --id QST-n --status closed`.
8. **Verify**: `negura doctor` must stay `ok: true, errors: []`.

## Quality bar

- 0–3 units per session is normal; zero is a valid harvest.
- A Claim must survive out of context; a Question must carry its own exit.
- No secrets, no third-party personal data, nothing you would not keep in plaintext on this
  machine.
