import { describe, expect, test } from 'claude-code/testing'

import { HELP, parseCommand, tokenize } from '../hooks/commands'
import { BAND_PROPS, SESSION_MODEL, cmd, install, prefsInStore, start, step, turn, SLOW } from './harness'

const BAND = { plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS } as const
const SURFACES = ['terminal', 'desktop'] as const

describe('commands (pure)', () => {
  test('parses every documented subcommand and rejects the rest with a reason', () => {
    expect(parseCommand('').kind).toBe('status')
    expect(parseCommand('on').kind).toBe('set-state')
    expect(parseCommand('dry-run').kind).toBe('set-state')
    expect(parseCommand('toggle').kind).toBe('toggle')
    expect(parseCommand('mode economy').kind).toBe('prefs')
    expect(parseCommand('mode turbo').kind).toBe('error')
    expect(parseCommand('model auto').kind).toBe('prefs')
    expect(parseCommand('model claude-sonnet-5-5').kind).toBe('prefs')
    expect(parseCommand('model "rm -rf /"').kind).toBe('error')
    expect(parseCommand('floor middle').kind).toBe('prefs')
    expect(parseCommand('effort strong ultra').kind).toBe('error')
    expect(parseCommand('price claude-x input=1 output=2 write5m=1 write1h=2 read=0.1 source=https://example.com date=2026-10-09').kind).toBe('prefs')
    expect(parseCommand('price claude-x input=1').kind).toBe('error')
    expect(parseCommand('experiment start a routed spec="add x" start=abc validation="npm test" env=sim').kind).toBe('experiment-start')
    expect(parseCommand('experiment start a routed spec="add x"').kind).toBe('error')
    expect(parseCommand('reset-task').kind).toBe('reset-task')
    expect(parseCommand('frobnicate').kind).toBe('error')
    expect(tokenize('a key="two words" b')).toEqual(['a', 'key=two words', 'b'])
    expect(HELP).toContain('/quality-router')
  })
})

