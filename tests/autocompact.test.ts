import { describe, expect, test } from 'claude-code/testing'

import { AUTO_COMPACT_COOLDOWN_MS, autoCompactDue } from '../hooks/advisor'
import { parseCommand } from '../hooks/commands'
import { compactCommandFailed, needsCompactCommand } from '../hooks/core'
import { normalizePrefs } from '../hooks/settings'
import { SLOW, SPAWN, cmd, install, start, step } from './harness'

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
