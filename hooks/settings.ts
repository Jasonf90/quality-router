// Preferences: defaults, validation of whatever the store hands back, and
// the tier helpers every other module leans on. Pure: no `$` here.

import type { CheckKind, Effort, ModelPrice, Override, Prefs, ProjectConfig, RouterMode, RouterState, Tier } from '../types'

export const TIERS: readonly Tier[] = ['cheap', 'middle', 'strong']
export const MODES: readonly RouterMode[] = ['quality-first', 'balanced', 'economy']

/**
 * The next mode in the cycle the band's one button steps through:
 * quality-first -> balanced -> economy -> quality-first. An unknown mode
 * (an older store, a hand-edited file) starts the cycle over.
 */
export function nextMode(mode: RouterMode): RouterMode {
  const i = MODES.indexOf(mode)
  return MODES[i < 0 ? 0 : (i + 1) % MODES.length] as RouterMode
}
export const STATES: readonly RouterState[] = ['on', 'off', 'dry-run']
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const TIER_LABEL: Record<Tier, string> = { cheap: 'Haiku tier', middle: 'Sonnet tier', strong: 'Opus tier' }

/**
 * Official list prices, read from the pricing page on the date given. They are
 * defaults the person can replace or clear (`/quality-router price ...`); every
 * estimate made with them names this source and date.
 */
const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'
const PRICING_AS_OF = '2026-10-09'

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5-5': {
    input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20,
    source: PRICING_SOURCE, asOf: PRICING_AS_OF,
  },
  'claude-sonnet-5-5': {
    input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10,
    source: PRICING_SOURCE, asOf: PRICING_AS_OF,
  },
  'claude-haiku-5-5': {
    input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5,
    over100k: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    source: PRICING_SOURCE, asOf: PRICING_AS_OF,
  },
}

/**
 * Model ids from the models overview page and this environment's model list.
 * Configuration, not an assumption: `/quality-router models ...` replaces them.
 */
export const DEFAULT_MODELS: Record<Tier, string> = {
  cheap: 'claude-haiku-5-5',
  middle: 'claude-sonnet-5-5',
  strong: 'claude-opus-5-5',
}

export const DEFAULT_PREFS: Prefs = {
  version: 2,
  state: 'dry-run',
  mode: 'quality-first',
  models: DEFAULT_MODELS,
  override: { kind: 'auto' },
  floor: null,
  effort: {},
  autoEffort: true,
  autoCompactTokens: null,
  autoCompactSmart: 'off',
  autoCompactBoundary: 150_000,
  autoCompactCeiling: 400_000,
  classifier: { enabled: true, inDryRun: false, timeoutMs: 6000 },
  subagents: true,
  respectManual: true,
  review: 'suggest',
  downgradeContextLimit: 80_000,
  maxEscalationsPerPhase: 2,
  pricing: DEFAULT_PRICING,
  cacheTtl: 'auto',
  baselineModel: null,
  ui: { ascii: false, showReason: true, showLimits: true, statusLine: false, band: 'full' },
}

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier)
}

export function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b
}

export function raiseTier(tier: Tier, steps: number): Tier {
  return TIERS[Math.min(TIERS.length - 1, Math.max(0, tierRank(tier) + steps))] ?? 'strong'
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value)
}

export function effortRank(e: Effort): number {
  return EFFORTS.indexOf(e)
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/** A model id or alias as this mod accepts one: no spaces, no control text. */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/@]{0,95}$/.test(value)
}

/**
 * The tier a concrete model id belongs to: the configured ids first, then the
 * model family named in the id. Used for display and for comparing the
 * session's model with a decision, never to pick what is sent.
 */
export function tierOfModel(model: string | null | undefined, prefs: Prefs): Tier | null {
  if (!model) return null
  for (const tier of TIERS) {
    if (prefs.models[tier] === model) return tier
  }
  const id = model.toLowerCase()
  if (id.includes('haiku')) return 'cheap'
  if (id.includes('sonnet')) return 'middle'
  if (id.includes('opus') || id.includes('fable')) return 'strong'
  return null
}

