# Database Schema Survey (AS-IS)

> Survey of the current database schema, produced by static analysis of `db/knex_init_db.js` and every file under `db/knex_migrations/`. No runtime probing was performed. This document is descriptive only — it records what exists today and does not propose any change.

## Sources

| Source | Role |
| --- | --- |
| `db/knex_init_db.js` | Creates the base schema used for MariaDB/MySQL installs (called "Converted Patch" section included). Header comment: "DO NOT ADD ANYTHING HERE! IF YOU NEED TO ADD FIELDS, ADD IT TO ./db/knex_migrations" (`db/knex_init_db.js:4-8`). |
| `db/knex_migrations/*.js` | 58 migration files (2023-08 → 2026-08) that create tables and alter columns/indexes. |

Note on dialects: SQLite installs are built from the same Knex definitions via `redbean-node`/Knex schema builder; some migrations (e.g. `2025-12-22-0121-optimize-important-indexes.js`, `2026-08-18-0000-sqlite-only-drop-analytics-type-check.js`) contain SQLite-specific branches. The inventory below reflects the union of all definitions found in code.

## Table inventory

27 table definitions were found (26 surviving tables + `maintenance_timeslot`, which is created and then dropped during init).

Conventions: **NN** = `NOT NULL`; **U** = unique; **FK** = foreign key with the referenced table and ON DELETE / ON UPDATE actions as written in code (`RESTRICT` is the implicit default where no action is specified). The final column records whether the table already carries a `user_id`-scoped column.

### `docker_host`

Source: `db/knex_init_db.js:17-23`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| user_id | integer unsigned | NN | — | no FK declared in schema |
| docker_daemon | varchar(255) | null | — | |
| docker_type | varchar(255) | null | — | |
| name | varchar(255) | null | — | |

Indexes: none declared. FKs: none declared.
Existing `user_id` column: **Yes** (no FK constraint declared at schema level).

### `group` (monitor group)

Source: `db/knex_init_db.js:26-34`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| name | varchar(255) | NN | — | |
| created_date | datetime | NN | now() | |
| public | boolean | NN | false | |
| active | boolean | NN | true | |
| weight | integer | NN | 1000 | |
| status_page_id | integer unsigned | null | — | no FK declared |

Indexes: none declared. FKs: none declared (`status_page_id` references `status_page` logically but no constraint is written).
Existing `user_id` column: **No**.

### `proxy`

