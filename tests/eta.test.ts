import { describe, expect, test } from 'claude-code/testing'

import type { AgentActivity, TaskItem } from '../types'
import { agentEstimate, etaText, median, overallAgentEta, recordRun, taskEstimate } from '../hooks/eta'
import { applyTaskUpdate, applyTodoWrite, emptyActivity } from '../hooks/activity'
import { BAND_PROPS, SPAWN, T0, cmd, install, start, step, tool, SLOW } from './harness'

const M = 60_000
const item = (status: TaskItem['status'], over: Partial<TaskItem> = {}): TaskItem => ({ id: Math.random().toString(36), subject: 's', status, ...over })

function agent(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'a1', description: 'find colors', type: 'Explore', model: 'claude-haiku-5-5', status: 'running',
    startedAt: T0, endedAt: null, steps: 3, tools: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unknown: 0,
    phaseId: 'p', background: false, ...over,
  }
}

describe('task list estimates (pure)', () => {
  test('estimating until the first task finishes; then pace-based', () => {
    expect(taskEstimate([item('in_progress'), item('pending')], T0, T0 + M)?.status).toBe('estimating')
    // Two done in 10 minutes (5 min each); 2 left; the current one has run 1 minute.
    const list = [item('completed', { completedAt: T0 + 4 * M }), item('completed', { completedAt: T0 + 10 * M }), item('in_progress'), item('pending')]
    const e = taskEstimate(list, T0, T0 + 11 * M)
    expect(e?.status).toBe('estimate')
    expect(e?.fraction).toBe(0.5)
    expect(e?.remainingMs).toBe(4 * M + 5 * M)
    expect(e?.basis).toBe('2 of 4 done, about 5m00s per task so far (from 2 timed)')
  })

  test('a slow current task pushes the estimate out, never below a quarter task', () => {
    const list = [item('completed', { completedAt: T0 + 5 * M }), item('in_progress'), item('pending')]
    const e = taskEstimate(list, T0, T0 + 20 * M)
    expect(e?.remainingMs).toBe(1.25 * M + 5 * M)
  })

  test('tasks already finished when the list is first seen do not set a pace', () => {
    const list = [item('completed', { completedAt: T0 }), item('in_progress'), item('pending')]
    expect(taskEstimate(list, T0, T0 + M)?.status).toBe('estimating')
  })

  test('all done is done; empty is nothing', () => {
    expect(taskEstimate([item('completed', { completedAt: T0 })], T0, T0)?.status).toBe('done')
    expect(taskEstimate([], T0, T0)).toBe(null)
  })

  test('reducers stamp completion times (TodoWrite matched by subject)', () => {
    let a = applyTodoWrite(emptyActivity(), 'main', { todos: [{ content: 'A', status: 'in_progress', activeForm: 'a' }, { content: 'B', status: 'pending', activeForm: 'b' }] }, T0)
    expect(a.listStarted.main).toBe(T0)
    expect(a.todos.main?.[0]?.startedAt).toBe(T0)
    a = applyTodoWrite(a, 'main', { todos: [{ content: 'A', status: 'completed', activeForm: 'a' }, { content: 'B', status: 'in_progress', activeForm: 'b' }] }, T0 + 3 * M)
    expect(a.todos.main?.[0]?.completedAt).toBe(T0 + 3 * M)
    a = applyTodoWrite(a, 'main', { todos: [{ content: 'A', status: 'completed', activeForm: 'a' }, { content: 'B', status: 'in_progress', activeForm: 'b' }] }, T0 + 9 * M)
    expect(a.todos.main?.[0]?.completedAt).toBe(T0 + 3 * M)
    const b = applyTaskUpdate({ ...emptyActivity(), tasks: [{ id: '1', subject: 'x', status: 'pending' }] }, { taskId: '1', status: 'completed' }, T0 + M)
    expect(b.tasks[0]?.completedAt).toBe(T0 + M)
  })
})

