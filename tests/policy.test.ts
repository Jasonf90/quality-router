import { describe, expect, test } from 'claude-code/testing'

import type { Prefs } from '../types'
import { EMPTY_RUNTIME, planStep } from '../hooks/core'
import { analyzePrompt, analyzeSubagent, answerDemands, applyMode, decide, followUpRaises, isContinuation, isExecution, isFollowUp, raisesTask } from '../hooks/policy'
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
    for (const t of ['ok implement it', 'Looks good, proceed with the implementation', 'go ahead and do it', 'the test still fails, try a different approach', 'yes, go with option 2', '<task-notification>agent finished</task-notification>', 'yes', 'what is next', "what's next?", 'do all as recommended', 'go ahead with everything', 'keep going'])
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

describe('learned from the sessions of Oct 12-14 (paraphrased)', () => {
  test('data that syncs across a person\'s devices is high risk: a bug reaches every device, a production schema stays', () => {
    for (const t of [
      'can we move the icloud sync and cross device continuity to the front of our plan?',
      'add CloudKit sync for routines',
      'let people choose whether business rhythms sync to their other devices',
      'set up conflict resolution for edits made offline on two devices',
      'deploy the schema to production in the CloudKit console',
    ]) {
      expect(`${t}: ${analyzePrompt(t).risk}`).toBe(`${t}: high`)
      expect(`${t}: ${route(t).tier}`).toBe(`${t}: strong`)
    }
    for (const t of ['sync my branch with main', 'add a lip sync animation to the mascot', 'rename the SyncButton label'])
      expect(`${t}: ${analyzePrompt(t).risk}`).toBe(`${t}: low`)
  })

  test('a reply that sets the proposed work going is an execution; one that asks about it is not', () => {
    for (const t of ['Yes', "Let's start working the plan", 'Continue with all that is recommended', 'Do it for me', 'go ahead', 'complete for me'])
      expect(`${t}: ${isExecution(t)}`).toBe(`${t}: true`)
    for (const t of ["what's next?", 'whats next', 'Is it building it', 'why did that fail?'])
      expect(`${t}: ${isExecution(t)}`).toBe(`${t}: false`)
  })

  test('an answer proposing high-risk or design work raises the reply that starts it; an ordinary plan does not', () => {
    const risky = answerDemands('Here is the plan.\n1. Move routines to CloudKit with NSPersistentCloudKitContainer.\n2. Handle sync conflicts.\nShall I start?')
    expect(risky?.tier).toBe('strong')
    expect(risky?.signals).toContain('data sync')
    const plain = answerDemands('Next: tidy the settings copy and add a unit test for the formatter. We also plan to look at spacing.')
    expect(plain).toBe(null)
    expect(answerDemands('')).toBe(null)
    const question = analyzePrompt('what should we do next?')
    expect(raisesTask(question, risky as NonNullable<typeof risky>, 'quality-first')).toBe(true)
  })

  test('a long answer is read at its opening and its end, where the proposal sits', () => {
    const filler = 'Ran the sweep and checked each screen. '.repeat(400)
    expect(answerDemands(`Done.\n${filler}\nNext I can submit build 42 to App Store review. Want me to?`)?.signals).toContain('store release')
    expect(answerDemands(`Done.\n${filler.slice(0, 3000)} payments ${filler}\nAll checks pass.`)).toBe(null)
  })
})

describe('learned from the sessions of Oct 15-17 (paraphrased)', () => {
  test('terse release steps are high risk: what is uploaded or submitted reaches people', () => {
    for (const t of [
      'Build and upload 14',
      'push build 7',
      'upload the new build',
      'finish the support page and the screenshots, then submit',
      'complete the schema deploy for me',
    ]) {
      expect(`${t}: ${analyzePrompt(t).risk}`).toBe(`${t}: high`)
      expect(`${t}: ${route(t).tier}`).toBe(`${t}: strong`)
    }
    for (const t of ['push the branch', 'build the project and run the tests', 'upload the logs to the issue']) {
      expect(`${t}: ${analyzePrompt(t).signals.includes('store release')}`).toBe(`${t}: false`)
    }
  })

  test('"does not work" and "don\'t work" are bug reports, like "doesn\'t work"', () => {
    for (const t of ['mouse input does not work on any pop up window', "the buttons on the mac pop ups don't work"]) {
      expect(`${t}: ${analyzePrompt(t).category}`).toBe(`${t}: debug`)
    }
  })
})

