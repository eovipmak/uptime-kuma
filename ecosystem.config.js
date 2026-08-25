// OPS PIN (KUM-125) — DO NOT REMOVE.
// Production MUST run under Node >= 22. System node (v18.19.1) crash-loops at boot
// with ERR_REQUIRE_ESM on unlimited-timeout@0.1.0 (ESM-only).
// See docs/ops/prod-runbook.md before touching pm2.
const NODE22 = "/root/.nvm/versions/node/v22.22.2/bin/node";

module.exports = {
    apps: [
        {
            name: "uptime-kuma",
            script: "./server/server.js",
            cwd: "/opt/paperclip/instances/default/boards/kuma-prod",
            interpreter: NODE22,
            autorestart: true,
            max_restarts: 10,
            env: {
                UPTIME_KUMA_PORT: 3001,
            },
        },
    ],
};
