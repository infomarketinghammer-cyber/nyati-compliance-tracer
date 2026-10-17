# Compliance Tracker & Calendar — Nyati

A Node/Express server that serves the single-page app in `app/` and stores all
tracking data in MongoDB Atlas. Users sign in with email and password; roles are
enforced on the server.

## Run locally

```
cd server
npm install
copy .env.example .env     # then fill in the values (see below)
npm start                  # http://localhost:8000
```

Required `.env` values: `MONGODB_URI`, and for the first run `ADMIN_EMAIL` +
`ADMIN_PASSWORD` (creates the first admin when there are no users) and
`SESSION_SECRET`. Remove `ADMIN_PASSWORD` once you have signed in; sign in, then
change the password from the **Password** button in the top bar.

In Atlas, add your IP address under **Network Access**, otherwise the server cannot
connect (the error looks like a TLS / "internal error" failure).

## Roles (enforced by the server)

| Role | Update status / projects | Change item stage | Manage users |
|---|---|---|---|
| Admin | yes | yes | yes |
| Compliance Head, Owner, Approver | yes | no | no |
| Read-only | no | no | no |

Admins add users, change roles, disable accounts and reset passwords on the
**Users** tab. Who made each change is recorded by the server from the signed-in
user, not from anything the browser sends.

## Deploy

Any host that runs Node or Docker works (Render, Railway, Fly.io, Azure, a VPS).
A `Dockerfile` is included at the repo root.

1. Create the service from this repo (Docker, or Node with root `server/`, build
   `npm ci --omit=dev`, start `node server.js`).
2. Set these environment variables on the host (never commit them):
   - `NODE_ENV=production`
   - `MONGODB_URI`, `MONGODB_DB`
   - `SESSION_SECRET` — 32+ random characters
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — for the first start only
   - `TRUST_PROXY=1`
3. In Atlas **Network Access**, allow the host's outbound IP (or `0.0.0.0/0` with a
   strong database password if the host has no fixed IP). Use a database user that
   only has access to this one database.
4. Use the host's HTTPS URL. Cookies are marked secure in production, so sign-in
   only works over HTTPS.
5. Health check path: `/healthz`.
6. Turn on Atlas backups.

## Contents

- `app/index.html` — the single-page app (dashboard, stages, calendar, register,
  projects, data quality, users, item detail drawer).
- `app/login.html` — sign-in page.
- `app/items.json` — all 306 compliance items from the master sheet, with
  normalized fields and a draft stage assignment.
- `app/stages.json` — the 8 draft stages ("Proposed — needs compliance head
  approval") plus "Unmapped to Stage".
- `server/server.js` — API, authentication, role checks, static hosting.
- `data-prep/` — scripts that build `items.json` from the master Excel file.

## Re-running the data prep

If the company sends an updated master sheet, update the `path` variable at the
top of `build_data.py` and re-run the three scripts in order:

```
python3 build_data.py
python3 normalize.py
python3 stage_map.py
cp items_final.json ../app/items.json
```

Compare the new `items_final.json` against the old one before redeploying (the
acceptance checks — item counts by department and type — are printed by
`build_data.py`).

## Open items

1. Stage mapping for the 236 non-Sanctioning items needs the compliance head's
   sign-off on a stage list.
2. Email digest reminders are not implemented (no scheduler).
3. Re-import/diff of a newer master sheet is a manual script re-run.
4. Compliance Head, Owner and Approver currently have identical permissions.
