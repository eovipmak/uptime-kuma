# Monitoring Engine Touchpoints Survey (AS-IS)

> Static-analysis map of the monitoring engine: how monitors are loaded into the scheduler, where heartbeats are written, and where notifications are dispatched. Concrete file paths and symbol names only; no recommendations.

## 1. Monitor type registry

- All monitor type implementations are instantiated and registered in the `UptimeKumaServer` constructor at `server/uptime-kuma-server.js:113-137` into the static map `UptimeKumaServer.monitorTypeList` (`server/uptime-kuma-server.js:55`).
- Implementations live in `server/monitor-types/`. The base class is `MonitorType` in `server/monitor-types/monitor-type.js`; the beat loop dispatches through the static registry: `const monitorType = UptimeKumaServer.monitorTypeList[this.type]; await monitorType.check(this, bean, UptimeKumaServer.getInstance())` (`server/model/monitor.js:869-872`). Types not present in the registry (`http`, `keyword`, `json-query`, `ping`, `push`, `docker`, `radius`) are implemented inline inside `beat()` itself.
- Registry entries (type string → class): `real-browser`, `tailscale-ping`, `websocket-upgrade`, `dns`, `postgres`, `mqtt`, `smtp`, `group`, `snmp`, `grpc-keyword`, `mongodb`, `rabbitmq`, `sip-options`, `gamedig`, `steam`, `port` (TCP), `manual`, `globalping`, `redis`, `pm2`, `system-service`, `sqlserver`, `mysql`, `oracledb`, `ntp` — plus `push`, which is not a registered class: push monitors are driven by the HTTP route `/api/push/:pushToken` instead of a scheduled check.
- Files present under `server/monitor-types/` (26 files):

```text
dns.js, gamedig.js, globalping.js, group.js, grpc.js, manual.js, mongodb.js,
monitor-type.js (base class), mqtt.js, mssql.js, mysql.js, ntp.js, oracledb.js,
pm2.js, postgres.js, rabbitmq.js, real-browser-monitor-type.js, redis.js,
sip-options.js, smtp.js, snmp.js, steam.js, system-service.js, tailscale-ping.js,
tcp.js, websocket-upgrade.js
```

(25 monitor-type implementations + 1 shared base-class file.)

## 2. How monitors load into the scheduler

| Step | Location | Symbol |
| --- | --- | --- |
| Server boot → after listen | `server/server.js:1777-1783` | inside `server.httpServer.listen(...)` callback: `await startMonitors(); await initBackgroundJobs();` |
| Load all active monitors | `server/server.js:1951-1969` | `async function startMonitors()` — `R.find("monitor", " active = 1 ")`, puts each bean into the in-memory map `UptimeKumaServer.monitorList` keyed by monitor id, then calls `monitor.start(io)` with a random 300–1000 ms stagger between starts |
| Single monitor start/resume | `server/server.js:1901-1932` | `async function startMonitor(userID, monitorID)` — verifies ownership (`checkOwner`), sets `active = 1`, inserts bean into `server.monitorList`, calls `monitor.start(io)` |
| Pause/stop | `server/server.js:1934-1948` | `async function pauseMonitor(userID, monitorID)` — ownership check, `active = 0`, calls `monitor.stop()` |
| Per-monitor loop | `server/model/monitor.js:414-1105` | `Monitor.start(io)` defines the `beat()` closure and `safeBeat()` error wrapper; each iteration re-arms itself with `setTimeout(safeBeat, intervalRemainingMs)` stored on `this.heartbeatInterval` (self-scheduling timer per monitor, no central queue) |
| Stop loop | `server/model/monitor.js:1211-1216` | `Monitor.stop()` — `clearTimeout(this.heartbeatInterval); this.isStop = true;` |
| Monitor-type dispatch | `server/model/monitor.js` (inside `beat()`) | resolves the registered type from `UptimeKumaServer.monitorTypeList[this.type]` and invokes its check; result determines `bean.status` |

