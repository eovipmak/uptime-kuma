# REST Routes & Socket.IO Events Survey (AS-IS)

> Static-analysis inventory of every HTTP route registered in `server/routers/*.js` and every Socket.IO event handler registered in `server/socket-handlers/*.js` plus the direct `socket.on(...)` registrations in the main connection handler in `server/server.js` (note: `server/uptime-kuma-server.js` itself registers no `socket.on(...)` handlers; it only hosts the Socket.IO server bootstrap and server→client emit helpers). Descriptive only; no recommendations.

## HTTP mounting

- `server/routers/api-router.js` is mounted via `app.use(apiRouter)` at `server/server.js:372-373`.
- `server/routers/status-page-router.js` is mounted at `server/server.js:376-377`, after the API router.
- A universal catch-all `app.get("*", ...)` at `server/server.js:380-386` serves the SPA `index.html`.

## How identity works today (context for the flags below)

- Socket handlers receive an authenticated socket whose `socket.userID` is set by `afterLogin()` (`server/server.js:1759-1790`: `socket.userID = user.id; socket.join(user.id)`). Most handlers check ownership with `user_id = ?` predicates against `socket.userID`.
- The REST routers under `/api/badge/*`, `/api/push/*` and `/status*` are **public/unauthenticated** endpoints (no session or API key middleware); they gate visibility via data conditions (`group.public = 1`, monitor existence by push token).
- API keys are validated by `server/auth.js` `verifyAPIKey()` / `apiKeyAuth` middleware, but no current route uses it as of this survey (the middleware exists for future use; grep shows it exported but unused in `server/routers/`).

## REST routes

### `server/routers/api-router.js`

| Method | Path | Line | References `user_id`? | References `monitor_id`? | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/entry-page` | 28 | No | No | Returns entry page or status-page domain mapping (`StatusPage.domainMappingList`). |
| ALL | `/api/push/:pushToken` | 47 | Yes — reads `monitor.user_id` to target socket room (`io.to(monitor.user_id)`, line 127) | Yes — resolved from `push_token`; writes heartbeat rows for that monitor | Push heartbeat ingestion; unauthenticated; dispatches notifications via `Monitor.sendNotification`. |
| GET | `/api/badge/:id/status` | 148 | No | Yes — `:id` param is a monitor id | Public badge; visibility via `isMonitorPublic()` (line 626). |
| GET | `/api/badge/:id/uptime/:duration?` | 221 | No | Yes — `:id` monitor id | Public badge. |
| GET | `/api/badge/:id/ping/:duration?` | 285 | No | Yes — `:id` monitor id | Public badge. |
| GET | `/api/badge/:id/avg-response/:duration?` | 351 | No | Yes — `:id` monitor id | Raw SQL joins `monitor_group`,`group`,`heartbeat`. |
| GET | `/api/badge/:id/cert-exp` | 424 | No | Yes — `:id` monitor id | Reads `monitor_tls_info`. |
| GET | `/api/badge/:id/response` | 507 | No | Yes — `:id` monitor id | Reads latest heartbeat. |

### `server/routers/status-page-router.js`

| Method | Path | Line | References `user_id`? | References `monitor_id`? | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/status/:slug` | 16 | No | No | Renders SPA shell for slug. |
| GET | `/status/:slug/rss` | 22 | No | Indirect | RSS feed via `StatusPage.handleStatusPageRSSResponse`. |
| GET | `/status` | 28 | No | No | Slug "default". |
| GET | `/status-page` | 33 | No | No | Slug "default". |
| GET | `/api/status-page/:slug` | 39 | No | Indirect — returns public group/monitor list | Only if published/config found. |
| GET | `/api/status-page/heartbeat/:slug` | 64 | No | Yes — iterates public monitor ids, queries last 100 heartbeats each | Unauthenticated polling endpoint. |
| GET | `/api/status-page/:slug/manifest.json` | 113 | No | No | PWA manifest. |
| GET | `/api/status-page/:slug/incident-history` | 145 | No | No | Paginated incident history (cursor). |
| GET | `/api/status-page/:slug/badge` | 170 | No | Yes — iterates public monitor ids and their latest heartbeats | Overall status badge. |