Sources: `db/knex_init_db.js:37-51`, altered by `db/knex_migrations/2025-03-25-0127-fix-5721.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| user_id | integer unsigned | NN | — | no FK declared |
| protocol | varchar(10) | NN | — | |
| host | varchar(255) | NN | — | |
| port | smallint → **integer** (2025-03-25) | NN | — | |
| auth | boolean | NN | — | |
| username | varchar(255) | null | — | |
| password | varchar(255) | null | — | |
| active | boolean | NN | true | |
| default | boolean | NN | false | |
| created_date | datetime | NN | now() | |

Indexes: `proxy_user_id` (`user_id`). FKs: none declared.
Existing `user_id` column: **Yes** (no FK constraint declared at schema level).

### `user`

Source: `db/knex_init_db.js:54-63`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| username | varchar(255) | NN | — | U, collate utf8_general_ci |
| password | varchar(255) | null | — | |
| active | boolean | NN | true | |
| timezone | varchar(150) | null | — | |
| twofa_secret | varchar(64) | null | — | |
| twofa_status | boolean | NN | false | |
| twofa_last_token | varchar(6) | null | — | |

Indexes: unique(`username`). FKs: none.
Existing `user_id` column: n/a (this is the user table itself).

### `monitor`

Sources: `db/knex_init_db.js:66-122`, converted patches at `db/knex_init_db.js:410-604`, plus monitor-altering migrations: `2023-10-08`, `2023-10-11`, `2023-10-16` (adds `remote_browser`), `2023-12-…` none, `2024-04-26`, `2024-08-24-0000`, `2024-08-24-000-add-cache-bust`, `2024-10-1315`, `2025-01-01`, `2025-02-15`, `2025-03-04`, `2025-06-03`, `2025-06-11`, `2025-06-15`, `2025-06-24`, `2025-07-17`, `2025-09-02` (adds `domain_expiry_notification`), `2025-10-14`, `2025-10-15-0001`, `2025-12-09`, `2025-12-17`, `2025-12-31`, `2026-01-02-0551`, `2026-01-05-0000-add-tls-monitor`, `2026-01-15`, `2026-01-16`, `2026-02-07` (default flip), `2026-03-27`, `2026-05-20`, `2026-05-25`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| name | varchar(150) | null | — | |
| active | boolean | NN | true | |
| user_id | integer unsigned | null | — | FK → `user.id` ON DELETE SET NULL ON UPDATE CASCADE |
| interval | integer | NN | 20 | |
| url | text | null | — | |
| type | varchar(20) | null | — | |
| weight | integer | null | 2000 | |
| hostname | varchar(255) | null | — | |
| port | integer | null | — | |
| created_date | datetime | NN | now() | |
| keyword | varchar(255) | null | — | |
| maxretries | integer | NN | 0 | |
| ignore_tls | boolean | NN | false | |
| upside_down | boolean | NN | false | |
| maxredirects | integer | NN | 10 | |
| accepted_statuscodes_json | text | NN | `'["200-299"]'` | |
| dns_resolve_type | varchar(5) | null | — | |
| dns_resolve_server | varchar(255) | null | — | |
| dns_last_result | varchar(255) → **text** (`2026-01-02-0551`) | null | — | |
| retry_interval | integer | NN | 0 | |
| push_token | varchar(20) → **varchar(32)** (`2023-10-11`) | null | null | |
| method | text | NN | "GET" | |
| body | text | null | null | |
| headers | text | null | null | |
| basic_auth_user | text | null | null | |
| basic_auth_pass | text | null | null | |
| docker_host | integer unsigned | null | — | FK → `docker_host.id` (no action specified) |
| docker_container | varchar(255) | null | — | |
| proxy_id | integer unsigned | null | — | FK → `proxy.id` (no action specified) |
| expiry_notification | boolean | null | true | |
| mqtt_topic | text | null | — | |
| mqtt_success_message | varchar(255) | null | — | |
| mqtt_username | varchar(255) | null | — | |
| mqtt_password | varchar(255) | null | — | |
| database_connection_string | varchar(2000) | null | — | |
| database_query | text | null | — | |
| auth_method | varchar(250) | null | — | |
| auth_domain | text | null | — | |
| auth_workstation | text | null | — | |
| grpc_url | varchar(255) | null | null | |
| grpc_protobuf | text | null | null | |
| grpc_body | text | null | null | |
| grpc_metadata | text | null | null | |
| grpc_method | text | null | null | |
| grpc_service_name | text | null | null | |
| grpc_enable_tls | boolean | NN | false | |
| radius_username | varchar(255) | null | — | |
| radius_password | varchar(255) | null | — | |
| radius_calling_station_id | varchar(50) | null | — | |
| radius_called_station_id | varchar(50) | null | — | |
| radius_secret | varchar(255) | null | — | |
| resend_interval | integer | NN | 0 | |
| packet_size | integer | NN | 56 | |
| game | varchar(255) | null | — | |
| http_body_encoding | varchar(25) | null | — | backfilled to 'json' for http/keyword types during init |
| description | text | null | null | |
| tls_ca | text | null | null | |
| tls_cert | text | null | null | |
| tls_key | text | null | null | |
| parent | integer unsigned | null | — | FK → `monitor.id` ON DELETE SET NULL ON UPDATE CASCADE |
| invert_keyword | boolean | NN | 0 | |
| json_path | text | null | — | |
| expected_value | varchar(255) | null | — | |
| kafka_producer_topic | varchar(255) | null | — | |
| kafka_producer_brokers | text | null | — | |
| kafka_producer_ssl | boolean | NN | 0 | |
| kafka_producer_allow_auto_topic_creation | boolean | NN | 0 | |
| kafka_producer_sasl_options | text | null | — | |
| kafka_producer_message | text | null | — | |
| oauth_client_id | text | null | null | |
| oauth_client_secret | text | null | null | |
| oauth_token_url | text | null | null | |
| oauth_scopes | text | null | null | |
| oauth_auth_method | text | null | null | |
| timeout | double | NN | 0 | |
| gamedig_given_port_only | boolean | NN | 1 | |
| mqtt_check_type | varchar(255) | NN | "keyword" | `2023-10-08` |
| remote_browser | integer unsigned | null | null | FK → `remote_browser.id` (no action specified), indexed; `2023-10-16` |
| snmp_oid | varchar | null | null | `2024-04-26` |
| snmp_version | enum('1','2c','3') | null | "2c" | `2024-04-26` |
| json_path_operator | varchar | null | null | `2024-04-26`, backfilled to '==' by `2024-10-31` |
| conditions | text | NN | '[]' | `2024-08-24-0000` |
| cache_bust | boolean | NN | false | `2024-08-24-000-add-cache-bust` |
| rabbitmq_nodes | text | null | — | `2024-10-1315` |
| rabbitmq_username | varchar | null | — | `2024-10-1315` |
| rabbitmq_password | varchar | null | — | `2024-10-1315` |
| smtp_security | varchar | null | null | `2025-01-01` |
| ws_ignore_sec_websocket_accept_header | boolean | NN | false | `2025-02-15` |
| ws_subprotocol | varchar(255) | NN | '' | `2025-02-15` |
| ping_count | integer | NN | 1 | `2025-03-04` |
| ping_numeric | boolean | NN | true | `2025-03-04` |
| ping_per_request_timeout | integer | NN | 2 | `2025-03-04` |
| ip_family | boolean → **varchar(4)** ('ipv4'/'ipv6') (`2025-10-14`) | null | null | added `2025-06-03` |
| manual_status | varchar → **smallint** (`2025-06-15`) | null | null | added `2025-06-11` |
| oauth_audience | varchar | null | null | `2025-06-24` |
| mqtt_websocket_path | varchar(255) | null | — | `2025-07-17` |
| domain_expiry_notification | boolean | null | 1 → **0** (`2026-02-07`) | added `2025-09-02` |
| save_response | boolean | NN | false | `2025-10-15-0001` |
| save_error_response | boolean | NN | true | `2025-10-15-0001` |
| response_max_length | integer | NN | 1024 | `2025-10-15-0001` |
| system_service_name | varchar | null | — | `2025-12-09` |
| subtype | varchar(10) | null | — | `2025-12-17` (globalping) |
| location | varchar(255) | null | — | `2025-12-17` (globalping) |
| protocol | varchar(20) | null | — | `2025-12-17` (globalping) |
| snmp_v3_username | varchar(255) | null | — | `2025-12-31` |
| expected_tls_alert | varchar(50) | null | null | `2026-01-05-0000-add-tls-monitor` |
| retry_only_on_status_code_failure | boolean | NN | false | `2026-01-15` |
| screenshot_delay | integer unsigned | NN | 0 | `2026-01-16` |
| ntp_stratum_threshold | integer | null | 5 | `2026-03-27` |
| ntp_time_offset_threshold | integer | null | 1000 | `2026-03-27` |
| ntp_root_dispersion_threshold | integer | null | 500 | `2026-03-27` |
| bearer_token | text | null | null | `2026-05-20` |
| gamedig_token | text | null | null | `2026-05-25` |

Indexes: none declared inline beyond the `remote_browser` index (`.index()` in migration `2023-10-16`). FKs: `user_id`→`user` (SET NULL/CASCADE), `docker_host`→`docker_host`, `proxy_id`→`proxy`, `parent`→`monitor` (SET NULL/CASCADE), `remote_browser`→`remote_browser`.
Data migrations touching rows only (no schema change): `2026-01-02-0713-gamedig-v4-to-v5.js` (rewrites `game` IDs), `2024-10-31-0000-fix-snmp-monitor.js` (backfills `json_path_operator`), `2026-02-07-0000-disable-domain-expiry-unsupported-tlds.js` (flips `domain_expiry_notification` per monitor).
Existing `user_id` column: **Yes** (owner FK with ON DELETE SET NULL).

### `heartbeat`

Sources: `db/knex_init_db.js:125-148`, migrations `2023-08-18-0301-heartbeat.js`, `2023-09-29-0000-heartbeat-retires.js`, `2025-10-15-0002-add-response-to-heartbeat.js`, `2025-12-22-0121-optimize-important-indexes.js`, `2026-01-10-0000-convert-float-precision.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| important | boolean | NN | false | indexed |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| status | smallint | NN | — | 0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE (see `server/model/heartbeat.js:5-9`) |
| msg | text | null | — | |
| time | datetime | NN | — | |
| ping | integer → **bigInteger** (`2026-01-10`) | null | — | |
| duration | integer | NN | 0 | |
| down_count | integer | NN | 0 | |
| end_time | datetime | null | null | `2023-08-18` |
| retries | integer | NN | 0 | `2023-09-29` |
| response | text | null | null | `2025-10-15-0002` (brotli-compressed payload, see `server/model/heartbeat.js:66-78`) |

