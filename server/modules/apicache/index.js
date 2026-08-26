const apicache = require("./apicache");

apicache.options({
    headerBlacklist: ["cache-control"],
    headers: {
        // Disable client side cache, only server side cache.
        // BUG! Not working for the second request
        "cache-control": "no-cache",
    },
    // G6.24: namespace cache entries by the resolved status-page tenant so two
    // tenants serving the same URL path under different Host headers never
    // read each other's cached responses. resolveStatusPageTenant runs BEFORE
    // apicache on every status-page route; requests without a resolved tenant
    // append "" and keep today's key shape.
    appendKey: [
        (req) => (req.statusPageTenant ? String(req.statusPageTenant.tenantId) : ""),
    ],
});

module.exports = apicache;
