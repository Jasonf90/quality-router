import { describe, expect, test } from 'claude-code/testing'

const close = (a: number | undefined, b: number) => expect(Math.abs((a ?? NaN) - b) < 1e-9).toBe(true)

import type { LimitTrack } from '../types'
import { addReading, formatWhen, limitLine, project } from '../hooks/limits'
import { BAND_PROPS, T0, cmd, install, start, turn, SLOW } from './harness'

const H = 3_600_000
const RESET = new Date(T0 + 3 * 24 * H).toISOString()

function track(points: [number, number][], resetsAt: string | null = RESET): LimitTrack {
  return { kind: 'seven_day', resetsAt, readings: points.map(([h, pct]) => ({ t: T0 + h * H, pct })) }
}

describe('weekly limit projection (pure)', () => {
  test('not enough data until readings span 3 hours with usage between them', () => {
    expect(project(track([[0, 40]], null), T0).status).toBe('insufficient-data')
    expect(project(track([[0, 40], [2, 44]], null), T0 + 2 * H).status).toBe('insufficient-data')
  })

  test('a week is not worked round the clock: the window average leads until readings span most of a day', () => {
    // Three days into the window, 36% used (0.5%/h average); this morning 4%/h.
    const reset = new Date(T0 + 4 * 24 * H).toISOString()
    const morning = project({ kind: 'seven_day', resetsAt: reset, readings: [{ t: T0 - 3 * H, pct: 24 }, { t: T0 - 1.5 * H, pct: 30 }, { t: T0, pct: 36 }] }, T0)
    expect(morning.primary?.method).toBe('window-average')
    expect(morning.alternative?.method).toBe('recent-pace')
    expect(morning.status).toBe('not-before-reset')
    // A day of readings at a pace that fills the window: projected.
    const day = project({ kind: 'seven_day', resetsAt: reset, readings: [{ t: T0 - 22 * H, pct: 14 }, { t: T0 - 11 * H, pct: 25 }, { t: T0, pct: 36 }] }, T0)
    expect(day.primary?.method).toBe('recent-pace')
    expect(day.status).toBe('projected')
  })

  test('early in a fresh window one busy hour is not stretched over the week', () => {
    // The real case: the window reset ~1.3h ago and 4% was used since.
    const reset = new Date(T0 + (168 - 1.3) * H).toISOString()
    const p = project({ kind: 'seven_day', resetsAt: reset, readings: [{ t: T0 - 0.2 * H, pct: 3 }, { t: T0, pct: 4 }] }, T0)
    expect(p.status).toBe('insufficient-data')
    expect(limitLine(p)).toContain('not enough data yet')
  })

  test('recent pace projects when the window would fill', () => {
    // 40% -> 46% over 6 hours: 1%/h, 54 points left: 54 hours from the last reading.
    const p = project(track([[0, 40], [3, 43], [6, 46]], null), T0 + 6 * H)
    expect(p.status).toBe('projected')
    expect(p.primary?.method).toBe('recent-pace')
    close(p.primary?.pctPerHour, 1)
    expect(p.etaMs).toBe(T0 + 60 * H)
    expect(limitLine(p)).toContain(`est. limit ${formatWhen(T0 + 60 * H)}`)
  })

  test('a pace that fills after the reset says so instead of giving a time', () => {
    // 0.1%/h with 54 points left: 540 hours, well after a reset 3 days out.
    const p = project(track([[0, 40], [10, 41], [20, 42]]), T0 + 20 * H)
    expect(p.status).toBe('not-before-reset')
    expect(p.etaMs).toBe(null)
    expect(limitLine(p)).toContain('not projected to hit before reset')
  })

  test('the window average is used, and labelled with its assumption, when recent readings are thin', () => {
    // Reset in 3 days: a 7-day window began 4 days ago; 48% over 96h is 0.5%/h.
    const p = project(track([[0, 48]]), T0)
    expect(p.primary?.method).toBe('window-average')
    expect(p.primary?.assumption).toContain('168h')
    expect(p.status).toBe('not-before-reset')
    const fast = project(track([[0, 90]]), T0)
    expect(fast.status).toBe('projected')
  })

  test('a used-up window and a new window are told apart', () => {
    expect(project(track([[0, 100]]), T0).status).toBe('exceeded')
    let t = addReading(undefined, { kind: 'seven_day', percentUsed: 80, resetsAt: RESET }, T0)
    t = addReading(t, { kind: 'seven_day', percentUsed: 3, resetsAt: new Date(T0 + 10 * 24 * H).toISOString() }, T0 + H)
    expect(t.readings.length).toBe(1)
    expect(t.readings[0]?.pct).toBe(3)
  })

  test('flat usage gives no date', () => {
    const p = project(track([[0, 40], [5, 40]], null), T0 + 5 * H)
    expect(p.status).toBe('flat')
  })
})

describe('weekly limit in the session (mock integration)', () => {
  test('provider readings over time become an estimated limit date on the band and in /quality-router limits', SLOW, async ($, on) => {
    const w = install(on)
    await start($)
    w.rateLimits = [{ kind: 'seven_day', percentUsed: 40, resetsAt: RESET }, { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(T0 + 2 * H).toISOString() }]
    await turn($, 'Fix the typo in the title', 't1')
    for (const [h, pct] of [[2, 44], [4, 48]] as const) {
      await w.clock.advance(2 * H)
      w.rateLimits = [{ kind: 'seven_day', percentUsed: pct, resetsAt: RESET }]
      await $.session.measure({ context: { window: 200_000 }, rateLimits: w.rateLimits, cost: { usd: 1 }, changed: ['rateLimits'] } as never)
      expect(h).toBeGreaterThan(0)
    }
    const text = await cmd($, 'limits')
    expect(text).toContain('Weekly: 48% used')
    // Four busy hours are not stretched over the week: the window average leads, the burst is shown beside it.
    expect(text).toContain('window average over 4d')
    expect(text).toContain('also: 2.00%/h, recent pace from 3 readings over 4h')
    expect(text).toContain('not projected to hit before reset')
    expect(text).toContain('Not a count of tasks or tokens remaining')
    const ui = await $.ui.mount({ plugin: 'quality-router', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Weekly' })).not.toBe(undefined)
    expect(await ui.find({ type: 'Text', text: '48%' })).not.toBe(undefined)
    // Readings outlive the session: they are kept in the store.
    expect(JSON.stringify(w.store.get('limits'))).toContain('seven_day')
  })
})
