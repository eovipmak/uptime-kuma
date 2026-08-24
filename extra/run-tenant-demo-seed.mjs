/**
 * Thin runner for the multi-tenant demo seed (G1.07).
 *
 * Usage: npm run seed:tenant-demo
 * Guards: refuses to run outside dev/demo (see db/seed/multi-tenant-demo.js).
 * Database: the normal Uptime Kuma data dir, or an isolated SQLite file when
 * UPTIME_KUMA_DEMO_SEED_DB points at one (e.g. ./data/demo-seed-test.db).
 */
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Database = require("../server/database");
const { R } = require("redbean-node");
const {
    isDemoSeedAllowed,
    seed,
} = require("../db/seed/multi-tenant-demo.js");

// Guard first — zero DB writes (and no connection) on refusal.
if (!isDemoSeedAllowed()) {
    console.error("Refusing to run outside dev/demo. Set UPTIME_KUMA_DEMO_SEED=1 to override.");
    process.exit(1);
}

const customDbPath = process.env.UPTIME_KUMA_DEMO_SEED_DB;

if (customDbPath) {
    const absDbPath = path.resolve(customDbPath);
    Database.initDataDir({ "data-dir": path.dirname(absDbPath) });
    // Point SQLite at the requested file instead of <data-dir>/kuma.db
    Database.sqlitePath = absDbPath;

    // The isolated-file mode only supports SQLite. Bail out before connecting
    // if this data dir is configured for a different database type, so we can
    // never seed a foreign database by accident.
    let existingConfig = null;
    try {
        existingConfig = Database.readDBConfig();
    } catch (err) {
        // No db-config.json yet — connect() will default to SQLite.
        existingConfig = null;
    }
    if (existingConfig && existingConfig.type !== "sqlite") {
        console.error(
            `UPTIME_KUMA_DEMO_SEED_DB only supports SQLite but ${path.dirname(absDbPath)}/db-config.json declares type "${existingConfig.type}".`
        );
        process.exit(1);
    }
    if (!existingConfig) {
        // Materialize db-config.json: connect() only assigns
        // Database.dbConfig when readDBConfig() succeeds, and patch()
        // needs it to run patchSqlite() (baseline schema) on fresh DBs.
        Database.writeDBConfig({ type: "sqlite" });
    }
} else {
    Database.initDataDir({});
}

let exitCode = 0;

try {
    // Not testMode: seed real dev databases with the same WAL journaling the
    // server uses (crash-safe), not the throwaway MEMORY mode tests use.
    await Database.connect(false);
    await Database.patch();

    const summary = await seed(R.knex);

    const formatCounts = (counts) =>
        Object.entries(counts)
            .map(([table, n]) => `${table}=${n}`)
            .join(" ");

    console.log("");
    console.log("Demo seed finished.");
    console.log(`  created: ${formatCounts(summary.created)}`);
    console.log(`  skipped: ${formatCounts(summary.skipped)}`);
} catch (err) {
    console.error(err.message);
    exitCode = 1;
} finally {
    // Bound teardown: stray handles can keep the event loop alive after
    // close(); the WAL checkpoint inside close() runs first, so a hard
    // exit after the grace period is safe.
    await Promise.race([
        Database.close(),
        new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
}

process.exit(exitCode);