Indexes: `important`; `monitor_time_index` (`monitor_id`,`time`); `monitor_id`; `monitor_important_time_index` (`monitor_id`,`important`,`time`). On SQLite, `2025-12-22-0121` replaces two of these with partial indexes (`WHERE important = 1`): `monitor_important_time_index` becomes (`monitor_id`,`time`) partial and a new partial `heartbeat_important_index` (`important`) is added; MariaDB/MySQL unchanged.
FKs: `monitor_id`→`monitor` (CASCADE/CASCADE).
Existing `user_id` column: **No** (ownership reached indirectly through `monitor.user_id`).

### `incident`

Source: `db/knex_init_db.js:151-161`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| title | varchar(255) | NN | — | |
| content | text | NN | — | |
| style | varchar(30) | NN | "warning" | |
| created_date | datetime | NN | now() | |
| last_updated_date | datetime | null | — | |
| pin | boolean | NN | true | |
| active | boolean | NN | true | |
| status_page_id | integer unsigned | null | — | no FK declared |

Indexes: none declared. FKs: none declared.
Existing `user_id` column: **No**.

### `maintenance`

Sources: `db/knex_init_db.js:164-182` + converted patch `db/knex_init_db.js:484-488` (cron fields) + `db/knex_migrations/2025-06-13-0000-maintenance-add-last-start.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| title | varchar(150) | NN | — | |
| description | text | NN | — | |
| user_id | integer unsigned | null | — | FK → `user.id` ON DELETE SET NULL ON UPDATE CASCADE |
| active | boolean | NN | true | indexed |
| strategy | varchar(50) | NN | "single" | |
| start_date | datetime | null | — | |
| end_date | datetime | null | — | |
| start_time | time | null | — | |
| end_time | time | null | — | |
| weekdays | varchar(250) | null | '[]' | |
| days_of_month | text | null | '[]' | |
| interval_day | integer | null | — | |
| cron | text | null | — | converted patch (init db) |
| timezone | varchar(255) | null | — | converted patch (init db) |
| duration | integer | null | — | converted patch (init db) |
| last_start_date | datetime | null | — | `2025-06-13` (migration also rewrites cron values for recurring-interval rows) |

Indexes: `active`; `manual_active` (`strategy`,`active`); `maintenance_user_id` (`user_id`).
FKs: `user_id`→`user` (SET NULL/CASCADE).
Existing `user_id` column: **Yes**.

### `status_page`

Sources: `db/knex_init_db.js:185-202`, converted patch `db/knex_init_db.js:559-561`, migrations `2023-12-20-0000-alter-status-page.js`, `2025-02-17-2142-generalize-analytics.js`, `2025-10-24-0000-show-only-last-heartbeat.js`, `2026-01-05-0000-add-rss-title.js`, `2026-06-19-1412-analytics-type-to-string.js`, `2026-08-18-0000-sqlite-only-drop-analytics-type-check.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| slug | varchar(255) | NN | — | U, collate utf8_general_ci |
| title | varchar(255) | NN | — | |
| description | text | null | — | |
| icon | varchar(255) | NN | — | |
| theme | varchar(30) | NN | — | |
| published | boolean | NN | true | |
| search_engine_index | boolean | NN | true | |
| show_tags | boolean | NN | false | |
| password | varchar(255) | null | — | |
| created_date | datetime | NN | now() | |
| modified_date | datetime | NN | now() | |
| footer_text | text | null | — | |
| custom_css | text | null | — | |
| show_powered_by | boolean | NN | true | |
| google_analytics_tag_id → renamed **analytics_id** (`2025-02-17`) | varchar(255) | null | — | |
| analytics_script_url | varchar(255) | null | — | `2025-02-17` |
| analytics_type | enum(google,umami,plausible,matomo) → **string** (`2026-06-19-1412`; SQLite enum check dropped by rebuild in `2026-08-18`) | null | null | `2025-02-17`; 'rybbit' value allowed from `2026-06-19-1411` onward (no-op migration) |
| show_certificate_expiry | boolean | NN | 0 | converted patch (init db) |
| auto_refresh_interval | integer unsigned | null | 300 | `2023-12-20` |
| show_only_last_heartbeat | boolean | NN | false | `2025-10-24` |
| rss_title | varchar(255) | null | — | `2026-01-05-0000-add-rss-title` |

