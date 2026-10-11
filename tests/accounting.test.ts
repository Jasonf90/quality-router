import { describe, expect, test } from 'claude-code/testing'

const close = (a: number | undefined, b: number) => expect(Math.abs((a ?? NaN) - b) < 1e-9).toBe(true)

import type { ExperimentArm, RequestRecord, Tokens } from '../types'
import { addRequest, allTokens, emptyLedger, fromUsage, restoreLedger } from '../hooks/accounting'
import { emptyArm } from '../hooks/core'
import { compareExperiment, findPrice, priceBucket, sameVolumeEstimate, cacheAwareHeadline, cacheAwareStep, emptyCacheAware, lifetime } from '../hooks/savings'
import { DEFAULT_PREFS, normalizePrefs } from '../hooks/settings'
import { usageText } from '../hooks/view'
import { EMPTY_HISTORY, EMPTY_PROJECT, EMPTY_RUNTIME } from '../hooks/core'
import { emptyValidation } from '../hooks/escalation'
import { cmd, install, start, step, turn, SLOW } from './harness'

const T = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Tokens => ({ input, output, cacheRead, cacheWrite })

function rec(key: string, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    key,
    at: 0,
    role: 'main',
    purpose: 'normal',
    phaseId: 'p',
    requestedModel: 'claude-sonnet-5-5',
    observedModel: 'claude-sonnet-5-5',
    routed: true,
    proposedModel: null,
    usage: T(1000, 100, 10_000, 500),
    durationMs: 10,
    status: 'ok',
    ...over,
  }
}

describe('ledger (pure)', () => {
  test('missing usage is unknown, never zero', () => {
    const { ledger } = addRequest(emptyLedger('s', 0), rec('a', { usage: null, observedModel: null, status: 'no-response' }))
    expect(ledger.total.requests).toBe(1)
    expect(ledger.total.unknown).toBe(1)
    expect(allTokens(ledger.total.tokens)).toBe(0)
    expect(Object.keys(ledger.byModel)).toEqual(['claude-sonnet-5-5 (unconfirmed)'])
    expect(ledger.noResponse).toBe(1)
  })

  test('the same request is never counted twice', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('t1:main:0:0')).ledger
    const again = addRequest(l, rec('t1:main:0:0'))
    expect(again.added).toBe(false)
    expect(again.ledger.total.requests).toBe(1)
    l = addRequest(l, rec('t1:main:0:1')).ledger
    expect(l.total.requests).toBe(2)
  })

  test('token categories stay separate; long prompts are tracked apart', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a', { usage: T(1000, 100, 10_000, 500) })).ledger
    l = addRequest(l, rec('b', { usage: T(5000, 200, 120_000, 0) })).ledger
    expect(l.total.tokens).toEqual(T(6000, 300, 130_000, 500))
    expect(l.total.over100k).toEqual(T(5000, 200, 120_000, 0))
  })

  test('interrupted requests: partial usage counted, interruption recorded', () => {
    const l = addRequest(emptyLedger('s', 0), rec('a', { status: 'aborted', usage: T(100, 3) })).ledger
    expect(l.aborted).toBe(1)
    expect(l.total.tokens.output).toBe(3)
  })

  test('roles and purposes group the same requests without adding them again', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a')).ledger
    l = addRequest(l, rec('b', { role: 'subagent', purpose: 'escalated' })).ledger
    l = addRequest(l, rec('c', { role: 'classifier', purpose: 'classifier', observedModel: null, requestedModel: 'claude-haiku-5-5', usage: T(400, 40) })).ledger
    expect(l.total.requests).toBe(3)
    expect(l.byRole.classifier?.tokens).toEqual(T(400, 40))
    expect(l.byPurpose.escalated?.requests).toBe(1)
    expect(Object.keys(l.byModel)).toContain('claude-haiku-5-5 (classifier, as requested)')
  })

  test('a stored ledger restores only for its own session', () => {
    const l = addRequest(emptyLedger('s1', 0), rec('a')).ledger
    const saved = JSON.parse(JSON.stringify(l))
    expect(restoreLedger(saved, 's1', 5).total.requests).toBe(1)
    expect(restoreLedger(saved, 's2', 5).total.requests).toBe(0)
    expect(restoreLedger('garbage', 's1', 5).total.requests).toBe(0)
    expect(fromUsage({ input_tokens: -5, output_tokens: 2.4, cache_read_input_tokens: NaN, cache_creation_input_tokens: 1 })).toEqual(T(0, 2, 0, 1))
  })
})

