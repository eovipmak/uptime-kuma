# Task G2.11 — Socket.IO Tenant-Context Wiring + Room Reshaping

**Phase:** G2 — Authentication & Tenant Context
**Status:** completed
**Estimate:** L (per plan template "Format output task chuẩn")
**Reviewer:** Realtime lead / Uptime Kuma maintainer

## Objective

Reshape the Socket.IO room scheme so that every `io.to(...).emit(...)` is partitioned by `tenant_id`, eliminating any path where a client could receive events belonging to another tenant. The existing pattern is `io.to(socket.userID)` — task-this changes that to a composite room `tenant:${tenantId}:user:${userId}` (and the broadcast variant `tenant:${tenantId}` when the same tenant's multiple users should receive a system-wide tenant event).

This task also hardens `checkLogin(socket)` in `server/util-server.js` to also assert a tenant context is set, and ensures the `disconnectAllSocketClients` helper handles tenant-aware eviction.

## Prerequisites/dependencies

- **Task G2.09** reviewed and approved — `socket.tenantID` is set during `afterLogin` and the JWT claim shape is `{ username, h, tid, role }`.
- **Task G2.10** reviewed and approved — `resolveTenantIdForInbound()` is the shared resolver exported from `server/middleware/resolve-tenant.js`; the socket handshake reuses it.
- **If either is incomplete:** stop, report the blocker, do not reshape rooms against an unstable `socket.tenantID` source.

## Owner / recommended agent profile

**Realtime/socket engineer** — fluent with Socket.IO rooms, `socket.join`/`socket.leave`, the project's existing `io.to(socket.userID).emit(...)` call sites (numerous — see `server/client.js`, `server/uptime-kuma-server.js`, the socket handlers). Must run a careful, mechanical refactor across many files without changing observable behavior **except** that the room key is now tenant-partitioned.

## Exact files and artifacts to create or modify

1. **Create** `server/socket-handlers/tenant-room.js` — exports `userRoom(tenantId, userId)`, `tenantRoom(tenantId)`, and helpers `joinUserRooms(socket, { tenantId, userId })`, `leaveUserRooms(socket)`. Centralizes the room-key naming convention so call sites are mechanical replacements.
2. **Modify** `server/util-server.js` — extend `exports.checkLogin(socket)` to also throw if `socket.tenantID` is not set. (One-line addition + JSDoc update; do not refactor the rest of the file.)
3. **Modify** `server/uptime-kuma-server.js`:
   - The handshake at connection time: when `socket.on("loginByToken")` succeeds, also call `joinUserRooms(socket, { tenantId: socket.tenantID, userId: socket.userID })` — replace the existing `socket.join(user.id)` in `afterLogin`.
   - Extend `disconnectAllSocketClients(userID, currentSocketID)` to a new `disconnectAllSocketClientsForTenant(tenantId, userId, currentSocketID)` that targets only sockets in `tenant:${tenantId}:user:${userId}`. Keep the original `disconnectAllSocketClients(userID)` for password-reset flow (which is still cross-tenant — a password reset invalidates all sessions for the user).
4. **Modify** `server/client.js` — every `io.to(socket.userID).emit(...)` becomes `io.to(userRoom(socket.tenantID, socket.userID)).emit(...)`. This is the largest mechanical change site; verify by grep that no `io.to(socket.userID)` calls remain after the refactor.
5. **Modify** every socket-handler file under `server/socket-handlers/` that emits to a user room:
   - `database-socket-handler.js`, `proxy-socket-handler.js`, `cloudflared-socket-handler.js`, `remote-browser-socket-handler.js`, `docker-socket-handler.js`, `api-key-socket-handler.js`, `maintenance-socket-handler.js`, `status-page-socket-handler.js`, `chart-socket-handler.js`, `general-socket-handler.js` — wherever they call `io.to(socket.userID).emit(...)` or `socket.join(user.id)`, swap to the helper.
6. **Modify** `server/server.js` — the `io.on("connection", ...)` block, specifically the `socket.on("logout", ...)` and `socket.on("changePassword", ...)` (the latter calls `disconnectAllSocketClients`), so logout leaves the rooms correctly. Add a new `socket.on("switchTenant", ...)` that re-resolves the new tenant via `resolveTenantIdForInbound` and calls `leaveUserRooms(socket)`, `joinUserRooms(socket, { tenantId, userId })`, sets `socket.tenantID = tenantId`, and re-emits the tenant-scoped lists (monitors, notifications, etc.) so the client UI refreshes to the new tenant's data (the UI rendering of the switcher itself is G7, but the server must push the new tenant's data shortly after switch).
7. **No other file** — model relationships stay as G1 left them (further wiring is G4); frontend untouched except where socket events change payload shape (none here — payloads are unchanged, only the room key changes).