## Socket.IO events — client → server

### Direct registrations in `server/server.js` (inside `io.on("connection")`, line 389)

| Event | Handler line | Resource touched | Ownership scoping observed |
| --- | --- | --- | --- |
| `loginByToken` | 401 | user | Token auth; calls `afterLogin`. |
| `login` | 450 | user | Username/password; `afterLogin`. |
| `logout` | 530 | user | Leaves `socket.userID` room. |
| `prepare2FA` | 544 | user | Scoped by `socket.userID`. |
| `save2FA` | 587 | user | Scoped by `socket.userID`. |
| `disable2FA` | 617 | user | Scoped by `socket.userID`. |
| `verifyToken` | 646 | user | 2FA token verify. |
| `twoFAStatus` | 676 | user | Scoped by `socket.userID`. |
| `needSetup` | 701 | setup state | Read-only global flag. |
| `setup` | 705 | user | Creates first admin user when needed. |
| `add` | 743 | monitor | Sets `bean.user_id = socket.userID` (785). |
| `editMonitor` | 818 | monitor | Rejects if `bean.user_id !== socket.userID` (825). |
| `getMonitorList` | 995 | monitor | Per-user list via `server.sendMonitorList(socket)`. |
| `getMonitor` | 1011 | monitor | `id = ? AND user_id = ?` (1017). |
| `checkDomain` | 1033 | utility | DNS lookup helper. |
| `getMonitorBeats` | 1053 | heartbeat | Beats page for one monitor (owner checked upstream of query). |
| `resumeMonitor` | 1089 | monitor | `startMonitor(userID, monitorID)` → `checkOwner`. |
| `pauseMonitor` | 1108 | monitor | `pauseMonitor(userID, monitorID)` → `checkOwner`. |
| `deleteMonitor` | 1127 | monitor (+children) | `id = ? AND user_id = ?` (1140); recursive delete. |
| `getTags` | 1217 | tag | Global tag list. |
| `addTag` | 1235 | tag | Creates tag (global). |
| `editTag` | 1256 | tag | Edits tag (global). |
| `deleteTag` | 1287 | tag | Deletes tag (global). |
| `addMonitorTag` | 1306 | tag/monitor | Attaches tag value to monitor. |
| `editMonitorTag` | 1331 | tag/monitor | Updates tag value on monitor. |
| `deleteMonitorTag` | 1356 | tag/monitor | Removes tag from monitor. |
| `monitorImportantHeartbeatListCount` | 1381 | heartbeat | Count of important beats per monitor. |
| `monitorImportantHeartbeatListPaged` | 1404 | heartbeat | Paged important beats per monitor. |
| `changePassword` | 1446 | user | Scoped by `socket.userID`. |
| `getSettings` | 1478 | setting | Global settings read. |
| `setSettings` | 1499 | setting | Global settings write. |
| `addNotification` | 1562 | notification | Saves with `user_id` (via `Notification.save`). |
| `deleteNotification` | 1583 | notification | Owner-scoped delete. |
| `testNotification` | 1603 | notification | Sends test message. |
| `checkApprise` | 1623 | notification | Apprise availability check. |
| `getWebpushVapidPublicKey` | 1632 | notification | Web-push public key. |
| `clearEvents` | 1658 | heartbeat | Clears important events for monitor. |
| `clearHeartbeats` | 1677 | heartbeat/stat | Clears heartbeats for monitor. |
| `clearStatistics` | 1705 | stat | `UptimeCalculator.clearAllStatistics()`, restarts monitors. |

### `server/socket-handlers/api-key-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `addAPIKey` | 18 | api_key | `APIKey.save(key, socket.userID)`. |
| `getAPIKeyList` | 54 | api_key | List sent to user room. |
| `deleteAPIKey` | 70 | api_key | `DELETE ... WHERE id = ? AND user_id = ?` (77). |
| `disableAPIKey` | 95 | api_key | User-scoped update. |
| `enableAPIKey` | 120 | api_key | User-scoped update. |

