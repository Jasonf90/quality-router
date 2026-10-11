import { describe, expect, test } from 'claude-code/testing'

import {
  agentStep,
  agentSummary,
  agentTool,
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  applyTodoWrite,
  emptyActivity,
  endAgent,
  phaseAgents,
  progress,
  startAgent,
  taskList,
} from '../hooks/activity'
import { barCells, fillTone } from '../hooks/present'
import { BAND_PROPS, SESSION_MODEL, SPAWN, cmd, install, start, step, tool, turn, SLOW } from './harness'

const BAND = { plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS } as const

describe('task lists (pure)', () => {
  test('TodoWrite replaces the list for its loop', () => {
    let a = applyTodoWrite(emptyActivity(), 'main', {
      todos: [
        { content: 'Add model', status: 'completed', activeForm: 'Adding model' },
        { content: 'Wire screen', status: 'in_progress', activeForm: 'Wiring screen' },
        { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      ],
    })
    expect(progress(taskList(a, 'main'))).toEqual({ done: 1, total: 3, current: 'Wiring screen' })
    a = applyTodoWrite(a, 'main', { todos: [{ content: 'Only one', status: 'completed', activeForm: 'x' }] })
    expect(progress(taskList(a, 'main'))).toEqual({ done: 1, total: 1, current: null })
    expect(applyTodoWrite(a, 'main', { todos: 'nope' })).toBe(a)
  })

  test('TaskCreate, TaskUpdate and TaskList keep the session-wide list', () => {
    let a = applyTaskCreate(emptyActivity(), { subject: 'Build', activeForm: 'Building' }, { task: { id: '1', subject: 'Build' } })
    a = applyTaskCreate(a, { subject: 'Test' }, { task: { id: '2', subject: 'Test' } })
    a = applyTaskUpdate(a, { taskId: '1', status: 'in_progress' })
    expect(progress(taskList(a, 'main'))?.current).toBe('Building')
    a = applyTaskUpdate(a, { taskId: '1', status: 'completed' })
    a = applyTaskUpdate(a, { taskId: '2', status: 'deleted' })
    expect(progress(taskList(a, 'main'))).toEqual({ done: 1, total: 1, current: null })
    a = applyTaskList(a, { tasks: [{ id: '1', subject: 'Build', status: 'completed', blockedBy: [] }, { id: '3', subject: 'Ship', status: 'pending', blockedBy: [] }] })
    expect(taskList(a, 'main').map(t => t.id)).toEqual(['1', '3'])
    // The session-wide list wins over a TodoWrite list for the main loop.
    a = applyTodoWrite(a, 'main', { todos: [{ content: 'x', status: 'pending', activeForm: 'x' }] })
    expect(taskList(a, 'main').length).toBe(2)
  })

  test('no list: no progress (never an invented percentage)', () => {
    expect(progress([])).toBe(null)
  })
})

describe('agents (pure)', () => {
  test('lifecycle: running, steps, tools, done or failed', () => {
    let a = startAgent(emptyActivity(), { id: 'a1', description: 'find colors', type: 'Explore', model: 'claude-haiku-5-5', at: 0, phaseId: 'p', background: false })
    a = startAgent(a, { id: 'a2', description: 'fix login', type: 'general-purpose', model: null, at: 5, phaseId: 'p', background: true })
    a = agentStep(a, 'a1', { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 'claude-haiku-5-5')
    a = agentStep(a, 'a1', null, null)
    a = agentTool(agentTool(a, 'a1'), 'a1')
    expect(a.agents.a1?.steps).toBe(2)
    expect(a.agents.a1?.unknown).toBe(1)
    expect(a.agents.a1?.tools).toBe(2)
    expect(agentSummary(phaseAgents(a, 'p'))).toEqual({ running: 2, done: 0, failed: 0, total: 2 })
    a = endAgent(a, 'a1', 'answer', 10)
    a = endAgent(a, 'a2', 'error', 12)
    expect(agentSummary(phaseAgents(a, 'p'))).toEqual({ running: 0, done: 1, failed: 1, total: 2 })
    expect(agentStep(a, 'missing', null, null)).toBe(a)
  })
})

describe('bars (pure)', () => {
  test('cells never show full below 100% nor empty above 0%', () => {
    expect(barCells(0, 10)).toEqual({ filled: 0, empty: 10 })
    expect(barCells(0.01, 10)).toEqual({ filled: 1, empty: 9 })
    expect(barCells(0.99, 10)).toEqual({ filled: 9, empty: 1 })
    expect(barCells(1, 10)).toEqual({ filled: 10, empty: 0 })
    expect(barCells(7, 10)).toEqual({ filled: 10, empty: 0 })
    expect(barCells(NaN, 10)).toEqual({ filled: 0, empty: 10 })
    expect([fillTone(10), fillTone(70), fillTone(90)]).toEqual(['success', 'warning', 'error'])
  })
})

describe('the band (mock integration)', () => {
  test('shows task and agent progress with bars, in every routing state', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    await tool($, w, 'TodoWrite', {
      todos: [
        { content: 'Add model', status: 'completed', activeForm: 'Adding model' },
        { content: 'Wire screen', status: 'in_progress', activeForm: 'Wiring the screen' },
        { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      ],
    })
    const a = await $.agent.spawn({ ...SPAWN, prompt: 'Find where the theme colors are defined', subagentType: 'Explore' } as never)
    const id = (a as { agentId: string }).agentId
    await step($, { turnId: 'ta', agentId: id })
    await tool($, w, 'Read', { file_path: 'App/Theme.swift' }, { ok: true }, id)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'Tasks' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '1/3' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /^Wiring the screen · time left: estimating$/ })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: 'Agents' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '0/1' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /^1 running · time left: see each agent$/ })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '▸ Explore' })).not.toBe(undefined)
      expect(await ui.find({ type: 'Text', text: /^find colors · Opus 5\.5 · 1 steps · 1 tools/ })).not.toBe(undefined)
      await ui.unmount()
    }
    await $.turn.complete({ answer: 'found', durationMs: 5, isAborted: false, turnId: 'ta', agentId: id, reason: 'answer' } as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '1/1' })).not.toBe(undefined)
    const pane = await $.ui.mount({ plugin: 'quality-router', surface: 'terminal', component: 'Pane', requestId: 'quality-router', props: { title: 'Quality Router', isFocused: false } as never })
    expect(await pane.find({ type: 'Text', text: /find colors · Opus 5\.5 · 1 steps · 1 tools/ })).not.toBe(undefined)
    expect(await pane.find({ type: 'Text', text: /▸ Wiring the screen/ })).not.toBe(undefined)
  })

  test('context fill shows as a meter, and a recommendation offers to compact', SLOW, async ($, on) => {
    const w = install(on)
    w.context = { tokens: 156_000, window: 200_000, percent: 78 }
    await start($)
    await turn($, 'Fix the failing discount calculation in CartViewModel', 't1')
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Context' })).not.toBe(undefined)
    expect((await ui.find({ type: 'Text', text: '78%' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: /Context 78% full: compact soon/ })).not.toBe(undefined)
    await ui.press({ key: 'qr-tip' })
    expect(w.toasts.some(t => t.includes('compacting now'))).toBe(true)
    // It runs a moment later, outside the press: Claude Code refuses one from inside it.
    expect(w.compactions.length).toBe(0)
    await w.clock.advance(300)
    expect(w.compactions.length).toBe(1)
    expect(w.compactions[0]).toContain('current debug task')
    expect(w.toasts.some(t => t.includes('Conversation compacted'))).toBe(true)
    await ui.press({ key: 'qr-dismiss' })
    expect(await ui.find({ type: 'Text', text: /compact soon/ })).toBe(undefined)
  })

  test('a verified task on a big context offers a fresh start, by typing /clear for the person to confirm', SLOW, async ($, on) => {
    const w = install(on)
    w.stepUsage = { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 1000 }
    await start($)
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1' })
    await tool($, w, 'Bash', { command: 'npm test' }, undefined)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(await cmd($, 'tips')).toContain('Checks passed: start fresh for the next task')
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Checks passed/ })).not.toBe(undefined)
    expect((await ui.find({ key: 'qr-tip' }))?.props.label).toBe('Start fresh')
    await ui.press({ key: 'qr-tip' })
    expect(w.filled).toEqual(['/clear'])
    expect(w.toasts.some(t => t.includes('press Enter to start fresh'))).toBe(true)
  })

  test('in the desktop app (no prompt box to type into) Start fresh asks in the band, and only the second press clears', SLOW, async ($, on) => {
    const w = install(on)
    w.noComposer = true
    w.stepUsage = { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 1000 }
    await start($)
    await $.turn.start({ text: 'Fix the failing discount calculation in CartViewModel', turnId: 't1' })
    await step($, { turnId: 't1' })
    await tool($, w, 'Bash', { command: 'npm test' }, undefined)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await ui.find({ key: 'qr-tip' }))?.props.label).toBe('Start fresh')
    await ui.press({ key: 'qr-tip' })
    expect(w.filled).toEqual([])
    expect(w.commandsRun).toEqual([])
    expect(await ui.find({ type: 'Text', text: /clears this conversation/ })).not.toBe(undefined)
    await ui.press({ key: 'qr-clear-confirm' })
    await w.clock.advance(300)
    expect(w.commandsRun).toEqual(['clear'])
  })

  test('what a button did shows in the band itself, not only as a notification', SLOW, async ($, on) => {
    const w = install(on)
    w.context = { tokens: 156_000, window: 200_000, percent: 78 }
    await start($)
    await turn($, 'Fix the failing discount calculation in CartViewModel', 't1')
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'qr-tip' })
    await w.clock.advance(300)
    expect(await ui.find({ type: 'Text', text: /Conversation compacted/ })).not.toBe(undefined)
  })

  test('savings are front and centre: ON shows the estimate, DRY RUN what routing could save', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await turn($, 'Fix the typo in the onboarding title', 't1')
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Could save' })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /^est\. \$/ })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /this session if ON · \d+% less than all Opus 5\.5 · list prices, re-caching included/ })).not.toBe(undefined)
    await ui.unmount()
    await cmd($, 'on')
    await w.clock.advance(61 * 60_000)
    await turn($, 'Fix the typo in the settings title', 't2')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Saved' })).not.toBe(undefined)
    const value = await ui.find({ type: 'Text', text: /^est\. \$/ })
    expect(value?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: /^this session · .*less than all Opus 5\.5/ })).not.toBe(undefined)
    expect(w.store.get('savings-log')).not.toBe(undefined)
    const text = await cmd($, 'savings')
    expect(text).toContain('Saved: est.')
    expect(text).toContain('Haiku 5.5: 1 request(s)')
  })

  test('band sizes: compact is one row, off hides it but keeps other mods\' content', SLOW, async ($, on) => {
    install(on)
    await start($)
    await cmd($, 'band compact')
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(JSON.stringify(await ui.drawn())).not.toContain('borderStyle')
    expect(await ui.find({ text: /Router DRY RUN/ })).not.toBe(undefined)
    await ui.unmount()
    await cmd($, 'band off')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /Router/ })).toBe(undefined)
    expect(await ui.find({ text: 'another mod draws here' })).not.toBe(undefined)
    await ui.unmount()
    await cmd($, 'band full')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(JSON.stringify(await ui.drawn())).toContain('round')
  })

  test('the session model keeps working while the band tracks it (no request is altered by tracking)', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await turn($, 'Fix the typo in the title', 't1', 2)
    expect(w.sent.every(s => s.model === SESSION_MODEL)).toBe(true)
  })

  test('savings stay visible all session: OFF shows what routing could save, and real savings survive turning it off', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'off')
    await turn($, 'Fix the typo in the onboarding title', 't1')
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Could save' })).not.toBe(undefined)
    expect(w.sent.every(x => x.model === SESSION_MODEL)).toBe(true)
    await ui.unmount()
    await cmd($, 'on')
    await w.clock.advance(61 * 60_000)
    await turn($, 'Fix the typo in the settings title', 't2')
    await $.turn.start({ text: 'Fix the typo in the about screen title', turnId: 't3' })
    await step($, { turnId: 't3' })
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /\+\$\d+\.\d+ this turn/ })).not.toBe(undefined)
    await ui.unmount()
    await cmd($, 'off')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Saved' })).not.toBe(undefined)
  })

  test('no button shares a row with text, in the band and the pane, on terminal and desktop', SLOW, async ($, on) => {
    const w = install(on)
    w.context = { tokens: 160_000, window: 200_000, percent: 80 }
    await start($)
    await cmd($, 'on')
    await turn($, 'Fix the failing discount calculation in CartViewModel', 't1')
    type Node = { type?: string; children?: unknown[] }
    const offending: string[] = []
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return
      const o = n as Node
      const kids = (o.children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)
      if (o.type === 'Box' && kids.some(k => k.type === 'Button') && kids.some(k => k.type === 'Text')) offending.push(JSON.stringify(o).slice(0, 120))
      kids.forEach(walk)
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ key: 'qr-tip' })).not.toBe(undefined)
      walk(await ui.drawn())
      await ui.unmount()
      const pane = await $.ui.mount({ plugin: 'quality-router', surface, component: 'Pane', requestId: 'quality-router', props: { title: 'Quality Router', isFocused: false } as never })
      walk(await pane.drawn())
      await pane.unmount()
    }
    expect(offending).toEqual([])
  })

  test('effort: the band shows the exact level, who set it, and what Claude Code applied', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    await step($, { turnId: 't1', effort: 'high' })
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /effort high \(session setting\)/ })).not.toBe(undefined)
    await ui.unmount()
    await cmd($, 'effort middle low')
    await step($, { turnId: 't1', index: 1, effort: 'high' })
    expect(w.sent[1]?.effort).toBe('low')
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /effort low \(your middle-tier setting\)/ })).not.toBe(undefined)
    await ui.unmount()
    // Claude Code lowers a level the model does not take, and says so on its hook events.
    await $.classic.PostToolUse({ tool_name: 'Read', tool_input: {}, tool_response: {}, tool_use_id: 'x', effort: { level: 'medium' } } as never)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /effort low \(your middle-tier setting, last applied medium\)/ })).not.toBe(undefined)
    expect(await cmd($, 'status')).toContain('effort low (your middle-tier setting, last applied medium)')
  })
})