## Concrete implementation steps

1. Re-read `docs/adr/ADR-0003-routing-and-tenant-resolution.md` for the inbound resolver and `docs/adr/ADR-0004-authentication-strategy.md` for the tenant-switch flow. The shared `resolveTenantIdForInbound` from `task-10` is the single resolver — **do not** re-implement the priority order in the socket layer.
2. **`server/socket-handlers/tenant-room.js`:**
   ```js
   const userRoom = (tenantId, userId) => `t${tenantId}:u${userId}`;
   const tenantRoom = (tenantId) => `t${tenantId}`;
   const joinUserRooms = (socket, { tenantId, userId }) => {
       socket.join(userRoom(tenantId, userId));
       socket.join(tenantRoom(tenantId));
   };
   const leaveUserRooms = (socket) => {
       // leave all currently-joined tenant rooms; iterate socket.rooms
       for (const room of socket.rooms) {
           if (room !== socket.id && /^t\d+:/.test(room)) socket.leave(room);
       }
   };
   module.exports = { userRoom, tenantRoom, joinUserRooms, leaveUserRooms };
   ```
   - Use compact `t${id}:u${id}` keys (Socket.IO is sensitive to long room names at scale).
   - Every helper gets JSDoc.
3. **`server.js` `io.on("connection")`:**
   - On `loginByToken` success, after `socket.tenantID = activeTenantId` (set by task-09 in `afterLogin`), call `joinUserRooms(socket, { tenantId: socket.tenantID, userId: socket.userID })`.
   - Replace `socket.join(user.id)` in `afterLogin` (line ~1831) with the helper call.
   - Add `socket.on("switchTenant", async (tenantSlugOrId, callback) => { … })`:
     - Re-resolve via `resolveTenantIdForInbound(socket.handshake, { user: { id: socket.userID, tid: socket.tenantID } })` — i.e., the user must still be a member; if not, return callback `{ ok: false, msg: "tenantAccessDenied" }` (i18n key from `task-10`).
     - On success: `leaveUserRooms(socket)`, `joinUserRooms(socket, { tenantId, userId })`, set `socket.tenantID = tenantId`, re-emit `sendMonitorList`, `sendNotificationList`, etc. (the same set `afterLogin` calls).
     - Issue a refreshed JWT via `User.createJWT(user, tenantId, role, server.jwtSecret)` and return it in the callback (`{ ok: true, token, tenantId, tenants }`) so the client stores the new token — this is the canonical tenant-switch flow; the HTTP switch endpoint in task-10 mirrors it.
   - On `logout`, leave rooms: `leaveUserRooms(socket)`, then `socket.tenantID = null; socket.userID = null` (existing behavior plus the room leaves).
4. **`checkLogin(socket)`** extension in `server/util-server.js`:
   ```js
   exports.checkLogin = (socket) => {
       if (!socket.userID) throw new Error("You are not logged in.");
       if (socket.tenantID === undefined || socket.tenantID === null) {
           throw new Error("Tenant context required.");
       }
   };
   ```
   - This makes G3's role check and G4's query injection safe — every business handler that calls `checkLogin` now also implicitly asserts tenant context.
5. **Room-key replacement sweep** — for every `io.to(socket.userID).emit(...)` and `server.io.to(socket.userID).emit(...)`:
   - Replace with `io.to(userRoom(socket.tenantID, socket.userID)).emit(...)`.
   - Use `grep -rn "io.to(socket.userID)" server/` before and after — before: many hits; after: zero hits in handlers that are tenant-scoped (only allowed exception: none — every business emit is tenant-scoped).
   - For the per-tenant broadcast variant (e.g., a maintenance window starting affects all users in the tenant), use `io.to(tenantRoom(socket.tenantID)).emit(...)`. The plan's G5 monitoring engine will use this for heartbeat-broadcast at scale; here, only wire the helper.