/** A short display name: `claude-sonnet-5-5` reads `Sonnet 5.5`. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return 'unknown'
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model)
  if (!m || !m[1] || !m[2]) return model
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] && m[3].length <= 2 ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function priceRow(raw: unknown): ModelPrice['over100k'] | null {
  const r = obj(raw)
  const keys = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const
  for (const k of keys) {
    const v = r[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000) return null
  }
  return {
    input: r.input as number,
    output: r.output as number,
    cacheWrite5m: r.cacheWrite5m as number,
    cacheWrite1h: r.cacheWrite1h as number,
    cacheRead: r.cacheRead as number,
  }
}

export function normalizePrice(raw: unknown): ModelPrice | null {
  const row = priceRow(raw)
  if (!row) return null
  const r = obj(raw)
  if (typeof r.source !== 'string' || r.source.length === 0 || typeof r.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.asOf)) {
    return null
  }
  const over = r.over100k === undefined ? undefined : priceRow(r.over100k) ?? undefined
  return { ...row, ...(over ? { over100k: over } : {}), source: r.source.slice(0, 200), asOf: r.asOf }
}

function normalizeOverride(raw: unknown): Override {
  const r = obj(raw)
  if (r.kind === 'tier' && isTier(r.tier)) return { kind: 'tier', tier: r.tier }
  if (r.kind === 'model' && isModelId(r.model)) return { kind: 'model', model: r.model }
  return { kind: 'auto' }
}

/**
 * Turns whatever the store held (possibly an older shape, possibly damaged)
 * into valid preferences, field by field, falling back to the defaults.
 */
export function normalizePrefs(raw: unknown): Prefs {
  const r = obj(raw)
  const models = obj(r.models)
  const effort = obj(r.effort)
  const classifier = obj(r.classifier)
  const ui = obj(r.ui)
  const pricing: Record<string, ModelPrice> = {}
  const rawPricing = r.pricing === undefined ? DEFAULT_PRICING : obj(r.pricing)
  for (const [model, value] of Object.entries(rawPricing).slice(0, 40)) {
    const price = normalizePrice(value)
    if (price && isModelId(model)) pricing[model] = price
  }
  const effortOut: Partial<Record<Tier, Effort>> = {}
  for (const tier of TIERS) {
    const level = effort[tier]
    if (isEffort(level)) effortOut[tier] = level
  }
  return {
    version: 2,
    state: (STATES as readonly unknown[]).includes(r.state) ? (r.state as RouterState) : DEFAULT_PREFS.state,
    mode: (MODES as readonly unknown[]).includes(r.mode) ? (r.mode as RouterMode) : DEFAULT_PREFS.mode,
    models: {
      cheap: isModelId(models.cheap) ? models.cheap : DEFAULT_MODELS.cheap,
      middle: isModelId(models.middle) ? models.middle : DEFAULT_MODELS.middle,
      strong: isModelId(models.strong) ? models.strong : DEFAULT_MODELS.strong,
    },
    override: normalizeOverride(r.override),
    floor: isTier(r.floor) ? r.floor : null,
    effort: effortOut,
    autoEffort: bool(r.autoEffort, true),
    autoCompactTokens:
      typeof r.autoCompactTokens === 'number' && Number.isFinite(r.autoCompactTokens) && r.autoCompactTokens >= 50_000 && r.autoCompactTokens <= 2_000_000
        ? Math.round(r.autoCompactTokens)
        : null,
    autoCompactSmart: r.autoCompactSmart === 'on' || r.autoCompactSmart === 'watch' ? r.autoCompactSmart : 'off',
    autoCompactBoundary: compactSize(r.autoCompactBoundary, 150_000),
    autoCompactCeiling: Math.max(compactSize(r.autoCompactCeiling, 400_000), compactSize(r.autoCompactBoundary, 150_000)),
    classifier: {
      enabled: bool(classifier.enabled, true),
      inDryRun: bool(classifier.inDryRun, false),
      timeoutMs: num(classifier.timeoutMs, 6000, 1000, 30_000),
    },
    subagents: bool(r.subagents, true),
    respectManual: bool(r.respectManual, true),
    review: r.review === 'off' || r.review === 'auto' || r.review === 'suggest' ? r.review : 'suggest',
    downgradeContextLimit: num(r.downgradeContextLimit, 80_000, 0, 2_000_000),
    maxEscalationsPerPhase: num(r.maxEscalationsPerPhase, 2, 0, 2),
    pricing,
    cacheTtl: r.cacheTtl === '1h' ? '1h' : r.cacheTtl === '5m' && Number(r.version) >= 2 ? '5m' : 'auto',
    baselineModel: isModelId(r.baselineModel) ? r.baselineModel : null,
    ui: {
      ascii: bool(ui.ascii, false),
      showReason: bool(ui.showReason, true),
      showLimits: bool(ui.showLimits, true),
      statusLine: bool(ui.statusLine, false),
      band: ui.band === 'compact' || ui.band === 'off' ? ui.band : 'full',
    },
  }
}