The in-memory maps that matter:

- `server.monitorList` — every started monitor bean (`server/uptime-kuma-server.js:33`).
- `server.maintenanceList` — all maintenance beans, loaded once at boot (`loadMaintenanceList`, `server/uptime-kuma-server.js:320-327`) and consulted by `getMaintenance(maintenanceID)` (`:334-339`).

## 3. Where heartbeats are written

There are exactly two heartbeat writers:

1. **Scheduled beat loop** — `beat()` closure in `Monitor.start()`:
   - dispenses the bean: `let bean = R.dispense("heartbeat")` with `bean.monitor_id = this.id` (`server/model/monitor.js:447-453`);
   - updates uptime aggregates first via `UptimeCalculator.getUptimeCalculator(this.id).update(bean.status, parseFloat(bean.ping))` (`server/model/monitor.js:1053-1056`);
   - persists the beat with `await R.store(bean);` (`server/model/monitor.js:1067`, log tag `[name] Store`).
2. **Push ingestion route** — `router.all("/api/push/:pushToken")` in `server/routers/api-router.js:47-146`:
   - finds the active monitor by `push_token` (`R.findOne("monitor", " push_token = ? AND active = 1 ")`, line 62);
   - dispenses/stores a heartbeat bean the same way (`R.dispense("heartbeat")` line 72, `R.store(bean)` line 125);
   - applies the same retry/maintenance logic via local `determineStatus()` (`api-router.js:576-619`) and `Monitor.isUnderMaintenance(monitor.id)` (line 84).

Heartbeat row shape/status codes are documented in `server/model/heartbeat.js:5-9` (0=DOWN, 1=UP, 2=PENDING, 3=MAINTENANCE). The `response` payload column is brotli-compressed base64, decoded by `Heartbeat.decodeResponseValue()` (`server/model/heartbeat.js:66-78`).

### Stat aggregates written from the same flow

- `server/uptime-calculator.js` upserts one row per monitor+period into `stat_minutely`, `stat_hourly`, `stat_daily`:
  - store points: `await R.store(dailyStatBean)` (`:315`), `await R.store(hourlyStatBean)` (`:335`), `await R.store(minutelyStatBean)` (`:354`);
  - retention deletes for minutely/hourly (`:362-368`).
- Manual clearing: socket events `clearEvents`/`clearHeartbeats`/`clearStatistics` in `server/server.js:1658-1729`; `UptimeCalculator.clearAllStatistics()` deletes stat rows per monitor (`server/uptime-calculator.js:853-857`).

### Retention jobs

- `server/jobs.js` registers croner jobs at startup (`initBackgroundJobs`, called from `server/server.js:1777`):
  - `clear-old-data` (daily `14 03 * * *`) → `clearOldData()` in `server/jobs/clear-old-data.js:13` — deletes `heartbeat` rows older than the configured period (`DELETE FROM heartbeat WHERE time < ...`, line 44) and old `stat_daily` rows (line 49).
  - `incremental-vacuum` (every 5 minutes) → `incrementalVacuum()` in `server/jobs/incremental-vacuum.js`.

## 4. Where notifications are dispatched

Call chain (scheduled path):

1. Status-transition detection: `Monitor.isImportantBeat(isFirstBeat, previousBeatStatus, currentBeatStatus)` — `server/model/monitor.js:1385`.
2. Notification gating: `Monitor.isImportantForNotification(...)` — `server/model/monitor.js:1420`.
3. Dispatch: `static async sendNotification(isFirstBeat, monitor, bean)` — `server/model/monitor.js:1452`:
   - loads providers via `Monitor.getNotificationList(monitor)` (`server/model/monitor.js:1526-1530`: SQL join of `notification` × `monitor_notification` on `monitor_id`);
   - builds `msg` and heartbeat JSON, then loops `for (let notification of notificationList) { await Notification.send(JSON.parse(notification.config), msg, monitor.toJSON(...), heartbeatJSON) }` (`server/model/monitor.js:1516-1523`);
   - resend logic for sustained DOWN uses `bean.downCount` vs `monitor.resend_interval` (`server/model/monitor.js:987-1002`).
