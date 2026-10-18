import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { AUTO_COMPACT_COOLDOWN_MS, autoCompactDue, smartCompactDue, watchReport } from '../hooks/advisor'
import { parseCommand } from '../hooks/commands'
import { compactCommandFailed, compactInstructions, needsCompactCommand } from '../hooks/core'
import { analyzePrompt } from '../hooks/policy'
import { compactionDone, compactionNet, compactionReset, compactionStep, emptyCompaction } from '../hooks/savings'
import { normalizePrefs } from '../hooks/settings'
import { BAND_PROPS, SLOW, SPAWN, bash, cmd, edit, install, start, step, tool, turn } from './harness'

const due = { state: 'on' as const, threshold: 300_000, promptTokens: 400_000, turnReason: 'answer', agentsRunning: 0, lastAutoCompactAt: null, now: 1_000_000 }

describe('auto-compact rules (pure)', () => {
  test('due only when ON, armed, large enough, finished normally, no agents running, past the cooldown', () => {
    expect(autoCompactDue(due)).toBe(true)
    expect(autoCompactDue({ ...due, state: 'dry-run' })).toBe(false)
    expect(autoCompactDue({ ...due, state: 'off' })).toBe(false)
    expect(autoCompactDue({ ...due, threshold: null })).toBe(false)
    expect(autoCompactDue({ ...due, promptTokens: 299_999 })).toBe(false)
    expect(autoCompactDue({ ...due, turnReason: 'aborted' })).toBe(false)
    expect(autoCompactDue({ ...due, turnReason: 'error' })).toBe(false)
    expect(autoCompactDue({ ...due, agentsRunning: 1 })).toBe(false)
    expect(autoCompactDue({ ...due, lastAutoCompactAt: due.now - 60_000 })).toBe(false)
    expect(autoCompactDue({ ...due, lastAutoCompactAt: due.now - AUTO_COMPACT_COOLDOWN_MS - 1 })).toBe(true)
  })

  test('off by default; the command takes sizes like 300k and off', () => {
    expect(normalizePrefs({}).autoCompactTokens).toBe(null)
    expect(normalizePrefs({ autoCompactTokens: 10 }).autoCompactTokens).toBe(null)
    const on = parseCommand('autocompact 300k')
    expect(on.kind).toBe('prefs')
    if (on.kind === 'prefs') expect(on.change(normalizePrefs({})).autoCompactTokens).toBe(300_000)
    const off = parseCommand('autocompact off')
    if (off.kind === 'prefs') expect(off.change(normalizePrefs({ autoCompactTokens: 300_000 })).autoCompactTokens).toBe(null)
    expect(parseCommand('autocompact 5k').kind).toBe('error')
    expect(parseCommand('autocompact lots').kind).toBe('error')
  })
})

describe('auto-compact in the session (mock integration)', () => {
  const big = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 }

  test('compacts a moment after a large turn ends, keeping the plan; then waits out the cooldown', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    w.context = { tokens: 402_000, window: 1_000_000, percent: 40 }
    await start($)
    await cmd($, 'on')
    expect(await cmd($, 'autocompact 300k')).toContain('auto-compact at 300k tokens')
    await $.turn.start({ text: 'start phase 3', turnId: 't1' })
    await step($, { turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(w.compactions.length).toBe(0)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(1)
    expect(w.compactions[0]).toContain('Keep any plan in full')
    expect(w.toasts.some(t => t.includes('auto-compacted a 402k-token conversation'))).toBe(true)
    // A second large turn within ten minutes: no second compaction.
    await $.turn.start({ text: 'start phase 4', turnId: 't2' })
    await step($, { turnId: 't2' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(1)
    expect(await cmd($, 'status')).toContain('auto-compact at 300k tokens')
  })

  test('never when off (the default), in DRY RUN, after an interrupted turn, or with agents still running', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    w.context = { tokens: 402_000, window: 1_000_000, percent: 40 }
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'start phase 3', turnId: 't1' })
    await step($, { turnId: 't1' })
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(0)
    await cmd($, 'autocompact 300k')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(0)
    await $.agent.spawn({ ...SPAWN, prompt: 'Find the theme', subagentType: 'Explore' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(0)
    await cmd($, 'dry-run')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(0)
  })
})

describe('compacting on request (button and command)', () => {
  test('the command answers at once and compacts a moment later, outside the command', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    expect(await cmd($, 'compact')).toContain('compacting now')
    expect(w.compactions.length).toBe(0)
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(1)
    expect(w.toasts.some(t => t.includes('Conversation compacted'))).toBe(true)
    expect(w.store.get('last-compact')).toMatchObject({ source: 'command', ok: true })
  })

  test('one at a time: a second request while one is pending is turned away', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    expect(await cmd($, 'compact')).toContain('compacting now')
    expect(await cmd($, 'compact')).toContain('already running')
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(1)
    expect(await cmd($, 'compact')).toContain('compacting now')
  })

  test('when Claude Code refuses, it says why and types /compact with the same focus for the person to send', SLOW, async ($, on) => {
    const w = install(on)
    w.compactRefusal = 'session.compact: a turn is running'
    await start($)
    await cmd($, 'compact')
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(0)
    expect(w.filled.length).toBe(1)
    expect(w.filled[0]).toMatch(/^\/compact Keep the current task/)
    const last = w.toasts[w.toasts.length - 1] ?? ''
    // The test kit reports a refusing hook in its own words; the real engine names its check.
    expect(last).toContain('Claude Code did not compact:')
    expect(last).toContain('press Enter')
    expect(w.store.get('last-compact')).toMatchObject({ source: 'command', ok: false })
  })
})

