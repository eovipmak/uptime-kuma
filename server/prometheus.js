const PrometheusClient = require("prom-client");
const { log } = require("../src/util");
const { R } = require("redbean-node");

// G4.20 cache-key note: Prometheus exports are process-global system metrics
// scraped per install, not per tenant. There are no hand-written cache keys in
// this module — cache key not tenant-scoped; metric is global (task-20 step 3).
let monitorCertDaysRemaining = null;
let monitorCertIsValid = null;
let monitorUptimeRatio = null;
let monitorAverageResponseTimeSeconds = null;
let monitorResponseTime = null;
let monitorStatus = null;

class Prometheus {
    monitorLabelValues = {};

    /**
     * @param {object} monitor Monitor object to monitor
     * @param {Array<{name:string,value:?string}>} tags Tags to add to the monitor
     */
    constructor(monitor, tags) {
        this.monitorLabelValues = {
            ...this.mapTagsToLabels(tags),
            // G5.23: every exported series is labeled with the owning tenant.
            // Null-tenant rows (pre-G1 backfill edge) export an empty label
            // value instead of being dropped.
            tenant_id: monitor.tenant_id != null ? String(monitor.tenant_id) : "",
            monitor_id: monitor.id,
            monitor_name: monitor.name,
            monitor_type: monitor.type,
            monitor_url: monitor.url,
            monitor_hostname: monitor.hostname,
            monitor_port: monitor.port,
        };
    }

    /**
     * Initialize Prometheus metrics, and add all available tags as possible labels.
     * This should be called once at the start of the application.
     * New tags will NOT be added dynamically, a restart is sadly required to add new tags to the metrics.
     * Existing tags added to monitors will be updated automatically.
     * @returns {Promise<void>}
     */
    static async init() {
        // Add all available tags as possible labels,
        // and use Set to remove possible duplicates (for when multiple tags contain non-ascii characters, and thus are sanitized to the same label)
        const tags = new Set(
            (await R.findAll("tag"))
                .map((tag) => {
                    return Prometheus.sanitizeForPrometheus(tag.name);
                })
                .filter((tagName) => {
                    return tagName !== "";
                })
                .sort(this.sortTags)
        );

        const commonLabels = [
            // G5.23: tenant_id leads the label set so multi-tenant scrapes can
            // be filtered/aggregated per tenant without renaming any metric
            // (backward compatible for existing dashboards).
            "tenant_id",
            ...tags,
            "monitor_id",
            "monitor_name",
            "monitor_type",
            "monitor_url",
            "monitor_hostname",
            "monitor_port",
        ];

        monitorCertDaysRemaining = new PrometheusClient.Gauge({
            name: "monitor_cert_days_remaining",
            help: "The number of days remaining until the certificate expires",
            labelNames: commonLabels,
        });

        monitorCertIsValid = new PrometheusClient.Gauge({
            name: "monitor_cert_is_valid",
            help: "Is the certificate still valid? (1 = Yes, 0= No)",
            labelNames: commonLabels,
        });

        monitorUptimeRatio = new PrometheusClient.Gauge({
            name: "monitor_uptime_ratio",
            help: "Uptime ratio calculated over sliding window specified by the 'window' label. (0.0 - 1.0)",
            labelNames: [...commonLabels, "window"],
        });

        monitorAverageResponseTimeSeconds = new PrometheusClient.Gauge({
            name: "monitor_response_time_seconds",
            help: "Average response time in seconds calculated over sliding window specified by the 'window' label",
            labelNames: [...commonLabels, "window"],
        });

        monitorResponseTime = new PrometheusClient.Gauge({
            name: "monitor_response_time",
            help: "Monitor Response Time (ms)",
            labelNames: commonLabels,
        });

        monitorStatus = new PrometheusClient.Gauge({
            name: "monitor_status",
            help: "Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)",
            labelNames: commonLabels,
        });
    }

    /**
     * Sanitize a string to ensure it can be used as a Prometheus label or value.
     * See https://github.com/louislam/uptime-kuma/pull/4704#issuecomment-2366524692
     * @param {string} text The text to sanitize
     * @returns {string} The sanitized text
     */
    static sanitizeForPrometheus(text) {
        text = text.replace(/[^a-zA-Z0-9_]/g, "");
        text = text.replace(/^[^a-zA-Z_]+/, "");
        return text;
    }

