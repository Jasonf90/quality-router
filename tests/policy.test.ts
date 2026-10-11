import { describe, expect, test } from 'claude-code/testing'

import type { Prefs } from '../types'
import { EMPTY_RUNTIME, planStep } from '../hooks/core'
import { analyzePrompt, analyzeSubagent, applyMode, decide, isContinuation, isFollowUp, raisesTask } from '../hooks/policy'
import { DEFAULT_PREFS, normalizePrefs } from '../hooks/settings'

const prefs = (over: Partial<Prefs> = {}): Prefs => ({ ...DEFAULT_PREFS, ...over })

function route(text: string, p: Prefs = prefs()) {
  return decide({ prefs: p, analysis: analyzePrompt(text), verdict: null, escalations: 0, projectFloor: null, previousTier: null, promptTokens: 0, epoch: 0, now: 0 })
}

describe('routing tiers', () => {
  test('mechanical task -> cheap tier', () => {
    const d = route('Fix the typo in the onboarding title string')
    expect(d.tier).toBe('cheap')
    expect(d.model).toBe('claude-haiku-5-5')
    expect(analyzePrompt('Sort the imports in ProfileView.swift').category).toBe('mechanical')
  })

  test('a mechanical edit mixed with a fix, a refactor or a change of behaviour is not mechanical', () => {
    for (const text of [
      'Bump the version and fix the crash in AppDelegate.swift',
      'Replace callbacks with async/await in NetworkClient.swift',
      'Change the validation so the text field rejects emails without a domain',
      'Remove unused imports and refactor the sync manager',
    ]) {
      const a = analyzePrompt(text)
      expect(`${text}: ${a.category}`).not.toBe(`${text}: mechanical`)
      expect(route(text).tier).not.toBe('cheap')
    }
    for (const text of ['Fix the typo in the onboarding title string', 'Rename fetchUser to loadUser in ProfileService.swift', 'Bump the app version', 'Change the button color to blue']) {
      expect(`${text}: ${analyzePrompt(text).category}`).toBe(`${text}: mechanical`)
    }
  })

  test('scoped implementation -> middle tier', () => {
    const d = route('Add pull-to-refresh to the OrdersList screen and wire it to the existing fetchOrders call')
    expect(d.tier).toBe('middle')
    expect(route('Write unit tests for the CartViewModel discount calculation').tier).toBe('middle')
    expect(route('The app crashes when I tap Save on the profile screen, please fix it').tier).toBe('middle')
  })

  test('ambiguous architecture -> strong tier', () => {
    const a = analyzePrompt('How should we structure offline sync for the app? Not sure if Core Data is right, maybe something else')
    expect(a.category).toBe('architecture')
    expect(route('How should we structure offline sync for the app? Not sure if Core Data is right, maybe something else').tier).toBe('strong')
    expect(route('Migrate the navigation from UIKit to SwiftUI across the whole app').tier).toBe('strong')
  })

  test('hard diagnosis -> strong tier', () => {
    expect(route('The app randomly crashes only on device in release builds and I have no idea why').tier).toBe('strong')
  })

  test('security-sensitive task -> strong tier, in every mode', () => {
    for (const mode of ['quality-first', 'balanced', 'economy'] as const) {
      expect(route('Update the OAuth refresh token handling in AuthService.swift', prefs({ mode })).tier).toBe('strong')
      expect(route('Add StoreKit in-app purchase restore to the paywall', prefs({ mode })).tier).toBe('strong')
      expect(route('Write the Core Data migration for the new schema', prefs({ mode })).tier).toBe('strong')
    }
  })

  test('presentation-only change on an auth screen is not treated as high risk', () => {
    const a = analyzePrompt('Change the login button color to blue')
    expect(a.risk).toBe('medium')
    expect(route('Change the login button color to blue').tier).toBe('middle')
    expect(analyzePrompt('Change the login session token expiry').risk).toBe('high')
  })

  test('low confidence -> conservative (stronger) choice', () => {
    const a = analyzePrompt('do the thing from before with the other bit')
    expect(a.category).toBe('unknown')
    expect(route('do the thing from before with the other bit').tier).toBe('strong')
    // A vague ask lowers confidence and moves up a tier.
    expect(route('improve it').tier).toBe('strong')
  })

  test('length alone does not decide: a long mechanical ask stays cheap, a short risky one is strong', () => {
    const long = `Fix the typo in the onboarding title string. ${'The string lives in Localizable.strings under the key onboarding.title and only the spelling of "Welcome" is wrong. '.repeat(8)}`
    expect(route(long).tier).toBe('cheap')
    expect(route('rotate the api keys').tier).toBe('strong')
  })

  test('modes differ for low-risk work but share safety floors', () => {
    const q = 'Summarize what the README says about building the app'
    expect(route(q, prefs({ mode: 'quality-first' })).tier).toBe('cheap')
    const docs = 'Update the README with the new build steps'
    expect(route(docs, prefs({ mode: 'quality-first' })).tier).toBe('middle')
    expect(route(docs, prefs({ mode: 'balanced' })).tier).toBe('cheap')
    expect(applyMode(analyzePrompt('Refactor the networking layer across the whole app'), 'economy').tier).toBe('middle')
    expect(applyMode(analyzePrompt('Refactor the networking layer across the whole app'), 'quality-first').tier).toBe('strong')
  })
})

