# File Impact Map (AS-IS, all entries "candidate")

> Per-domain inventory of the backend model file, socket handler(s), REST router (if any), and frontend entry points that exist in the codebase today. **Every entry below is a candidate** — this map records where a domain currently lives; it asserts no change decisions. Final modification decisions belong to later phases.

Legend: **model** = `server/model/<name>.js` (or the module that owns persistence); **socket** = Socket.IO handler registering events for the domain; **REST** = HTTP routes touching the domain; **frontend** = real Vue entry points found by search under `src/`.

## user

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/user.js` | User bean. |
| model (auth logic) | `server/auth.js` | `login()`, 2FA verify, API key verification (`verifyAPIKey`). |
| socket | `server/server.js` — direct handlers: `loginByToken` (:401), `login` (:450), `logout` (:530), `prepare2FA` (:544), `save2FA` (:587), `disable2FA` (:617), `verifyToken` (:646), `twoFAStatus` (:676), `setup` (:705), `changePassword` (:1446), `disconnectOtherSocketClients` via `general-socket-handler.js:152` | All scoped to `socket.userID`. |
| REST | none dedicated | Auth is socket-only; badges/push are public. |
| frontend | `src/pages/Setup.vue`, `src/components/Login.vue`, `src/pages/Settings.vue`, `src/components/settings/Security.vue`, `src/mixins/socket.js` | Login/2FA/settings UI. |

## monitor

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/monitor.js` | 2083-line bean: beat loop (`start()` :414), notification dispatch (`sendNotification` :1452), stats emits (`sendStats` :1315). |
| socket | `server/server.js` — `add` (:743), `editMonitor` (:818), `getMonitorList` (:995), `getMonitor` (:1011), `checkDomain` (:1033), `getMonitorBeats` (:1053), `resumeMonitor` (:1089), `pauseMonitor` (:1108), `deleteMonitor` (:1127), `clearEvents` (:1658), `clearHeartbeats` (:1677), `clearStatistics` (:1705); plus `chart-socket-handler.js` (`getMonitorChartData`) and tag-on-monitor events (see tag domain) | Ownership via `socket.userID`. |
| scheduler | `server/server.js` `startMonitors()`/:1951, `startMonitor()`/:1901, `pauseMonitor()`/:1934; registry in `server/uptime-kuma-server.js`:113-137 | See `monitoring-engine.md`. |
| REST | `server/routers/api-router.js` — `/api/push/:pushToken` (:47), `/api/badge/:id/*` (:148-565) | Push ingestion + public badges. |
| frontend | `src/pages/EditMonitor.vue`, `src/pages/Details.vue`, `src/pages/DashboardHome.vue`, `src/pages/List.vue`, `src/components/MonitorList.vue`, `src/components/MonitorListItem.vue`, `src/components/MonitorSettingDialog.vue`, `src/components/CreateGroupDialog.vue`, `src/components/EditMonitorConditions.vue` (+ Condition/ConditionGroup variants), `src/components/Datetime.vue`, `src/components/PingChart.vue`, `src/components/HeartbeatBar.vue`, `src/mixins/socket.js` (`heartbeat` listener :204) | Editor + dashboard + live updates. |

## notification

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model/dispatcher | `server/notification.js` (`Notification.send` :254, `save` :268) | Provider registry `providerList`. |
| providers | `server/notification-providers/*.js` (107 files) | Out of survey scope beyond this count. |
| socket | `server/server.js` — `addNotification` (:1562), `deleteNotification` (:1583), `testNotification` (:1603), `checkApprise` (:1623), `getWebpushVapidPublicKey` (:1632); list push in `server/client.js` `sendNotificationList()` (:18) | Notification rows carry `user_id`. |
| REST | none | Socket-only admin surface. |
| frontend | `src/components/NotificationDialog.vue`, `src/components/settings/Notifications.vue` | Provider config UI. |