describe('learned from the sessions of Oct 18-23 (paraphrased)', () => {
  const follow = (t: string) => isFollowUp(t, analyzePrompt(t))

  test('a question about work under way carries the task on, as "keep going" does', () => {
    for (const t of [
      'tests still running?',
      'Are they still running?',
      'is the archive done yet',
      'build 22 finished?',
      'ipad build loaded yet?',
      'how is the audit going?',
      'almost done with the audit?',
      'How far along is the test run?',
      'how many screens are left?',
      'What next then',
      'What’s next on the list',
      'what should we do next',
    ])
      expect(`${t}: ${follow(t)}`).toBe(`${t}: true`)
    for (const t of ['keep it running', 'get the release ready', 'is build 40 live in TestFlight yet', 'how should the onboarding flow work?', 'Where is the theme defined?'])
      expect(`${t}: ${follow(t)}`).toBe(`${t}: false`)
  })

  test('so it keeps the task it asks about, and never lowers it', () => {
    const audit = analyzePrompt('Make a detailed plan to audit every screen and fix what is broken')
    expect(applyMode(audit, 'quality-first').tier).toBe('strong')
    // Started as new work it was a plain question, on the middle tier.
    expect(applyMode(analyzePrompt('tests still running?'), 'quality-first').tier).toBe('middle')
    expect(raisesTask(audit, analyzePrompt('tests still running?'), 'quality-first')).toBe(false)
    const lookup = analyzePrompt('list all the files that import the theme')
    expect(raisesTask(lookup, analyzePrompt('tests still running?'), 'quality-first')).toBe(true)
    // One the rules cannot read would have started a new task on the strongest tier: it still gets that.
    const fix = analyzePrompt('Fix the failing discount calculation in CartViewModel')
    expect(applyMode(fix, 'quality-first').tier).toBe('middle')
    expect(followUpRaises(fix, 'Build finished?', analyzePrompt('Build finished?'), 'quality-first')).toBe(true)
    expect(followUpRaises(fix, 'ok thanks', analyzePrompt('ok thanks'), 'quality-first')).toBe(false)
  })

  test('typographic apostrophes read like plain ones', () => {
    expect(analyzePrompt('the share button doesn’t work on the second device').category).toBe('debug')
    expect(isExecution('Let’s start the plan')).toBe(true)
    expect(follow('Do what’s next')).toBe(true)
  })

  test('store steps that reach testers or App Review are high risk', () => {
    for (const t of [
      'all set, submit 2.1.4 now',
      'push build now',
      'have we pushed the updated build yet',
      'remove the old build and add the updated build to the version',
      'write What to Test notes for build 52',
      'can we ask for an expedited review?',
      'file an app status review with Apple',
      'please get a status update from Apple on the review',
    ]) {
      expect(`${t}: ${analyzePrompt(t).signals.includes('store release')}`).toBe(`${t}: true`)
      expect(`${t}: ${route(t).tier}`).toBe(`${t}: strong`)
    }
    for (const t of ['push the build script changes', 'add a new build phase for the linter', 'request a status update from the agent', 'decide what to test first', 'push the branch'])
      expect(`${t}: ${analyzePrompt(t).signals.includes('store release')}`).toBe(`${t}: false`)
  })

  test('what sits behind a paywall is payments work', () => {
    const a = analyzePrompt('only the basic tracker stays free; move every other feature behind the paywall')
    expect(a.risk).toBe('high')
    expect(a.signals).toContain('payments')
  })
})
