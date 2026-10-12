import { describe, expect, test } from 'claude-code/testing'

import { type AdviceInput, recommend } from '../hooks/advisor'
import type { Projection } from '../hooks/limits'

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
