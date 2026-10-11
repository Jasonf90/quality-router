import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_CHECKS,
  applyCheck,
  applyCodeEdit,
  bashWritesCode,
  checkStatus,
  classifyOutcome,
  compileChecks,
  emptyScope,
  emptyValidation,
  isCodeFile,
  isDestructive,
  matchCheck,
  recordCheck,
  recordEdit,
  riskyPath,
  scopeFloor,
  verdict,
} from '../hooks/escalation'
import { analyzePrompt, decide } from '../hooks/policy'
import { DEFAULT_PREFS } from '../hooks/settings'
import { bash, cmd, edit, install, start, step, tool, turn, SLOW } from './harness'

const checks = compileChecks(null)
const out = (text: string, extra: Partial<Parameters<typeof classifyOutcome>[0]> = {}) =>
  classifyOutcome({ denied: false, isError: true, interrupted: false, timedOut: false, text, isCheck: true, ...extra })

describe('outcome classification (pure)', () => {
  test('mobile and web toolchain commands are recognised as checks', () => {
    expect(matchCheck('xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" test', checks)).toBe('test')
    expect(matchCheck('xcodebuild -scheme App build', checks)).toBe('build')
    expect(matchCheck('./gradlew testDebugUnitTest', checks)).toBe('test')
    expect(matchCheck('./gradlew lintDebug', checks)).toBe('lint')
    expect(matchCheck('flutter test', checks)).toBe('test')
    expect(matchCheck('npx tsc --noEmit', checks)).toBe('typecheck')
    expect(matchCheck('npm test -- --watch=false', checks)).toBe('test')
    expect(matchCheck('ls -la', checks)).toBe(null)
    expect(DEFAULT_CHECKS.length).toBeGreaterThan(5)
  })

  test('a nonzero exit is not automatically a model failure', () => {
    expect(out('Exit code 1\nTests failed: 2 of 10')).toBe('check-failed')
    expect(out('zsh: command not found: xcodebuild')).toBe('environment')
    expect(out('Unable to boot the Simulator.')).toBe('environment')
    expect(out('SDK location not found. Define ANDROID_HOME')).toBe('environment')
    expect(out("Error: Cannot find module 'react-native-reanimated'")).toBe('missing-dependency')
    expect(out('The sandbox is not in sync with the Podfile.lock. Run pod install')).toBe('missing-dependency')
    expect(out('', { interrupted: true })).toBe('cancelled')
    expect(out('', { denied: true })).toBe('denied')
    expect(out('Executed 0 tests', { isError: false })).toBe('no-tests')
    expect(out('', { timedOut: true })).toBe('timeout')
    expect(out('grep: no match', { isCheck: false })).toBe('command-failed')
  })

  test('sensitive paths are recognised', () => {
    expect(riskyPath('App/Auth/LoginService.swift', null)).not.toBe(null)
    expect(riskyPath('app/src/main/AndroidManifest.xml', null)).not.toBe(null)
    expect(riskyPath('App/Features/Paywall/PurchaseManager.swift', null)).not.toBe(null)
    expect(riskyPath('App/Views/ProfileHeader.swift', null)).toBe(null)
  })
})