### `server/socket-handlers/chart-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `getMonitorChartData` | 6 | heartbeat/stat | Monitor chart data; logs `socket.userID` (157); reads stat tables for a monitorID. |

### `server/socket-handlers/cloudflared-socket-handler.js`

Event names are prefixed with `"cloudflared_"` (line 7).

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `cloudflared_join` | 36 | tunnel | Joins `cloudflared` room; emits installed/running/token to user room. |
| `cloudflared_leave` | 48 | tunnel | Leaves room. |
| `cloudflared_start` | 57 | tunnel | Starts tunnel with token. |
| `cloudflared_stop` | 72 | tunnel | Password-confirmed stop. |
| `cloudflared_removeToken` | 88 | tunnel | Removes stored token. |

### `server/socket-handlers/database-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `getDatabaseSize` | 11 | database | Server-wide DB size info. |
| `shrinkDatabase` | 26 | database | VACUUM/shrink (admin instance-level action). |

### `server/socket-handlers/docker-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `addDockerHost` | 12 | docker_host | `DockerHost.save(dockerHost, dockerHostID, socket.userID)` (375 in dump; source line 33). |
| `deleteDockerHost` | 33 | docker_host | `DockerHost.delete(dockerHostID, socket.userID)`. |
| `testDockerHost` | 53 | docker_host | Connection test. |