Indexes: unique(`slug`). FKs: none declared.
Existing `user_id` column: **No**.

### `maintenance_status_page`

Source: `db/knex_init_db.js:205-225`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| status_page_id | integer unsigned | NN | — | FK → `status_page.id` ON DELETE CASCADE ON UPDATE CASCADE |
| maintenance_id | integer unsigned | NN | — | FK → `maintenance.id` ON DELETE CASCADE ON UPDATE CASCADE |

Indexes: none declared. Existing `user_id` column: **No**.

### `maintenance_timeslot` (created, then dropped during init)

Created at `db/knex_init_db.js:228-245` and dropped by `knex.schema.dropTableIfExists("maintenance_timeslot")` at `db/knex_init_db.js:484`. It appears in `createTable(...)` grep output and therefore must be accounted for; it does not exist in a fresh install's final state.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| maintenance_id | integer unsigned | NN | — | FK → `maintenance.id` ON DELETE CASCADE ON UPDATE CASCADE |
| start_date | datetime | NN | — | |
| end_date | datetime | null | — | |
| generated_next | boolean | null | false | indexed |

Indexes: `maintenance_id`; `active_timeslot_index` (`maintenance_id`,`start_date`,`end_date`); `generated_next_index`.
Existing `user_id` column: **No**.

