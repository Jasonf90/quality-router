import { describe, expect, test } from 'claude-code/testing'

import { NO_TTL_EVIDENCE, expectedPhaseRequests, resolveTtl, switchPays, ttlEvidence } from '../hooks/economics'
import { recommend } from '../hooks/advisor'
import { chooseEffort } from '../hooks/effort'
import { analyzePrompt, assessFromTasks, isPlanPrompt } from '../hooks/policy'
import { DEFAULT_PREFS, DEFAULT_PRICING, normalizePrefs } from '../hooks/settings'
import { SLOW, SPAWN, cmd, install, start, step, tool, turn } from './harness'

const base = {
  prefs: DEFAULT_PREFS,
  fromModel: 'claude-opus-5-5',
  toModel: 'claude-sonnet-5-5',
  promptTokens: 600_000,
  expectedRequests: 19,
  expectedSource: 'history' as const,
  avgOutput: 1500,
  cacheWarm: true,
}

describe('switching economics (pure)', () => {
  test('a huge warm context: switching down does not pay over a normal phase', () => {
    const v = switchPays(base)
    expect(v.pays).toBe(false)
    expect((v.breakEven ?? 0) > 19).toBe(true)
    expect(v.reason).toContain('pays back after ~')
  })

  test("a cold cache: the new model's whole write is still extra (the old model writes again on the way back)", () => {
    const v = switchPays({ ...base, cacheWarm: false })
    expect(v.pays).toBe(false)
    expect(v.oneTimeUsd).toBeGreaterThan(0)
    // Cheaper than switching on a warm cache, where both writes are extra.
    expect(v.oneTimeUsd).toBeLessThan(switchPays(base).oneTimeUsd)
    // A small cold context pays within a normal phase.
    expect(switchPays({ ...base, cacheWarm: false, promptTokens: 50_000 }).pays).toBe(true)
  })

  test('the cache lifetime is learned from idle gaps: a big read after 10 minutes means 1h, repeated full rewrites mean 5m', () => {
    const big = { input: 0, output: 500, cacheRead: 300_000, cacheWrite: 2_000 }
    const rewrite = { input: 0, output: 500, cacheRead: 0, cacheWrite: 300_000 }
    let ev = ttlEvidence(NO_TTL_EVIDENCE, 10 * 60_000, big, true)
    expect(ev.longReads).toBe(1)
    expect(resolveTtl('auto', ev)).toBe('1h')
    expect(ttlEvidence(NO_TTL_EVIDENCE, 2 * 60_000, rewrite, true)).toEqual(NO_TTL_EVIDENCE)
    expect(ttlEvidence(NO_TTL_EVIDENCE, 10 * 60_000, rewrite, false)).toEqual(NO_TTL_EVIDENCE)
    ev = ttlEvidence(ttlEvidence(NO_TTL_EVIDENCE, 10 * 60_000, rewrite, true), 20 * 60_000, rewrite, true)
    expect(resolveTtl('auto', ev)).toBe('5m')
    expect(resolveTtl('auto', null)).toBe('1h')
    expect(resolveTtl('5m', null)).toBe('5m')
  })

  test('a small context or a long phase pays', () => {
    expect(switchPays({ ...base, promptTokens: 20_000, toModel: 'claude-haiku-5-5', expectedRequests: 12 }).pays).toBe(true)
    expect(switchPays({ ...base, expectedRequests: 400 }).pays).toBe(true)
  })

  test('no price for a model: no verdict (the plain rule applies)', () => {
    expect(switchPays({ ...base, fromModel: 'claude-mystery-1' }).pays).toBe(null)
    expect(switchPays({ ...base, prefs: normalizePrefs({ pricing: {}, pricingCleared: Object.keys(DEFAULT_PRICING) }) }).reason).toBe('no price for claude-opus-5-5')
  })

  test('expected phase length: this session\'s median once three phases finished', () => {
    expect(expectedPhaseRequests([], 0)).toEqual({ n: 10, source: 'default' })
    expect(expectedPhaseRequests([20, 18, 30], 4)).toEqual({ n: 16, source: 'history' })
    expect(expectedPhaseRequests([5, 5, 5], 9).n).toBe(3)
  })
})