### `server/socket-handlers/general-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `initServerTimezone` | 45 | setting | Sets server timezone once. |
| `getGameList` | 57 | monitor (gamedig) | GameDig game list. |
| `getPM2ProcessList` | 72 | monitor (pm2) | Local pm2 processes. |
| `testChrome` | 87 | monitor (real-browser) | Chrome executable test. |
| `getPushExample` | 116 | monitor (push) | Build push URL example (uses first monitor's push token for the user). |
| `disconnectOtherSocketClients` | 152 | user sessions | `server.disconnectAllSocketClients(socket.userID, socket.id)`. |

### `server/socket-handlers/maintenance-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `addMaintenance` | 16 | maintenance | Saved with `user_id` (bean.user_id = socket.userID). |
| `editMaintenance` | 46 | maintenance | Owner-scoped update. |
| `addMonitorMaintenance` | 77 | maintenance/monitor | Junction updates. |
| `addMaintenanceStatusPage` | 109 | maintenance/status_page | Junction updates. |
| `getMaintenance` | 140 | maintenance | `id = ? AND user_id = ?` (748 in dump; source line 20 area). |
| `getMaintenanceList` | 160 | maintenance | Per-user list. |
| `getMonitorMaintenance` | 176 | maintenance/monitor | Monitors attached to a maintenance. |
| `getMaintenanceStatusPage` | 200 | maintenance/status_page | Status pages attached to a maintenance. |
| `deleteMaintenance` | 224 | maintenance | `DELETE FROM maintenance WHERE id = ? AND user_id = ?` (837 in dump). |
| `pauseMaintenance` | 254 | maintenance | Owner-scoped pause. |
| `resumeMaintenance` | 287 | maintenance | Owner-scoped resume. |

### `server/socket-handlers/proxy-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `addProxy` | 13 | proxy | `Proxy.save(proxy, proxyID, socket.userID)`. |
| `deleteProxy` | 39 | proxy | `Proxy.delete(proxyID, socket.userID)`. |

### `server/socket-handlers/remote-browser-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `addRemoteBrowser` | 14 | remote_browser | `RemoteBrowser.save(remoteBrowser, remoteBrowserID, socket.userID)`. |
| `deleteRemoteBrowser` | 35 | remote_browser | `RemoteBrowser.delete(id, socket.userID)`. |
| `testRemoteBrowser` | 55 | remote_browser | Connection test. |

### `server/socket-handlers/status-page-socket-handler.js`

| Event | Line | Resource touched | Scoping |
| --- | --- | --- | --- |
| `postIncident` | 34 | incident/status_page | Slug-resolved; incident pinned to status page. |
| `unpinIncident` | 84 | incident | Slug-scoped. |
| `getIncidentHistory` | 103 | incident | Paginated by slug. |
| `editIncident` | 124 | incident | Slug + incidentID scoped. |
| `deleteIncident` | 187 | incident | Slug + incidentID scoped. |
| `resolveIncident` | 227 | incident | Slug + incidentID scoped. |
| `getStatusPage` | 268 | status_page | By slug. |
| `saveStatusPage` | 292 | status_page/group/monitor | Rewrites config, icon, public group list (creates `group` + `monitor_group` records). Visibility check notes `isPublic = !socket.userID` path (dump line 1175). |
| `addStatusPage` | 436 | status_page | Creates new status page with unique slug. |
| `deleteStatusPage` | 482 | status_page | Deletes by slug. |

## Socket.IO events — server → client (emits)

Emitted from `server/server.js`, `server/client.js`, `server/model/monitor.js`, `server/uptime-kuma-server.js`, and socket handlers:

| Event | Emitted from (representative) | Payload / resource |
| --- | --- | --- |
| `setup` | `server.js:394` | Need-first-run flag. |
| `autoLogin` / `loginRequired` | `server.js:1754/1756` | Auth-state on connect. |
| `info` | `server/client.js` `sendInfo()` | Version/setup info. |
| `monitorList` | `uptime-kuma-server.js:224` | Per-user monitor list. |
| `updateMonitorIntoList` / `deleteMonitorFromList` | `uptime-kuma-server.js:237/248` | Incremental monitor-list updates. |
| `maintenanceList` | `uptime-kuma-server.js:298` | Per-user maintenance list. |
| `notificationList` | `server/client.js` `sendNotificationList()` | Per-user notification providers. |
| `proxyList` | `client.js sendProxyList()` | Proxies. |
| `dockerHostList` | `client.js sendDockerHostList()` | Docker hosts. |
| `apiKeyList` | `client.js sendAPIKeyList()` | API keys. |
| `remoteBrowserList` | `client.js sendRemoteBrowserList()` | Remote browsers. |
| `monitorTypeList` | `client.js sendMonitorTypeList()` | Available monitor types. |
| `statusPageList` | `model/status_page.js` `sendStatusPageList()` | Status pages. |
| `heartbeatList` | `client.js sendHeartbeatList()` | Historical beats per monitor. |
| `heartbeat` | `model/monitor.js:1060` (beat loop) and `routers/api-router.js:127` (push) | Live beat, emitted to room named by `user_id`. |
| `avgPing` / `uptime` / `certInfo` / `domainInfo` | `model/monitor.js` `sendStats()/sendCertInfo()/sendDomainInfo()` (1315+) | Aggregates per monitor, emitted to user room. |
| `importantHeartbeatList` | `client.js` | Important-beats pages. |
| `refresh` | `uptime-kuma-server.js:555` | Force client refresh (password reset). |
| `initServerTimezone` | `server.js:1858` | Timezone init handshake. |
| `error` | various handlers | Error surfacing. |
| `cloudflared_running` / `cloudflared_message` / `cloudflared_errorMessage` / `cloudflared_installed` / `cloudflared_token` | `cloudflared-socket-handler.js:17-42` | Tunnel status stream (room `cloudflared`). |

## Room topology note

Each logged-in user joins a Socket.IO room named after their own user id (`afterLogin`, `server/server.js:1760-1761`). All live monitor traffic (`heartbeat`, stats emits) is addressed `io.to(<user_id>)` from the beat loop (`server/model/monitor.js:1059-1060`) and the push route (`api-router.js:127`) — i.e., per-user rooms are the existing tenancy boundary at the socket layer.

## Reproduce

```bash
# REST routes
grep -nE '^router\.(get|post|put|delete|all)\(' server/routers/*.js
# Socket event registrations in dedicated handlers
grep -rn 'socket\.on(' server/socket-handlers/
# Socket event registrations in the main connection handler
grep -n 'socket\.on(' server/server.js
# All server->client emits
grep -rno 'emit("[a-zA-Z]*"' server --include=*.js | sort -u
# Mounting of routers
grep -n "routers/" server/server.js
```
