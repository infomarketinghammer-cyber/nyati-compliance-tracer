# Compliance Tracker & Calendar — Project Package

## Live app
The working app is published as a Claude Artifact (with a live shared database for
status tracking, audit log and project data):
https://claude.ai/artifact/QJG73dMNVZRhJsNZWMJWN6

The files in `app/` are the exact source for that artifact. Opening `index.html`
directly in a browser (double-click) will render the UI and load items.json/stages.json,
but status changes won't persist anywhere — that only works through the published
Claude Artifact link above, which provides the `db` capability.

## Contents

- `app/index.html` — the full single-page application (dashboard, stage view,
  calendar, master register, projects, data quality, item detail drawer).
- `app/items.json` — all 306 compliance items from the company's master sheet,
  reconciled, with source values preserved alongside normalized fields and a
  draft stage assignment.
- `app/stages.json` — the 8 draft stages (derived from the Sanctioning sequence,
  labelled "Proposed — needs compliance head approval") plus "Unmapped to Stage".

- `data-prep/build_data.py` — reads the master Excel file, recomputes Sr No and
  Compliance ID per department (the sheet's own formula is broken by a `=#REF!+1`
  chain from row 19 onward), and reconciles counts.
- `data-prep/normalize.py` — normalizes Frequency and Authority text into
  consistent categories (keeping the original text alongside), and parses Due
  Date text into concrete dates where safely possible; everything else is
  flagged rather than guessed.
- `data-prep/stage_map.py` — applies the draft stage mapping to the Sanctioning
  department's 70 items; all other 236 items are left "Unmapped to Stage" since
  the source sheet has no stage/order signal for them.
- `data-prep/items_raw.json`, `items_normalized.json`, `items_final.json` —
  intermediate outputs of each step above, in order.

## Re-running the data prep

If the company sends an updated master sheet, update the `path` variable at the
top of `build_data.py` and re-run the three scripts in order:

```
python3 build_data.py
python3 normalize.py
python3 stage_map.py
cp items_final.json ../app/items.json
```

Compare the new `items_final.json` against the old one before republishing, to
see what changed (the acceptance checks in the project — item counts by
department and type — are printed by `build_data.py`).

## Open items (see the Build Summary doc / chat for full detail)

1. Stage mapping for the 236 non-Sanctioning items still needs the compliance
   head's sign-off on a stage list.
2. Email digest reminders are not implemented (no backend scheduler here).
3. Re-import/diff of a newer master sheet is a manual script re-run, not a
   one-click in-app import.
4. Roles in the app are a UI-level toggle, not real per-person authentication.