describe('plan phases (pure)', () => {
  test('plan-step prompts are recognised', () => {
    for (const t of ['start phase 3', 'Start Phase 12', 'next phase', 'do step 2', "let's begin phase four", 'proceed to milestone 2']) expect(isPlanPrompt(t)).toBe(true)
    for (const t of ['fix the login bug', 'phase out the old API across the app and replace every call site with the new client, then update tests']) expect(isPlanPrompt(t)).toBe(false)
  })

  test('a phase is judged by its hardest task', () => {
    const light = assessFromTasks(['Fix typo in onboarding title', 'Sort imports in ProfileView.swift'])
    expect(light?.tier).toBe('cheap')
    expect(light?.signals[0]).toBe('from task list')
    const mixed = assessFromTasks(['Fix typo in onboarding title', 'Add pull-to-refresh to OrdersList'])
    expect(mixed?.tier).toBe('middle')
    const risky = assessFromTasks(['Fix typo in onboarding title', 'Store the session token in the Keychain'])
    expect([risky?.tier, risky?.risk]).toEqual(['strong', 'high'])
    expect(assessFromTasks(['Do the thing', 'Other stuff'])).toBe(null)
    expect(assessFromTasks([])).toBe(null)
  })
})

describe('compaction and effort on big contexts (pure)', () => {
  const advice = { state: 'on' as const, mode: 'quality-first' as const, contextPercent: 57, isWorking: false, idleMs: 0, phaseVerdict: 'unverified' as const, phaseStartContext: 0, phaseOrdinal: 0, weekly: null, potential: null, dismissed: [] }

  test('between plan phases on 150k+ tokens: compact (urgent from 500k); percentages alone are not waited for', () => {
    const r = recommend({ ...advice, promptTokens: 200_000, planPrompt: true })
    expect(r[0]?.id).toBe('compact-before-next-phase')
    expect(r[0]?.action).toBe('compact')
    expect(recommend({ ...advice, promptTokens: 566_000, planPrompt: true })[0]?.severity).toBe('urgent')
    expect(recommend({ ...advice, promptTokens: 300_000 })[0]?.id).toBe('prompt-large')
    expect(recommend({ ...advice, promptTokens: 120_000 })).toEqual([])
  })

  test('only one compaction suggestion shows at a time', () => {
    const r = recommend({ ...advice, contextPercent: 95, promptTokens: 600_000, planPrompt: true })
    expect(r.filter(x => x.action === 'compact').length).toBe(1)
  })

  test('a plan phase on inherited context suggests compacting, not starting fresh', () => {
    const r = recommend({ ...advice, promptTokens: 90_000, phaseOrdinal: 2, phaseStartContext: 90_000, planPrompt: true })
    expect(r.find(x => x.id === 'new-task-old-context')?.action).toBe('compact')
  })

  test('effort is not lowered on a large warm context; raising for quality still is', () => {
    const typo = analyzePrompt('Fix the typo in the onboarding title string')
    const args = { prefs: DEFAULT_PREFS, analysis: typo, tier: typo.tier, confidence: typo.confidence, fallback: false, escalations: 0, phaseFailed: false, sessionEffort: 'high' }
    expect(chooseEffort(args).effort).toBe('medium')
    expect(chooseEffort({ ...args, holdLowering: true })).toEqual({})
    const auth = analyzePrompt('Update the OAuth refresh token handling')
    expect(chooseEffort({ ...args, analysis: auth, tier: auth.tier, confidence: auth.confidence, sessionEffort: 'medium', holdLowering: true }).effort).toBe('high')
  })
})

