# KUM-174/KUM-176 Durable Patches

**Source:** npm `@paperclipai/server@2026.817.0`  
**Location:** patches outside `node_modules` → survive `npm install` / CLI upgrades.

## Patches

| File | Purpose | Marker |
|------|---------|--------|
| `write-guard-timer-exemption.patch` | Timer-run write-guard exemption (`cross-issue-influence-limit.js`) | `isTimerRun` / `heartbeat_timer` |
| `agent-self-cancel.patch` | Agent self-cancel allowance (`routes/agents.js`) | `isAgentSelfCancel` / `selfCancel` |
| `heartbeat-self-cancel-sibling.patch` | Risk2: heartbeat immediate recovery ignores self-cancel when live sibling exists | `isSelfCancelledRun` + `siblingLiveRun` |
| `recovery-service-self-cancel-sibling.patch` | Risk2: reconciler `hasActiveExecutionPath` lock-aware + selfCancel sibling exempt | `isSelfCancelledRun` + `issueLock` |

## Reapply Mechanism (Owned)

- **Storage:** `/opt/paperclip/patches/*.patch` (outside versioned `installs/npm/<version>`).
- **Reapply:** `/opt/paperclip/scripts/reapply-paperclip-patches.sh` — finds current install via `readlink -f /opt/paperclip/cli/current`, applies each patch with `patch -p1` idempotently (checks reverse dry-run before forward), then runs verify.
- **Verify (fail-loud):** `/opt/paperclip/scripts/verify-paperclip-patches.sh` — greps markers; exits 1 with loud error if any missing, prompting reapply. Intended as **startup integrity check** before `node paperclipai/dist/index.js run`.
- **Wrapper:** `/opt/paperclip/scripts/paperclip-server-launcher.sh` runs verify then execs server; use this in systemd / manual start to guarantee fail-loud.

## Proof of Surviving Reinstall (Mock, no containers)

Simulated reinstall by restoring pristine `dist` files from `https://registry.npmjs.org/@paperclipai/server/-/server-2026.817.0.tgz` then:

```bash
/tmp/simulate_reinstall.sh         # wipes patches -> verify FAILS loud -> reapply -> verify PASSES
/tmp/test_new_version_sim.sh       # simulates upgrade to 2026.818.0 fresh install -> same
/opt/paperclip/scripts/test-risk2-recovery.js  # in-memory mock for Risk2 positive/negative cases
```

- **Positive Risk2:** selfCancel + live sibling → exempt (no stranded `blocked`)
- **Negative Risk2:** selfCancel + NO sibling → still recovers (blocked)
- Board `D-016` respected: no Docker/Testcontainers, only mocks + embedded postgres (port 54329).

## Usage After CLI Upgrade

```bash
/opt/paperclip/scripts/reapply-paperclip-patches.sh  # re-apply to new version
/opt/paperclip/scripts/verify-paperclip-patches.sh   # must exit 0 before starting server
# or
/opt/paperclip/scripts/paperclip-server-launcher.sh run --instance default
```

All patches are idempotent and leave no `.rej` files when already applied.