### `monitor_group`

Sources: `db/knex_init_db.js:248-270`, `db/knex_migrations/2025-05-09-0000-add-custom-url.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| group_id | integer unsigned | NN | — | FK → `group.id` ON DELETE CASCADE ON UPDATE CASCADE |
| weight | integer | NN | 1000 | |
| send_url | boolean | NN | false | |
| custom_url | text | null | — | `2025-05-09` |

Indexes: `fk` (`monitor_id`,`group_id`). Existing `user_id` column: **No**.

### `monitor_maintenance`

Source: `db/knex_init_db.js:272-293`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| maintenance_id | integer unsigned | NN | — | FK → `maintenance.id` ON DELETE CASCADE ON UPDATE CASCADE |

Indexes: `maintenance_id_index2` (`maintenance_id`), `monitor_id_index` (`monitor_id`). Existing `user_id` column: **No**.

### `notification`

Source: `db/knex_init_db.js:296-303`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| name | varchar(255) | null | — | |
| active | boolean | NN | true | |
| user_id | integer unsigned | null | — | no FK declared |
| is_default | boolean | NN | false | |
| config | longtext | null | — | JSON blob of provider config |

Indexes: none declared. FKs: none declared.
Existing `user_id` column: **Yes** (no FK constraint declared at schema level).

### `monitor_notification`

Source: `db/knex_init_db.js:306-326`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK (unsigned) | NN | autoincrement | source comment notes uncertainty: "TODO: no auto increment????" |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| notification_id | integer unsigned | NN | — | FK → `notification.id` ON DELETE CASCADE ON UPDATE CASCADE |

Indexes: `monitor_notification_index` (`monitor_id`,`notification_id`). Existing `user_id` column: **No**.

### `tag`

Source: `db/knex_init_db.js:329-334`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| name | varchar(255) | NN | — | |
| color | varchar(255) | NN | — | |
| created_date | datetime | NN | now() | |

Indexes: none declared. FKs: none. Existing `user_id` column: **No**.

### `monitor_tag`

Source: `db/knex_init_db.js:337-356`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| tag_id | integer unsigned | NN | — | FK → `tag.id` ON DELETE CASCADE ON UPDATE CASCADE |
| value | text | null | — | |

Indexes: none declared (no unique on (`monitor_id`,`tag_id`,`value`)). Existing `user_id` column: **No**.

### `monitor_tls_info`

Sources: `db/knex_init_db.js:359-370`, `db/knex_migrations/2024-11-27-1927-fix-info-json-data-type.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| info_json | text → **longtext** (`2024-11-27`) | null | — | |

