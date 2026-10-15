import { describe, expect, test } from 'claude-code/testing'

import { type AdviceInput, recommend } from '../hooks/advisor'
import type { Projection } from '../hooks/limits'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { SLOW, cmd, install, start, step } from './harness'

const BASE: AdviceInput = {
  state: 'on',
  mode: 'quality-first',
  contextPercent: 20,
  promptTokens: 20_000,
  isWorking: false,
  idleMs: 0,
  phaseVerdict: 'unverified',
  phaseStartContext: 0,
  phaseOrdinal: 0,
  weekly: null,
  potential: null,
  dismissed: [],
}

const ids = (i: Partial<AdviceInput>) => recommend({ ...BASE, ...i }).map(r => r.id)

describe('recommendations (pure)', () => {
  test('a small, fresh session gets none', () => {
    expect(ids({})).toEqual([])
  })

  test('context: compact soon at 70%, now at 90% (urgent first)', () => {
    expect(ids({ contextPercent: 72 })).toEqual(['context-high'])
    const r = recommend({ ...BASE, contextPercent: 93, promptTokens: 186_000 })
    expect(r[0]?.id).toBe('context-critical')
    expect(r[0]?.severity).toBe('urgent')
    expect(r[0]?.action).toBe('compact')
  })

  test('the re-sent volume quoted is the observed prompt size', () => {
    const r = recommend({ ...BASE, contextPercent: 75, promptTokens: 150_000 })
    expect(r[0]?.detail).toContain('about 150k tokens')
  })

  test('a new task on a large inherited context suggests a new session (or compact)', () => {
    expect(ids({ phaseOrdinal: 1, phaseStartContext: 90_000 })).toContain('new-task-old-context')
    expect(ids({ phaseOrdinal: 0, phaseStartContext: 90_000 })).not.toContain('new-task-old-context')
    expect(ids({ phaseOrdinal: 1, phaseStartContext: 10_000 })).not.toContain('new-task-old-context')
  })

  test('verified work on a big context suggests starting fresh; unverified does not', () => {
    expect(ids({ phaseVerdict: 'verified', promptTokens: 50_000 })).toContain('task-verified')
    expect(ids({ phaseVerdict: 'unverified', promptTokens: 50_000 })).not.toContain('task-verified')
    expect(ids({ phaseVerdict: 'verified', promptTokens: 10_000 })).not.toContain('task-verified')
  })

  test('idle with a large prompt: the cache may have expired', () => {
    expect(ids({ idleMs: 12 * 60_000, promptTokens: 40_000 })).toContain('cache-cold')
    expect(ids({ idleMs: 2 * 60_000, promptTokens: 40_000 })).not.toContain('cache-cold')
  })

  test('nothing is suggested mid-turn except a full context', () => {
    expect(ids({ isWorking: true, phaseVerdict: 'verified', promptTokens: 90_000, idleMs: 20 * 60_000, phaseOrdinal: 6, phaseStartContext: 90_000 })).toEqual([])
    expect(ids({ isWorking: true, contextPercent: 95 })).toEqual(['context-critical'])
  })

  test('weekly pace and dry-run potential', () => {
    const weekly: Projection = { kind: 'seven_day', percentUsed: 70, resetsAt: null, status: 'projected', etaMs: Date.UTC(2026, 9, 12, 12), primary: null, alternative: null, note: '' }
    const r = recommend({ ...BASE, weekly })
    expect(r[0]?.id).toBe('weekly-pace')
    expect(r[0]?.title).toContain('(estimate)')
    expect(r[0]?.action).toBe('economy')
    expect(recommend({ ...BASE, weekly, mode: 'economy' })[0]?.action).toBe(null)
    expect(ids({ state: 'dry-run', potential: { usd: 1.5, percent: 40 } })).toContain('dry-run-potential')
    expect(ids({ state: 'dry-run', potential: { usd: 0.01, percent: 1 } })).not.toContain('dry-run-potential')
    expect(ids({ state: 'on', potential: { usd: 1.5, percent: 40 } })).not.toContain('dry-run-potential')
  })

  test('dismissed recommendations stay hidden', () => {
    expect(ids({ contextPercent: 75, dismissed: ['context-high'] })).toEqual([])
    expect(ids({ contextPercent: 95, dismissed: ['context-high'] })).toEqual(['context-critical'])
  })
})

describe('the compaction window tip', () => {
  test("suggested when a turn has grown past 500k and Claude Code compacts only near 1M; not once it compacts sooner", () => {
    expect(ids({ promptTokens: 600_000, contextWindow: 1_000_000 })).toContain('compact-window')
    expect(ids({ promptTokens: 600_000, contextWindow: null })).toContain('compact-window')
    expect(ids({ promptTokens: 600_000, contextWindow: 450_000 })).not.toContain('compact-window')
    expect(ids({ promptTokens: 300_000, contextWindow: 1_000_000 })).not.toContain('compact-window')
  })
})

describe('learned from the sessions of Oct 12-14', () => {
  const weekly: Projection = { kind: 'seven_day', percentUsed: 94, resetsAt: null, status: 'projected', etaMs: Date.UTC(2026, 9, 15, 18), primary: null, alternative: null, note: '' }
  test('near the weekly limit with smart compaction off, the tip offers smart compaction before Economy', () => {
    const off = recommend({ ...BASE, weekly, autoCompactSmart: 'off' }).find(r => r.id === 'weekly-pace')
    expect(off?.action).toBe('smart-compact')
    expect(off?.detail).toContain('a seventh of what they saved')
    const on = recommend({ ...BASE, weekly, autoCompactSmart: 'on' }).find(r => r.id === 'weekly-pace')
    expect(on?.action).toBe('economy')
    expect(on?.detail).toContain('trades some quality')
  })
  test('a session on a model that costs more than the tier\'s own says what switching would save, and acts on nothing', () => {
    const pricierModel = { model: 'claude-opus-5', cheaper: 'claude-opus-5-5', readUsd: 0.5, cheaperReadUsd: 0.2, cheaperWriteUsd: 8 }
    const tip = recommend({ ...BASE, promptTokens: 200_000, pricierModel }).find(r => r.id === 'pricier-model')
    expect(tip?.action).toBe(null)
    expect(tip?.detail).toContain('$0.10 from the cache on claude-opus-5 against $0.04 on claude-opus-5-5')
    expect(tip?.detail).toContain('/model claude-opus-5-5')
    expect(ids({ promptTokens: 200_000, pricierModel: null })).not.toContain('pricier-model')
  })
})

describe('the pricier-model tip in a session (mock integration)', () => {
  async function tipsOn($: Engine, on: On, model: string): Promise<string> {
    const w = install(on)
    w.context = { tokens: 200_000, window: 1_000_000, percent: 20 }
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the crash when saving a routine', turnId: 't1' })
    await step($, { turnId: 't1', model })
    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    return cmd($, 'tips')
  }
  test('a session on Opus 5 (its 1M variant too) is told what Opus 5.5 would cost', SLOW, async ($, on) => {
    expect(await tipsOn($, on, 'claude-opus-5[1m]')).toContain('/model claude-opus-5-5')
  })
  test('a session on Opus 5.5 is not', SLOW, async ($, on) => {
    expect(await tipsOn($, on, 'claude-opus-5-5[1m]')).not.toContain('/model claude-opus-5-5')
  })
})
