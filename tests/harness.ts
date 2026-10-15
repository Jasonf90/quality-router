// The world beneath the plugin in integration tests: every engine call the
// mod makes is answered here from memory, and what the mod sent is recorded.
// Each test calls `install(on)` before its first call on `$`.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, RenderElement, TurnStepChunk, TurnStepResult } from 'claude-code'

import { prefsStamp } from '../hooks/settings'

export const SESSION_MODEL = 'claude-opus-5-5'
export const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

export type ToolReply = { text: string; isError?: boolean; interrupted?: boolean; deny?: string; result?: unknown }

export type World = {
  store: Map<string, unknown>
  sent: { model: string; effort?: unknown; agentId?: string; turnId: string; index: number }[]
  classifierCalls: number
  modelReply: (e: ModelCompleteInput) => ModelCompleteResult | Promise<ModelCompleteResult>
  failModels: Set<string>
  toolReplies: ToolReply[]
  toolCalls: number
  spawned: { requested?: string; agentId: string }[]
  toasts: string[]
  logs: string[]
  submitted: string[]
  opened: string[]
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  projectFile: string | null
  clock: ReturnType<typeof mock.clock>
  otherBand: boolean
  sessionId: string
  context: { tokens?: number; window: number; percent?: number }
  compactions: (string | undefined)[]
  /** When set, Claude Code refuses a compaction with this message (as it does from inside a command). */
  compactRefusal: string | null
  /** No prompt box to type into (the desktop app): prompt.fill is refused with no_composer. */
  noComposer: boolean
  /** Slash commands the router ran through $.command.run. */
  commandsRun: string[]
  filled: string[]
  stepUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 }

export function verdictReply(v: Record<string, unknown>): ModelCompleteResult {
  return {
    isAnswered: true,
    text: JSON.stringify(v),
    usage: { input_tokens: 400, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

export function install(on: On, opts: { store?: Record<string, unknown>; now?: number } = {}): World {
  const w: World = {
    store: new Map(Object.entries(opts.store ?? {})),
    sent: [],
    classifierCalls: 0,
    modelReply: () => verdictReply({ category: 'implement', complexity: 'medium', risk: 'low', verifiability: 'high', tier: 'middle', confidence: 0.8, reason: 'scoped change' }),
    failModels: new Set(),
    toolReplies: [],
    toolCalls: 0,
    spawned: [],
    toasts: [],
    logs: [],
    submitted: [],
    opened: [],
    rateLimits: [],
    projectFile: null,
    clock: mock.clock(on, { now: opts.now ?? T0 }),
    otherBand: true,
    sessionId: 'session-1',
    context: { window: 200_000 },
    compactions: [],
    compactRefusal: null,
    noComposer: false,
    commandsRun: [],
    filled: [],
    stepUsage: USAGE,
  }

  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))

  on('session.id', () => ({ value: w.sessionId }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.usage', () => ({
    value: { startedAt: T0, context: w.context, rateLimits: w.rateLimits, cost: { usd: 1.25 } },
  }))
  on('fs.exists', () => ({ value: w.projectFile !== null }))
  on('fs.read', () => ({ value: w.projectFile ?? '' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))

  on('model.complete', async (_$, e) => {
    w.classifierCalls++
    return { value: await w.modelReply(e) }
  })

  on('session.compact', (_$, e) => {
    if (w.compactRefusal !== null) throw new Error(w.compactRefusal)
    w.compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }] }
  })
  on('prompt.fill', (_$, e) => {
    if (w.noComposer) return { isFilled: false, refusal: 'no_composer' }
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('command.run', { command: 'clear' }, (_$, e) => {
    w.commandsRun.push(e.command)
    return { text: '' }
  })

  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })

  on('turn.step', async function* (_$, e) {
    w.sent.push({ model: e.model, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}), turnId: e.turnId, index: e.index })
    const base = { turnId: e.turnId, index: e.index, toolUses: [] }
    if (w.failModels.has(e.model)) {
      return { ...base, answer: '', stopReason: null, usage: null } satisfies TurnStepResult
    }
    yield { kind: 'text', index: 0, text: 'ok' } as TurnStepChunk
    return { ...base, answer: 'ok', stopReason: 'end_turn', usage: { ...w.stepUsage, model: e.model } } satisfies TurnStepResult
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))

  on('agent.spawn', (_$, e) => {
    const agentId = `agent-${w.spawned.length + 1}`
    w.spawned.push({ ...(e.model ? { requested: e.model } : {}), agentId })
    return { model: e.model ?? e.parentModel, agentId }
  })

  on('tool.call', (_$, e) => {
    w.toolCalls++
    const reply = w.toolReplies.shift() ?? { text: '' }
    if (reply.deny) return { deny: reply.deny }
    const result = String(e.tool) === 'Bash' ? { stdout: reply.text, stderr: '', interrupted: reply.interrupted ?? false, ...((reply.result as object | undefined) ?? {}) } : reply.result ?? { ok: true }
    return reply.isError ? { result, text: reply.text, isError: true } : { result, text: reply.text }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (w.otherBand ? h(Box, {}, h(Text, {}, 'another mod draws here')) : h(Box, {})) as RenderElement
  })
  on('ui.render', { component: 'Pane' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  return w
}

export async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true } as never)
}