describe('same-volume estimate (pure)', () => {
  const prefs = DEFAULT_PREFS

  test('prices each category separately, with provenance', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a', { usage: T(1_000_000, 100_000, 0, 0) })).ledger
    const est = sameVolumeEstimate(l, prefs, 'claude-opus-5-5')
    // sonnet: 1M in * $2 + 0.1M out * $10 = $3; opus: 1M * $4 + 0.1M * $20 = $6
    close(est.routedUsd, 3)
    close(est.baselineUsd, 6)
    close(est.differenceUsd, 3)
    expect(est.provenance.join(' ')).toContain('platform.claude.com')
    expect(est.status).toBe('ok')
  })

  test('negative savings are shown as negative', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a', { observedModel: 'claude-opus-5-5', usage: T(1_000_000, 0) })).ledger
    const est = sameVolumeEstimate(l, normalizePrefs({ ...prefs, baselineModel: 'claude-haiku-5-5' }), null)
    expect(est.differenceUsd).toBeLessThan(0)
  })

  test('classifier overhead counts on the routed side only', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a', { usage: T(1_000_000, 0) })).ledger
    // A classifier call is small (50k input tokens here, under Haiku's 100k long-prompt tier).
    l = addRequest(l, rec('c', { role: 'classifier', purpose: 'classifier', observedModel: null, requestedModel: 'claude-haiku-5-5', usage: T(50_000, 0) })).ledger
    const est = sameVolumeEstimate(l, prefs, 'claude-opus-5-5')
    close(est.classifierUsd, 0.005)
    close(est.routedUsd, 2.005)
    close(est.baselineUsd, 4)
  })

  test('long prompts use the long-prompt price where the list has one', () => {
    const haiku = findPrice('claude-haiku-5-5', prefs.pricing)
    expect(haiku).not.toBe(null)
    const b = { requests: 1, unknown: 0, tokens: T(1_000_000, 0), over100k: T(1_000_000, 0) }
    close(priceBucket(b, haiku!.price, '5m'), 0.5)
    expect(findPrice('claude-opus-5-5[1m]', prefs.pricing)?.id).toBe('claude-opus-5-5')
  })

  test('no price: no estimate, or a partial one that names what is missing', () => {
    let l = emptyLedger('s', 0)
    l = addRequest(l, rec('a', { observedModel: 'claude-mystery-1', usage: T(1000, 10) })).ledger
    expect(sameVolumeEstimate(l, normalizePrefs({ pricing: {} }), 'claude-opus-5-5').status).toBe('unavailable')
    const partial = sameVolumeEstimate(l, prefs, 'claude-opus-5-5')
    expect(partial.status).toBe('partial')
    expect(partial.missingPrices).toEqual(['claude-mystery-1'])
  })

  test('the usage report labels the estimate and never presents failed validation as success', () => {
    const l = addRequest(emptyLedger('s', 0), rec('a')).ledger
    const text = usageText({
      prefs,
      rt: EMPTY_RUNTIME,
      ledger: l,
      validation: emptyValidation(null, null),
      history: { ...EMPTY_HISTORY, phases: [{ phaseId: 'p', tier: 'cheap', escalations: 0, verdict: 'failed', tokens: T(1, 1), unknown: 0 }] },
      limits: { tracks: {}, latest: [] },
      project: EMPTY_PROJECT,
      experiment: null,
      now: 0,
    })
    expect(text).toContain('Estimated pricing difference — same recorded token volumes'.toUpperCase())
    expect(text).toContain("does not predict the baseline model's actual token use")
    expect(text).toContain('not successful optimizations')
    expect(text).toContain('No comparable baseline')
  })
})

describe('experiments (pure)', () => {
  const arm = (a: Partial<ExperimentArm>): ExperimentArm => ({
    ...emptyArm({ label: 'x', arm: 'routed', spec: 'add dark mode', startState: 'abc123', validation: 'xcodebuild test', environment: 'iPhone 16 sim', sessionId: 's', startedAt: 0 }),
    endedAt: 10,
    ...a,
  })

  test('no baseline, or mismatched conditions: no number is given', () => {
    expect(compareExperiment([arm({})], 'x').status).toBe('no-baseline')
    const c = compareExperiment([arm({}), arm({ arm: 'baseline', startState: 'def456' })], 'x')
    expect(c.status).toBe('not-comparable')
    if (c.status === 'not-comparable') expect(c.mismatched).toEqual(['startState'])
  })

  test('comparable runs report per-category reduction, negative when routing used more, and validation', () => {
    const c = compareExperiment(
      [arm({ tokens: T(1000, 500, 0, 0), outcome: { passed: 0, failed: 1, notRun: 0 } }), arm({ arm: 'baseline', tokens: T(800, 400, 0, 0), outcome: { passed: 1, failed: 0, notRun: 0 } })],
      'x',
    )
    expect(c.status).toBe('compared')
    if (c.status === 'compared') {
      expect(c.reduction.input).toBe(-200)
      expect(c.reduction.all).toBe(-300)
      expect(c.routedFailedValidation).toBe(true)
    }
  })
})