describe('in the session (mock integration)', () => {
  test('a downgrade on a large warm context is kept, with the payback reason', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = { input_tokens: 2000, output_tokens: 1500, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 0 }
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Add pull-to-refresh to the OrdersList screen', turnId: 't1' })
    await step($, { turnId: 't1' })
    await $.turn.start({ text: 'Fix the typo in the onboarding title string', turnId: 't2' })
    await step($, { turnId: 't2', effort: 'high' })
    // The first task went to Sonnet (a fresh session switches for free); the typo stays on it.
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    expect(w.sent[1]).toEqual(expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'high' }))
    expect(await cmd($, 'status')).toMatch(/kept middle: switching pays back after ~\d+ requests at 602k tokens \(warm cache\)/)
  })

  test('"start phase N" is re-judged from the task list Claude writes', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'start phase 3', turnId: 't1' })
    await step($, { turnId: 't1' })
    expect(w.sent[0]?.model).toBe('claude-opus-5-5')
    expect(w.classifierCalls).toBe(0)
    await tool($, w, 'TodoWrite', { todos: [
      { content: 'Fix typo in onboarding title', status: 'in_progress', activeForm: 'Fixing typo' },
      { content: 'Sort imports in ProfileView.swift', status: 'pending', activeForm: 'Sorting imports' },
    ] })
    expect(await cmd($, 'status')).toContain('decided at the next request')
    // Idle past the 1-hour cache: on a small cold context the switch pays.
    await w.clock.advance(61 * 60_000)
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-haiku-5-5')
    expect(await cmd($, 'status')).toContain('why: from task list')
    // A risky task appearing later moves the phase back up at once.
    await tool($, w, 'TodoWrite', { todos: [
      { content: 'Fix typo in onboarding title', status: 'completed', activeForm: 'Fixing typo' },
      { content: 'Store the session token in the Keychain', status: 'in_progress', activeForm: 'Storing token' },
    ] })
    await step($, { turnId: 't1', index: 2 })
    expect(w.sent[2]?.model).toBe('claude-opus-5-5')
  })

  test('workflow agents keep their spawn model but are routed on every request', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Run the audit workflow', turnId: 't1' })
    const r = await $.agent.spawn({ ...SPAWN, prompt: 'Find where the theme colors are defined', subagentType: 'workflow-subagent', workflow: { runId: 'wf_1', agentIndex: 1 } } as never)
    expect(w.spawned[0]?.requested).toBe(undefined)
    const id = (r as { agentId: string }).agentId
    await step($, { turnId: 'wa', agentId: id })
    await step($, { turnId: 'wa', agentId: id, index: 1 })
    expect(w.sent.map(x => x.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
  })
})

describe('prices added after the stored table was written', () => {
  test('Opus 5 is priced from the official page, joins an older stored table, and stays out once cleared', () => {
    const older = normalizePrefs({ pricing: { 'claude-opus-5-5': DEFAULT_PRICING['claude-opus-5-5'] } })
    expect(older.pricing['claude-opus-5']).toMatchObject({ input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 })
    const cleared = normalizePrefs({ pricing: { 'claude-opus-5-5': DEFAULT_PRICING['claude-opus-5-5'] }, pricingCleared: ['claude-opus-5'] })
    expect(cleared.pricing['claude-opus-5']).toBe(undefined)
  })
})

describe('a reply that starts what the last answer proposed (mock integration)', () => {
  const RISKY = 'Plan: move routines to CloudKit so they sync across devices, then handle sync conflicts. Shall I start?'
  const PLAIN = 'Plan: tidy the settings copy and add a unit test for the date formatter. Shall I start?'

  test('"let\'s start working the plan" after a plan for iCloud sync runs on the strong tier', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await turn($, 'what should we work on next?', 't1', 1, RISKY)
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    await turn($, "Let's start working the plan", 't2')
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })

  test('after an ordinary plan, or when the reply only asks about it, the task keeps its tier', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await turn($, 'what should we work on next?', 't1', 1, PLAIN)
    await turn($, "Let's start working the plan", 't2')
    expect(w.sent[1]?.model).toBe('claude-sonnet-5-5')
    await turn($, 'what should we work on next?', 't3', 1, RISKY)
    await turn($, "what's next?", 't4')
    expect(w.sent[3]?.model).toBe('claude-sonnet-5-5')
  })
})