6. **`disconnectAllSocketClientsForTenant(tenantId, userId, currentSocketID)`** — added to `uptime-kuma-server.js`:
   - Iterate `this.io.sockets.sockets.values()`; for sockets whose `socket.tenantID === tenantId && socket.userID === userId && socket.id !== currentSocketID`, emit `"refresh"` and disconnect.
   - Used by `task-12`'s force-logout job when a user is removed from a tenant.
7. **Behavioral parity check:** the observable event payloads (e.g., `monitorList`, `notificationList`, `heartbeatList`) must be identical before and after the refactor — only the room key changes. Reviewers will spot-check by running the existing backend tests.
8. JSDoc every new function; `.eslintrc.js` style.

## Interfaces/contracts and integration points

- **Upstream consumers (within G2):**
  - `task-09` sets `socket.tenantID` — this task consumes it.
  - `task-10` exports `resolveTenantIdForInbound` — this task imports it for the `switchTenant` handler membership check.
- **Downstream consumer (within G2):** `task-12` (force-logout) consumes `disconnectAllSocketClientsForTenant` and the room helpers.
- **Downstream consumers (later phases):**
  - G4 (Repository) — the tenant-safe query layer does not emit; it reads `req.user.tenantId` from the HTTP path. The socket path uses `socket.tenantID` directly. Both must agree on the tenant id; this task ensures `socket.tenantID` is always set when `checkLogin` passes.
  - G5 (Monitoring engine) — broadcasts heartbeat updates via `io.to(tenantRoom(tenantId)).emit(...)` for tenant-wide events; the helper is the contract.
  - G7 (UI) — listens to the same event names (no payload change); only the routing changes server-side.
- **Contract — room key naming (frozen here):**
  - User-scoped: `t${tenantId}:u${userId}` — exposed via `userRoom(tenantId, userId)`.
  - Tenant-scoped: `t${tenantId}` — exposed via `tenantRoom(tenantId)`.
  - The literal form `{tenantId}`/`{userId}` are uint numbers; the `t`/`u` prefixes prevent accidental collision with user IDs (which sometimes were used as room names pre-G2).
- **Behavioral-parity contract:** no event name or payload shape changes in this task — only the room keys.

## Acceptance criteria

- [ ] `server/socket-handlers/tenant-room.js` exports `userRoom`, `tenantRoom`, `joinUserRooms`, `leaveUserRooms` with JSDoc.
- [ ] `checkLogin(socket)` throws on missing `socket.tenantID` (in addition to the existing `socket.userID` check).
- [ ] `socket.on("switchTenant", ...)` exists, re-resolves membership via the shared middleware helper, swaps rooms, sets `socket.tenantID`, re-emits tenant-scoped lists, and returns a refreshed JWT in the callback.
- [ ] `logout` leaves all joined tenant rooms and clears `socket.tenantID`.
- [ ] `disconnectAllSocketClientsForTenant(tenantId, userId, currentSocketID)` exists on `UptimeKumaServer` and is consumed by `task-12`.
- [ ] `grep -rn "io.to(socket.userID)" server/` returns zero matches in tenant-scoped handlers after the refactor (any remaining matches are documented with a rationale).
- [ ] `grep -rn "socket.join(user.id)\|socket.join(userID)" server/` returns zero matches except inside the project's own tests/examples.
- [ ] Event payload shapes unchanged — every existing `test/backend-test/*.test.js` for monitor/notification/status page still passes (regression gate).
- [ ] `npm run lint` passes on every modified file.
- [ ] No changes outside the files listed in "Exact files" (no frontend, no migrations, no models).

## Verification commands/checks

Run from the repository root:

```bash
# 1. Lint all modified files
npx eslint server/socket-handlers/ server/client.js server/util-server.js server/uptime-kuma-server.js server/server.js

# 2. Helper exports
node -e "
const h = require('./server/socket-handlers/tenant-room');
['userRoom','tenantRoom','joinUserRooms','leaveUserRooms'].forEach(k => {
  console.log((typeof h[k] === 'function' ? 'OK' : 'MISSING')+' helper: '+k);
});
console.log('userRoom(7, 11)=' + h.userRoom(7, 11));
"

# 3. checkLogin now asserts tenant
grep -A5 "exports.checkLogin" server/util-server.js | grep -q "tenantID" && echo "OK tenant check" || echo "MISSING tenant check"

# 4. No remaining old-room emits
matches=$(grep -rn "io.to(socket.userID)" server/ | grep -vE '//' | wc -l)
[ "$matches" -eq 0 ] && echo "OK no old-room emits" || { echo "REMAINING old-room emits: $matches"; grep -rn "io.to(socket.userID)" server/ | grep -vE '//'; }

# 5. switchTenant handler registered
grep -nE 'socket\.on\(\s*[\"'\'']switchTenant[\"'\'']' server/server.js

# 6. disconnectAllSocketClientsForTenant exists
grep -nE 'disconnectAllSocketClientsForTenant' server/uptime-kuma-server.js

# 7. Regression — run existing backend tests that touch socket flow
npm run test-backend 2>&1 | tail -40

# 8. Only allowed files changed
git status --short | grep -vE '^\s?[?M]\s+(server/socket-handlers/|server/client\.js|server/util-server\.js|server/uptime-kuma-server\.js|server/server\.js)' && echo 'VIOLATION: unexpected file' || echo 'OK: only allowed files changed'
```

## Reviewer

Realtime lead / Uptime Kuma maintainer. Specifically confirms:
- (a) zero `io.to(socket.userID)` call sites remain in tenant-scoped handlers (no missed leaks),
- (b) `checkLogin` now also gates on `socket.tenantID` — G3/G4 can assume tenant context is present after `checkLogin`,
- (c) the room-key naming is compact and collision-safe,
- (d) the `switchTenant` flow re-resolves membership server-side (no client trust),
- (e) **event payload shapes are unchanged** — the existing backend test suite must still pass.

## Explicit out-of-scope

- **Do not** introduce `@socket.io/redis-adapter` or sticky-session support — that is G10 (multi-instance). G2 rooms work in-process; the room-key contract is cluster-safe by design but the adapter procurement is later.
- **Do not** implement the multi-instance broadcast for G5's heartbeat dispatch (the `tenantRoom` helper is added but the heavy emit volume is tuned in G5).
- **Do not** add RBAC decorators or per-event role gates — that is G3.
- **Do not** touch the public status page Socket.IO room (`monitor-$monitorID` style used for non-authenticated viewers) — G6 owns that; only authenticated user rooms are reshaped here.
- **Do not** change front-end event listeners or payload shapes; UI onboarding/switcher is G7.
- **Do not** implement a feature flag for "single-tenant mode" — the default-tenant path covers it.
- **Do not** add audit logging for room joins/leaves — that is G9.
- **Do not** modify the push-token flow beyond ensuring the push handler uses `monitor.tenant_id` (the explicit push-flow refactor is G5).
- **Do not** change `disconnectAllSocketClients(userID)` (the original, used by password reset); only add the new `…ForTenant` variant alongside it.

## Coordinator status
- Status: completed
- Completed by: CTO (Oracle)
- Completed at: 2026-08-25T01:46:00Z
- Verification: PR #28 reviewed across two rounds. Round 1 @2933d95f: eslint clean, tsc 0, targeted tests 15/15, backend 270/270, acceptance greps zero legacy io.to(socket.userID)/socket.join(user.id) — verdict posted to PR (changes requested: conflict resolution + shared resolver wiring). Round 2 @89ec0a80 after Echo rebase: conflicts resolved vs #27, switchTenant consumes findTenantByIdOrSlug+getMembershipRole (resolveTenantIdForInbound deliberately avoided: its JWT-tid/default fallback would silently resolve a non-member target instead of denying), afterLogin null-tenant early-return added, isValidId tightened to numbers/digit-strings with canonical Number() keys ("007"≡"7"), 17/17 targeted, backend 294/294, tsc 0. Squash-merged.
- Commit or artifact reference: master a7f820bb (PR #28); review record PR #28 comment 5403668218; Paperclip KUM-84/KUM-86