export async function cmd($: Engine, args: string): Promise<string> {
  const out = await $.command.run({ command: 'quality-router', args } as never)
  return out.text ?? ''
}

/** Runs one model request through the chain to its end. */
export async function step($: Engine, args: { turnId: string; index?: number; model?: string; agentId?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }): Promise<TurnStepResult> {
  const s = $.turn.step({
    turnId: args.turnId,
    index: args.index ?? 0,
    model: args.model ?? SESSION_MODEL,
    messageCount: 1,
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
  })
  let it = await s.next()
  while (!it.done) it = await s.next()
  return it.value
}

/** One whole main-loop turn: start, `steps` requests, completion. */
export async function turn($: Engine, text: string, turnId: string, steps = 1, answer = 'done'): Promise<void> {
  await $.turn.start({ text, turnId })
  for (let i = 0; i < steps; i++) await step($, { turnId, index: i })
  await $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId, reason: 'answer' } as never)
}

export async function bash($: Engine, w: World, command: string, reply: ToolReply, agentId?: string): Promise<void> {
  w.toolReplies.push(reply)
  await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
}

export async function edit($: Engine, w: World, path: string, agentId?: string): Promise<void> {
  w.toolReplies.push({ text: 'edited' })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)
}

export function prefsInStore(w: World): Record<string, unknown> {
  return (w.store.get('prefs') ?? {}) as Record<string, unknown>
}

/** Another session running this version changes the shared settings: a stamped write, kept as the reference. */
export function otherSessionSets(w: World, patch: Record<string, unknown>): void {
  const body: Record<string, unknown> = { ...prefsInStore(w), ...patch }
  delete body.stamp
  body.stamp = prefsStamp(body)
  w.store.set('prefs', body)
  w.store.set('prefs-good', body)
}

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
} as never

/** Any tool call, with the result the tool returns. */
export async function tool($: Engine, w: World, name: string, input: Record<string, unknown>, result: unknown = { ok: true }, agentId?: string): Promise<void> {
  w.toolReplies.push({ text: 'ok', result })
  await $.tool.call({ tool: name, ...input, ...(agentId ? { agentId } : {}) } as never)
}

export const SPAWN = { tool_use_id: 'tu', description: 'find colors', provider: { plugin: 'engine', tier: 'core' }, parentModel: SESSION_MODEL, background: false, fork: false }

/** Integration tests get a longer time limit than the kit's 5 s: they stay reliable on a busy machine. */
export const SLOW = { timeoutMs: 30_000 }