describe('compacting in the desktop app (pure, from the real engine messages)', () => {
  test("an SDK host's refusal sends the compaction through /compact; other refusals do not", () => {
    expect(needsCompactCommand('quality-router: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on')).toBe(true)
    expect(needsCompactCommand('quality-router: session.compact: called from a command.run hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete) (host check)')).toBe(false)
  })

  test("/compact's own output tells a failure from a compaction", () => {
    expect(compactCommandFailed('Not enough messages to compact.')).toBe(true)
    expect(compactCommandFailed('Error during compaction: the request failed')).toBe(true)
    expect(compactCommandFailed('Compacted. ctrl+o to see full summary')).toBe(false)
    expect(compactCommandFailed('')).toBe(false)
  })
})

describe('smart auto-compact (pure)', () => {
  const at = { state: 'on' as const, smart: 'on' as const, promptTokens: 160_000, turnReason: 'answer', agentsRunning: 0, lastAt: null, now: 1_000_000, boundaryTokens: 150_000, ceilingTokens: 400_000, finished: true, failingCheck: false }

  test('compacts finished work past the boundary size, and anything past the ceiling', () => {
    expect(smartCompactDue(at)).toBe('boundary')
    expect(smartCompactDue({ ...at, promptTokens: 149_000 })).toBe(null)
    expect(smartCompactDue({ ...at, promptTokens: 420_000, finished: false })).toBe('ceiling')
    expect(smartCompactDue({ ...at, promptTokens: 420_000, failingCheck: true })).toBe('ceiling')
  })

  test('never mid-task below the ceiling: work not finished (no commit, checks not passing, tasks open), or a check failing', () => {
    expect(smartCompactDue({ ...at, promptTokens: 380_000, finished: false })).toBe(null)
    expect(smartCompactDue({ ...at, promptTokens: 380_000, failingCheck: true })).toBe(null)
  })

  test('never when off, routing not ON, after an interrupted turn, with agents running, or within ten minutes', () => {
    expect(smartCompactDue({ ...at, smart: 'off' })).toBe(null)
    expect(smartCompactDue({ ...at, state: 'dry-run' })).toBe(null)
    expect(smartCompactDue({ ...at, turnReason: 'aborted' })).toBe(null)
    expect(smartCompactDue({ ...at, agentsRunning: 1 })).toBe(null)
    expect(smartCompactDue({ ...at, lastAt: at.now - 60_000 })).toBe(null)
    expect(smartCompactDue({ ...at, smart: 'watch' })).toBe('boundary')
  })

  test('the commands: smart, watch, report, sizes; a plain size leaves watching on and turns smart off', () => {
    const base = normalizePrefs({ autoCompactTokens: 300_000 })
    const run = (cmd: string, p = base) => {
      const a = parseCommand(cmd)
      if (a.kind !== 'prefs') throw new Error(`${cmd}: ${a.kind}`)
      return normalizePrefs(a.change(p))
    }
    expect(base.autoCompactSmart).toBe('off')
    expect(run('autocompact smart').autoCompactSmart).toBe('on')
    expect(run('autocompact watch').autoCompactSmart).toBe('watch')
    expect(parseCommand('autocompact report').kind).toBe('autocompact-report')
    expect(run('autocompact boundary 200k').autoCompactBoundary).toBe(200_000)
    expect(run('autocompact ceiling 450k').autoCompactCeiling).toBe(450_000)
    expect(run('autocompact 250k', run('autocompact watch')).autoCompactSmart).toBe('watch')
    expect(run('autocompact 250k', run('autocompact smart')).autoCompactSmart).toBe('off')
    expect(run('autocompact off', run('autocompact smart'))).toMatchObject({ autoCompactSmart: 'off', autoCompactTokens: null })
    expect(parseCommand('autocompact boundary lots').kind).toBe('error')
  })

  test('the watch report counts what smart would have done and what the plain threshold did', () => {
    const lines = watchReport([
      { at: 1, tokens: 180_000, smart: 'boundary', plain: false, midTask: false },
      { at: 2, tokens: 310_000, smart: null, plain: true, midTask: true },
    ])
    expect(lines.join(' ')).toContain('would have compacted 1 time(s): 1 when work is finished (at 180k)')
    expect(lines.join(' ')).toContain('compacted 1 time(s), 1 of them with work unfinished')
  })
})

