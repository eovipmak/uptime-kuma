let express = require("express");
const {
    allowDevAllOrigin,
    allowAllOrigin,
    percentageToColor,
    filterAndJoin,
    sendHttpError,
} = require("../util-server");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const Monitor = require("../model/monitor");
const dayjs = require("dayjs");
const { UP, MAINTENANCE, DOWN, PENDING, flipStatus, log, badgeConstants } = require("../../src/util");
const StatusPage = require("../model/status_page");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { makeBadge } = require("badge-maker");
const { Prometheus } = require("../prometheus");
const Database = require("../database");
const { UptimeCalculator } = require("../uptime-calculator");
// G2 task-11: push flow emits to the monitor's tenant-scoped user room
const { userRoom } = require("../socket-handlers/tenant-room");
const TenantUser = require("../model/tenant_user");
const User = require("../model/user");
const TranslatableError = require("../translatable-error");
const { bearerAuth, extractRequestHostname, findTenantByIdOrSlug, getMembershipRole } = require("../middleware");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();
let io = server.io;

// G3 task-15 — HTTP router RBAC enforcement sweep.
//
// This fork's HTTP surface is intentionally read-only/public: every business
// mutation lives on Socket.IO, which is gated by task-14's socket-side RBAC
// helpers against the same task-13 matrix. Each route below therefore carries
// an explicit disposition:
//   - `// RBAC: public, no auth`      -> anonymous by design (G2 task-10
//     TENANT_GUARD_EXEMPT_PREFIXES keep them outside requireTenantContext()).
//   - `// RBAC: membership, not role` -> authenticated + membership-checked in
//     the handler; no role gate (task-13 matrix has no permission for it).
// If a future authenticated business route is added here, mount
// requirePermission(PERMISSIONS...) from ../middleware/require-rbac as the
// first route-level middleware (see docs/kanban .../task-15.md).

// RBAC: public, no auth — entry page config for anonymous SPA bootstrap
// (G2 task-10 exempt prefix).
router.get("/api/entry-page", async (request, response) => {
    allowDevAllOrigin(response);

    let result = {};
    let hostname = await extractRequestHostname(request);

    if (hostname in StatusPage.domainMappingList) {
        result.type = "statusPageMatchedDomain";
        // G6.24: mapping values are now { tenantId, slug }; keep the wire
        // format a plain slug string for the SPA bootstrap (frontend owns any
        // richer contract later).
        result.statusPageSlug = StatusPage.domainMappingList[hostname].slug;
    } else {
        result.type = "entryPage";
        result.entryPage = server.entryPage;
    }
    response.json(result);
});

