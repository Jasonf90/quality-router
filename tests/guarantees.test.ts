// The router's quality guarantees, checked over every combination the
// decision can see rather than a handful of examples: each category, risk,
// ambiguity, breadth, rules tier, confidence, mode, session effort, and the
// escalation, classifier-fallback and failed-check flags (about 440,000
// decisions). Each test names the guarantee in plain words.

import { describe, expect, test } from 'claude-code/testing'

import type { Analysis, Category, ClassifierVerdict, Decision, Effort, Prefs, Risk, RouterMode, Tier } from '../types'
import { decide } from '../hooks/policy'
import { DEFAULT_PREFS, MODES, TIERS, effortRank, tierRank } from '../hooks/settings'

const CATEGORIES: Category[] = ['extraction', 'summarize', 'classify', 'mechanical', 'question', 'docs', 'implement', 'debug', 'test', 'refactor', 'review', 'architecture', 'diagnosis', 'security', 'unknown']
const RISKS: Risk[] = ['low', 'medium', 'high']
const BREADTHS: Analysis['breadth'][] = ['single', 'few', 'broad']
const CONFIDENCES = [0.35, 0.55, 0.75, 0.9]
const SESSION_EFFORTS: (Effort | null)[] = [null, 'low', 'medium', 'high', 'max']
const FLAGS = [
  { fallback: false, phaseFailed: false },
  { fallback: true, phaseFailed: false },
  { fallback: false, phaseFailed: true },
]
/** Work that writes, fixes or judges code. */
const CODE_WORK: Category[] = ['implement', 'debug', 'test', 'refactor', 'review', 'architecture', 'diagnosis', 'security', 'unknown']
/** What quality-first lets the cheap tier do at all. */
const CHEAP_IN_QUALITY_FIRST: Category[] = ['mechanical', 'extraction', 'summarize', 'classify']

type Case = {
  mode: RouterMode
  analysis: Analysis
  session: Effort | null
  escalations: number
  fallback: boolean
  phaseFailed: boolean
}

function* cases(): Generator<Case> {
  for (const mode of MODES)
    for (const category of CATEGORIES)
      for (const risk of RISKS)
        for (const ambiguity of RISKS)
          for (const breadth of BREADTHS)
            for (const tier of TIERS)
              for (const confidence of CONFIDENCES)
                for (const session of SESSION_EFFORTS)
                  for (const escalations of [0, 1])
                    for (const f of FLAGS) {
                      const analysis: Analysis = { category, risk, ambiguity, breadth, readOnly: false, tdd: false, tier, confidence, signals: [] }
                      yield { mode, analysis, session, escalations, ...f }
                    }
}

function prefs(mode: RouterMode): Prefs {
  return { ...DEFAULT_PREFS, mode, state: 'on' }
}

function run(c: Case, verdict: ClassifierVerdict | null = null): Decision {
  return decide({
    prefs: prefs(c.mode),
    analysis: c.analysis,
    verdict,
    escalations: c.escalations,
    projectFloor: null,
    previousTier: null,
    promptTokens: 0,
    epoch: 0,
    now: 0,
    sessionEffort: c.session,
    phaseFailed: c.phaseFailed,
    fallback: c.fallback,
  })
}

/** Every case that breaks `rule`, described, at most five (an empty list passes). */
function violations(rule: (c: Case, d: Decision) => boolean): string[] {
  const out: string[] = []
  let checked = 0
  for (const c of cases()) {
    checked++
    const d = run(c)
    if (!rule(c, d)) {
      out.push(`${c.mode} ${c.analysis.category} risk=${c.analysis.risk} amb=${c.analysis.ambiguity} ${c.analysis.breadth} rules=${c.analysis.tier} conf=${c.analysis.confidence} effort=${c.session} esc=${c.escalations} → ${d.tier} ${d.effort ?? '-'}`)
      if (out.length >= 5) break
    }
  }
  if (checked < 400_000 && out.length === 0) out.push(`only ${checked} cases checked`)
  return out
}

const lowered = (c: Case, d: Decision) => c.session !== null && d.effort !== undefined && effortRank(d.effort) < effortRank(c.session)
const SLOW = { timeoutMs: 60_000 }