describe('smart auto-compact in the session (mock integration)', () => {
  const big = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 }
  const todos = (done: number, total: number) => ({ todos: Array.from({ length: total }, (_, i) => ({ content: `Step ${i + 1}`, status: i < done ? 'completed' : 'in_progress', activeForm: `Doing step ${i + 1}` })) })

  async function work($: Engine, w: ReturnType<typeof install>, id: string, done: number, total: number) {
    await $.turn.start({ text: id === 't1' ? 'Add a settings screen with a dark mode toggle' : 'ok continue', turnId: id })
    await step($, { turnId: id })
    await tool($, w, 'TodoWrite', todos(done, total))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' } as never)
    await w.clock.advance(2000)
  }

  test('on: waits while the task is open, compacts once it is finished, with instructions that keep what summaries lose', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    await start($)
    await cmd($, 'on')
    expect(await cmd($, 'autocompact smart')).toContain('smart auto-compact on')
    w.context = { tokens: 300_000, window: 1_000_000, percent: 30 }
    await work($, w, 't1', 2, 3)
    expect(w.compactions.length).toBe(0)
    w.context = { tokens: 310_000, window: 1_000_000, percent: 31 }
    await work($, w, 't2', 3, 3)
    expect(w.compactions.length).toBe(1)
    expect(w.compactions[0]).toContain('approaches already tried and rejected')
    expect(w.compactions[0]).toContain('preferences and constraints')
    expect(w.toasts.some(t => t.includes('the task list is done'))).toBe(true)
  })

  test('on: a commit or passing checks mark the work finished; a failing check does not', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    await start($)
    await cmd($, 'on')
    await cmd($, 'autocompact smart')
    w.context = { tokens: 200_000, window: 1_000_000, percent: 20 }
    // A failing check: not finished.
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1' })
    await edit($, w, 'App/Cart/CartViewModel.swift')
    await bash($, w, 'xcodebuild -scheme App test', { text: 'Exit code 65\n** TEST FAILED **', isError: true })
    await $.turn.complete({ answer: 'still failing', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(0)
    // The fix passes its checks: finished.
    await $.turn.start({ text: 'ok try again', turnId: 't2' })
    await step($, { turnId: 't2' })
    await edit($, w, 'App/Cart/CartViewModel.swift')
    await bash($, w, 'xcodebuild -scheme App test', { text: '** TEST SUCCEEDED **' })
    await $.turn.complete({ answer: 'fixed', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(1)
    expect(w.toasts.some(t => t.includes('the checks pass'))).toBe(true)
  })

  test('on: a commit during the turn marks the work finished', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    await start($)
    await cmd($, 'on')
    await cmd($, 'autocompact smart')
    w.context = { tokens: 200_000, window: 1_000_000, percent: 20 }
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    await step($, { turnId: 't1' })
    await bash($, w, 'git add -A && git commit -m "Settings screen"', { text: '[main abc123] Settings screen' })
    await $.turn.complete({ answer: 'committed', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(1)
    expect(w.toasts.some(t => t.includes('the work was committed'))).toBe(true)
  })

  test('on: past the ceiling it compacts even mid-task', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    await start($)
    await cmd($, 'on')
    await cmd($, 'autocompact smart')
    w.context = { tokens: 420_000, window: 1_000_000, percent: 42 }
    await work($, w, 't1', 1, 3)
    expect(w.compactions.length).toBe(1)
    expect(w.toasts.some(t => t.includes('past the 400k ceiling'))).toBe(true)
  })

  test('watch: the plain threshold still compacts; smart only notes when it would have, in the band and the report', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = big
    await start($)
    await cmd($, 'on')
    await cmd($, 'autocompact 300k')
    expect(await cmd($, 'autocompact watch')).toContain('watching')
    // A finished task at 180k: smart would compact, the plain 300k threshold does not.
    w.context = { tokens: 180_000, window: 1_000_000, percent: 18 }
    await work($, w, 't1', 3, 3)
    expect(w.compactions.length).toBe(0)
    const ui = await $.ui.mount({ plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /would compact now: the task list is done, 180k tokens/ })).not.toBe(undefined)
    await ui.unmount()
    // Past 300k with a task open: the plain threshold compacts, and the report says it was mid-task.
    await w.clock.advance(11 * 60_000)
    w.context = { tokens: 320_000, window: 1_000_000, percent: 32 }
    await work($, w, 't2', 1, 3)
    expect(w.compactions.length).toBe(1)
    const report = await cmd($, 'autocompact report')
    expect(report).toContain('Smart auto-compact: watching')
    expect(report).toContain('1 when work is finished (at 180k)')
    expect(report).toContain('1 of them with work unfinished')
    expect(await cmd($, 'status')).toContain('smart auto-compact watching')
  })
})

