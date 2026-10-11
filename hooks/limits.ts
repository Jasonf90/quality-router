// Plan limits: the provider-reported windows (observed) and a projection of
// when a window would reach 100% at the pace seen so far (an estimate). Pure.
//
// Observed: `percentUsed` and `resetsAt` exactly as the API's rate-limit
// readings report them. Estimated: the time a window would fill, extrapolated
// from those readings. The estimate never says how many tasks remain, and it
// is not derived from token counts.

import type { LimitReading, LimitTrack } from '../types'

const HOUR = 3_600_000
const MAX_READINGS = 240

export type Pace = {
  method: 'recent-pace' | 'window-average'
  pctPerHour: number
  readings: number
  spanMs: number
  assumption: string | null
}

export type Projection = {
  kind: string
  percentUsed: number
  resetsAt: string | null
  status: 'exceeded' | 'projected' | 'not-before-reset' | 'flat' | 'insufficient-data'
  /** When the window would reach 100%, in epoch ms; set when status is `projected`. */
  etaMs: number | null
  primary: Pace | null
  alternative: Pace | null
  note: string
}

/** Window lengths, used only by the window-average method and named as an assumption. */
const WINDOW_MS: Record<string, number> = { seven_day: 7 * 24 * HOUR, five_hour: 5 * HOUR }

export function windowLength(kind: string): number | null {
  if (kind.startsWith('seven_day')) return WINDOW_MS.seven_day ?? null
  if (kind.startsWith('five_hour')) return WINDOW_MS.five_hour ?? null
  return null
}

export function isWeekly(kind: string): boolean {
  return kind.startsWith('seven_day')
}

/**
 * Adds one reading. A new reset time, or a drop of more than two points,
 * means a new window: the old readings no longer describe it and are dropped.
 */
export function addReading(
  track: LimitTrack | undefined,
  reading: { kind: string; percentUsed: number; resetsAt?: string },
  now: number,
): LimitTrack {
  const resetsAt = reading.resetsAt ?? null
  const pct = Math.max(0, reading.percentUsed)
  const fresh: LimitTrack = { kind: reading.kind, resetsAt, readings: [{ t: now, pct }] }
  if (!track) return fresh
  const last = track.readings[track.readings.length - 1]
  const newWindow = (resetsAt !== null && track.resetsAt !== null && resetsAt !== track.resetsAt) || (last !== undefined && pct < last.pct - 2)
  if (newWindow) return fresh
  if (last && last.pct === pct && now - last.t < 10 * 60_000) {
    return { ...track, resetsAt: resetsAt ?? track.resetsAt }
  }
  let readings = [...track.readings, { t: now, pct }]
  if (readings.length > MAX_READINGS) {
    // Keep the first reading (the long baseline) and thin the oldest of the rest.
    readings = [readings[0] as LimitReading, ...readings.slice(-(MAX_READINGS - 1))]
  }
  return { kind: track.kind, resetsAt: resetsAt ?? track.resetsAt, readings }
}

/** Least-squares slope of percent over time, in percent per hour. */
function slope(points: LimitReading[]): number {
  const n = points.length
  const mt = points.reduce((s, p) => s + p.t, 0) / n
  const mp = points.reduce((s, p) => s + p.pct, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - mt) * (p.pct - mp)
    den += (p.t - mt) ** 2
  }
  return den === 0 ? 0 : (num / den) * HOUR
}

export type ProjectOptions = {
  /** How far back the recent pace looks. */
  lookbackMs: number
  /** The least span of readings the recent pace needs. */
  minSpanMs: number
  /** The least rise in points the recent pace needs. */
  minRisePct: number
}

export const DEFAULT_PROJECT_OPTIONS: ProjectOptions = {
  lookbackMs: 24 * HOUR,
  minSpanMs: 3 * HOUR,
  minRisePct: 1,
}

/**
 * The window average needs a day of the window behind it: early in a fresh
 * window one busy hour would otherwise be stretched over the whole week.
 */
export const MIN_WINDOW_ELAPSED_MS = 24 * HOUR

/**
 * Projects when a window reaches 100%. Two paces:
 * - recent pace: the trend of this mod's own readings over the lookback,
 *   which already includes usage from other sessions, devices and apps;
 * - window average: percent used over the time since the window began,
 *   assuming the window is its nominal length ending at its reset time.
 * The recent pace is primary when it has enough readings, except for windows
 * longer than a day, where the window average leads until the readings span
 * 20 hours; the result says which and on what basis.
 */