describe('precedence and constraints', () => {
  test('model floor raises automatic choices', () => {
    expect(route('Fix the typo in the onboarding title string', prefs({ floor: 'middle' })).tier).toBe('middle')
    const d = decide({ prefs: prefs(), analysis: analyzePrompt('Fix the typo in the title'), verdict: null, escalations: 0, projectFloor: 'strong', previousTier: null, promptTokens: 0, epoch: 0, now: 0 })
    expect(d.tier).toBe('strong')
  })

  test('manual override takes precedence over the rules, with a warning below the safety recommendation', () => {
    const d = route('Update the OAuth refresh token handling', prefs({ override: { kind: 'tier', tier: 'cheap' } }))
    expect(d.tier).toBe('cheap')
    expect(d.source).toBe('override')
    expect(d.reason).toContain('below the safety recommendation')
    const m = route('Fix the typo', prefs({ override: { kind: 'model', model: 'claude-sonnet-5-5' } }))
    expect(m.model).toBe('claude-sonnet-5-5')
  })

  test('escalation raises the tier, bounded by the strong tier', () => {
    const d = decide({ prefs: prefs(), analysis: analyzePrompt('Fix the typo in the title'), verdict: null, escalations: 5, escalationReason: '2 failed repair attempts on test', projectFloor: null, previousTier: null, promptTokens: 0, epoch: 0, now: 0 })
    expect(d.tier).toBe('strong')
    expect(d.source).toBe('escalation')
  })

  test('a downgrade is held while the prompt is large (switching would resend it uncached)', () => {
    const base = { prefs: prefs(), analysis: analyzePrompt('Fix the typo in the title'), verdict: null, escalations: 0, projectFloor: null, epoch: 0, now: 0 }
    expect(decide({ ...base, previousTier: 'strong', promptTokens: 120_000 }).tier).toBe('strong')
    expect(decide({ ...base, previousTier: 'strong', promptTokens: 120_000 }).source).toBe('held')
    expect(decide({ ...base, previousTier: 'strong', promptTokens: 20_000 }).tier).toBe('cheap')
  })

  test('only supported effort values survive; unset effort leaves the session effort alone', () => {
    const p = normalizePrefs({ effort: { cheap: 'ultra', middle: 'medium', strong: 7 } })
    expect(p.effort).toEqual({ middle: 'medium' })
    expect(route('Fix the typo in the title').effort).toBe(undefined)
    expect(route('Add a settings screen with a dark mode toggle', p).effort).toBe('medium')
  })

  test('an unavailable model is not sent; a decision from an old epoch is not applied', () => {
    const on = prefs({ state: 'on' })
    const decision = route('Fix the typo in the title', on)
    const rt = { ...EMPTY_RUNTIME, unavailableModels: ['claude-haiku-5-5'] }
    expect(planStep({ prefs: on, rt, e: { model: 'claude-opus-5-5' }, decision, applies: true }).rewrite).toBe(false)
    const stale = { ...EMPTY_RUNTIME, epoch: 3 }
    expect(planStep({ prefs: on, rt: stale, e: { model: 'claude-opus-5-5' }, decision, applies: true }).rewrite).toBe(false)
    expect(planStep({ prefs: on, rt: EMPTY_RUNTIME, e: { model: 'claude-opus-5-5' }, decision, applies: true }).model).toBe('claude-haiku-5-5')
  })

  test('a decision for the session model\'s own tier keeps that exact model', () => {
    const on = prefs({ state: 'on' })
    const decision = route('Update the OAuth refresh token handling', on)
    const plan = planStep({ prefs: on, rt: EMPTY_RUNTIME, e: { model: 'claude-opus-5-5[1m]' }, decision, applies: true })
    expect(plan.rewrite).toBe(false)
    expect(plan.model).toBe('claude-opus-5-5[1m]')
  })

  test('DRY RUN and OFF never rewrite', () => {
    for (const state of ['dry-run', 'off'] as const) {
      const p = prefs({ state })
      const plan = planStep({ prefs: p, rt: EMPTY_RUNTIME, e: { model: 'claude-opus-5-5' }, decision: route('Fix the typo', p), applies: true })
      expect(plan.rewrite).toBe(false)
    }
  })
})