describe('repair tracking (pure)', () => {
  test('expected red test under TDD does not count', () => {
    const scope = emptyScope(true)
    const r = applyCheck(recordEdit(scope, 'Tests/CartTests.swift'), 'test', 'check-failed', 'quality-first', 2)
    expect(r.escalate).toBe(null)
    expect(r.note).toContain('expected under TDD')
    expect(r.scope.repair.test?.failedAttempts).toBe(0)
  })

  test('the same failure re-run with no edit in between does not count again', () => {
    let s = recordEdit(emptyScope(false), 'Sources/Cart.swift')
    s = applyCheck(s, 'test', 'check-failed', 'quality-first', 2).scope
    s = applyCheck(s, 'test', 'check-failed', 'quality-first', 2).scope
    expect(s.repair.test?.failedAttempts).toBe(1)
  })

  test('repeated unsuccessful repairs escalate, once per limit, bounded', () => {
    let s = recordEdit(emptyScope(false), 'Sources/Cart.swift')
    let r = applyCheck(s, 'test', 'check-failed', 'quality-first', 1)
    expect(r.escalate).toBe(null)
    s = recordEdit(r.scope, 'Sources/Cart.swift')
    r = applyCheck(s, 'test', 'check-failed', 'quality-first', 1)
    expect(r.escalate).toContain('2 failed repair attempts on test')
    expect(r.scope.escalations).toBe(1)
    // At the bound, more failures do not escalate again.
    s = recordEdit(r.scope, 'Sources/Cart.swift')
    s = applyCheck(s, 'test', 'check-failed', 'quality-first', 1).scope
    s = recordEdit(s, 'Sources/Cart.swift')
    const last = applyCheck(s, 'test', 'check-failed', 'quality-first', 1)
    expect(last.escalate).toBe(null)
    expect(last.scope.escalations).toBe(1)
  })

  test('environment failures never escalate, and say a model change will not help', () => {
    let s = recordEdit(emptyScope(false), 'Sources/Cart.swift')
    let note: string | null = null
    for (let i = 0; i < 3; i++) {
      const r = applyCheck(s, 'build', 'environment', 'quality-first', 2)
      s = r.scope
      note = r.note
      expect(r.escalate).toBe(null)
    }
    expect(note).toContain('will not fix the environment')
  })

  test('a pass before later edits is stale, not a verification', () => {
    let v = emptyValidation('p1', null)
    v = recordCheck(v, 'test', 'ok', 'npm test', 1, { sourceVersion: 1, testVersion: 0 })
    expect(checkStatus(v, 'test', { sourceVersion: 1, testVersion: 0 })).toBe('passed')
    expect(verdict(v, { sourceVersion: 1, testVersion: 0 })).toBe('verified')
    expect(checkStatus(v, 'test', { sourceVersion: 2, testVersion: 0 })).toBe('stale')
    expect(verdict(v, { sourceVersion: 2, testVersion: 0 })).toBe('unverified')
    expect(verdict(emptyValidation('p', null), { sourceVersion: 0, testVersion: 0 })).toBe('unverified')
  })
})

describe('escalation in the session (mock integration)', () => {
  test('repeated failed repairs move the next request to a stronger model; no tool is replayed', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    await edit($, w, 'App/Cart/CartViewModel.swift')
    await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    await edit($, w, 'App/Cart/CartViewModel.swift')
    await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    expect(w.toolCalls).toBe(4)
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
    expect(w.toasts.some(t => t.includes('escalating'))).toBe(true)
    expect(w.toolCalls).toBe(4)
  })

  test('environment failures and cancellations do not escalate', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    for (let i = 0; i < 3; i++) {
      await edit($, w, 'App/Cart/CartViewModel.swift')
      await bash($, w, 'xcodebuild -scheme App test', { text: 'xcodebuild: error: Unable to find a destination matching the provided destination specifier', isError: true })
    }
    await bash($, w, 'xcodebuild -scheme App test', { text: '', interrupted: true, isError: true })
    await bash($, w, 'xcodebuild -scheme App test', { text: '', deny: 'The user denied this' })
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-sonnet-5-5')
    expect(await cmd($, 'status')).toContain('test ?')
  })

  test('editing a sensitive file raises the scope to the strong tier and suggests review', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    await edit($, w, 'App/Auth/SessionStore.swift')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(await cmd($, 'status')).toContain('review suggested')
    expect(w.submitted.length).toBe(0)
  })

  test('OFF: no escalation; checks are still tracked for display', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    for (let i = 0; i < 3; i++) {
      await edit($, w, 'App/Cart/CartViewModel.swift')
      await bash($, w, 'npm test', { text: 'Exit code 1\n1 failed', isError: true })
    }
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-opus-5-5')
    expect(w.toasts.length).toBe(0)
    expect(await cmd($, 'status')).toContain('test ✗')
  })

  test('a check that passed is shown stale after a later edit', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await turn($, 'Fix the failing discount calculation in CartViewModel', 't1')
    await bash($, w, 'npm test', { text: 'Tests: 10 passed' })
    expect(await cmd($, 'status')).toContain('test ✓')
    await edit($, w, 'src/cart.ts')
    expect(await cmd($, 'status')).toContain('test ~')
  })
})