## status_page

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/status_page.js` | Slug mapping, `getStatusPageData`, `sendStatusPageList`, incident history helpers. |
| socket | `server/socket-handlers/status-page-socket-handler.js` — `postIncident` (:34), `unpinIncident` (:84), `getIncidentHistory` (:103), `editIncident` (:124), `deleteIncident` (:187), `resolveIncident` (:227), `getStatusPage` (:268), `saveStatusPage` (:292), `addStatusPage` (:436), `deleteStatusPage` (:482) | Slug-scoped; rewrites groups on save. |
| REST | `server/routers/status-page-router.js` (all 9 routes, see `api-and-socket-events.md`) | Public/unauthenticated pages + polling data. |
| frontend | `src/pages/StatusPage.vue`, `src/pages/AddStatusPage.vue`, `src/pages/ManageStatusPage.vue`, `src/components/PublicGroupList.vue`, `src/components/IncidentHistory.vue`, `src/components/IncidentEditForm.vue`, `src/components/IncidentManageModal.vue`, `src/components/settings/General.vue` (domain/CNAME refs) | Public viewer + editor. |

## tag

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/tag.js` | Tag + monitor_tag beans. Tags are global (no owner column). |
| socket | `server/server.js` — `getTags` (:1217), `addTag` (:1235), `editTag` (:1256), `deleteTag` (:1287), `addMonitorTag` (:1306), `editMonitorTag` (:1331), `deleteMonitorTag` (:1356) | Global tag CRUD + per-monitor assignment. |
| REST | none | |
| frontend | `src/components/TagsManager.vue`, `src/components/TagEditDialog.vue`, `src/components/Tag.vue`, `src/pages/EditMonitor.vue` (tag section), `src/components/MonitorListFilterDropdown.vue` | Tag editing and filtering. |

## maintenance

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/maintenance.js` | `run()` (:212), strategy logic, timeslot generation. |
| socket | `server/socket-handlers/maintenance-socket-handler.js` — 11 events (:16–:287, full table in `api-and-socket-events.md`) | Owner-scoped (`user_id = ?`). |
| REST | none | |
| frontend | `src/pages/EditMaintenance.vue`, `src/pages/ManageMaintenance.vue`, `src/components/MaintenanceTime.vue` | Editor + manager UI. |

## heartbeat

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/heartbeat.js` | Bean with `toPublicJSON`/`toJSON`; response decoding. |
| writer | `server/model/monitor.js` beat loop (`R.store(bean)` :1067) and `server/routers/api-router.js` push route (`R.store(bean)` :125) | Two writers only; see `monitoring-engine.md`. |
| socket | No dedicated handler — served via `server/server.js` `getMonitorBeats` (:1053), `monitorImportantHeartbeatListCount` (:1381), `monitorImportantHeartbeatListPaged` (:1404); initial history pushed by `server/client.js` `sendHeartbeatList()` (:46); live pushes from `Monitor.sendStats`/beat loop | |
| REST | `GET /api/status-page/heartbeat/:slug` (`status-page-router.js:64`), badge routes reading heartbeats | Public polling. |
| retention | `server/jobs/clear-old-data.js` (`DELETE FROM heartbeat ...` :44) | Cron-driven. |
| frontend | `src/components/HeartbeatBar.vue`, `src/components/MonitorListItem.vue`, `src/pages/Details.vue`, `src/components/PingChart.vue`, `src/mixins/socket.js` | Beat visualization. |