4. Provider resolution: `Notification.send(notification, msg, monitorJSON, heartbeatJSON)` — `server/notification.js:254-261`; looks up `this.providerList[notification.type]` and delegates to the provider's `send(...)`.
5. Providers: 107 files under `server/notification-providers/` (single-line reference count only, per task scope).

The push path repeats steps 1–4 inline in `server/routers/api-router.js:100-123` (`Monitor.isImportantForNotification` → `Monitor.sendNotification`), plus domain-expiry notifications via `DomainExpiry.sendNotifications(...)` (`server/model/monitor.js:1010` and `api-router` has no equivalent).

Default-notification application when a provider is created with "applyExisting": `applyNotificationEveryMonitor(bean.id, userID)` called from `Notification.save()` (`server/notification.js:286-296`).

## 5. Where the owner concept (`user_id`) currently influences these flows

| Touchpoint | File:line | Observation |
| --- | --- | --- |
| Socket room addressing | `server/server.js:1759-1761` (`afterLogin`) | `socket.userID = user.id; socket.join(user.id)` — one room per user id. |
| Live beat delivery | `server/model/monitor.js:1059-1061` | `io.to(this.user_id).emit("heartbeat", bean.toJSON()); Monitor.sendStats(io, this.id, this.user_id);` — the beat loop reads the monitor's `user_id` column directly to pick the room. Same pattern in push route `server/routers/api-router.js:127-129`. |
| Stats emission | `server/model/monitor.js:1315-1343` (`Monitor.sendStats`) | Emits `avgPing`, `uptime`, `certInfo`, `domainInfo` to room `userID`. |
| Ownership checks | `server/server.js` `checkOwner(userID, monitorID)` used by `startMonitor`/`pauseMonitor` (1901+, 1934+); handler-level `id = ? AND user_id = ?` queries (e.g. `getMonitor` :1017, `deleteMonitor` :1140) | All monitor mutations are scoped by comparing `monitor.user_id` with `socket.userID`. |
| Maintenance list push | `server/model/monitor.js:1020` | After important beats, `UptimeKumaServer.getInstance().sendMaintenanceListByUserID(this.user_id)` refreshes the owner's maintenance list. Note `loadMaintenanceList(userID)` ignores its parameter and loads **all** maintenances globally (`server/uptime-kuma-server.js:320-327`). |
| Scheduler load query | `server/server.js:1952` | `startMonitors()` selects all monitors with `active = 1` regardless of user; tenancy is not part of the load query. |
| Notification recipient resolution | `server/model/monitor.js:1526-1530` | Notification list is resolved monitor→`monitor_notification`→`notification`; `notification.user_id` is not consulted during dispatch. |

## Reproduce

```bash
# Scheduler bootstrap
grep -n "startMonitors\|initBackgroundJobs" server/server.js
sed -n '/^async function startMonitors/,/^}/p' server/server.js
# Beat loop + heartbeat write + notification call sites
grep -n 'dispense("heartbeat")\|R.store(bean)\|sendNotification\|isImportantForNotification\|emit("heartbeat"' server/model/monitor.js server/routers/api-router.js
# Notification dispatch chain
grep -n "static async send(\|providerList" server/notification.js
grep -n "getNotificationList" server/model/monitor.js
# Stat aggregate writes
grep -n "stat_minutely\|stat_hourly\|stat_daily\|R.store(" server/uptime-calculator.js | head -20
# Background jobs
cat server/jobs.js; grep -n "DELETE FROM" server/jobs/*.js
# Monitor type registry
grep -n "monitorTypeList\[" server/uptime-kuma-server.js
ls server/monitor-types/
```
