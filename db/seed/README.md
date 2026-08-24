# Multi-tenant Demo Seed (G1.07)

One-command developer seed that creates **three demo tenants** — Acme (slug `acme`), XYZ (slug `xyz`), 123 (slug `123-org`) — with a small but realistic data set, so multi-tenant UX can be exercised without manual SQL.

## Usage

```bash
npm run seed:tenant-demo
```

This is a manual developer tool. It is **not** invoked by the app at runtime and never runs automatically on boot or in CI.

## Safety guard (non-production)

The seed refuses to run unless the environment explicitly signals dev/demo:

- `NODE_ENV=development`, **or**
- `UPTIME_KUMA_DEMO_SEED=1`

On refusal it prints:

```
Refusing to run outside dev/demo. Set UPTIME_KUMA_DEMO_SEED=1 to override.
```

and exits non-zero **before opening any database connection** — zero DB writes, never prompts. Seeding a populated production database is blocked by this guard.

## Environment variables

| Variable                  | Effect                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=development`    | Allows the seed to run (guard). With `npm run dev` conventions, SQLite lands in the branch dev-data dir when on a non-master branch.  |
| `UPTIME_KUMA_DEMO_SEED=1` | Allows the seed to run (guard) even outside development mode.                                                                        |
| `UPTIME_KUMA_DEMO_SEED_DB`| Optional path to an isolated SQLite file (e.g. `./data/demo-seed-test.db`). When set, the seed targets that file instead of the normal `<data-dir>/kuma.db`. SQLite only — if that directory's `db-config.json` declares another DB type, the runner exits before connecting. |

Without `UPTIME_KUMA_DEMO_SEED_DB`, the seed uses the normal data dir resolution of `server/database.js` (`DATA_DIR` env → branch dev-data dir in dev mode → `./data/`) and whatever database type is configured there, including MariaDB.

## What gets created (per tenant)

- 1 `tenant` row (`plan=free`, `status=active`)
- 1 `tenant_user` row attaching the instance admin as `tenant_admin`
- 2 `monitor` rows: one HTTP (`https://example.com`) and one TCP (`example.com:443`)
- 1 webhook-type `notification`
- 2 `tag` rows
- 2 `monitor_tag` links (tag 1 → HTTP monitor, tag 2 → TCP monitor; note `monitor_tag` has no `tenant_id` column — tenancy flows through monitor/tag)

Every tenant-scoped row has `tenant_id` set. The admin user must already exist: if the `user` table is empty, the seed exits with a message telling you to run the setup wizard first (start the server once and create the admin account).

## Idempotency & reset

Re-running the seed is a no-op: every insert looks up its unique key first (tenant slug, per-tenant names, `(monitor_id, tag_id)` link, ...) and logs `` `acme` already exists; skipping ``-style lines instead of duplicating rows.

To start over from scratch:

```bash
rm -f ./data/kuma.db            # default SQLite location
# MariaDB: DROP DATABASE <database>; then re-run migrations via a fresh install
```