describe('state, controls and indicators (mock integration)', () => {
  test('first run is DRY RUN, shown with text as well as colour, with its own controls', SLOW, async ($, on) => {
    install(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const head = await ui.find({ type: 'Text', text: /Router DRY RUN/ })
      expect(head?.props.color).toBe('warning')
      expect(await ui.find({ text: /Proposed:/ })).not.toBe(undefined)
      expect(await ui.find({ key: 'qr-enable' })).not.toBe(undefined)
      expect(await ui.find({ key: 'qr-off' })).not.toBe(undefined)
      expect(await ui.find({ key: 'qr-usage' })).not.toBe(undefined)
      await ui.unmount()
    }
  })

  test('the button and the command go through the same setter and agree', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'qr-enable' })
      expect(prefsInStore(w).state).toBe('on')
      expect(await cmd($, 'status')).toContain('Router ON')
      expect((await ui.find({ type: 'Text', text: /Router ON/ }))?.props.color).toBe('success')
      expect(await cmd($, 'off')).toContain('Router OFF')
      const off = await ui.find({ type: 'Text', text: /Router OFF/ })
      expect(off?.props.color).toBe('inactive')
      expect(await ui.find({ key: 'qr-on' })).not.toBe(undefined)
      expect(await ui.find({ text: /Claude Code selects the model/ })).not.toBe(undefined)
      await ui.press({ key: 'qr-dry' })
      expect(prefsInStore(w).state).toBe('dry-run')
      await ui.unmount()
    }
  })

  test('preferences persist across reloads (a new session reads the store)', SLOW, async ($, on) => {
    install(on, { store: { prefs: { state: 'on', mode: 'economy', floor: 'middle', ui: { ascii: true } } } })
    await start($)
    const status = await cmd($, 'status')
    expect(status).toContain('[ON] Router ON')
    expect(status).toContain('Economy')
    expect(status).toContain('floor middle')
  })

  test('another mod\'s content in the band is kept', SLOW, async ($, on) => {
    install(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ text: 'another mod draws here' })).not.toBe(undefined)
      expect(await ui.find({ text: /Router DRY RUN/ })).not.toBe(undefined)
      await ui.unmount()
    }
  })

  test('DRY RUN logs proposals but changes nothing; OFF passes through', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await turn($, 'Fix the typo in the title', 't1')
    expect(w.sent[0]?.model).toBe(SESSION_MODEL)
    expect(await cmd($, 'status')).toContain('Proposed: Haiku 5.5 (cheap)')
    await cmd($, 'off')
    await turn($, 'Fix the typo in the subtitle', 't2')
    expect(w.sent[1]?.model).toBe(SESSION_MODEL)
    expect(w.classifierCalls).toBe(0)
  })

  test('toggling during a request: the request in flight is untouched; the next one follows the new state', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the title', turnId: 't1' })
    const s = $.turn.step({ turnId: 't1', index: 0, model: SESSION_MODEL, messageCount: 1 })
    const first = await s.next()
    expect(first.done).toBe(false)
    expect(await cmd($, 'off')).toContain('Router OFF')
    let it = first
    while (!it.done) it = await s.next()
    expect(it.value.usage?.model).toBe('claude-haiku-5-5')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent.map(x => x.model)).toEqual(['claude-haiku-5-5', SESSION_MODEL])
  })

  test('re-enabling reassesses instead of reusing an obsolete decision', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Fix the typo in the title', turnId: 't1' })
    await step($, { turnId: 't1', index: 0 })
    await cmd($, 'off')
    await cmd($, 'floor strong')
    await cmd($, 'on')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent.map(x => x.model)).toEqual(['claude-haiku-5-5', SESSION_MODEL])
  })

  test('a manual /model change pauses routing until automatic selection is resumed', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.classic.PostModelSwitch({ from_model: SESSION_MODEL, to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'command', context_tokens: 0, prompt_cache_warm: false, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'catalog' } as never)
    await turn($, 'Fix the typo in the title', 't1')
    expect(w.sent[0]?.model).toBe(SESSION_MODEL)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /Manual: Sonnet 5\.5 \(router paused\)/ })).not.toBe(undefined)
    await ui.press({ key: 'qr-auto' })
    await w.clock.advance(61 * 60_000)
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe('claude-haiku-5-5')
  })

  test('manual override command takes precedence and can be set back to auto', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await cmd($, 'model middle')
    await turn($, 'Update the OAuth refresh token handling', 't1')
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
    expect(await cmd($, 'status')).toContain('below the safety recommendation')
    await cmd($, 'model auto')
    await step($, { turnId: 't1', index: 1 })
    expect(w.sent[1]?.model).toBe(SESSION_MODEL)
  })

  test('concurrent subagents keep their own decisions', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await $.turn.start({ text: 'Add a settings screen with a dark mode toggle', turnId: 't1' })
    const base = { tool_use_id: 'tu', description: 'x', provider: { plugin: 'engine', tier: 'core' }, parentModel: SESSION_MODEL, background: false, fork: false }
    const a = await $.agent.spawn({ ...base, prompt: 'Find where the theme colors are defined', subagentType: 'Explore' } as never)
    const b = await $.agent.spawn({ ...base, prompt: 'Update the keychain storage of the session token', subagentType: 'general-purpose' } as never)
    expect(w.spawned.map(s => s.requested)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    const ida = (a as { agentId: string }).agentId
    const idb = (b as { agentId: string }).agentId
    await Promise.all([
      step($, { turnId: 'ta', agentId: ida, model: 'claude-haiku-5-5' }),
      step($, { turnId: 'tb', agentId: idb, model: 'claude-opus-5-5' }),
      step($, { turnId: 'ta', agentId: ida, model: 'claude-haiku-5-5', index: 1 }),
    ])
    const byAgent = (id: string) => w.sent.filter(s => s.agentId === id).map(s => s.model)
    expect(byAgent(ida)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
    expect(byAgent(idb)).toEqual(['claude-opus-5-5'])
    // An explicit model on the Agent call is left alone.
    await $.agent.spawn({ ...base, prompt: 'Find files', subagentType: 'Explore', model: 'claude-sonnet-5-5' } as never)
    expect(w.spawned[2]?.requested).toBe('claude-sonnet-5-5')
  })

  test('subagents spawned while not ON are never rewritten later', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    const base = { tool_use_id: 'tu', description: 'x', provider: { plugin: 'engine', tier: 'core' }, parentModel: SESSION_MODEL, background: false, fork: false }
    const a = await $.agent.spawn({ ...base, prompt: 'Find where the theme colors are defined', subagentType: 'Explore' } as never)
    expect(w.spawned[0]?.requested).toBe(undefined)
    await cmd($, 'on')
    await step($, { turnId: 'ta', agentId: (a as { agentId: string }).agentId, model: SESSION_MODEL })
    expect(w.sent[0]?.model).toBe(SESSION_MODEL)
  })

  test('reset-task resets routing state and keeps usage history', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await cmd($, 'on')
    await turn($, 'Fix the typo in the title', 't1')
    expect(await cmd($, 'reset-task')).toContain('Usage history is kept')
    const ledger = w.store.get('ledger:session-1') as { total: { requests: number } }
    expect(ledger.total.requests).toBe(1)
    expect(await cmd($, 'status')).toContain('decided at the next request')
  })

  test('the usage pane opens from the band and draws its sections', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    await turn($, 'Fix the typo in the title', 't1')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'qr-usage' })
    expect(w.opened).toEqual(['quality-router'])
    for (const surface of SURFACES) {
      const pane = await $.ui.mount({ plugin: 'quality-router', surface, component: 'Pane', requestId: 'quality-router', props: { title: 'Quality Router', isFocused: false } as never })
      for (const title of ['Now', 'Savings', 'Tasks', 'Agents', 'Recommendations', 'Checks', 'Usage report', 'Recent decisions']) {
        expect(await pane.find({ type: 'Text', text: title })).not.toBe(undefined)
      }
      expect(await pane.find({ text: /A\. OBSERVED TOKEN USAGE/ })).not.toBe(undefined)
      expect(await pane.find({ key: 'pane-on' })).not.toBe(undefined)
      await pane.unmount()
    }
  })

  test('a project file can add checks and raise the floor, but cannot change preferences', SLOW, async ($, on) => {
    const w = install(on)
    w.projectFile = JSON.stringify({ checks: [{ kind: 'test', pattern: '\\bmake check\\b' }], floor: 'middle', state: 'on', models: { cheap: 'evil' } })
    await start($)
    expect(prefsInStore(w).state).toBe('dry-run')
    const status = await cmd($, 'status')
    expect(status).toContain('ignored key "state"')
    await cmd($, 'on')
    await turn($, 'Fix the typo in the title', 't1')
    expect(w.sent[0]?.model).toBe('claude-sonnet-5-5')
  })
})

describe('settings shared by several sessions (mock integration)', () => {
  test('a change here never undoes a change another session made since this one read the settings', SLOW, async ($, on) => {
    const w = install(on, { store: { prefs: { version: 2, state: 'on', autoCompactTokens: 300_000 } } })
    await start($)
    expect(await cmd($, 'status')).toContain('auto-compact at 300k')
    // Another session turns auto-compact down to 250k in the shared store.
    w.store.set('prefs', { ...(w.store.get('prefs') as object), autoCompactTokens: 250_000 })
    await cmd($, 'mode balanced')
    expect(prefsInStore(w)).toMatchObject({ mode: 'balanced', autoCompactTokens: 250_000 })
  })

  test('each turn takes up settings another session changed', SLOW, async ($, on) => {
    const w = install(on, { store: { prefs: { version: 2, state: 'on' } } })
    await start($)
    w.store.set('prefs', { ...(w.store.get('prefs') as object), mode: 'economy' })
    await turn($, 'Fix the typo in the onboarding title', 't1')
    expect(await cmd($, 'status')).toContain('Economy')
  })
})
