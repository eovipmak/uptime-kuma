// KUM-75 — Repair demo-seeded monitor rows persisted with type "tcp".
//
// The G1.07 demo seed originally inserted monitor.type = "tcp", but the server
// registers the TCP monitor type under key "port"
// (UptimeKumaServer.monitorTypeList, server/uptime-kuma-server.js). Types not
// present in monitorTypeList fall through the beat chain to
// "Unknown Monitor Type" (server/model/monitor.js), so every seeded TCP
// monitor failed on every beat and never went UP.
//
// The seed itself was fixed to emit "port" (4d477f95) with a seed-time type
// guard; this migration repairs rows already written by earlier seed runs.
//
// Knex methods only (no raw SQL) so SQLite and MariaDB behave identically.
// Idempotent: only rows still carrying "tcp" are touched.

exports.up = function (knex) {
    return knex("monitor")
        .where("type", "tcp")
        .update({ type: "port" });
};

exports.down = function (knex) {
    // Intentionally irreversible: once converted, repaired rows are
    // indistinguishable from TCP monitors created as "port" through the UI,
    // so a blanket port -> tcp rewrite would corrupt legitimate rows.
    // Per the migration contract (Clause F — rollback without data loss)
    // this down() touches nothing; the seed-side VALID_MONITOR_TYPES guard
    // prevents new "tcp" rows from ever appearing again.
    return Promise.resolve();
};