describe('model tier guarantees (exhaustive)', () => {
  test('high-risk work always runs on the strongest tier, in every mode', SLOW, () => {
    expect(violations((c, d) => c.analysis.risk !== 'high' || d.tier === 'strong')).toEqual([])
  })

  test('quality-first and balanced never route below the tier the rules judged the task needs', SLOW, () => {
    expect(violations((c, d) => c.mode === 'economy' || tierRank(d.tier) >= tierRank(c.analysis.tier))).toEqual([])
  })

  test('quality-first gives the cheap tier only mechanical edits, look-ups, summaries and classification', SLOW, () => {
    expect(violations((c, d) => c.mode !== 'quality-first' || d.tier !== 'cheap' || CHEAP_IN_QUALITY_FIRST.includes(c.analysis.category))).toEqual([])
  })

  test('code work (implement, fix, test, refactor, review, design, diagnosis) never runs on the cheap tier in any mode', SLOW, () => {
    expect(violations((c, d) => !CODE_WORK.includes(c.analysis.category) || d.tier !== 'cheap')).toEqual([])
  })

  test('after a failed repair the next request is on a stronger tier (or already the strongest)', SLOW, () => {
    expect(
      violations((c, d) => {
        if (c.escalations === 0) return true
        const before = run({ ...c, escalations: 0 })
        return d.tier === 'strong' || tierRank(d.tier) > tierRank(before.tier)
      }),
    ).toEqual([])
  })

  test('economy is the only mode that goes below the rules, and never for high-risk work, architecture, diagnosis or review', SLOW, () => {
    expect(
      violations((c, d) => {
        if (tierRank(d.tier) >= tierRank(c.analysis.tier)) return true
        return c.mode === 'economy' && c.analysis.risk !== 'high' && !['architecture', 'diagnosis', 'review'].includes(c.analysis.category)
      }),
    ).toEqual([])
  })
})

describe('effort guarantees (exhaustive)', () => {
  test('effort is never lowered for code work, in any mode', SLOW, () => {
    expect(violations((c, d) => !CODE_WORK.includes(c.analysis.category) || !lowered(c, d))).toEqual([])
  })

  test('effort is never lowered when anything is uncertain: risk, ambiguity, a classifier fallback, a failed check, an escalation', SLOW, () => {
    expect(
      violations((c, d) => {
        const uncertain = c.analysis.risk !== 'low' || c.analysis.ambiguity !== 'low' || c.fallback || c.phaseFailed || c.escalations > 0
        return !uncertain || !lowered(c, d)
      }),
    ).toEqual([])
  })

  test('quality-first lowers effort by one step at most', SLOW, () => {
    expect(
      violations((c, d) => c.mode !== 'quality-first' || !lowered(c, d) || effortRank(d.effort as Effort) === effortRank(c.session as Effort) - 1),
    ).toEqual([])
  })

  test('quality-first gives high-risk, architecture, diagnosis and broad work at least high effort', SLOW, () => {
    expect(
      violations((c, d) => {
        const critical = c.analysis.risk === 'high' || c.analysis.category === 'architecture' || c.analysis.category === 'diagnosis' || c.analysis.breadth === 'broad'
        if (c.mode !== 'quality-first' || !critical || c.session === null) return true
        return effortRank(d.effort ?? c.session) >= effortRank('high')
      }),
    ).toEqual([])
  })

  test('after a failed repair, effort is at least high (when the session has an effort level)', SLOW, () => {
    expect(violations((c, d) => c.escalations === 0 || c.session === null || effortRank(d.effort ?? c.session) >= effortRank('high'))).toEqual([])
  })
})

describe('classifier verdicts cannot lower the safety floor', () => {
  test('a verdict claiming cheap, low-risk work cannot move high-risk work or code work in quality-first onto the cheap tier', () => {
    const bad: string[] = []
    for (const category of CATEGORIES)
      for (const risk of RISKS)
        for (const vCategory of CATEGORIES)
          for (const vTier of TIERS)
            for (const vConfidence of [0.3, 0.6, 0.95]) {
              const analysis: Analysis = { category, risk, ambiguity: 'low', breadth: 'single', readOnly: false, tdd: false, tier: risk === 'high' ? 'strong' : 'middle', confidence: 0.5, signals: [] }
              const verdict: ClassifierVerdict = { category: vCategory, complexity: 'low', risk: 'low', verifiability: 'high', tier: vTier, confidence: vConfidence, reason: 'test' }
              const d = run({ mode: 'quality-first', analysis, session: 'high', escalations: 0, fallback: false, phaseFailed: false }, verdict)
              if (risk === 'high' && d.tier !== 'strong') bad.push(`high risk ${category} → ${d.tier} (verdict ${vCategory}/${vTier})`)
              if (d.tier === 'cheap' && !CHEAP_IN_QUALITY_FIRST.includes(vCategory)) bad.push(`${vCategory} verdict → cheap`)
              if (risk === 'medium' && d.tier === 'cheap') bad.push(`medium risk ${category} → cheap (verdict ${vCategory})`)
            }
    expect(bad.slice(0, 5)).toEqual([])
  })
})
