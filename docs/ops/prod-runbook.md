# Production Runbook — uptime-kuma (pm2)

## Hard requirements (read before touching pm2)

- **Node >= 22 is mandatory.** The app crash-loops at boot on system Node 18.19.1 with
  `ERR_REQUIRE_ESM` (`unlimited-timeout@0.1.0` is ESM-only).
- **Interpreter pin:** `/root/.nvm/versions/node/v22.22.2/bin/node` — every
  `pm2 start` MUST set this explicitly. Never rely on `node` on `$PATH`
  (that resolves to system v18).
- **Port:** `3001`. Health check: `curl -f http://localhost:3001/dashboard` → HTTP 200.
- **Production checkout:** `/opt/paperclip/instances/default/boards/kuma-prod`.
  Do not start prod from a dev/feature checkout.
- **Only QA runs production pm2 commands.** Devs and CTO must request it from QA.

## Canonical commands

Start (first time, or after the process was deleted):

```bash
cd /opt/paperclip/instances/default/boards/uptime-kuma   # repo holding ecosystem.config.js
pm2 startOrReload ecosystem.config.js
pm2 save
```

Restart (safe — interpreter survives because it lives in the saved process definition):

```bash
pm2 restart uptime-kuma
```

After host reboot or if the pm2 daemon list was lost:

```bash
pm2 resurrect   # restores the pinned config from ~/.pm2/dump.pm2
```

## Verify after any start/restart

```bash
pm2 describe uptime-kuma | grep -E "status|interpreter"
# expect: status = online
# expect: interpreter = /root/.nvm/versions/node/v22.22.2/bin/node
pm2 restart uptime-kuma && sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/dashboard   # expect 200
pm2 save    # re-pin the dump after any change
```

## If you find it running under Node 18 / crash-looping

Symptom: `pm2 logs uptime-kuma` shows `ERR_REQUIRE_ESM`; describe shows an
interpreter without `/v22.22.2/` or no interpreter at all.

```bash
pm2 delete uptime-kuma
cd /opt/paperclip/instances/default/boards/uptime-kuma
pm2 startOrReload ecosystem.config.js
pm2 save
```

Do NOT just `pm2 restart` a Node-18 process — restart keeps the bad interpreter.

## Why this exists

QA verdict on KUM-111 flagged the environment requirement; KUM-125 made the pin
durable: `ecosystem.config.js` carries the interpreter + cwd + port so plain
starts cannot regress to Node 18, and `pm2 save` keeps it across daemon loss.
