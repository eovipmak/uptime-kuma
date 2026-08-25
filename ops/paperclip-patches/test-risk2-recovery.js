#!/usr/bin/env node
// In-memory mock for KUM-176 Risk2: recovery false-positive fix
// No Docker/Testcontainers, pure JS stubs.

/**
 * Normalize a value to an object, falling back to an empty object.
 * @param {any} v Value to normalize.
 * @returns {object} The value itself when it is a non-array object, otherwise {}.
 */
function parseObject(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
        return {};
    }
    return v;
}

/**
 * Detect a run cancelled by its own agent (self-cancel).
 * @param {object|null} run Execution run record to inspect.
 * @returns {boolean} True when the run was cancelled by an agent actor.
 */
function isSelfCancelledRun(run) {
    if (!run || run.status !== "cancelled") {
        return false;
    }
    const result = parseObject(run.resultJson);
    return result.selfCancel === true || result.cancelledByActorType === "agent";
}

/**
 * Detect a run cancelled by an operator (user or board).
 * @param {object|null} run Execution run record to inspect.
 * @returns {boolean} True when the run was operator-interrupted or cancelled by user/board.
 */
function isOperatorCancelledRun(run) {
    if (!run || run.status !== "cancelled") {
        return false;
    }
    if (run.errorCode === "operator_interrupted") {
        return true;
    }
    const result = parseObject(run.resultJson);
    return result.cancelledByActorType === "user" || result.cancelledByActorType === "board";
}

// Mock hasActiveExecutionPath: returns true if sibling live exists

/**
 * Build a mocked hasActiveExecutionPath resolver returning a canned sibling state.
 * @param {boolean} siblingExists Whether a live sibling execution path exists.
 * @returns {Function} Async resolver that resolves to the canned sibling state.
 */
function mockHasActive(siblingExists) {
    return async () => siblingExists;
}

/**
 * Mirror of the reconciler exemption logic after the KUM-176 patch:
 * stranded-run recovery must ignore runs that are exempt from recovery.
 * @param {object|null} latestRun Latest execution run for the subject.
 * @param {boolean} siblingExists Whether a live sibling execution path exists.
 * @returns {Promise<{exempt: boolean, reason: string}>} Exemption verdict and reason.
 */
async function shouldExemptAsStranded(latestRun, siblingExists) {
    const hasActive = mockHasActive(siblingExists);
    if (isOperatorCancelledRun(latestRun)) {
        return { exempt: true, reason: "operator" };
    }
    if (isSelfCancelledRun(latestRun)) {
        const sibling = await hasActive();
        if (sibling) {
            return { exempt: true, reason: "selfCancel+ sibling" };
        }
    }
    return { exempt: false, reason: "no exempt" };
}

/**
 * Run the KUM-176 Risk2 recovery-exemption mocks and the KUM-174 timer write-guard mocks.
 * @returns {Promise<void>} Exits with code 1 when any mock case fails.
 */
async function test() {
    console.log("=== KUM-176 Risk2: recovery self-cancel with sibling ===");
    const cases = [
        {
            name: "Positive: selfCancel with live sibling => should EXEMPT (ignore just-cancelled)",
            run: {
                status: "cancelled",
                resultJson: { cancelledByActorType: "agent", selfCancel: true, cancelledByAgentId: "a1" },
                errorCode: "cancelled",
            },
            sibling: true,
            expectExempt: true,
        },
        {
            name: "Negative: selfCancel with NO sibling => should NOT exempt (still recovers -> blocked)",
            run: {
                status: "cancelled",
                resultJson: { cancelledByActorType: "agent", selfCancel: true },
                errorCode: "cancelled",
            },
            sibling: false,
            expectExempt: false,
        },
        {
            name: "Operator cancel (board) with sibling => exempt regardless",
            run: { status: "cancelled", resultJson: { cancelledByActorType: "user" }, errorCode: "cancelled" },
            sibling: true,
            expectExempt: true,
        },
        {
            name: "Operator cancel without sibling => exempt",
            run: { status: "cancelled", resultJson: { cancelledByActorType: "board" } },
            sibling: false,
            expectExempt: true,
        },
        {
            name: "Failed run (not cancelled) with sibling => not exempt via cancel path (falls through to normal recovery)",
            run: { status: "failed", resultJson: {} },
            sibling: true,
            expectExempt: false,
        },
        {
            name: "SelfCancel without selfCancel flag but agent type => should count as selfCancel",
            run: { status: "cancelled", resultJson: { cancelledByActorType: "agent", cancelledByAgentId: "a1" } },
            sibling: true,
            expectExempt: true,
        },
    ];

    let pass = 0;
    for (const c of cases) {
        const res = await shouldExemptAsStranded(c.run, c.sibling);
        const ok = res.exempt === c.expectExempt;
        console.log(`${ok ? "PASS" : "FAIL"}: ${c.name}`);
        console.log(`  -> exempt=${res.exempt} (${res.reason}) expected=${c.expectExempt}`);
        if (ok) {
            pass++;
        } else {
            console.log("  RUN:", c.run);
        }
    }
    console.log(`\n${pass}/${cases.length} cases passed`);
    if (pass !== cases.length) {
        process.exit(1);
    }

    // Also test timer write-guard logic
    console.log("\n=== KUM-174 Risk1a: timer write-guard exemption ===");
    /**
     * Detect timer-originated wake contexts eligible for the write-guard exemption.
     * @param {object|null} ctx Wake context carrying wakeReason/wakeSource fields.
     * @returns {boolean} True when the context originates from a timer/scheduler source.
     */
    function isTimerRun(ctx) {
        if (!ctx || typeof ctx !== "object") {
            return false;
        }
        const wakeReason = String(ctx.wakeReason ?? ctx.reason ?? "");
        const wakeSource = String(ctx.wakeSource ?? ctx.source ?? "");
        return wakeReason === "heartbeat_timer" || wakeSource === "timer" || wakeSource === "scheduler";
    }
    const timerCases = [
        { ctx: { wakeReason: "heartbeat_timer" }, expect: true },
        { ctx: { wakeSource: "timer" }, expect: true },
        { ctx: { wakeSource: "scheduler" }, expect: true },
        { ctx: { wakeReason: "assignment" }, expect: false },
        { ctx: {}, expect: false },
        { ctx: null, expect: false },
    ];
    let tp = 0;
    for (const tc of timerCases) {
        const got = isTimerRun(tc.ctx);
        const ok = got === tc.expect;
        console.log(`${ok ? "PASS" : "FAIL"}: ctx=${JSON.stringify(tc.ctx)} => ${got} expect ${tc.expect}`);
        if (ok) {
            tp++;
        }
    }
    console.log(`${tp}/${timerCases.length} timer cases passed`);
    if (tp !== timerCases.length) {
        process.exit(1);
    }

    console.log("\nAll Risk2 & Risk1 mocks PASSED");
}
test();