export function project(track: LimitTrack, now: number, opts: ProjectOptions = DEFAULT_PROJECT_OPTIONS): Projection {
  const last = track.readings[track.readings.length - 1]
  const pct = last?.pct ?? 0
  const resetMs = track.resetsAt ? Date.parse(track.resetsAt) : NaN
  const resetKnown = Number.isFinite(resetMs)
  const base = { kind: track.kind, percentUsed: pct, resetsAt: track.resetsAt }

  if (pct >= 100) {
    return { ...base, status: 'exceeded', etaMs: null, primary: null, alternative: null, note: 'the provider reports this window used up' }
  }

  let recent: Pace | null = null
  const window = track.readings.filter(r => r.t >= now - opts.lookbackMs)
  const first = window[0]
  const lastInWindow = window[window.length - 1]
  if (first && lastInWindow && window.length >= 2) {
    const spanMs = lastInWindow.t - first.t
    const rise = lastInWindow.pct - first.pct
    if (spanMs >= opts.minSpanMs && rise >= opts.minRisePct) {
      recent = { method: 'recent-pace', pctPerHour: Math.max(0, slope(window)), readings: window.length, spanMs, assumption: null }
    } else if (spanMs >= opts.minSpanMs && rise <= 0) {
      recent = { method: 'recent-pace', pctPerHour: 0, readings: window.length, spanMs, assumption: null }
    }
  }

  let average: Pace | null = null
  const length = windowLength(track.kind)
  if (resetKnown && length !== null && pct > 0) {
    const elapsed = now - (resetMs - length)
    if (elapsed >= Math.min(MIN_WINDOW_ELAPSED_MS, length / 2) && elapsed <= length) {
      average = {
        method: 'window-average',
        pctPerHour: (pct / elapsed) * HOUR,
        readings: track.readings.length,
        spanMs: elapsed,
        assumption: `assumes the window is ${Math.round(length / HOUR)}h long and ends at its reset time`,
      }
    }
  }

  // A week is not worked round the clock: a recent pace from a few working
  // hours, stretched over nights and weekends, fills the window far too early.
  // For windows longer than a day the window average leads unless the recent
  // readings span most of a day (20 hours: a night included).
  const longWindow = length !== null && length > 24 * HOUR
  const averageLeads = longWindow && average !== null && (recent === null || recent.spanMs < 20 * HOUR)
  const primary = averageLeads ? average : recent ?? average
  const alternative = averageLeads ? recent : recent ? average : null
  if (!primary) {
    return { ...base, status: 'insufficient-data', etaMs: null, primary: null, alternative: null, note: 'needs readings spanning 3 hours, or a day into the window' }
  }
  if (primary.pctPerHour <= 0) {
    return { ...base, status: 'flat', etaMs: null, primary, alternative, note: 'no rise in usage over the readings' }
  }
  const etaMs = now + ((100 - pct) / primary.pctPerHour) * HOUR
  if (resetKnown && etaMs >= resetMs) {
    return { ...base, status: 'not-before-reset', etaMs: null, primary, alternative, note: 'at this pace the window resets before it fills' }
  }
  return { ...base, status: 'projected', etaMs, primary, alternative, note: 'estimate: assumes usage continues at this pace' }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Thu Oct 15 14:20` in the machine's local time zone. */
export function formatWhen(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`
}

export function formatSpan(ms: number): string {
  const h = ms / HOUR
  if (h >= 48) return `${Math.round(h / 24)}d`
  if (h >= 1) return `${Math.round(h)}h`
  return `${Math.max(1, Math.round(ms / 60_000))}m`
}

export function kindLabel(kind: string): string {
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'five_hour') return '5-hour'
  if (kind.startsWith('seven_day_')) return `Weekly (${kind.slice('seven_day_'.length)})`
  return kind.replace(/_/g, ' ')
}

/** The one-line form the band shows for a weekly window. */
export function limitLine(p: Projection): string {
  const head = `${kindLabel(p.kind)} ${p.percentUsed}%`
  const reset = p.resetsAt && Number.isFinite(Date.parse(p.resetsAt)) ? ` · resets ${formatWhen(Date.parse(p.resetsAt))}` : ''
  switch (p.status) {
    case 'exceeded':
      return `${head} · limit reached${reset}`
    case 'projected':
      return `${head} · est. limit ${formatWhen(p.etaMs as number)}${reset}`
    case 'not-before-reset':
      return `${head} · not projected to hit before reset${reset}`
    case 'flat':
      return `${head} · no recent rise${reset}`
    default:
      return `${head} · est. limit: not enough data yet${reset}`
  }
}