describe('code written on the cheap tier', () => {
  test('source files are told from docs, data and config', () => {
    for (const f of ['App/Save/SaveStore.swift', 'app/src/Main.kt', 'src/screens/Home.tsx', 'lib/main.dart', 'Shaders/Glow.metal', 'tools/gen.py'])
      expect(isCodeFile(f)).toBe(true)
    for (const f of ['README.md', 'planning/notes.md', 'Tuning.json', 'Info.plist', 'page.html', 'data.csv', 'Package.resolved'])
      expect(isCodeFile(f)).toBe(false)
  })

  test('shell commands that plainly write a source file are seen; reads and logs are not', () => {
    expect(bashWritesCode("sed -i '' 's/old/new/' App/Save/SaveStore.swift")).toBe('App/Save/SaveStore.swift')
    expect(bashWritesCode("sed -E -i 's/a/b/g' src/Home.tsx")).toBe('src/Home.tsx')
    expect(bashWritesCode("perl -pi -e 's/x/y/' lib/main.dart")).toBe('lib/main.dart')
    expect(bashWritesCode("cat > App/New/View.swift <<'EOF'\nstruct V {}\nEOF")).toBe('App/New/View.swift')
    expect(bashWritesCode('echo "// note" >> src/util.ts')).toBe('src/util.ts')
    expect(bashWritesCode('printf x | tee -a App/A.swift')).toBe('App/A.swift')
    expect(bashWritesCode('grep -rn "save" App/Save/SaveStore.swift')).toBe(null)
    expect(bashWritesCode('xcodebuild test 2>&1 | tail -5')).toBe(null)
    expect(bashWritesCode('swift test > test.log 2>&1')).toBe(null)
    expect(bashWritesCode('cat README.md > notes.md')).toBe(null)
  })

  test('a non-mechanical task that edits code on the cheap tier moves up one tier, once', () => {
    const s = emptyScope(false)
    const first = applyCodeEdit(s, 'extraction', 0, 'App/Save/SaveStore.swift')
    expect(first.escalate).toBe('code edited during extraction work (SaveStore.swift)')
    expect(first.scope.escalations).toBe(1)
    expect(applyCodeEdit(first.scope, 'extraction', 0, 'App/Other.swift').escalate).toBe(null)
    expect(applyCodeEdit(s, 'mechanical', 0, 'App/A.swift').escalate).toBe(null)
    expect(applyCodeEdit(s, 'question', 1, 'App/A.swift').escalate).toBe(null)
  })
})

describe('code written on the cheap tier (mock integration)', () => {
  test('a look-up that turns into a code change moves to the middle tier for the rest of the task', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Find all places where the save file is written', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
    await edit($, w, 'App/Save/SaveStore.swift')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-sonnet-5-5')
  })

  test('the same through a shell write', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Find all places where the save file is written', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
    await bash($, w, "sed -i '' 's/a/b/' App/Save/SaveStore.swift", { text: '' })
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-sonnet-5-5')
  })

  test('a mechanical edit (a typo) stays on the cheap tier', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the onboarding title string', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
    await edit($, w, 'App/Onboarding/OnboardingView.swift')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-haiku-5-5')
  })
})

describe('escalation never moves down, and risk lasts (reviewer cases)', () => {
  test('a task held on the strong tier that escalates stays strong', () => {
    const analysis = analyzePrompt('Rename fetchUser to loadUser in ProfileService.swift')
    const d = decide({ prefs: { ...DEFAULT_PREFS, state: 'on' }, analysis, verdict: null, escalations: 2, projectFloor: null, previousTier: 'strong', promptTokens: 0, epoch: 0, now: 0 })
    expect(d.tier).toBe('strong')
  })

  test('a sensitive edit sets a strong floor that later decisions keep; a cheap-tier code edit a middle one', () => {
    expect(scopeFloor({ riskTouched: ['edited Auth/TokenStore.swift'] })).toBe('strong')
    expect(scopeFloor({ riskTouched: ['code edit'] })).toBe('middle')
    expect(scopeFloor({ riskTouched: [] })).toBe(null)
    const analysis = analyzePrompt('Find all places where the save file is written')
    const d = decide({ prefs: { ...DEFAULT_PREFS, state: 'on' }, analysis, verdict: null, escalations: 0, projectFloor: null, scopeFloor: 'strong', previousTier: null, promptTokens: 0, epoch: 0, now: 0 })
    expect(d.tier).toBe('strong')
  })
})