Indexes: none declared (no unique on `monitor_id`). Existing `user_id` column: **No**.

### `notification_sent_history`

Source: `db/knex_init_db.js:373-380`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| type | varchar(50) | NN | — | part of U + index |
| monitor_id | integer unsigned | NN | — | no FK declared |
| days | integer | NN | — | part of U + index |

Constraints: unique(`type`,`monitor_id`,`days`). Indexes: `good_index` (`type`,`monitor_id`,`days`). Existing `user_id` column: **No**.

### `setting`

Source: `db/knex_init_db.js:383-388`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| key | varchar(200) | NN | — | U, collate utf8_general_ci |
| value | text | null | — | |
| type | varchar(20) | null | — | |

Existing `user_id` column: **No** (global key/value store).

### `status_page_cname`

Source: `db/knex_init_db.js:391-401`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| status_page_id | integer unsigned | null | — | FK → `status_page.id` ON DELETE CASCADE ON UPDATE CASCADE |
| domain | varchar(255) | NN | — | U, collate utf8_general_ci |

Existing `user_id` column: **No**.

### `api_key`

Source: converted patch in `db/knex_init_db.js:442-457` (original SQL preserved in comment at lines 430-441).

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| key | varchar(255) | NN | — | |
| name | varchar(255) | NN | — | |
| user_id | integer unsigned | NN | — | FK → `user.id` ON DELETE CASCADE ON UPDATE CASCADE |
| created_date | datetime | NN | now() | |
| active | boolean | NN | 1 | |
| expires | datetime | null | null | |

Existing `user_id` column: **Yes**.

### `stat_minutely`

Sources: `db/knex_migrations/2023-08-16-0000-create-uptime.js`, `2023-12-21-0000-stat-ping-min-max.js`, `2024-01-22-0000-stats-extras.js`, `2025-10-15-0000-stat-table-fix.js`, `2026-01-10-0000-convert-float-precision.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| timestamp | integer | NN | — | unix time rounded to minute; part of U |
| ping | float | NN | — | default 0 added by `2025-10-15-0000`; precision float(20,2) via `2026-01-10` |
| up | smallint | NN | — | |
| down | smallint | NN | — | |
| ping_min | float | NN | 0 | `2023-12-21`; float(20,2) via `2026-01-10` |
| ping_max | float | NN | 0 | `2023-12-21`; float(20,2) via `2026-01-10` |
| extras | text | null | null | `2024-01-22` |

Constraints: unique(`monitor_id`,`timestamp`). Existing `user_id` column: **No**.

### `stat_daily`

Sources: same files as `stat_minutely`, plus `db/knex_migrations/2026-07-22-0000-fix-stat-daily-overflow.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| timestamp | integer | NN | — | unix time rounded to day; part of U |
| ping | float | NN | 0 | default added `2025-10-15-0000`; float(20,2) via `2026-01-10` |
| up | smallint → **integer unsigned** (`2026-07-22`) | NN | — | |
| down | smallint → **integer unsigned** (`2026-07-22`) | NN | — | |
| ping_min | float | NN | 0 | `2023-12-21`; float(20,2) via `2026-01-10` |
| ping_max | float | NN | 0 | `2023-12-21`; float(20,2) via `2026-01-10` |
| extras | text | null | null | `2024-01-22` |

Constraints: unique(`monitor_id`,`timestamp`). Existing `user_id` column: **No**.

### `stat_hourly`