describe("Claude Code's own compactions (mock integration)", () => {
  test('its automatic compactions, mid-turn included, get the router instructions; a /compact with its own text keeps it', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] } as never)
    expect(w.compactions.length).toBe(1)
    expect(w.compactions[0]).toContain('approaches already tried and rejected')
    expect(w.compactions[0]).toContain('Keep any plan in full')
    await $.session.compact({ trigger: 'manual', instructions: 'keep the API notes', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] } as never)
    expect(w.compactions[1]).toBe('keep the API notes')
  })

  test('after a compaction whose size is not reported, a model switch is not treated as free', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 }
    await start($)
    await cmd($, 'on')
    await turn($, 'Plan how to add OAuth login with refresh tokens to the app', 't1')
    expect(w.sent[0]?.model).toBe('claude-opus-5-5')
    await cmd($, 'compact')
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(1)
    await turn($, 'How does the settings screen decide which theme to show?', 't2')
    expect(w.sent[1]?.model).toBe('claude-opus-5-5')
  })
})

describe('what every summary is told to keep (pure)', () => {
  test('beyond the task and plan: approvals and their scope, side effects done, work still running, exact values', () => {
    const t = compactInstructions(null, false)
    expect(t).toStartWith('Keep the current task: its goal and what the person counts as done')
    expect(t).not.toContain('Keep any plan in full')
    for (const part of [
      'approaches already tried and rejected',
      'what they approved and how far that approval goes',
      'how far any step interrupted part-way had got',
      'side effects already done (commits, pushes, uploads, submissions, deployments, messages sent) with their ids, so none is repeated',
      'each background command, monitor, agent or workflow not yet finished, with its id',
      'checked on rather than started again',
      'version and build numbers, branch names, commit hashes',
    ]) expect(`${part}: ${t.includes(part)}`).toBe(`${part}: true`)
    expect(compactInstructions(null, true)).toContain('Keep any plan in full')
  })

  test('each kind of task adds what it most needs; a release and high-risk work add theirs', () => {
    const bug = compactInstructions(analyzePrompt('the settings screen crashes when I rotate the phone'), true)
    expect(bug).toStartWith('Keep the current debugging task')
    expect(bug).toContain('each hypothesis tested and what it showed')
    expect(bug).not.toContain('high risk')
    const release = compactInstructions(analyzePrompt('push build 7 to TestFlight, then submit'), true)
    expect(release).toContain('For the release: what is uploaded, submitted or approved')
    expect(release).toContain('This work is high risk: keep what cannot be undone and is already done')
    // A kind without its own focus gets the general instructions, unlabelled.
    expect(compactInstructions(analyzePrompt('what does the onboarding flow do?'), true)).toStartWith('Keep the current task:')
  })

  test('built from the verdict alone: no text of the prompt reaches it', () => {
    const t = compactInstructions(analyzePrompt('fix the crash in PaymentsVault.swift, key sk-test-123'), true)
    for (const leak of ['PaymentsVault', 'sk-test-123', 'crash in']) expect(t.includes(leak)).toBe(false)
  })

  test("Claude Code's own compaction of high-risk work gets the release and risk lines", SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await turn($, 'push build 7 to TestFlight, then submit', 't1')
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] } as never)
    expect(w.compactions[0]).toContain('For the release')
    expect(w.compactions[0]).toContain('This work is high risk')
    expect(w.compactions[0]).toContain('checked on rather than started again')
  })
})