describe('two edits in one response (mock integration)', () => {
  test('a sensitive file edited after an ordinary one still moves the task to the strong tier', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Find all places where the save file is written', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-haiku-5-5')
    await edit($, w, 'App/Config.swift')
    await edit($, w, 'App/Auth/TokenStore.swift')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })
})

describe('follow-ups and task lists keep the risk (mock integration)', () => {
  test('"ok implement it" after a high-risk plan stays on the strong tier', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await turn($, 'Plan how to add OAuth login with refresh tokens to the app', 't1')
    expect(w.sent[0]?.model).toBe('claude-opus-5-5')
    await turn($, 'ok implement it', 't2')
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })

  test('"still fails, try again" keeps the escalation it continues', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    for (let i = 0; i < 2; i++) {
      await edit($, w, 'App/Cart/CartViewModel.swift')
      await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    }
    await $.turn.complete({ answer: 'stuck', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await turn($, 'the test still fails, try a different approach', 't2')
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })

  test('a high-risk prompt keeps its risk when its task list looks routine', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: "let's finish the oauth stuff", turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-opus-5-5')
    await tool($, w, 'TodoWrite', { todos: [{ content: 'Add the redirect handler', status: 'in_progress', activeForm: 'Adding' }, { content: 'Write unit tests for the handler', status: 'pending', activeForm: 'Writing' }] })
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })
})

describe('routine work does not trigger risk escalation (cost, no quality value)', () => {
  test('cleaning build output is routine; deleting source or forcing history is not', () => {
    expect(isDestructive('rm -rf build/ DerivedData')).toBe(false)
    expect(isDestructive('rm -rf ~/Library/Developer/Xcode/DerivedData/MyApp-abc')).toBe(false)
    expect(isDestructive('rm -rf build/MyApp.xcarchive build/export && xcodebuild -exportArchive')).toBe(false)
    expect(isDestructive('defaults delete com.example.myapp')).toBe(false)
    expect(isDestructive('rm -rf App/Sources')).toBe(true)
    expect(isDestructive('rm -rf build && rm -rf App')).toBe(true)
    expect(isDestructive('git push origin main --force')).toBe(true)
    expect(isDestructive('xcrun altool --upload-app -f build/App.ipa')).toBe(true)
  })

  test('a note about purchases is not a purchase flow', () => {
    expect(riskyPath('planning/iap-pricing-research.md', null)).toBe(null)
    expect(riskyPath('App/Store/IAPManager.swift', null)).not.toBe(null)
  })
})

describe('checks the router cannot see the end of (mock integration)', () => {
  test('a test run sent to the background is not a pass', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    await edit($, w, 'App/Cart/CartViewModel.swift')
    await bash($, w, 'xcodebuild -scheme App test', { text: 'Command running in background with ID: b1', result: { backgroundTaskId: 'b1' } })
    expect(await cmd($, 'status')).not.toContain('test ✓')
    expect(await cmd($, 'status')).not.toContain('verified')
  })

  test('repairs that only rewrite tests still count toward escalation', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Write unit tests for the CartViewModel discount calculation', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    for (let i = 0; i < 2; i++) {
      await edit($, w, 'AppTests/CartViewModelTests.swift')
      await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    }
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })

  test('a fix written with sed counts as a repair attempt', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    for (let i = 0; i < 2; i++) {
      await bash($, w, "sed -i '' 's/0.1/0.15/' App/Cart/CartViewModel.swift", { text: '' })
      await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    }
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })
})