## incident

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/incident.js` | Incident bean tied to `status_page_id`. |
| socket | `server/socket-handlers/status-page-socket-handler.js` — `postIncident`, `unpinIncident`, `getIncidentHistory`, `editIncident`, `deleteIncident`, `resolveIncident` (lines above) | Slug-scoped. |
| REST | `GET /api/status-page/:slug/incident-history` (`status-page-router.js:145`) | Public read. |
| frontend | `src/components/IncidentEditForm.vue`, `src/components/IncidentHistory.vue`, `src/components/IncidentManageModal.vue`, `src/pages/StatusPage.vue` | Authoring + display. |

## proxy

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/proxy.js` | Proxy bean; applied to monitors via `monitor.proxy_id`. |
| socket | `server/socket-handlers/proxy-socket-handler.js` — `addProxy` (:13), `deleteProxy` (:39); list push in `server/client.js` `sendProxyList()` (:104) | User-scoped save/delete. |
| REST | none | |
| frontend | `src/components/ProxyDialog.vue`, `src/components/settings/Proxies.vue`, `src/pages/EditMonitor.vue` (proxy select) | |

## docker_host

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/docker_host.js` | Docker host bean. |
| socket | `server/socket-handlers/docker-socket-handler.js` — `addDockerHost` (:12), `deleteDockerHost` (:33), `testDockerHost` (:53); list push in `server/client.js` `sendDockerHostList()` (:170) | User-scoped save/delete. |
| REST | none | |
| frontend | `src/components/DockerHostDialog.vue`, `src/components/settings/Docker.vue`, `src/pages/EditMonitor.vue` (docker monitor fields) | |

## api_key

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/api_key.js` | Key bean; validation consumed by `server/auth.js` `verifyAPIKey`. |
| socket | `server/socket-handlers/api-key-socket-handler.js` — `addAPIKey` (:18), `getAPIKeyList` (:54), `deleteAPIKey` (:70), `disableAPIKey` (:95), `enableAPIKey` (:120); list push in `server/client.js` `sendAPIKeyList()` (:123) | `user_id`-scoped SQL. |
| REST | none currently uses the auth middleware | Middleware exists at `server/auth.js`. |
| frontend | `src/components/APIKeyDialog.vue`, `src/components/settings/APIKeys.vue` | Key management UI. |

## monitor_group

(`group` table + `monitor_group` junction)

| Layer | File (candidate) | Notes |
| --- | --- | --- |
| model | `server/model/group.js` (group bean); group membership handled inside `server/model/monitor.js` helpers and `server/model/status_page.js` (`save` rewrites public groups) | Groups attach to status pages via `group.status_page_id`. |
| socket | `server/socket-handlers/status-page-socket-handler.js` `saveStatusPage` (:292) creates/deletes groups and `monitor_group` rows; monitor-side wiring inside `server/server.js` `add`/`editMonitor`/`deleteMonitor` (parent/child handling :1127-1180) | |
| REST | badge/heartbeat routes join `monitor_group`+`group` for public visibility (`api-router.js:351-422`, `status-page-router.js:64-110,170-262`) | |
| frontend | `src/components/CreateGroupDialog.vue`, `src/pages/DashboardHome.vue`, `src/pages/EditMonitor.vue` (parent monitor field), `src/pages/StatusPage.vue`, `src/components/PublicGroupList.vue` | Group editor + public rendering. |

## Cross-cutting infrastructure (context, not a domain row)

| Concern | Files (candidate) |
| --- | --- |
| Tenancy boundary today | `user_id` columns + `socket.userID` room joins (`server/server.js:1759-1761`); see `database-schema.md` summary table. |
| Aggregation | `server/uptime-calculator.js` (stat tables writer/reader). |
| Background jobs | `server/jobs.js`, `server/jobs/clear-old-data.js`, `server/jobs/incremental-vacuum.js`. |
| Settings store | `server/settings.js` + global `setting` table. |
| Metrics export | `server/prometheus.js`. |

## Reproduce

```bash
# Model files
ls server/model/
# Socket handlers per domain
grep -rn "socket.on(" server/socket-handlers/
# Frontend references per keyword (example: status page)
grep -rln "StatusPage" src/pages src/components
# Frontend files referencing socket lifecycle
grep -rn "socket.on(" src/mixins/socket.ts src/mixins/socket.js
```
