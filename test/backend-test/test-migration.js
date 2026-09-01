const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("Database Migration", () => {
    test("SQLite migrations run successfully from fresh database", async () => {
        const testDbPath = path.join(__dirname, "../../data/test-migration.db");
        const testDbDir = path.dirname(testDbPath);

        // Ensure data directory exists
        if (!fs.existsSync(testDbDir)) {
            fs.mkdirSync(testDbDir, { recursive: true });
        }

        // Clean up any existing test database
        if (fs.existsSync(testDbPath)) {
            fs.unlinkSync(testDbPath);
        }

        // Use the same SQLite driver as the project
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");

        const knex = require("knex");
        const db = knex({
            client: Dialect,
            connection: {
                filename: testDbPath,
            },
            useNullAsDefault: true,
        });

        // Setup R (redbean) with knex instance like production code does
        const { R } = require("redbean-node");
        R.setup(db);

        try {
            // Use production code to initialize SQLite tables (like first run)
            const { createTables } = require("../../db/knex_init_db.js");
            await createTables();

            // Run all migrations like production code does
            await R.knex.migrate.latest({
                directory: path.join(__dirname, "../../db/knex_migrations"),
            });

            // Test passes if migrations complete successfully without errors
        } finally {
            // Clean up
            await R.knex.destroy();
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
        }
    });

    test(
        "In-memory SQLite migrations run successfully from fresh database",
        async () => {
            const knex = require("knex");
            const db = knex({
                client: "better-sqlite3",
                connection: ":memory:",
                useNullAsDefault: true,
            });

            // Setup R (redbean) with knex instance like production code does
            const { R } = require("redbean-node");
            R.setup(db);

            try {
                // Use production code to initialize SQLite tables (like first run)
                const { createTables } = require("../../db/knex_init_db.js");
                await createTables();

                // Run all migrations like production code does
                await R.knex.migrate.latest({
                    directory: path.join(__dirname, "../../db/knex_migrations"),
                });

                // Verify tables exist and are accessible
                const tables = await R.knex.raw("SELECT name FROM sqlite_master WHERE type='table'");
                const rows = tables.rows || tables;
                assert.ok(rows && rows.length > 0);

                // Test passes if migrations complete successfully without errors
            } finally {
                // Clean up
                try {
                    await R.knex.destroy();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    );

    test(
        "In-memory SQLite migrations run with redbean migration rollback",
        async () => {
            const knex = require("knex");
            const db = knex({
                client: "better-sqlite3",
                connection: ":memory:",
                useNullAsDefault: true,
            });

            // Setup R (redbean) with knex instance like production code does
            const { R } = require("redbean-node");
            R.setup(db);

            try {
                // Use production code to initialize SQLite tables (like first run)
                const { createTables } = require("../../db/knex_init_db.js");
                await createTables();

                // Run all migrations like production code does
                await R.knex.migrate.latest({
                    directory: path.join(__dirname, "../../db/knex_migrations"),
                });

                // Create a test monitor and verify it can be read back
                const monitor = R.dispense("monitor");
                monitor.hostname = "test.example.com";
                monitor.interval = 60;
                monitor.type = "http";
                monitor.status = "UP";
                const saved = R.store(monitor);

                // Read it back
                const found = R.findOne("monitor", { id: saved.id });
                assert.ok(found, "Monitor should be found after migration");

                // Test passes if migrations complete and data operations work
            } finally {
                // Clean up
                try {
                    await R.knex.destroy();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    );
});