    /**
     * Map the tags value to valid labels used in Prometheus. Sanitize them in the process.
     * @param {Array<{name: string, value:?string}>} tags The tags to map
     * @returns {object} The mapped tags, usable as labels
     */
    mapTagsToLabels(tags) {
        let mappedTags = {};
        tags.forEach((tag) => {
            let sanitizedTag = Prometheus.sanitizeForPrometheus(tag.name);
            if (sanitizedTag === "") {
                return; // Skip empty tag names
            }

            if (mappedTags[sanitizedTag] === undefined) {
                mappedTags[sanitizedTag] = [];
            }

            let tagValue = Prometheus.sanitizeForPrometheus(tag.value || "");
            if (tagValue !== "") {
                mappedTags[sanitizedTag].push(tagValue);
            }

            mappedTags[sanitizedTag] = mappedTags[sanitizedTag].sort();
        });

        // Order the tags alphabetically
        return Object.keys(mappedTags)
            .sort(this.sortTags)
            .reduce((obj, key) => {
                obj[key] = mappedTags[key];
                return obj;
            }, {});
    }

    /**
     * Merge the effective label values for an update/remove call (G5.23).
     * The tenant_id label value comes from the explicit argument when given,
     * otherwise falls back to the constructor-captured monitor tenant.
     * @param {number|null|undefined} tenantId Tenant override supplied by the caller
     * @returns {object} Complete label values object for every gauge
     */
    buildLabelValues(tenantId) {
        return {
            ...this.monitorLabelValues,
            tenant_id: tenantId != null ? String(tenantId) : (this.monitorLabelValues.tenant_id ?? ""),
        };
    }

    /**
     * Update the metrics page
     * @typedef {import("./uptime-calculator").UptimeDataResult} UptimeDataResult
     * @param {number|null} tenantId Owning tenant of the monitor (G5.23 tenant_id label; null keeps the constructor value)
     * @param {object} heartbeat Heartbeat details
     * @param {object} tlsInfo TLS details
     * @param {{data24h: UptimeDataResult, data30d: UptimeDataResult, data1y:UptimeDataResult} | null} uptime the uptime and average response rate over a variety of fixed windows
     * @returns {void}
     */
    update(tenantId, heartbeat, tlsInfo, uptime) {
        const labelValues = this.buildLabelValues(tenantId);

        if (typeof tlsInfo !== "undefined") {
            try {
                let isValid;
                if (tlsInfo.valid === true) {
                    isValid = 1;
                } else {
                    isValid = 0;
                }
                monitorCertIsValid.set(labelValues, isValid);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }

            try {
                if (tlsInfo.certInfo != null) {
                    monitorCertDaysRemaining.set(labelValues, tlsInfo.certInfo.daysRemaining);
                }
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
        }

        if (uptime) {
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...labelValues, window: "1d" },
                    uptime.data24h.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...labelValues, window: "30d" },
                    uptime.data30d.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorAverageResponseTimeSeconds.set(
                    { ...labelValues, window: "365d" },
                    uptime.data1y.avgPing / 1000
                );
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...labelValues, window: "1d" }, uptime.data24h.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...labelValues, window: "30d" }, uptime.data30d.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
            try {
                monitorUptimeRatio.set({ ...labelValues, window: "365d" }, uptime.data1y.uptime);
            } catch (e) {
                log.error("prometheus", "Caught error", e);
            }
        }

        if (heartbeat) {
            try {
                monitorStatus.set(labelValues, heartbeat.status);
            } catch (e) {
                log.error("prometheus", "Caught error");
                log.error("prometheus", e);
            }

            try {
                if (typeof heartbeat.ping === "number") {
                    monitorResponseTime.set(labelValues, heartbeat.ping);
                } else {
                    // Is it good?
                    monitorResponseTime.set(labelValues, -1);
                }
            } catch (e) {
                log.error("prometheus", "Caught error");
                log.error("prometheus", e);
            }
        }
    }

    /**
     * Remove monitor from prometheus
     * @param {number|null} tenantId Owning tenant of the monitor (G5.23; selects the exact (tenant_id, monitor_id) series)
     * @param {number|null} monitorID ID of the monitor whose series should be removed
     * @returns {void}
     */
    remove(tenantId, monitorID) {
        const labelValues = {
            ...this.buildLabelValues(tenantId),
            ...(monitorID != null ? {
                monitor_id: monitorID,
            } : {}),
        };
        try {
            monitorCertDaysRemaining.remove(labelValues);
            monitorCertIsValid.remove(labelValues);
            ["1d", "30d", "365d"].forEach((window) => {
                monitorUptimeRatio.remove({ ...labelValues, window });
                monitorAverageResponseTimeSeconds.remove({ ...labelValues, window });
            });
            monitorResponseTime.remove(labelValues);
            monitorStatus.remove(labelValues);
        } catch (e) {
            console.error(e);
        }
    }

    /**
     * Sort the tags alphabetically, case-insensitive.
     * @param {string} a The first tag to compare
     * @param {string} b The second tag to compare
     * @returns {number} The alphabetical order number
     */
    sortTags(a, b) {
        const aLowerCase = a.toLowerCase();
        const bLowerCase = b.toLowerCase();

        if (aLowerCase < bLowerCase) {
            return -1;
        }

        if (aLowerCase > bLowerCase) {
            return 1;
        }

        return 0;
    }
}

module.exports = {
    Prometheus,
};
