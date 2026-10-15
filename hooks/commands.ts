// `/quality-router <subcommand>`: parsing only. Pure. The adapter applies the
// parsed action through the same setter the band's buttons use.

import type { Effort, ModelPrice, Override, Prefs, ReviewPolicy, RouterMode, RouterState, Tier } from '../types'
import { MODES, isEffort, isModelId, isTier, normalizePrice } from './settings'

export type Action =
  | { kind: 'set-state'; state: RouterState }
  | { kind: 'toggle' }
  | { kind: 'status' }
  | { kind: 'usage' }
  | { kind: 'limits' }
  | { kind: 'reset-task' }
  | { kind: 'help' }
  | { kind: 'config' }
  | { kind: 'prefs'; change: (p: Prefs) => Prefs; summary: string }
  | { kind: 'review-now' }
  | { kind: 'tips' }
  | { kind: 'compact' }
  | { kind: 'autocompact-report' }
  | { kind: 'savings' }
  | { kind: 'resume-auto' }
  | { kind: 'experiment-start'; label: string; arm: 'routed' | 'baseline'; spec: string; startState: string; validation: string; environment: string }
  | { kind: 'experiment-stop' }
  | { kind: 'experiment-report'; label: string }
  | { kind: 'experiment-list' }
  | { kind: 'error'; message: string }

export const HELP = [
  'Quality Router commands (/quality-router <subcommand>):',
  '  on | off | toggle | dry-run        routing state (OFF keeps accounting and the band)',
  '  status | usage | limits | config   show state, open the usage pane, plan limits, all prefs',
  '  savings | tips | compact           savings summary, recommendations, compact the conversation now',
  '  band full|compact|off              size of the band above the prompt',
  '  autocompact <tokens>|off           compact automatically when a turn ends this large (e.g. 300k)',
  '  autocompact smart|watch|report     compact at finished tasks (smart), or watch when it would first',
  '  autocompact boundary|ceiling <tokens>   smart sizes (default 150k when work is finished, 400k mid-task)',
  '  mode quality-first|balanced|economy',
  '  model auto|cheap|middle|strong|<model-id>   manual override (auto = router decides)',
  '  floor none|cheap|middle|strong      never route below this tier',
  '  effort auto on|off                 automatic effort (default on): lower only for narrow low-risk work',
  '  effort <tier> low|medium|high|xhigh|max|default   a fixed effort for one tier (overrides auto)',
  '  models cheap=<id> middle=<id> strong=<id>',
  '  price <model-id> input=<$> output=<$> write5m=<$> write1h=<$> read=<$> source=<url> date=YYYY-MM-DD',
  '  price clear <model-id>',
  '  baseline session|<model-id>         model the same-volume estimate compares with',
  '  classifier on|off | classifier dry-run on|off | subagents on|off',
  '  review off|suggest|auto | review now   stronger-model review of the current phase',
  '  cache-ttl 5m|1h|auto | ascii on|off | statusline on|off | resume-auto | reset-task',
  '  experiment start <label> routed|baseline spec="..." start="..." validation="..." env="..."',
  '  experiment stop | experiment report <label> | experiment list',
].join('\n')

/** Splits on spaces, keeping "quoted values" and key="quoted values" whole. */
export function tokenize(args: string): string[] {
  const out: string[] = []
  const re = /(\w[\w-]*=)?"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args.slice(0, 2000))) !== null) {
    if (m[2] !== undefined) out.push(`${m[1] ?? ''}${m[2]}`)
    else if (m[3] !== undefined) out.push(m[3])
  }
  return out
}

function keyValues(tokens: string[]): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const t of tokens) {
    const i = t.indexOf('=')
    if (i > 0) kv[t.slice(0, i).toLowerCase()] = t.slice(i + 1)
  }
  return kv
}

function onOff(word: string | undefined): boolean | null {
  if (word === 'on' || word === 'true' || word === 'yes') return true
  if (word === 'off' || word === 'false' || word === 'no') return false
  return null
}

