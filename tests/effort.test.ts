import { describe, expect, test } from 'claude-code/testing'

import type { Prefs } from '../types'
import { chooseEffort } from '../hooks/effort'
import { analyzePrompt, decide } from '../hooks/policy'
import { DEFAULT_PREFS } from '../hooks/settings'
import { BAND_PROPS, bash, cmd, edit, install, start, step, SLOW } from './harness'

const prefs = (over: Partial<Prefs> = {}): Prefs => ({ ...DEFAULT_PREFS, ...over })

function effortFor(text: string, session: string | null, over: Partial<Parameters<typeof chooseEffort>[0]> = {}, p: Prefs = prefs()) {
  const analysis = analyzePrompt(text)
  return chooseEffort({ prefs: p, analysis, tier: analysis.tier, confidence: analysis.confidence, fallback: false, escalations: 0, phaseFailed: false, sessionEffort: session, ...over })
}

describe('automatic effort (pure)', () => {
  test('narrow, low-risk work is lowered: one step in quality-first, to low elsewhere', () => {
    expect(effortFor('Fix the typo in the onboarding title string', 'high').effort).toBe('medium')
    expect(effortFor('Fix the typo in the onboarding title string', 'medium').effort).toBe('low')
    expect(effortFor('Fix the typo in the onboarding title string', 'high', {}, prefs({ mode: 'balanced' })).effort).toBe('low')
    expect(effortFor('Summarize the README in three bullet points', 'high').effortReason).toBe('lowered for summarize')
    // Mixed signals ("building the app" also reads as implementation) lower confidence: no lowering.
    expect(effortFor('Summarize what the README says about building the app', 'high').effort).toBe(undefined)
    // Already at the bottom: nothing to change.
    expect(effortFor('Fix the typo in the onboarding title string', 'low').effort).toBe(undefined)
  })

  test('writing or fixing code is never lowered, in any mode', () => {
    for (const mode of ['quality-first', 'balanced', 'economy'] as const) {
      for (const task of [
        'Add pull-to-refresh to the OrdersList screen and wire it to fetchOrders',
        'The app crashes when I tap Save on the profile screen, please fix it',
        'Write unit tests for the CartViewModel discount calculation',
        'Refactor the ProfileView into smaller components',
      ]) {
        const e = effortFor(task, 'high', {}, prefs({ mode }))
        expect(e.effort === undefined || e.effort === 'high' || e.effort === 'xhigh' || e.effort === 'max').toBe(true)
      }
    }
  })

  test('high-risk, architecture and hard diagnosis are raised in quality-first, never lowered anywhere', () => {
    expect(effortFor('Update the OAuth refresh token handling in AuthService', 'medium').effort).toBe('high')
    expect(effortFor('Update the OAuth refresh token handling in AuthService', 'medium').effortReason).toBe('raised for high-risk work')
    expect(effortFor('How should we structure offline sync for the app?', 'low').effort).toBe('high')
    expect(effortFor('The app randomly crashes only on device in release builds', 'medium').effort).toBe('high')
    expect(effortFor('Update the OAuth refresh token handling', 'medium', {}, prefs({ mode: 'balanced' })).effort).toBe(undefined)
    expect(effortFor('Update the OAuth refresh token handling', 'low', {}, prefs({ mode: 'balanced' })).effort).toBe('medium')
    expect(effortFor('Update the OAuth refresh token handling', 'low', {}, prefs({ mode: 'economy' })).effort).toBe(undefined)
    expect(effortFor('Update the OAuth refresh token handling', 'max').effort).toBe(undefined)
  })

  test('uncertainty, a failed check, or a classifier fallback means no lowering', () => {
    expect(effortFor('Fix the typo in the onboarding title string', 'high', { phaseFailed: true }).effort).toBe(undefined)
    expect(effortFor('Fix the typo in the onboarding title string', 'high', { fallback: true }).effort).toBe(undefined)
    expect(effortFor('Fix the typo in the onboarding title string', 'high', { confidence: 0.6 }).effort).toBe(undefined)
    expect(effortFor('do the thing from before', 'high').effort).toBe(undefined)
    expect(effortFor('improve it', 'high').effort).toBe(undefined)
  })

  test('failed repairs raise effort with the escalation', () => {
    const e = effortFor('Fix the failing discount calculation in CartViewModel', 'medium', { escalations: 1 })
    expect(e.effort).toBe('high')
    expect(e.effortReason).toBe('raised after failed repairs')
    expect(effortFor('Fix the failing test', 'high', { escalations: 2 }).effort).toBe('xhigh')
  })

  test('a per-tier setting wins; auto off or no session effort changes nothing', () => {
    const tierSet = prefs({ effort: { cheap: 'max' } })
    expect(effortFor('Fix the typo in the title', 'high', {}, tierSet)).toEqual({ effort: 'max', effortSource: 'preference', effortReason: 'your cheap-tier setting' })
    expect(effortFor('Fix the typo in the title', 'high', {}, prefs({ autoEffort: false }))).toEqual({})
    expect(effortFor('Fix the typo in the title', null)).toEqual({})
    expect(effortFor('Fix the typo in the title', '32000')).toEqual({})
  })

  test('decide carries the effort, its source and the session effort it was based on', () => {
    const d = decide({ prefs: prefs(), analysis: analyzePrompt('Fix the typo in the title'), verdict: null, escalations: 0, projectFloor: null, previousTier: null, promptTokens: 0, epoch: 0, now: 0, sessionEffort: 'high' })
    expect(d.effort).toBe('medium')
    expect(d.effortSource).toBe('auto')
    expect(d.baseEffort).toBe('high')
  })
})

