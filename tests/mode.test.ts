import { describe, expect, test } from 'claude-code/testing'

import { MODE_NOTE } from '../hooks/core'
import { MODES, nextMode } from '../hooks/settings'
import { MODE_LABEL } from '../hooks/view'
import { BAND_PROPS, SLOW, cmd, install, prefsInStore, start } from './harness'

const BAND = { plugin: 'quality-router', component: 'AbovePrompt', props: BAND_PROPS } as const
const PANE = { plugin: 'quality-router', component: 'Pane', requestId: 'quality-router', props: { title: 'Quality Router', isFocused: false } as never } as const

describe('mode cycle (pure)', () => {
  test('steps quality-first -> balanced -> economy and wraps round', () => {
    expect(nextMode('quality-first')).toBe('balanced')
    expect(nextMode('balanced')).toBe('economy')
    expect(nextMode('economy')).toBe('quality-first')
  })

  test('one press per mode returns to where it started', () => {
    let m = MODES[0]!
    for (let i = 0; i < MODES.length; i++) m = nextMode(m)
    expect(m).toBe(MODES[0])
  })

  test('every mode has a label and a note; an unknown mode restarts the cycle', () => {
    for (const m of MODES) {
      expect(MODE_LABEL[m].length).toBeGreaterThan(0)
      expect(MODE_NOTE[m]).toContain('from the next model request')
    }
    expect(nextMode('turbo' as never)).toBe('quality-first')
  })
})

describe('the mode button', () => {
  test('is labelled with the mode it switches to, and cycles every mode', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(prefsInStore(w).mode).toBe('quality-first')
    expect((await ui.find({ key: 'qr-mode' }))?.props.label).toBe('Balanced mode')

    await ui.press({ key: 'qr-mode' })
    expect(prefsInStore(w).mode).toBe('balanced')
    expect((await ui.find({ key: 'qr-mode' }))?.props.label).toBe('Economy mode')

    await ui.press({ key: 'qr-mode' })
    expect(prefsInStore(w).mode).toBe('economy')
    expect((await ui.find({ key: 'qr-mode' }))?.props.label).toBe('Quality-first mode')

    await ui.press({ key: 'qr-mode' })
    expect(prefsInStore(w).mode).toBe('quality-first')
    await ui.unmount()
  })

  test('the button and the command go through the same setter and agree', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'qr-mode' })
      expect(prefsInStore(w).mode).toBe('balanced')
      expect(await cmd($, 'status')).toContain('Balanced')

      await cmd($, 'mode economy')
      expect(prefsInStore(w).mode).toBe('economy')
      expect(await ui.find({ type: 'Text', text: /Economy/ })).not.toBe(undefined)
      expect((await ui.find({ key: 'qr-mode' }))?.props.label).toBe('Quality-first mode')

      await cmd($, 'mode quality-first')
      await ui.unmount()
    }
  })

  test('switching the mode leaves the routing state alone', SLOW, async ($, on) => {
    const w = install(on, { store: { prefs: { state: 'dry-run' } } })
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'qr-mode' })
    expect(prefsInStore(w).mode).toBe('balanced')
    expect(prefsInStore(w).state).toBe('dry-run')
    expect(await ui.find({ key: 'qr-enable' })).not.toBe(undefined)
    await ui.unmount()
  })

  test('the pane offers the same control', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await pane.find({ key: 'pane-mode' }))?.props.label).toBe('Balanced mode')
    await pane.press({ key: 'pane-mode' })
    expect(prefsInStore(w).mode).toBe('balanced')
    await pane.unmount()
  })
})