Sources: `db/knex_migrations/2023-12-22-0000-hourly-uptime.js`, `2024-01-22-0000-stats-extras.js`, `2025-10-15-0000-stat-table-fix.js`, `2026-01-10-0000-convert-float-precision.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| monitor_id | integer unsigned | NN | — | FK → `monitor.id` ON DELETE CASCADE ON UPDATE CASCADE |
| timestamp | integer | NN | — | unix time rounded to hour; part of U |
| ping | float | NN | 0 | default added `2025-10-15-0000`; float(20,2) via `2026-01-10` |
| ping_min | float | NN | 0 | float(20,2) via `2026-01-10` |
| ping_max | float | NN | 0 | float(20,2) via `2026-01-10` |
| up | smallint | NN | — | |
| down | smallint | NN | — | |
| extras | text | null | null | `2024-01-22` |

Constraints: unique(`monitor_id`,`timestamp`). Existing `user_id` column: **No**.

### `remote_browser`

Source: `db/knex_migrations/2023-10-16-0000-create-remote-browsers.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| name | varchar(255) | NN | — | |
| url | varchar(255) | NN | — | |
| user_id | integer unsigned | null | — | no FK declared |

Indexes: none declared. Existing `user_id` column: **Yes** (no FK constraint declared at schema level). Also adds `monitor.remote_browser` FK (see `monitor` above).

### `domain_expiry`

Sources: `db/knex_migrations/2025-09-02-0000-add-domain-expiry.js`, `2026-01-06-0000-fix-domain-expiry-column-type.js`.

| Column | Type | Null | Default | Constraints/FK |
| --- | --- | --- | --- | --- |
| id | integer AI PK | NN | autoincrement | |
| last_check | datetime | null | — | |
| domain | varchar(255) | NN | — | U |
| expiry | datetime | null | — | |
| last_expiry_notification_sent | integer | null | null | |

Existing `user_id` column: **No** (global cache keyed by domain string).

## `user_id` scoping summary

| Table | Has `user_id` column? | Notes |
| --- | --- | --- |
| `user` | n/a | identity table itself |
| `monitor` | Yes | FK → user, ON DELETE SET NULL |
| `api_key` | Yes | FK → user, ON DELETE CASCADE |
| `docker_host` | Yes | no FK declared |
| `proxy` | Yes | no FK declared |
| `notification` | Yes | no FK declared |
| `maintenance` | Yes | FK → user, ON DELETE SET NULL |
| `remote_browser` | Yes | no FK declared |
| `heartbeat` | No | scoped via `monitor_id` |
| `stat_minutely` | No | scoped via `monitor_id` |
| `stat_hourly` | No | scoped via `monitor_id` |
| `stat_daily` | No | scoped via `monitor_id` |
| `incident` | No | scoped via `status_page_id` (no FK) |
| `status_page` | No | no owner column at all |
| `status_page_cname` | No | scoped via `status_page_id` |
| `group` | No | linked to status_page via `status_page_id` (no FK) |
| `monitor_group` | No | junction monitor↔group |
| `monitor_tag` | No | junction monitor↔tag |
| `tag` | No | globally shared tags |
| `monitor_tls_info` | No | scoped via `monitor_id` |
| `monitor_notification` | No | junction monitor↔notification |
| `monitor_maintenance` | No | junction monitor↔maintenance |
| `maintenance_status_page` | No | junction maintenance↔status_page |
| `maintenance_timeslot` | No | created then dropped during init |
| `notification_sent_history` | No | scoped via `monitor_id` (no FK) |
| `setting` | No | global settings |
| `domain_expiry` | No | global cache keyed by domain |

## Reproduce

```bash
# All table creations in the init script
grep -nE 'createTable\("' db/knex_init_db.js
# All ALTER/add-column operations in the init script ("converted patches")
grep -nE 'schema\.table\("' db/knex_init_db.js
# Tables created by migrations
grep -rnE 'createTable\("' db/knex_migrations/
# Columns added/altered by each migration
for f in db/knex_migrations/*.js; do echo "== $f"; grep -nE 'alterTable|createTable|renameColumn|dropColumn|dropTable|table\.(string|text|integer|boolean|datetime|double|float|smallint|bigInteger|enum|enu)' "$f"; done
# FK / index declarations
grep -rnE 'references\(|\.index\(|\.unique\(' db/knex_init_db.js db/knex_migrations/
```
