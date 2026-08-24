# Migration Contract — What Phase G1 Must Deliver

> This is a **contract, not SQL**. Phase G1 implements against it verbatim; deviation requires a new ADR ([task G0.03 interfaces](../kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-03.md)). Inputs: [ADR-0001](../adr/ADR-0001-database-choice.md), [ADR-0002](../adr/ADR-0002-isolation-model.md), the [schema survey](./survey/database-schema.md), and the [plan's G1 section](../plans/multi_tenant_uptime_kuma_plan.md).

## Clause A — New tables

Three tables, created by one migration (`db/knex_migrations/2026-08-23-0000-create-tenant-tables.js` per kanban task G1.04). Column lists are **frozen** — implement exactly this; do not invent columns.

### `tenant`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | integer AI PK | required by Knex rules |
| `name` | string NOT NULL | display name |
| `slug` | string NOT NULL | **unique**, URL-safe routing id (G2/G6 consume) |
| `plan` | string, default `'free'` | billing placeholder; G8 owns real plans |
| `status` | string, default `'active'` | supports `active \| suspended \| deleted` |
| `custom_domain` | string, nullable | populated in G6; non-unique index for routing lookup |
| `created_at` | datetime, default now() | |
| `updated_at` | datetime, default now() | |

### `tenant_user` (N-N membership)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | integer AI PK | |
| `tenant_id` | unsigned int NOT NULL | FK → `tenant.id`, ON DELETE CASCADE, ON UPDATE CASCADE |
| `user_id` | unsigned int NOT NULL | FK → `user.id`, ON DELETE CASCADE, ON UPDATE CASCADE |
| `role` | string NOT NULL, default `'viewer'` | placeholder enum; values frozen to `super_admin/tenant_admin/member/viewer` by [ADR-0004](../adr/ADR-0004-authentication-strategy.md); refined in G3 without renaming |
| `joined_at` | datetime, default now() | |

Composite **unique** `(tenant_id, user_id)`.

### `tenant_invitation`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | integer AI PK | |
| `tenant_id` | unsigned int NOT NULL | FK → `tenant.id`, ON DELETE CASCADE |
| `email` | string NOT NULL | invitee email |
| `token` | string NOT NULL | **unique**, single-use invite token |
| `role` | string NOT NULL, default `'viewer'` | same frozen role vocabulary |
| `invited_by_user_id` | unsigned int, nullable | FK → `user.id`, ON DELETE SET NULL |
| `expires_at` | datetime NOT NULL | enforced at read time in G2, not by DB job |
| `accepted_at` | datetime, nullable | null until accepted in G2 |

Non-unique index `(tenant_id, email)` for pending-invite lists.

RedBean models `server/model/tenant.js`, `server/model/tenant_user.js` (with `static async listForUser(userId)` helper), `server/model/tenant_invitation.js` ship with the migration per kanban G1.04. The G2 `refresh_token` table is **not** part of this contract (it belongs to G2 per ADR-0004).

## Clause B — Tables gaining `tenant_id`

Exactly **ten** existing tables gain a nullable-at-migration `tenant_id` column: unsigned integer, FK → `tenant.id`, `ON DELETE CASCADE`, `ON UPDATE CASCADE`. Nullable at DDL time so the backfill (Clause D) can run on populated databases; whether to flip `NOT NULL` afterwards is G1 task-06's call, recorded in its PR.

| # | Table | Why it is business-scoped |
| --- | --- | --- |
| 1 | `monitor` | owner-scoped root entity (`user_id` today) |
| 2 | `group` | monitor grouping, page-scoped via `status_page_id` |
| 3 | `proxy` | owner-scoped (`user_id`) |
| 4 | `docker_host` | owner-scoped (`user_id`) |
| 5 | `notification` | owner-scoped (`user_id`) |
| 6 | `status_page` | public-facing root entity (no owner column today) |
| 7 | `maintenance` | owner-scoped (`user_id`) |
| 8 | `api_key` | credential scoped to owner + tenant |
| 9 | `tag` | becomes per-tenant rows ([ADR-0002](../adr/ADR-0002-isolation-model.md) Context classifies tags as business data) |
| 10 | `remote_browser` | owner-scoped (`user_id`) |

**Explicitly excluded** (no `tenant_id` column, isolation derived through anchors):

| Family | Tables | Derivation rule after G1 |
| --- | --- | --- |
| Write-hot children | `heartbeat`, `stat_minutely`, `stat_hourly`, `stat_daily` | `monitor_id IN (SELECT id FROM monitor WHERE tenant_id = ?)` — no redundant column, no extra index maintenance ([ADR-0002 Decision](../adr/ADR-0002-isolation-model.md)) |
| Monitor-anchored children | `monitor_tag`, `monitor_notification`, `monitor_tls_info`, `notification_sent_history` | same subquery pattern |
| Status-page-anchored children | `incident`, `status_page_cname` | `status_page_id IN (SELECT id FROM status_page WHERE tenant_id = ?)` |
| Parent-pair junctions | `monitor_group`, `monitor_maintenance`, `maintenance_status_page` | both parents tenant-scoped after Clause B; junctions inherit tenancy from either parent row |
| Instance-global | `user`, `setting` | documented exemptions with inline rationale + eslint directive at query sites |
| Cross-tenant cache | `domain_expiry` | global dedupe cache keyed by domain string — see Open Item C3 |
| Non-existent | `maintenance_timeslot` | dropped during init; ignore |

Tables where `user_id` exists keep it: `user_id` remains the per-user owner link, `tenant_id` the per-tenant membership link. Both are needed ([kanban G1.05](../kanban/2026-08-23_multi-tenant-uptime-kuma-plan/task-05.md)).

### Supersession record (read before implementing)

The plan's G1 section illustrates a 12-table list including `heartbeat`, `incident`, `monitor_group`, and `user`. **[ADR-0002 supersedes that illustration]**: child/junction rows are parent-anchored (no redundant column — protects write-hot tables from doubled index maintenance), and `user` is global identity with membership expressed only through `tenant_user`. Kanban phases G4/G5 repeat the ADR position in their constraint blocks. Wherever older wording conflicts with this contract, **this contract wins**; report surprises instead of improvising.

## Clause C — Required composite indexes

Created alongside Clause B's columns, explicitly named `<table>_<cols>_index` so SQLite and MariaDB agree:

| Table | Indexes |
| --- | --- |
| `monitor` | `monitor_tenant_id_id_index (tenant_id, id)`; `monitor_tenant_id_user_id_index (tenant_id, user_id)` |
| `group`, `proxy`, `docker_host`, `notification`, `status_page`, `maintenance`, `api_key`, `tag`, `remote_browser` | `(tenant_id, id)` each |
| `tenant` | unique `slug`; index `custom_domain` |
| `tenant_user` | unique `(tenant_id, user_id)` |
| `tenant_invitation` | unique `token`; index `(tenant_id, email)` |
| child family | **none added** — existing `monitor_id`/parent-leading indexes serve the anchor-subquery pattern |

Knex methods only (no raw SQL); both SQLite and MariaDB dialects must pass. Where dialects genuinely diverge (e.g., SQLite partial indexes cannot exist on MariaDB), follow the established branch pattern of migration `2025-12-22-0121` — but note **no new partial indexes are required by this contract**.

## Clause D — Default-tenant seeding

1. Insert exactly one **default tenant** row during migration backfill (name/slug e.g. `Default` / `default`; slug uniqueness applies).
2. Backfill every existing row of all ten Clause-B tables to the default tenant's id.
3. Create `tenant_user` membership for every existing user: role `tenant_admin` on the default tenant ([ADR-0004 backward compatibility](../adr/ADR-0004-authentication-strategy.md)).
4. Post-backfill behavior: an upgraded single-user install returns identical result sets under `(user_id, tenant_id = default)` queries; `/status/default` keeps working.
5. The demo seed (3 tenants: Acme, XYZ, 123) is a separate dev/staging-only script (kanban G1.07), never executed by migrations.

## Clause E — Idempotency

- Migrations must run cleanly on an **empty database** (fresh install) *and* on a **populated database** (upgrade path).
- Backfill statements must be re-runnable without duplicating rows or re-inserting the default tenant (check-before-insert or `ON CONFLICT`-equivalent via Knex).
- Running the full chain twice must be a no-op the second time (Knex's own migration ledger helps, but data backfills must not rely on it alone since they live inside single migrations).
- Fresh MariaDB installs get the baseline schema from `knex_init_db.js` plus migrations; fresh SQLite installs go straight through migrations — both paths must land on identical logical schemas.

## Clause F — Rollback without data loss

- Every `exports.down` removes only what its `exports.up` added (drop the three new tables in reverse-FK order: `tenant_invitation`, `tenant_user`, `tenant`; drop `tenant_id` columns + their composite indexes elsewhere).
- `down` must **never** delete or truncate user data that predates the migration; dropping a column loses that column's values, so any post-backfill constraint flip belongs to a separate forward migration whose `down` restores nullability rather than dropping the column.
- Migration tests must execute up → verify → down → verify on copies of a populated database and assert row counts match the original snapshot (kanban G1 task-08).
- Operators are still advised to take a backup before upgrading (documented in release notes — G12 scope).

## Open items (decided at G1 kickoff, not silently)

| # | Item | Recommendation |
| --- | --- | --- |
| C1 | Flip `tenant_id` to `NOT NULL` after backfill? | Yes for the ten business tables, as a separate forward migration with a nullability-restoring `down`; verify no code path inserts tenant-less rows first (G4 wrapper enforces injection). |
| C2 | `status_page.slug` global-unique vs per-tenant | Keep the existing global `UNIQUE(slug)` for G1 (zero-downtime compat); G6's `(tenant_id, slug)` resolution works unchanged. Relaxing to composite uniqueness would need a new ADR since public URLs collide otherwise. |
| C3 | `domain_expiry` stays global? | Yes for now — it is a dedupe cache keyed by domain string shared across tenants; revisit when G9/G8 add audit/billing dimensions. If made tenant-aware, it joins Clause B via a new ADR. |