describe('agent estimates (pure)', () => {
  test('no history: no percentage, just activity', () => {
    const e = agentEstimate(agent(), [], null, {}, T0 + M)
    expect(e.fraction).toBe(null)
    expect(e.status).toBe('no-history')
    expect(e.basis).toBe('no finished Explore runs yet to estimate from')
    const two = recordRun(recordRun({}, 'Explore', 2 * M, 5), 'Explore', 2 * M, 5)
    expect(agentEstimate(agent(), [], null, two, T0 + M).basis).toBe('2 finished Explore run(s) so far; estimates start at 3')
  })

  test('from typical duration of past runs of the same type', () => {
    let stats = {}
    for (const d of [2 * M, 4 * M, 3 * M]) stats = recordRun(stats, 'Explore', d, 6)
    const e = agentEstimate(agent(), [], null, stats, T0 + 1.5 * M)
    expect(e.status).toBe('estimate')
    expect(e.fraction).toBe(0.5)
    expect(e.remainingMs).toBe(1.5 * M)
    expect(e.basis).toBe('typical Explore run 3m00s, from 3 past runs')
  })

  test('past its usual time: "longer than usual", capped below 100%', () => {
    let stats = {}
    for (const d of [2 * M, 2 * M, 2 * M]) stats = recordRun(stats, 'Explore', d, 6)
    const e = agentEstimate(agent(), [], null, stats, T0 + 5 * M)
    expect(e.status).toBe('overdue')
    expect(e.fraction).toBe(0.95)
    expect(e.remainingMs).toBe(null)
  })

  test('its own task list wins over history, still capped until it finishes', () => {
    const own = [item('completed', { completedAt: T0 + 2 * M }), item('completed', { completedAt: T0 + 4 * M })]
    const e = agentEstimate(agent(), own, T0, {}, T0 + 4 * M)
    expect(e.fraction).toBe(0.95)
    const done = agentEstimate(agent({ status: 'done', endedAt: T0 + 3 * M }), [], null, {}, T0 + 5 * M)
    expect([done.status, done.fraction, done.basis]).toEqual(['done', 1, 'done after 3m00s'])
  })

  test('overall: the latest agent, only when every running agent has an estimate', () => {
    const a = { fraction: 0.5, status: 'estimate' as const, remainingMs: M, etaMs: T0 + M, basis: '' }
    const b = { fraction: 0.2, status: 'estimate' as const, remainingMs: 4 * M, etaMs: T0 + 4 * M, basis: '' }
    expect(overallAgentEta([a, b])?.remainingMs).toBe(4 * M)
    expect(overallAgentEta([a, { ...b, status: 'no-history' as const, etaMs: null, remainingMs: null }])).toBe(null)
    expect(etaText({ remainingMs: 90_000, etaMs: T0 })).toMatch(/^~1m30s left · done ~\d\d:\d\d \(est\.\)$/)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([])).toBe(null)
  })
})

describe('progress and estimates on the band (mock integration)', () => {
  const BAND = { plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS } as const

  test('task list shows a bar and time left once a task finishes', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await $.turn.start({ text: 'Add pull-to-refresh to the OrdersList screen', turnId: 't1' })
    const todos = (s1: string, s2: string, s3: string) => ({ todos: [
      { content: 'Add control', status: s1, activeForm: 'Adding control' },
      { content: 'Wire fetch', status: s2, activeForm: 'Wiring fetch' },
      { content: 'Write tests', status: s3, activeForm: 'Writing tests' },
    ] })
    await tool($, w, 'TodoWrite', todos('in_progress', 'pending', 'pending'))
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Adding control · time left: estimating/ })).not.toBe(undefined)
    await ui.unmount()
    await w.clock.advance(4 * M)
    await tool($, w, 'TodoWrite', todos('completed', 'in_progress', 'pending'))
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '1/3' })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /Wiring fetch · ~8m00s left · done ~\d\d:\d\d \(est\.\)/ })).not.toBe(undefined)
  })

  test('running agents get their own rows: estimate from past runs, else activity', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    // Three finished Explore runs of 2 minutes teach the typical duration.
    for (let i = 0; i < 3; i++) {
      const r = await $.agent.spawn({ ...SPAWN, prompt: 'Find where colors are', subagentType: 'Explore' } as never)
      await w.clock.advance(2 * M)
      await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `tx${i}`, agentId: (r as { agentId: string }).agentId, reason: 'answer' } as never)
    }
    expect(JSON.stringify(w.store.get('agent-stats'))).toContain('"Explore"')
    const r = await $.agent.spawn({ ...SPAWN, description: 'find theme', prompt: 'Find the theme', subagentType: 'Explore' } as never)
    await step($, { turnId: 'ta', agentId: (r as { agentId: string }).agentId })
    await w.clock.advance(1 * M)
    const g = await $.agent.spawn({ ...SPAWN, description: 'plan it', prompt: 'Do the change', subagentType: 'general-purpose' } as never)
    expect((g as { agentId: string }).agentId).not.toBe(undefined)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: '▸ Explore' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '~50%' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /find theme · ~1m00s left · done ~\d\d:\d\d \(est\.\)/ })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '▸ general-purpose' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: 'working' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /no finished general-purpose runs yet to estimate from/ })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /2 running · time left: see each agent/ })).not.toBe(undefined)
      await ui.unmount()
    }
  })
})