describe('phases and subagents', () => {
  test('continuations keep the phase; new asks do not', () => {
    for (const t of ['yes', 'go ahead', 'Continue.', 'looks good', '']) expect(isContinuation(t)).toBe(true)
    for (const t of ['yes but also add tests', 'now fix the login bug']) expect(isContinuation(t)).toBe(false)
  })

  test('explorer subagents go cheap; planners strong; a high-risk parent sets a floor', () => {
    expect(analyzeSubagent('Find where the cart total is computed', 'Explore', 'low').tier).toBe('cheap')
    expect(analyzeSubagent('Lay out the steps', 'Plan', 'low').tier).toBe('strong')
    expect(analyzeSubagent('Find where the cart total is computed', 'Explore', 'high').tier).toBe('middle')
    expect(analyzeSubagent('Implement the change in CartView', 'general-purpose', 'high').tier).toBe('strong')
  })
})

describe('follow-ups carry the task on (reviewer cases)', () => {
  const follow = (t: string) => isFollowUp(t, analyzePrompt(t))
  test('short replies that point at the work in hand are follow-ups', () => {
    for (const t of ['ok implement it', 'Looks good, proceed with the implementation', 'go ahead and do it', 'the test still fails, try a different approach', 'yes, go with option 2', '<task-notification>agent finished</task-notification>', 'yes'])
      expect(`${t}: ${follow(t)}`).toBe(`${t}: true`)
  })
  test('new work is not: a named file, its own risk, a design question, or a plain new ask', () => {
    for (const t of ['Fix the typo in OnboardingView.swift', 'ok now add Apple Pay to checkout', 'Add a dark mode toggle to settings', 'How should we structure offline sync?'])
      expect(`${t}: ${follow(t)}`).toBe(`${t}: false`)
  })
  test('a follow-up can raise the task, never lower it', () => {
    const settings = analyzePrompt('Add a settings screen with a dark mode toggle')
    expect(raisesTask(settings, analyzePrompt('ok and do the same across the whole app'), 'quality-first')).toBe(true)
    expect(raisesTask(settings, analyzePrompt('ok thanks'), 'quality-first')).toBe(false)
  })
})

describe('asks the rules used to under-rate (from an audit of real prompts, paraphrased)', () => {
  test('planning and research shape everything after them: strongest tier', () => {
    for (const t of ['Make a detailed plan to simplify the app and make it more attractive', 'create a plan to audit this app and check every feature works', 'read the user feedback and make a plan to fix it', 'do some market research on popular timer apps, then make a plan'])
      expect(`${t}: ${route(t).tier}`).toBe(`${t}: strong`)
  })
  test('submitting a release is consequential: high risk', () => {
    for (const t of ['make the listing as appealing as possible then submit it for review', 'upload the build to TestFlight', 'check the App Store Connect submission draft'])
      expect(`${t}: ${analyzePrompt(t).risk}`).toBe(`${t}: high`)
  })
  test('a bug that survived earlier fixes is a hard diagnosis', () => {
    const a = analyzePrompt('Sharing with family still does not work, the invite never arrives on the second device')
    expect(a.category).toBe('diagnosis')
    expect(route('Sharing with family still does not work, the invite never arrives on the second device').tier).toBe('strong')
  })
  test('merging and rewriting documents is writing, not a look-up', () => {
    expect(route('can we merge the remaining plan with the roadmap in decisions.md? recreate them').tier).not.toBe('cheap')
  })
})