function prefs(change: (p: Prefs) => Prefs, summary: string): Action {
  return { kind: 'prefs', change, summary }
}

export function parseCommand(args: string): Action {
  const t = tokenize(args.trim())
  const [head, a1, a2] = [t[0]?.toLowerCase(), t[1], t[2]]
  switch (head) {
    case undefined:
    case 'status':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'on':
      return { kind: 'set-state', state: 'on' }
    case 'off':
      return { kind: 'set-state', state: 'off' }
    case 'dry-run':
    case 'dryrun':
    case 'dry':
      return { kind: 'set-state', state: 'dry-run' }
    case 'toggle':
      return { kind: 'toggle' }
    case 'usage':
      return { kind: 'usage' }
    case 'limits':
      return { kind: 'limits' }
    case 'config':
      return { kind: 'config' }
    case 'tips':
      return { kind: 'tips' }
    case 'autocompact':
    case 'auto-compact': {
      const size = (v: string | undefined): number => {
        const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(v ?? '')
        const n = m ? Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2] ? 1000 : 1)) : NaN
        return Number.isFinite(n) && n >= 50_000 && n <= 2_000_000 ? n : NaN
      }
      const k = (n: number) => `${Math.round(n / 1000)}k`
      if (a1 === 'off') return prefs(p => ({ ...p, autoCompactTokens: null, autoCompactSmart: 'off' }), 'auto-compact off: compaction is only suggested')
      if (a1 === 'report') return { kind: 'autocompact-report' }
      if (a1 === 'smart') {
        return prefs(
          p => ({ ...p, autoCompactSmart: 'on' }),
          'smart auto-compact on: compacts when a piece of work is finished (committed this turn, checks passing or task list complete, and no check failing) once the conversation is past the boundary size, and mid-task only past the ceiling',
        )
      }
      if (a1 === 'watch') {
        return prefs(
          p => ({ ...p, autoCompactSmart: 'watch' }),
          'smart auto-compact watching: the plain threshold still compacts; the band and /quality-router autocompact report show when smart would have compacted instead',
        )
      }
      if (a1 === 'boundary' || a1 === 'ceiling') {
        const n = size(a2)
        if (!Number.isFinite(n)) return { kind: 'error', message: `autocompact ${a1} takes a size from 50k to 2m tokens` }
        return a1 === 'boundary'
          ? prefs(p => ({ ...p, autoCompactBoundary: n, autoCompactCeiling: Math.max(p.autoCompactCeiling, n) }), `smart auto-compact compacts a finished task from ${k(n)} tokens`)
          : prefs(p => ({ ...p, autoCompactCeiling: Math.max(n, p.autoCompactBoundary) }), `smart auto-compact compacts mid-task only past ${k(n)} tokens`)
      }
      const n = size(a1)
      if (!Number.isFinite(n)) return { kind: 'error', message: 'autocompact takes a size from 50k to 2m tokens (e.g. 300k), smart, watch, report, boundary <size>, ceiling <size>, or off' }
      return prefs(
        p => ({ ...p, autoCompactTokens: n, autoCompactSmart: p.autoCompactSmart === 'on' ? 'off' : p.autoCompactSmart }),
        `auto-compact at ${k(n)} tokens: when a turn ends at or above that, the conversation is compacted, keeping the plan and current task`,
      )
    }
    case 'compact':
      return { kind: 'compact' }
    case 'savings':
      return { kind: 'savings' }
    case 'band': {
      if (a1 !== 'full' && a1 !== 'compact' && a1 !== 'off') return { kind: 'error', message: 'band full|compact|off' }
      const band = a1
      return prefs(p => ({ ...p, ui: { ...p.ui, band } }), `band ${band}`)
    }
    case 'reset-task':
      return { kind: 'reset-task' }
    case 'resume-auto':
      return { kind: 'resume-auto' }
    case 'mode': {
      const mode = a1?.toLowerCase()
      if (!mode || !(MODES as readonly string[]).includes(mode)) return { kind: 'error', message: 'mode takes quality-first, balanced or economy' }
      return prefs(p => ({ ...p, mode: mode as RouterMode }), `mode ${mode}`)
    }
    case 'model': {
      const v = a1
      if (!v) return { kind: 'error', message: 'model takes auto, a tier, or a model id' }
      let override: Override
      if (v === 'auto') override = { kind: 'auto' }
      else if (isTier(v)) override = { kind: 'tier', tier: v }
      else if (isModelId(v)) override = { kind: 'model', model: v }
      else return { kind: 'error', message: `not a model id: ${String(v).slice(0, 40)}` }
      return prefs(p => ({ ...p, override }), v === 'auto' ? 'automatic model selection' : `manual override: ${v}`)
    }
    case 'floor': {
      if (a1 === 'none') return prefs(p => ({ ...p, floor: null }), 'no floor')
      if (!isTier(a1)) return { kind: 'error', message: 'floor takes none, cheap, middle or strong' }
      const floor: Tier = a1
      return prefs(p => ({ ...p, floor }), `floor ${floor}`)
    }
    case 'effort': {
      if (a1 === 'auto') {
        const v = onOff(a2)
        if (v === null) return { kind: 'error', message: 'effort auto on|off' }
        return prefs(p => ({ ...p, autoEffort: v }), `automatic effort ${v ? 'on: lowered only for narrow low-risk work, raised for high-risk work and after failed repairs' : 'off: the session effort is kept unless a tier sets one'}`)
      }
      if (!isTier(a1)) return { kind: 'error', message: 'effort takes auto on|off, or a tier then a level (or default)' }
      const tier: Tier = a1
      if (a2 === 'default') {
        return prefs(p => {
          const effort = { ...p.effort }
          delete effort[tier]
          return { ...p, effort }
        }, `${tier} effort: the model's default`)
      }
      if (!isEffort(a2)) return { kind: 'error', message: 'effort levels: low, medium, high, xhigh, max, default' }
      const level: Effort = a2
      return prefs(p => ({ ...p, effort: { ...p.effort, [tier]: level } }), `${tier} effort ${level}`)
    }
    case 'models': {
      const kv = keyValues(t.slice(1))
      const next: Partial<Record<Tier, string>> = {}
      for (const tier of ['cheap', 'middle', 'strong'] as const) {
        const v = kv[tier]
        if (v === undefined) continue
        if (!isModelId(v)) return { kind: 'error', message: `not a model id for ${tier}: ${String(v).slice(0, 40)}` }
        next[tier] = v
      }
      if (Object.keys(next).length === 0) return { kind: 'error', message: 'models takes cheap=<id> middle=<id> strong=<id>' }
      return prefs(p => ({ ...p, models: { ...p.models, ...next } }), `models ${Object.entries(next).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    }
    case 'price': {
      if (a1 === 'clear') {
        const model = a2
        if (!isModelId(model)) return { kind: 'error', message: 'price clear takes a model id' }
        return prefs(p => {
          const pricing = { ...p.pricing }
          delete pricing[model]
          return { ...p, pricing, pricingCleared: [...new Set([...(p.pricingCleared ?? []), model])] }
        }, `price cleared for ${model}`)
      }
      const model = a1
      if (!isModelId(model)) return { kind: 'error', message: 'price takes a model id first' }
      const kv = keyValues(t.slice(2))
      const n = (k: string) => (kv[k] === undefined ? NaN : Number(kv[k]))
      const price = normalizePrice({
        input: n('input'), output: n('output'), cacheWrite5m: n('write5m'), cacheWrite1h: n('write1h'), cacheRead: n('read'),
        source: kv.source, asOf: kv.date,
      })
      if (!price) return { kind: 'error', message: 'price needs input, output, write5m, write1h, read (USD per million tokens), source and date=YYYY-MM-DD' }
      const p2: ModelPrice = price
      return prefs(p => ({ ...p, pricing: { ...p.pricing, [model]: p2 }, pricingCleared: (p.pricingCleared ?? []).filter(m => m !== model) }), `price set for ${model} (${p2.source}, ${p2.asOf})`)
    }
    case 'baseline': {
      if (a1 === 'session') return prefs(p => ({ ...p, baselineModel: null }), 'baseline: the session model')
      if (!isModelId(a1)) return { kind: 'error', message: 'baseline takes session or a model id' }
      const model = a1
      return prefs(p => ({ ...p, baselineModel: model }), `baseline ${model}`)
    }
    case 'classifier': {
      if (a1 === 'dry-run') {
        const v = onOff(a2)
        if (v === null) return { kind: 'error', message: 'classifier dry-run on|off' }
        return prefs(p => ({ ...p, classifier: { ...p.classifier, inDryRun: v } }), `paid classifier in dry run ${v ? 'on' : 'off'}`)
      }
      const v = onOff(a1)
      if (v === null) return { kind: 'error', message: 'classifier on|off' }
      return prefs(p => ({ ...p, classifier: { ...p.classifier, enabled: v } }), `classifier ${v ? 'on' : 'off'}`)
    }
    case 'subagents': {
      const v = onOff(a1)
      if (v === null) return { kind: 'error', message: 'subagents on|off' }
      return prefs(p => ({ ...p, subagents: v }), `subagent routing ${v ? 'on' : 'off'}`)
    }
    case 'review': {
      if (a1 === 'now') return { kind: 'review-now' }
      if (a1 !== 'off' && a1 !== 'suggest' && a1 !== 'auto') return { kind: 'error', message: 'review off|suggest|auto|now' }
      const review: ReviewPolicy = a1
      return prefs(p => ({ ...p, review }), `review ${review}`)
    }
    case 'cache-ttl': {
      if (a1 !== '5m' && a1 !== '1h' && a1 !== 'auto') return { kind: 'error', message: 'cache-ttl 5m|1h|auto' }
      const ttl = a1
      return prefs(p => ({ ...p, cacheTtl: ttl }), ttl === 'auto' ? 'cache lifetime inferred from cache reads after idle gaps (1h until expiries show 5m)' : `cache writes priced at the ${ttl} rate`)
    }
    case 'ascii':
    case 'statusline': {
      const v = onOff(a1)
      if (v === null) return { kind: 'error', message: `${head} on|off` }
      return head === 'ascii'
        ? prefs(p => ({ ...p, ui: { ...p.ui, ascii: v } }), `ascii symbols ${v ? 'on' : 'off'}`)
        : prefs(p => ({ ...p, ui: { ...p.ui, statusLine: v } }), `status line ${v ? 'on' : 'off'}`)
    }
    case 'experiment': {
      const sub = a1?.toLowerCase()
      if (sub === 'stop') return { kind: 'experiment-stop' }
      if (sub === 'list') return { kind: 'experiment-list' }
      if (sub === 'report') {
        if (!a2) return { kind: 'error', message: 'experiment report <label>' }
        return { kind: 'experiment-report', label: a2.slice(0, 60) }
      }
      if (sub === 'start') {
        const label = a2
        const arm = t[3]
        if (!label || (arm !== 'routed' && arm !== 'baseline')) {
          return { kind: 'error', message: 'experiment start <label> routed|baseline spec="..." start="..." validation="..." env="..."' }
        }
        const kv = keyValues(t.slice(4))
        const missing = ['spec', 'start', 'validation', 'env'].filter(k => !kv[k])
        if (missing.length > 0) return { kind: 'error', message: `experiment start needs ${missing.join(', ')}` }
        return {
          kind: 'experiment-start',
          label: label.slice(0, 60),
          arm,
          spec: (kv.spec as string).slice(0, 300),
          startState: (kv.start as string).slice(0, 120),
          validation: (kv.validation as string).slice(0, 200),
          environment: (kv.env as string).slice(0, 120),
        }
      }
      return { kind: 'error', message: 'experiment start|stop|report|list' }
    }
    default:
      return { kind: 'error', message: `unknown subcommand "${(head ?? '').slice(0, 30)}". Try /quality-router help` }
  }
}