describe('accounting in the session (mock integration)', () => {
  test('usage is recorded in every state, OFF included, and reported per model and role', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await turn($, 'Fix the typo in the title', 't1', 2)
    await cmd($, 'on')
    // Idle past the cache's lifetime (1 hour unless 5 minutes is observed): on a small cold context switching pays.
    await w.clock.advance(61 * 60_000)
    await turn($, 'Fix the typo in the subtitle', 't2', 1)
    const raw = w.store.get('ledger:session-1') as { total: { requests: number; tokens: Tokens }; byModel: Record<string, unknown> }
    expect(raw.total.requests).toBe(3)
    expect(raw.total.tokens.input).toBe(3600)
    expect(Object.keys(raw.byModel).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  })

  test('a routed model that answers nothing is set aside and the request is sent as the engine meant it', SLOW, async ($, on) => {
    const w = install(on)
    w.failModels.add('claude-haiku-5-5')
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the title', turnId: 't1' })
    const res = await step($, { turnId: 't1' })
    expect(w.sent.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    expect(res.usage?.model).toBe('claude-opus-5-5')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[2]?.model).toBe('claude-opus-5-5')
    const status = await cmd($, 'status')
    expect(status).toContain('Degraded')
  })

  test('a new session id (as after /clear) stores the old ledger and starts a new one; requests counted before are kept', SLOW, async ($, on) => {
    const w = install(on)
    // Requests counted before any session start (state freshly reset) are adopted, not dropped.
    await turn($, 'Fix the typo in the title', 't0')
    expect((w.store.get('ledger:session-1') as { total: { requests: number } }).total.requests).toBe(1)
    await start($)
    await turn($, 'Fix the typo in the subtitle', 't1')
    w.sessionId = 'session-2'
    await turn($, 'Fix the typo in the footer', 't2')
    expect((w.store.get('ledger:session-1') as { total: { requests: number } }).total.requests).toBe(2)
    expect((w.store.get('ledger:session-2') as { total: { requests: number } }).total.requests).toBe(1)
    expect(w.store.get('ledger-index')).toEqual(['session-1', 'session-2'])
  })
})

describe('the cache-aware estimate (pure)', () => {
  const prefs = { ...DEFAULT_PREFS, cacheTtl: '1h' as const }
  const OPUS = 'claude-opus-5-5'
  const SONNET = 'claude-sonnet-5-5'
  const u = (read: number, write: number, output = 1000) => ({ input: 10, output, cacheRead: read, cacheWrite: write })
  const run = (steps: { answered: string; usage: ReturnType<typeof u>; at: number; role?: string; proposed?: string | null }[]) =>
    steps.reduce((ca, st) => cacheAwareStep(ca, { role: st.role ?? 'main', answered: st.answered, asked: OPUS, proposed: st.proposed ?? null, usage: st.usage, at: st.at }, prefs), emptyCacheAware())

  test('nothing routed: as it ran, staying and following agree to the cent', () => {
    const ca = run([0, 1, 2, 3].map(i => ({ answered: OPUS, usage: u(400_000 + i * 2000, 2000), at: i * 60_000 })))
    expect(Math.abs(ca.actualUsd - ca.stayUsd)).toBeLessThan(1e-9)
    expect(Math.abs(ca.actualUsd - ca.followUsd)).toBeLessThan(1e-9)
    expect(cacheAwareHeadline(ca, true)?.usd).toBe(0)
  })

  test('a short switch on a large warm conversation is charged for re-caching both ways, and shows as costing more', () => {
    const ca = run([
      { answered: OPUS, usage: u(400_000, 2000), at: 0 },
      { answered: SONNET, usage: u(0, 402_000), at: 60_000 },
      { answered: SONNET, usage: u(402_000, 2000), at: 120_000 },
      { answered: SONNET, usage: u(404_000, 2000), at: 180_000 },
      { answered: OPUS, usage: u(0, 406_000), at: 240_000 },
    ])
    const h = cacheAwareHeadline(ca, true)
    expect(h?.kind).toBe('saved')
    expect((h?.usd ?? 0) < 0).toBe(true)
  })

  test('a long stretch on a small conversation does save', () => {
    const steps = [{ answered: OPUS, usage: u(20_000, 1000), at: 0 }]
    for (let i = 1; i <= 30; i++) steps.push({ answered: SONNET, usage: i === 1 ? u(0, 21_000) : u(20_000 + i * 1000, 1000), at: i * 60_000 })
    expect((cacheAwareHeadline(run(steps), true)?.usd ?? 0) > 0).toBe(true)
  })

  test('the classifier counts against routing; subagents compare the same volumes on each model', () => {
    const ca = run([
      { answered: OPUS, usage: u(30_000, 1000), at: 0 },
      { answered: 'claude-haiku-5-5', usage: u(0, 0, 40), at: 1000, role: 'classifier' },
      { answered: SONNET, usage: u(5_000, 5_000), at: 2000, role: 'subagent' },
    ])
    expect(ca.actualUsd).toBeGreaterThan(0)
    expect(ca.stayUsd).toBeGreaterThan(ca.actualUsd - 0.01)
  })

  test('the all-sessions total leaves out entries priced the old way, and says how many', () => {
    const entry = { at: 0, requests: 10, routedRequests: 5, failedPhases: 0, verifiedPhases: 1 }
    const life = lifetime([
      { ...entry, sessionId: 'a', routedUsd: 10, baselineUsd: 30 },
      { ...entry, sessionId: 'b', method: 'cache-aware', routedUsd: 10, baselineUsd: 12 },
    ])
    expect(life.usd).toBe(2)
    expect(life.legacy).toBe(1)
  })
})