describe('automatic effort in the session (mock integration)', () => {
  const BAND = { plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS } as const

  test('lowered for a typo, kept for implementation, raised for auth; shown on the band and counted', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the onboarding title string', turnId: 't1' })
    await step($, { turnId: 't1', effort: 'high' })
    expect(w.sent[0]).toEqual(expect.objectContaining({ model: 'claude-haiku-5-5', effort: 'medium' }))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /effort medium \(auto: lowered for a mechanical change\)/ })).not.toBe(undefined)
    await ui.unmount()
    await $.turn.start({ text: 'Add pull-to-refresh to the OrdersList screen', turnId: 't2' })
    await step($, { turnId: 't2', effort: 'high' })
    expect(w.sent[1]?.effort).toBe('high')
    await $.turn.start({ text: 'Update the OAuth refresh token handling in AuthService', turnId: 't3' })
    await step($, { turnId: 't3', effort: 'medium' })
    expect(w.sent[2]?.effort).toBe('high')
    const status = await cmd($, 'status')
    expect(status).toContain('effort high (auto: raised for high-risk work)')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as never)
    const ledger = w.store.get('ledger:session-1') as { effortLowered: number; effortRaised: number }
    expect([ledger.effortLowered, ledger.effortRaised]).toEqual([1, 1])
  })

  test('a failed check stops lowering for the rest of the task', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Rename userName to username in ProfileView.swift', turnId: 't1' })
    await step($, { turnId: 't1', effort: 'high' })
    expect(w.sent[0]?.effort).toBe('medium')
    await edit($, w, 'App/Profile/ProfileView.swift')
    await bash($, w, 'xcodebuild -scheme App build', { text: 'Exit code 65\n** BUILD FAILED **', isError: true })
    await step($, { turnId: 't1', index: 1, effort: 'high' })
    expect(w.sent[1]?.effort).toBe('high')
  })

  test('changing /effort mid-task re-decides against the new level; auto off keeps the session effort', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the onboarding title string', turnId: 't1' })
    await step($, { turnId: 't1', effort: 'high' })
    await step($, { turnId: 't1', index: 1, effort: 'medium' })
    expect(w.sent.map(x => x.effort)).toEqual(['medium', 'low'])
    await cmd($, 'effort auto off')
    await step($, { turnId: 't1', index: 2, effort: 'high' })
    expect(w.sent[2]?.effort).toBe('high')
  })

  test('DRY RUN shows the effort it would use without sending it', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await $.turn.start({ text: 'Fix the typo in the onboarding title string', turnId: 't1' })
    await step($, { turnId: 't1', effort: 'high' })
    expect(w.sent[0]?.effort).toBe('high')
    expect(await cmd($, 'status')).toContain('effort high now, would use medium (auto: lowered for a mechanical change)')
  })
})