describe("what the router's compactions save (estimate)", () => {
  const near = (a: number | null, b: number) => expect(a !== null && Math.abs(a - b) < 1e-9).toBe(true)
  const pane = ($: Engine) => $.ui.mount({ plugin: 'quality-router', surface: 'terminal', component: 'Pane', requestId: 'quality-router', props: { title: 'Quality Router', isFocused: false } as never })
  const prefs = normalizePrefs({ version: 2, cacheTtl: '5m' })
  const opus = 'claude-opus-5-5'

  test('cost: one read of the conversation, the summary written, the summary cached', () => {
    const c = compactionDone(emptyCompaction(), { pre: 400_000, post: 40_000, base: 17_000, model: opus, prefs })
    // 400k reads at 0.2 + 23k summary at 20 + 40k cache writes at 5, per million
    near(c.costUsd, 0.74)
    expect(c).toMatchObject({ count: 1, offset: 360_000, unpriced: 0 })
    near(compactionNet(c), -0.74)
  })

  test('each later request is credited with what it no longer carries, until Claude Code would have compacted anyway', () => {
    let c = compactionDone(emptyCompaction(), { pre: 400_000, post: 40_000, base: 17_000, model: opus, prefs })
    c = compactionStep(c, { promptTokens: 50_000, model: opus, point: 417_000, prefs })
    near(c.savedUsd, 0.072)
    expect(c.offset).toBe(360_000)
    // 60k + 360k passes 417k: only up to that point counts, then nothing more.
    c = compactionStep(c, { promptTokens: 60_000, model: opus, point: 417_000, prefs })
    near(c.savedUsd, 0.072 + 0.0714)
    expect(c.offset).toBe(0)
    expect(compactionStep(c, { promptTokens: 70_000, model: opus, point: 417_000, prefs })).toEqual(c)
  })

  test('nothing is counted without a known window, after any other compaction, or without a price', () => {
    const c = compactionDone(emptyCompaction(), { pre: 400_000, post: 40_000, base: 17_000, model: opus, prefs })
    expect(compactionStep(c, { promptTokens: 50_000, model: opus, point: null, prefs })).toEqual(c)
    expect(compactionReset(c).offset).toBe(0)
    const unpriced = compactionDone(emptyCompaction(), { pre: 400_000, post: 40_000, base: 17_000, model: 'claude-mystery-1', prefs })
    expect(unpriced).toMatchObject({ count: 1, unpriced: 1, offset: 0, costUsd: 0 })
    expect(compactionNet(unpriced)).toBe(null)
    expect(compactionNet(undefined)).toBe(null)
  })

  test("in the session: an automatic compaction is counted in the report and the band; one you ask for is not", SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 }
    w.context = { tokens: 402_000, window: 1_000_000, percent: 40 }
    await start($)
    await cmd($, 'on')
    await cmd($, 'autocompact 300k')
    await turn($, 'start phase 3', 't1')
    await w.clock.advance(2000)
    expect(w.compactions.length).toBe(1)
    w.stepUsage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0 }
    w.context = { tokens: 62_000, window: 1_000_000, percent: 6 }
    await turn($, 'start phase 4', 't2', 3)
    const report = await pane($)
    expect(await report.find({ text: /B3\. COMPACTION BY THE ROUTER/ })).not.toBe(undefined)
    expect(await report.find({ text: /1 compaction\(s\) cost \$[\d.]+; the requests after them read \$[\d.]+ less context/ })).not.toBe(undefined)
    await report.unmount()
    const ui = await $.ui.mount({ plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /compaction -?\$[\d.]+/ })).not.toBe(undefined)
    await ui.unmount()
  })

  test('a compaction asked for by command is the person\'s, not counted as the router\'s', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 }
    w.context = { tokens: 402_000, window: 1_000_000, percent: 40 }
    await start($)
    await cmd($, 'on')
    await turn($, 'start phase 3', 't1')
    await cmd($, 'compact')
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(1)
    await turn($, 'start phase 4', 't2')
    const report = await pane($)
    expect(await report.find({ text: /B3\. COMPACTION BY THE ROUTER/ })).not.toBe(undefined)
    expect(await report.find({ text: /none this session/ })).not.toBe(undefined)
    expect(await report.find({ text: /compaction\(s\) cost/ })).toBe(undefined)
    await report.unmount()
  })
})
