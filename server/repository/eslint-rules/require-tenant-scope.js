/**
 * Custom ESLint rule (G4.17, KUM-33): `uptime-kuma/require-tenant-scope`.
 *
 * Flags `R.findOne` / `R.find` / `R.exec` / `R.findAll` call sites whose SQL
 * fragment lacks a `tenant_id` token. Such call sites must migrate to
 * `findOneForTenant` / `findForTenant` / `execForTenant` /
 * `TenantScopedQueryBuilder` (server/repository), or carry an inline disable
 * with a documented rationale:
 *
 *     // eslint-disable-next-line uptime-kuma/require-tenant-scope -- setting is cross-tenant system config
 *     await R.findOne("setting", " `key` = ? ", [key]);
 *
 * Known permanent exemptions (document, don't "fix"):
 * - the `setting` table (server/settings.js) — cross-tenant system-wide config
 *   such as jwtSecret/entryPage; there is intentionally no tenant_id column,
 * - PRAGMA/VACUUM/wal_checkpoint maintenance statements in jobs/ and database.js.
 */
"use strict";

const SCOPED_METHODS = new Set([ "findOne", "find", "exec", "findAll" ]);
const TENANT_ID_TOKEN = /\btenant_id\b/i;

/**
 * Statically extract a string from an AST argument node.
 * @param {object} node ESLint AST node (or undefined for missing args)
 * @returns {string|null} the string value when statically analyzable, otherwise null
 */
function extractStaticString(node) {
    if (!node) {
        return null;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
        return node.value;
    }
    // Template literals without ${...} interpolations are as good as literals.
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        return node.quasis.map(q => q.value.cooked).join("");
    }
    return null;
}

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Require R.findOne/R.find/R.findAll/R.exec data-access calls to be tenant-scoped (via server/repository wrappers or an explicit tenant_id filter)",
        },
        schema: [],
        messages: {
            missingTenantScope: "Data-access call on {{table}} lacks a tenant_id filter; use findOneForTenant/findForTenant/execForTenant or document an exemption.",
        },
    },

    /**
     * @param {object} context ESLint rule context
     * @returns {object} AST visitor map
     */
    create(context) {
        return {
            CallExpression(node) {
                const callee = node.callee;
                if (
                    callee.type === "MemberExpression" &&
                    callee.object.type === "Identifier" &&
                    callee.object.name === "R" &&
                    callee.property.type === "Identifier" &&
                    SCOPED_METHODS.has(callee.property.name)
                ) {
                    const tableName = extractStaticString(node.arguments[0]) ?? "unknown";
                    const fragmentText = extractStaticString(node.arguments[1]);

                    // Dynamically built fragments cannot be proven safe; report them
                    // so the author either scopes via the repository wrappers or
                    // documents why tenant scoping does not apply.
                    if (fragmentText !== null && TENANT_ID_TOKEN.test(fragmentText)) {
                        return;
                    }

                    context.report({
                        node,
                        messageId: "missingTenantScope",
                        data: {
                            table: tableName,
                        },
                    });
                }
            },
        };
    },
};