/** True when a change between two preference values must invalidate decisions. */
export function routingChanged(before: Prefs, after: Prefs): boolean {
  return (
    before.state !== after.state ||
    before.mode !== after.mode ||
    before.floor !== after.floor ||
    JSON.stringify(before.override) !== JSON.stringify(after.override) ||
    JSON.stringify(before.models) !== JSON.stringify(after.models) ||
    JSON.stringify(before.effort) !== JSON.stringify(after.effort) ||
    before.autoEffort !== after.autoEffort ||
    before.subagents !== after.subagents
  )
}

const CHECK_KINDS: readonly CheckKind[] = ['build', 'test', 'lint', 'typecheck', 'custom']

/**
 * Reads a project's `.claude/quality-router.json`. The file is repository
 * content, so it is untrusted: it may add checks, acceptance criteria and
 * sensitive paths, and may RAISE the floor, but it cannot turn routing on,
 * pick models, lower a floor or change any preference.
 */
export function parseProjectConfig(raw: unknown, path: string): ProjectConfig {
  const r = obj(raw)
  const problems: string[] = []
  const checks: ProjectConfig['checks'] = []
  const rawChecks = Array.isArray(r.checks) ? r.checks.slice(0, 40) : []
  for (const c of rawChecks) {
    const o = obj(c)
    const kind = o.kind
    const pattern = o.pattern
    if (typeof kind !== 'string' || !(CHECK_KINDS as readonly string[]).includes(kind) || typeof pattern !== 'string' || pattern.length > 300) {
      problems.push('a check needs kind (build|test|lint|typecheck|custom) and a pattern under 300 characters')
      continue
    }
    try {
      new RegExp(pattern, 'i')
      checks.push({ kind: kind as CheckKind, pattern })
    } catch {
      problems.push(`check pattern does not compile: ${pattern.slice(0, 40)}`)
    }
  }
  const required = (Array.isArray(r.required) ? r.required : []).filter(
    (k): k is CheckKind => typeof k === 'string' && (CHECK_KINDS as readonly string[]).includes(k),
  )
  const acceptance = (Array.isArray(r.acceptance) ? r.acceptance : [])
    .filter((a): a is string => typeof a === 'string')
    .map(a => a.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200))
    .slice(0, 20)
  const riskPaths: string[] = []
  for (const p of (Array.isArray(r.riskPaths) ? r.riskPaths : []).slice(0, 40)) {
    if (typeof p !== 'string' || p.length > 300) continue
    try {
      new RegExp(p, 'i')
      riskPaths.push(p)
    } catch {
      problems.push(`risk path pattern does not compile: ${p.slice(0, 40)}`)
    }
  }
  const floor = isTier(r.floor) ? r.floor : null
  for (const key of Object.keys(r)) {
    if (!['checks', 'required', 'acceptance', 'riskPaths', 'floor', '$schema', 'comment'].includes(key)) {
      problems.push(`ignored key "${key.slice(0, 30)}" (a project file cannot change router preferences)`)
    }
  }
  return { checks, required, acceptance, riskPaths, floor, loadedFrom: path, problems: problems.slice(0, 10) }
}

/** The cache-write lifetime to price at: the person's setting, or 1h for 'auto' when nothing better is known. */
export function cacheTtlOf(prefs: Pick<Prefs, 'cacheTtl'>): '5m' | '1h' {
  return prefs.cacheTtl === '5m' ? '5m' : '1h'
}

/** A compaction size from 50k to 2m tokens, else the default. */
function compactSize(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 50_000 && v <= 2_000_000 ? Math.round(v) : fallback
}
