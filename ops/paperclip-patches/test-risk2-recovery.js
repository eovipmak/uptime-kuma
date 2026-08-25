#!/usr/bin/env node
// In-memory mock for KUM-176 Risk2: recovery false-positive fix
// No Docker/Testcontainers, pure JS stubs.

function parseObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function isSelfCancelledRun(run) {
  if (!run || run.status !== 'cancelled') return false
  const result = parseObject(run.resultJson)
  return result.selfCancel === true || result.cancelledByActorType === 'agent'
}
function isOperatorCancelledRun(run) {
  if (!run || run.status !== 'cancelled') return false
  if (run.errorCode === 'operator_interrupted') return true
  const result = parseObject(run.resultJson)
  return result.cancelledByActorType === 'user' || result.cancelledByActorType === 'board'
}

// Mock hasActiveExecutionPath: returns true if sibling live exists
function mockHasActive(siblingExists) { return async () => siblingExists }

async function shouldExemptAsStranded(latestRun, siblingExists) {
  // mirrors reconciler logic after patch
  const hasActive = mockHasActive(siblingExists)
  if (isOperatorCancelledRun(latestRun)) return { exempt: true, reason: 'operator' }
  if (isSelfCancelledRun(latestRun)) {
    const sibling = await hasActive()
    if (sibling) return { exempt: true, reason: 'selfCancel+ sibling' }
  }
  return { exempt: false, reason: 'no exempt' }
}

async function test() {
  console.log('=== KUM-176 Risk2: recovery self-cancel with sibling ===')
  const cases = [
    {
      name: 'Positive: selfCancel with live sibling => should EXEMPT (ignore just-cancelled)',
      run: { status: 'cancelled', resultJson: { cancelledByActorType: 'agent', selfCancel: true, cancelledByAgentId: 'a1' }, errorCode: 'cancelled' },
      sibling: true,
      expectExempt: true,
    },
    {
      name: 'Negative: selfCancel with NO sibling => should NOT exempt (still recovers -> blocked)',
      run: { status: 'cancelled', resultJson: { cancelledByActorType: 'agent', selfCancel: true }, errorCode: 'cancelled' },
      sibling: false,
      expectExempt: false,
    },
    {
      name: 'Operator cancel (board) with sibling => exempt regardless',
      run: { status: 'cancelled', resultJson: { cancelledByActorType: 'user' }, errorCode: 'cancelled' },
      sibling: true,
      expectExempt: true,
    },
    {
      name: 'Operator cancel without sibling => exempt',
      run: { status: 'cancelled', resultJson: { cancelledByActorType: 'board' } },
      sibling: false,
      expectExempt: true,
    },
    {
      name: 'Failed run (not cancelled) with sibling => not exempt via cancel path (falls through to normal recovery)',
      run: { status: 'failed', resultJson: {} },
      sibling: true,
      expectExempt: false,
    },
    {
      name: 'SelfCancel without selfCancel flag but agent type => should count as selfCancel',
      run: { status: 'cancelled', resultJson: { cancelledByActorType: 'agent', cancelledByAgentId: 'a1' } },
      sibling: true,
      expectExempt: true,
    },
  ]

  let pass = 0
  for (const c of cases) {
    const res = await shouldExemptAsStranded(c.run, c.sibling)
    const ok = res.exempt === c.expectExempt
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name}`)
    console.log(`  -> exempt=${res.exempt} (${res.reason}) expected=${c.expectExempt}`)
    if (ok) pass++
    else console.log('  RUN:', c.run)
  }
  console.log(`\n${pass}/${cases.length} cases passed`)
  if (pass !== cases.length) process.exit(1)

  // Also test timer write-guard logic
  console.log('\n=== KUM-174 Risk1a: timer write-guard exemption ===')
  function isTimerRun(ctx) {
    if (!ctx || typeof ctx !== 'object') return false
    const wakeReason = String(ctx.wakeReason ?? ctx.reason ?? '')
    const wakeSource = String(ctx.wakeSource ?? ctx.source ?? '')
    return wakeReason === 'heartbeat_timer' || wakeSource === 'timer' || wakeSource === 'scheduler'
  }
  const timerCases = [
    { ctx: { wakeReason: 'heartbeat_timer' }, expect: true },
    { ctx: { wakeSource: 'timer' }, expect: true },
    { ctx: { wakeSource: 'scheduler' }, expect: true },
    { ctx: { wakeReason: 'assignment' }, expect: false },
    { ctx: {}, expect: false },
    { ctx: null, expect: false },
  ]
  let tp=0
  for (const tc of timerCases) {
    const got = isTimerRun(tc.ctx)
    const ok = got===tc.expect
    console.log(`${ok?'PASS':'FAIL'}: ctx=${JSON.stringify(tc.ctx)} => ${got} expect ${tc.expect}`)
    if(ok) tp++
  }
  console.log(`${tp}/${timerCases.length} timer cases passed`)
  if(tp!==timerCases.length) process.exit(1)

  console.log('\nAll Risk2 & Risk1 mocks PASSED')
}
test()