// G2.10 — Switch the active tenant of the caller's session and re-issue a JWT
// with the new tenant claims (consumes the task-09 claim contract). This is
// the HTTP convenience mirror; the canonical switch flow stays socket.io
// loginByToken. Membership is verified via tenant_user before any token is
// issued — a non-member gets TranslatableError("tenantAccessDenied").
router.post(
    "/api/switch-tenant",
    // RBAC: membership, not role — no permission in the task-13 matrix;
    // getMembershipRole() below rejects non-members with tenantAccessDenied
    // (parity with task-14's socket-side switchTenant exemption).
    bearerAuth(),
    async (request, response) => {
    try {
        if (!request.user || !request.user.id) {
            sendHttpError(response, "Unauthorized");
            return;
        }

        const reference = request.body ? request.body.tenantId : null;
        if (reference == null || reference === "") {
            sendHttpError(response, "Tenant not found.");
            return;
        }

        // Accept both the numeric id and the human slug form.
        const tenant = await findTenantByIdOrSlug(reference);
        if (!tenant) {
            sendHttpError(response, "Tenant not found.");
            return;
        }

        const role = await getMembershipRole(request.user.id, tenant.id);
        if (role == null) {
            throw new TranslatableError("tenantAccessDenied");
        }

        const userBean = await R.findOne("user", " id = ? ", [ request.user.id ]);
        if (!userBean) {
            sendHttpError(response, "Unauthorized");
            return;
        }

        const token = User.createJWT(userBean, tenant.id, role, server.jwtSecret);
        log.info("tenant", `User ${request.user.username} switched to tenant ${tenant.slug}`);
        response.json({
            ok: true,
            token,
            tenant: {
                id: tenant.id,
                slug: tenant.slug,
                name: tenant.name,
                role: role,
            },
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — push-token IS the credential (monitor-scoped
// secret; G2 task-10 exempt prefix).
router.all("/api/push/:pushToken", async (request, response) => {
    try {
        let pushToken = request.params.pushToken;
        let msg = request.query.msg || "OK";
        let ping = parseFloat(request.query.ping) || null;
        let statusString = request.query.status || "up";
        const statusFromParam = statusString === "up" ? UP : DOWN;

        // Validate ping value - max 100 billion ms (~3.17 years)
        // Fits safely in both BIGINT and FLOAT(20,2)
        const MAX_PING_MS = 100000000000;
        if (ping !== null && (ping < 0 || ping > MAX_PING_MS)) {
            throw new Error(`Invalid ping value. Must be between 0 and ${MAX_PING_MS} ms.`);
        }

        let monitor = await R.findOne("monitor", " push_token = ? AND active = 1 ", [pushToken]);

        if (!monitor) {
            throw new Error("Monitor not found or not active.");
        }

        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);

        let isFirstBeat = true;

        let bean = R.dispense("heartbeat");
        bean.time = R.isoDateTimeMillis(dayjs.utc());
        bean.monitor_id = monitor.id;
        bean.ping = ping;
        bean.msg = msg;
        bean.downCount = previousHeartbeat?.downCount || 0;

        if (previousHeartbeat) {
            isFirstBeat = false;
            bean.duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
        }

        if (await Monitor.isUnderMaintenance(monitor.id)) {
            msg = "Monitor under maintenance";
            bean.status = MAINTENANCE;
        } else {
            determineStatus(statusFromParam, previousHeartbeat, monitor.maxretries, monitor.isUpsideDown(), bean);
        }

        // Calculate uptime
        // G5.21 frozen signature: tenant first; the push-token monitor bean
        // carries its owning tenant (null for pre-backfill rows resolves
        // internally).
        let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitor.tenant_id, monitor.id);
        let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
        bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

        log.debug("router", `/api/push/ called at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
        log.debug("router", "PreviousStatus: " + previousHeartbeat?.status);
        log.debug("router", "Current Status: " + bean.status);

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousHeartbeat?.status, bean.status);

        if (Monitor.isImportantForNotification(isFirstBeat, previousHeartbeat?.status, bean.status)) {
            // Reset down count
            bean.downCount = 0;

            log.debug("monitor", `[${monitor.name}] sendNotification`);
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        } else {
            if (bean.status === DOWN && monitor.resendInterval > 0) {
                ++bean.downCount;
                if (bean.downCount >= monitor.resendInterval) {
                    // Send notification again, because we are still DOWN
                    log.debug(
                        "monitor",
                        `[${monitor.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${monitor.resendInterval}`
                    );
                    await Monitor.sendNotification(isFirstBeat, monitor, bean);

                    // Reset down count
                    bean.downCount = 0;
                }
            }
        }

        await R.store(bean);

        // G2 task-11: route to the monitor's tenant-scoped user room; rows
        // predating the G4 tenant backfill fall back to the owner's primary tenant.
        const pushTenantID = (monitor.tenant_id != null) ? monitor.tenant_id : await TenantUser.getPrimaryTenantID(monitor.user_id);
        if (pushTenantID) {
            io.to(userRoom(pushTenantID, monitor.user_id)).emit("heartbeat", bean.toJSON());
        }

        // G5.21 frozen signature: tenant first. The push bean carries its
        // own tenant_id (null for pre-backfill rows — sendStats then routes
        // via the owner's primary tenant).
        Monitor.sendStats(io, monitor.tenant_id, monitor.id, monitor.user_id);

        try {
            new Prometheus(monitor, await monitor.getTags()).update(bean, undefined);
        } catch (e) {
            log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
        }

        response.json({
            ok: true,
        });
    } catch (e) {
        response.status(404).json({
            ok: false,
            msg: e.message,
        });
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/status", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        upLabel = "Up",
        downLabel = "Down",
        pendingLabel = "Pending",
        maintenanceLabel = "Maintenance",
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        pendingColor = badgeConstants.defaultPendingColor,
        maintenanceColor = badgeConstants.defaultMaintenanceColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }
        const overrideValue = value !== undefined ? parseInt(value) : undefined;
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(requestedMonitorId);
            const state = overrideValue !== undefined ? overrideValue : heartbeat.status;

            if (label === undefined) {
                badgeValues.label = "Status";
            } else {
                badgeValues.label = label;
            }
            switch (state) {
                case DOWN:
                    badgeValues.color = downColor;
                    badgeValues.message = downLabel;
                    break;
                case UP:
                    badgeValues.color = upColor;
                    badgeValues.message = upLabel;
                    break;
                case PENDING:
                    badgeValues.color = pendingColor;
                    badgeValues.message = pendingLabel;
                    break;
                case MAINTENANCE:
                    badgeValues.color = maintenanceColor;
                    badgeValues.message = maintenanceLabel;
                    break;
                default:
                    badgeValues.color = badgeConstants.naColor;
                    badgeValues.message = "N/A";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/uptime/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultUptimeLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultUptimeValueSuffix,
        color,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }
        // if no duration is given, set value to 24 (h)
        let requestedDuration = request.params.duration !== undefined ? request.params.duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            // G5.21 frozen signature: tenant first; public badge path has no
            // session tenant — resolved internally from the monitor row.
            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(null, requestedMonitorId);
            const uptime = overrideValue ?? uptimeCalculator.getDataByDuration(requestedDuration).uptime;

            // limit the displayed uptime percentage to four (two, when displayed as percent) decimal digits
            const cleanUptime = (uptime * 100).toPrecision(4);

            // use a given, custom color or calculate one based on the uptime value
            badgeValues.color = color ?? percentageToColor(uptime);
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Uptime (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, cleanUptime, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/ping/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultPingLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        let requestedDuration = request.params.duration !== undefined ? request.params.duration : "24h";
        const overrideValue = value && parseFloat(value);

        if (/^[0-9]+$/.test(requestedDuration)) {
            requestedDuration = `${requestedDuration}h`;
        }

        // Check if monitor is public
        const publicMonitor = await isMonitorPublic(requestedMonitorId);

        // G5.21 frozen signature: tenant first; public badge path has no
        // session tenant — resolved internally from the monitor row.
        const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(null, requestedMonitorId);
        const avgPing = uptimeCalculator.getDataByDuration(requestedDuration).avgPing;

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPingValue = parseInt(overrideValue ?? avgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a lable string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Ping (${requestedDuration.slice(0, -1)}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPingValue, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/avg-response/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        const requestedDuration = Math.min(request.params.duration ? parseInt(request.params.duration, 10) : 24, 720);
        const overrideValue = value && parseFloat(value);

        const sqlHourOffset = Database.sqlHourOffset();

        const publicAvgPing = parseInt(
            await R.getCell(
                `
            SELECT AVG(ping) FROM monitor_group, \`group\`, heartbeat
            WHERE monitor_group.group_id = \`group\`.id
            AND heartbeat.time > ${sqlHourOffset}
            AND heartbeat.ping IS NOT NULL
            AND public = 1
            AND heartbeat.monitor_id = ?
            `,
                [-requestedDuration, requestedMonitorId]
            )
        );

        const badgeValues = { style };

        if (!publicAvgPing) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPing = parseInt(overrideValue ?? publicAvgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Response (${requestedDuration}h)`,
                labelSuffix,
            ]);
            badgeValues.message = filterAndJoin([prefix, avgPing, suffix]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/cert-exp", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const date = request.query.date;

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = date ? "" : badgeConstants.defaultCertExpValueSuffix,
        upColor = badgeConstants.defaultUpColor,
        warnColor = badgeConstants.defaultWarnColor,
        downColor = badgeConstants.defaultDownColor,
        warnDays = badgeConstants.defaultCertExpireWarnDays,
        downDays = badgeConstants.defaultCertExpireDownDays,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [requestedMonitorId]);

            if (!tlsInfoBean) {
                // return a "No/Bad Cert" badge in naColor (grey), if no cert saved (does not save bad certs?)
                badgeValues.message = "No/Bad Cert";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const tlsInfo = JSON.parse(tlsInfoBean.info_json);

                if (!tlsInfo.valid) {
                    // return a "Bad Cert" badge in naColor (grey), when cert is not valid
                    badgeValues.message = "Bad Cert";
                    badgeValues.color = downColor;
                } else {
                    const daysRemaining = parseInt(overrideValue ?? tlsInfo.certInfo.daysRemaining);

                    if (daysRemaining > warnDays) {
                        badgeValues.color = upColor;
                    } else if (daysRemaining > downDays) {
                        badgeValues.color = warnColor;
                    } else {
                        badgeValues.color = downColor;
                    }
                    // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                    badgeValues.labelColor = labelColor ?? "";
                    // build a label string. If a custom label is given, override the default one
                    badgeValues.label = filterAndJoin([labelPrefix, label ?? "Cert Exp.", labelSuffix]);
                    badgeValues.message = filterAndJoin([
                        prefix,
                        date ? tlsInfo.certInfo.validTo : daysRemaining,
                        suffix,
                    ]);
                }
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// RBAC: public, no auth — badge for public monitors only
// (isMonitorPublic gate inside; G2 task-10 exempt prefix).
router.get("/api/badge/:id/response", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        if (Number.isNaN(requestedMonitorId)) {
            throw new Error("Invalid monitor ID");
        }

        const overrideValue = value && parseFloat(value);
        const publicMonitor = await isMonitorPublic(requestedMonitorId);
        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(requestedMonitorId);

            if (!heartbeat.ping) {
                // return a "N/A" badge in naColor (grey), if previous heartbeat has no ping

                badgeValues.message = "N/A";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const ping = parseInt(overrideValue ?? heartbeat.ping);

                badgeValues.color = color;
                // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                badgeValues.labelColor = labelColor ?? "";
                // build a label string. If a custom label is given, override the default one
                badgeValues.label = filterAndJoin([labelPrefix, label ?? "Response", labelSuffix]);
                badgeValues.message = filterAndJoin([prefix, ping, suffix]);
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * Determines the status of the next beat in the push route handling.
 * @param {string} status - The reported new status.
 * @param {object} previousHeartbeat - The previous heartbeat object.
 * @param {number} maxretries - The maximum number of retries allowed.
 * @param {boolean} isUpsideDown - Indicates if the monitor is upside down.
 * @param {object} bean - The new heartbeat object.
 * @returns {void}
 */
function determineStatus(status, previousHeartbeat, maxretries, isUpsideDown, bean) {
    if (isUpsideDown) {
        status = flipStatus(status);
    }

    if (previousHeartbeat) {
        if (previousHeartbeat.status === UP && status === DOWN) {
            // Going Down
            if (maxretries > 0 && previousHeartbeat.retries < maxretries) {
                // Retries available
                bean.retries = previousHeartbeat.retries + 1;
                bean.status = PENDING;
            } else {
                // No more retries
                bean.retries = 0;
                bean.status = DOWN;
            }
        } else if (previousHeartbeat.status === PENDING && status === DOWN && previousHeartbeat.retries < maxretries) {
            // Retries available
            bean.retries = previousHeartbeat.retries + 1;
            bean.status = PENDING;
        } else {
            // No more retries or not pending
            if (status === DOWN) {
                bean.retries = previousHeartbeat.retries + 1;
                bean.status = status;
            } else {
                bean.retries = 0;
                bean.status = status;
            }
        }
    } else {
        // First beat?
        if (status === DOWN && maxretries > 0) {
            // Retries available
            bean.retries = 1;
            bean.status = PENDING;
        } else {
            // Retires not enabled
            bean.retries = 0;
            bean.status = status;
        }
    }
}

/**
 * Check whether a monitor is publc
 * @param {number} monitorID - Monitor id
 * @returns {Promise<boolean>} true if the monitor is public, otherwise false
 */
async function isMonitorPublic(monitorID) {
    let publicMonitor = await R.getRow(
        `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor_group.monitor_id = ?
            AND public = 1
        `,
        [monitorID]
    );
    return !!publicMonitor;
}

module.exports = router;
