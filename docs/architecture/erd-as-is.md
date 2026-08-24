# ERD — AS-IS (Current Schema)

> Entity-relationship diagram of the schema as it exists today, rendered from [G0.01's database survey](./survey/database-schema.md) (sources: `db/knex_init_db.js` + all files under `db/knex_migrations/`). This is descriptive only; the target design is in [`erd-to-be.md`](./erd-to-be.md).
>
> Attributes shown are the primary key, foreign keys, uniqueness constraints, and scoping columns. Full column lists live in the survey; they are omitted here for legibility.

## Diagram

```mermaid
erDiagram
    USER {
        int id PK
        varchar username UK "collate utf8_general_ci"
        varchar password "bcrypt hash, nullable"
        boolean active
        varchar twofa_secret "TOTP secret, nullable"
        boolean twofa_status
    }

    MONITOR {
        int id PK
        int_unsigned user_id FK "ON DELETE SET NULL"
        varchar type "http, ping, push, ... 26 kinds"
        boolean active
        int interval "seconds, default 20"
        int_unsigned parent FK "self-ref, ON DELETE SET NULL"
        int_unsigned docker_host FK
        int_unsigned proxy_id FK
        int_unsigned remote_browser FK "indexed"
        varchar push_token UK-ish "lookup key for public push API"
    }

    HEARTBEAT {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        smallint status "0 DOWN, 1 UP, 2 PENDING, 3 MAINTENANCE"
        datetime time
        bigint ping
        boolean important "indexed; partial index on SQLite"
        text response "brotli-compressed payload"
    }

    GROUP {
        int id PK
        varchar name
        int_unsigned status_page_id "logical ref, no FK declared"
        boolean public
        int weight
    }

    MONITOR_GROUP {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int_unsigned group_id FK "ON DELETE CASCADE"
        boolean send_url
        text custom_url
    }

    TAG {
        int id PK
        varchar name
        varchar color
    }

    MONITOR_TAG {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int_unsigned tag_id FK "ON DELETE CASCADE"
        text value
    }

    MONITOR_TLS_INFO {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        longtext info_json
    }

    NOTIFICATION {
        int id PK
        int_unsigned user_id "no FK declared"
        boolean is_default
        longtext config "provider config JSON blob"
    }

    MONITOR_NOTIFICATION {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int_unsigned notification_id FK "ON DELETE CASCADE"
    }

    NOTIFICATION_SENT_HISTORY {
        int id PK
        varchar type "part of UNIQUE(type, monitor_id, days)"
        int_unsigned monitor_id "no FK declared"
        int days "part of UNIQUE(type, monitor_id, days)"
    }

    STATUS_PAGE {
        int id PK
        varchar slug UK "collate utf8_general_ci"
        varchar title
        boolean published
        varchar analytics_id "renamed from google_analytics_tag_id"
        boolean show_only_last_heartbeat
    }

    STATUS_PAGE_CNAME {
        int id PK
        int_unsigned status_page_id FK "ON DELETE CASCADE"
        varchar domain UK "collate utf8_general_ci"
    }

    INCIDENT {
        int id PK
        varchar title
        text content
        int_unsigned status_page_id "logical ref, no FK declared"
        boolean pin
        boolean active
    }

    MAINTENANCE {
        int id PK
        int_unsigned user_id FK "ON DELETE SET NULL"
        varchar strategy "single, cron, recurring-interval, ..."
        boolean active "indexed"
        text cron
        varchar timezone
    }

    MONITOR_MAINTENANCE {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int_unsigned maintenance_id FK "ON DELETE CASCADE"
    }

    MAINTENANCE_STATUS_PAGE {
        int id PK
        int_unsigned status_page_id FK "ON DELETE CASCADE"
        int_unsigned maintenance_id FK "ON DELETE CASCADE"
    }

    API_KEY {
        int id PK
        varchar key
        int_unsigned user_id FK "ON DELETE CASCADE"
        boolean active
        datetime expires
    }

    PROXY {
        int id PK
        int_unsigned user_id "no FK declared"
        varchar protocol
        varchar host
        integer port "widened from smallint by 2025-03-25"
        boolean default
    }

    DOCKER_HOST {
        int id PK
        int_unsigned user_id "no FK declared"
        varchar docker_daemon
        varchar docker_type
        varchar name
    }

    REMOTE_BROWSER {
        int id PK
        varchar name
        varchar url
        int_unsigned user_id "no FK declared"
    }

    STAT_MINUTELY {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int timestamp "UNIQUE(monitor_id, timestamp)"
        float ping
        smallint up
        smallint down
    }

    STAT_HOURLY {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int timestamp "UNIQUE(monitor_id, timestamp)"
        float ping
        smallint up
        smallint down
    }

    STAT_DAILY {
        int id PK
        int_unsigned monitor_id FK "ON DELETE CASCADE"
        int timestamp "UNIQUE(monitor_id, timestamp); up/down widened to integer unsigned by 2026-07-22"
        float ping
        integer_unsigned up
        integer_unsigned down
    }

    DOMAIN_EXPIRY {
        int id PK
        varchar domain UK "global cache keyed by domain string"
        datetime last_check
        datetime expiry
    }

    SETTING {
        int id PK
        varchar key UK "collate utf8_general_ci"
        text value
        varchar type
    }

    MAINTENANCE_TIMESLOT {
        int id PK
        int_unsigned maintenance_id FK "created then DROPPED during init (knex_init_db.js drops it)"
        datetime start_date
        datetime end_date
        boolean generated_next
    }

    USER ||--o{ MONITOR : "owns (user_id, SET NULL)"
    USER ||--o{ API_KEY : "owns (CASCADE)"
    USER |o--o{ MAINTENANCE : "owns (SET NULL)"
    USER |o--o{ NOTIFICATION : "user_id, no FK declared"
    USER |o--o{ PROXY : "user_id, no FK declared"
    USER |o--o{ DOCKER_HOST : "user_id, no FK declared"
    USER |o--o{ REMOTE_BROWSER : "user_id, no FK declared"

    MONITOR ||--o{ HEARTBEAT : "beats (CASCADE)"
    MONITOR ||--o{ STAT_MINUTELY : "aggregates (CASCADE)"
    MONITOR ||--o{ STAT_HOURLY : "aggregates (CASCADE)"
    MONITOR ||--o{ STAT_DAILY : "aggregates (CASCADE)"
    MONITOR ||--o{ MONITOR_TAG : "tagged (CASCADE)"
    MONITOR ||--o{ MONITOR_NOTIFICATION : "notifies (CASCADE)"
    MONITOR ||--o{ MONITOR_MAINTENANCE : "undergoes (CASCADE)"
    MONITOR ||--o{ MONITOR_TLS_INFO : "cert info (CASCADE)"
    MONITOR |o--o{ MONITOR_GROUP : "member of groups (CASCADE)"
    MONITOR |o--o| MONITOR : "parent (self-ref, SET NULL)"
    MONITOR |o--o| DOCKER_HOST : "docker_host FK"
    MONITOR |o--o| PROXY : "proxy_id FK"
    MONITOR |o--o| REMOTE_BROWSER : "remote_browser FK"
    MONITOR ||--o{ NOTIFICATION_SENT_HISTORY : "dedupe history, no FK declared"

    TAG ||--o{ MONITOR_TAG : "applied via"

    GROUP ||--o{ MONITOR_GROUP : "contains (CASCADE)"

    STATUS_PAGE |o--o{ GROUP : "status_page_id, no FK declared"
    STATUS_PAGE |o--o{ INCIDENT : "status_page_id, no FK declared"
    STATUS_PAGE ||--o{ STATUS_PAGE_CNAME : "custom domains (CASCADE)"
    STATUS_PAGE ||--o{ MAINTENANCE_STATUS_PAGE : "shows maintenance (CASCADE)"

    MAINTENANCE ||--o{ MONITOR_MAINTENANCE : "covers monitors (CASCADE)"
    MAINTENANCE ||--o{ MAINTENANCE_STATUS_PAGE : "shown on pages (CASCADE)"
```

## Isolation seams today (why multi-tenancy needs more than `user_id`)

| Seam | Tables | Observation |
| --- | --- | --- |
| Direct owner column (`user_id`) | `monitor`, `api_key`, `docker_host`, `proxy`, `notification`, `maintenance`, `remote_browser` | Single-owner model; one row has exactly one user. Only `monitor.user_id`, `maintenance.user_id`, `api_key.user_id` declare real FK constraints. |
| Indirect via parent FK | `heartbeat`, `stat_minutely`, `stat_hourly`, `stat_daily`, `monitor_tls_info`, `notification_sent_history` | No owner column at all; reached through `monitor_id`. Any tenant model must traverse `monitor`. |
| Junction tables | `monitor_group`, `monitor_tag`, `monitor_notification`, `monitor_maintenance`, `maintenance_status_page` | Pair two parents; inherit visibility from them. |
| Page-scoped, no owner | `status_page`, `group`, `incident`, `status_page_cname` | `status_page` has **no owner column**; `group.status_page_id` and `incident.status_page_id` are logical references without declared FKs. |
| Instance-global | `user`, `setting`, `domain_expiry` | Shared across the whole installation today. |

Key structural facts carried into the TO-BE design:

1. `heartbeat` and the three `stat_*` tables are the write-hot family — any extra column/index there costs write amplification on every beat ([survey §heartbeat](./survey/database-schema.md#heartbeat)).
2. SQLite-only partial indexes exist on `heartbeat` (`WHERE important = 1`, migration `2025-12-22-0121`) — MariaDB cannot express these ([ADR-0001](../adr/ADR-0001-database-choice.md)).
3. Several logical references have **no declared FK** (`group.status_page_id`, `incident.status_page_id`, `notification.user_id`, `proxy.user_id`, `docker_host.user_id`, `remote_browser.user_id`, `notification_sent_history.monitor_id`, `docker_host`/`monitor` links lack actions) — referential integrity currently depends on application code.
4. `maintenance_timeslot` is created and immediately dropped during init; it does not exist at runtime and is diagrammed only for completeness.

## Reproduce / verify

```bash
grep -qE '```mermaid' docs/architecture/erd-as-is.md   # mermaid block present
grep -c '^    [A-Z_]* {' docs/architecture/erd-as-is.md # entity count (27 expected)
```
