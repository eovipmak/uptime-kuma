/**
 * Local ESLint plugin (G4.17, KUM-33) exposing `uptime-kuma/require-tenant-scope`.
 *
 * Registered as a file: devDependency (`eslint-plugin-uptime-kuma`) so the
 * project's eslintrc-format config can resolve it without publishing anything.
 */
"use strict";

const requireTenantScope = require("./require-tenant-scope");

module.exports = {
    rules: {
        "require-tenant-scope": requireTenantScope,
    },
    configs: {
        recommended: {
            plugins: [ "uptime-kuma" ],
            rules: {
                // G4.17 ships this as "warn": existing call sites are still un-migrated
                // (migration is task-18/task-19, which flip warn→error per-file as they go).
                "uptime-kuma/require-tenant-scope": "warn",
            },
        },
    },
};
