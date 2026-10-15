// The routing policy: deterministic analysis of a task and the decision that
// turns an analysis (and, when one ran, a classifier verdict) into a tier and
// a model. Pure: no `$`, no clock, no I/O, so every rule is unit-tested.
//
// Prompt length is never a signal on its own: the rules read what a task
// asks for (its verbs, its domain, its breadth, its consequences).

import type {
  Analysis,
  Category,
  ClassifierVerdict,
  Decision,
  DecisionSource,
  Prefs,
  Risk,
  RouterMode,
  Tier,
} from '../types'
import { chooseEffort } from './effort'
import { maxTier, raiseTier, tierOfModel, tierRank } from './settings'

type Rule = { re: RegExp; signal: string }

const HIGH_RISK: Rule[] = [
  { re: /\b(auth(entication|orization|orize|n|z)?|log ?ins?|sign ?ins?|sign ?ups?|oauth\d?|openid|sso|jwt|(session|refresh|access|bearer|id) tokens?)\b/, signal: 'authentication' },
  { re: /\b(passwords?|passcodes?|keychain|keystore|secure ?enclave|encrypt(ion|ed|ing)?|decrypt\w*|cryptograph\w*|secrets?|credentials?|api[ -]?keys?|private keys?|certificate pinning|ssl pinning|cert pinning)\b/, signal: 'secrets or crypto' },
  { re: /\b(payments?|billing|checkout|in[- ]app purchases?|iap|storekit|revenuecat|stripe|braintree|apple pay|google pay|refunds?|invoices?|subscription (purchase|billing|flow|renewal)s?)\b/, signal: 'payments' },
  { re: /\b(privacy|gdpr|ccpa|hipaa|coppa|pii|personal data|delete (the |my |a |user |their )?accounts?|account deletion|tracking consent|app tracking transparency)\b/, signal: 'privacy' },
  { re: /\b(access control|acls?|firestore rules|security rules|row[- ]level security|rls|roles? and permissions|permission checks?|authorization rules)\b/, signal: 'access control' },
  { re: /\b(migrations?|migrate (the )?(database|db|schema|data|store)|schema changes?|drop (table|column|database)|truncate|backfill|data loss|wipe|destructive|irreversible|core data model version|realm schema)\b/, signal: 'data migration' },
  { re: /\b(security|vulnerab\w*|exploits?|xss|csrf|sql injection|injection attacks?|sanitiz\w*|cve-\d+|sandbox escape)\b/, signal: 'security' },
  { re: /\b(production (database|db|data|deploy\w*|release)|prod (db|database|deploy|data)|release signing|code signing|provisioning profiles?|deploy to prod\w*)\b/, signal: 'production' },
  { re: /\b(biometric\w*|face ?id|touch ?id|healthkit|health data|medical records?|background location|location tracking)\b/, signal: 'sensitive data' },
  { re: /\b(submit\w* (it |this |the app |the build |the update |build \d+ |\d+ )?(for|to) (app store |apple |google play |play store )?review|app store connect|testflight|(release|publish|ship|upload)\w* (it |the app |the build |the update |a build |build \d+ )?(to|on) (the )?(app store|play store|testflight|production)|phased release)\b/, signal: 'store release' },
  // A sync bug reaches every device a person owns, and a CloudKit schema
  // deployed to production cannot be taken back.
  { re: /\b(icloud (sync\w*|kit|key[- ]?value( store)?|containers?|backups?)|cloudkit|ck(record|share|container|database|syncengine|subscription)s?|nspersistentcloudkitcontainer|nsubiquitouskeyvaluestore|(cross|multi)[- ]device (sync\w*|continuity|data|state)|sync\w* (across|between|to|with) (the |all |other |your |my |their |our |every )*(devices|platforms)|(data|device|cloud|two[- ]way|bidirectional|offline) sync\w*|sync conflicts?|conflict resolution|production schema|deploy\w* (the )?(cloudkit |production )?schema)\b/, signal: 'data sync' },
]

/** An auth-flavoured task that only touches presentation is not high risk. */
const PRESENTATION_ONLY = /\b(colou?rs?|fonts?|padding|margins?|spacing|labels?|typos?|copy|wording|icons?|layout|alignment|styl(e|ing)|placeholder|button text|title)\b/
const AUTH_LOGIC = /\b(tokens?|sessions?|verify|validat\w*|passwords?|credentials?|oauth\d?|jwt|api|logic|flow|refresh|expire\w*|storage|store|keychain|backend|server)\b/

const ARCHITECTURE: Rule[] = [
  { re: /\b(architect\w*|re-?architect\w*|redesign\w*|system design|data model(ing|s)?|schema design|state management|navigation (architecture|structure)|module boundaries|modulari[sz]\w*|monorepo|overhaul|re-?platform\w*|offline[- ]first|sync engine|caching strategy|scalab\w*|trade-?offs?|tech(nical)? design|design (doc|document|proposal))\b/, signal: 'architecture' },
  { re: /\b(which (approach|library|framework|pattern)|how should (we|i) (structure|design|architect|organi[sz]e|approach))\b/, signal: 'design decision' },
  { re: /\b(rewrite (the|our|this|my) (app|codebase|module|layer|backend|networking|data layer))\b/, signal: 'rewrite' },
  { re: /\b(make|create|write|draft|build|prepare|come up with|put together|outline) (me |us )?(a |an |the )?(detailed |full |complete |thorough |step[- ]by[- ]step |comprehensive |master |new )?(plan|roadmap|strategy|proposal|spec|specification)\b|\bplan (to|for|how|out)\b|\b(market|competitor|competitive|user|ux) research\b|\b(product|marketing|growth|monetization|pricing|aso|launch) strategy\b|\baudit (this|the|my|our) (app|codebase|project)\b/, signal: 'planning' },
  { re: /\bmigrat\w* (from|to) (swiftui|uikit|jetpack compose|compose|react native|flutter|expo|kotlin|swift ?6?|typescript|redux|mobx|zustand|riverpod|bloc|combine|async\/await|coroutines)\b/, signal: 'framework migration' },
]

const DIAGNOSIS: Rule[] = [
  { re: /\b(intermittent\w*|flak(y|iness)|race conditions?|deadlocks?|memory leaks?|retain cycles?|heisenbugs?|non-?deterministic\w*|root cause|anrs?|main thread (block\w*|hang\w*)|corrupt\w*|performance regressions?|jank|dropped frames|battery drain)\b/, signal: 'hard diagnosis' },
  { re: /\b(randomly|sometimes) (crash|fail|freez|hang|break|log)\w*/, signal: 'intermittent failure' },
  { re: /\bonly (on|in) (a )?(real )?(device|release|production|ci|testflight|ios \d+|android \d+)\b/, signal: 'environment-specific failure' },
  { re: /\b(can'?t|cannot|couldn'?t) (figure out|reproduce|find out)|no idea why|have no idea\b/, signal: 'unclear cause' },
  { re: /\bstill (doesn'?t|does not|isn'?t|is not|not|won'?t|can'?t|fails?|failing|broken|crash\w*|happen\w*|wrong|the same)\b|\bnot fixed\b|\b(same|this) (bug|issue|problem|error|crash) (again|is back|keeps)\b|\bkeeps (happening|crashing|failing|breaking)\b/, signal: 'recurring failure' },
]

const BROAD = /\b(entire|whole) (app|codebase|project|repo)\b|\bacross (the |all |every )?(app|codebase|project|repo|modules|screens|files|platforms)\b|\bevery (screen|file|module|view|component|endpoint)\b|\bproject-?wide\b|\bthroughout (the )?(app|codebase|project)\b|\ball (the )?(screens|files|modules|views|components)\b/
const FILE_REF = /\b[\w/.-]+\.(swift|kt|kts|java|ts|tsx|js|jsx|dart|m|mm|h|gradle|xml|plist|json|ya?ml|xib|storyboard|xcconfig|podspec)\b/g

const CONSEQUENTIAL_REVIEW = /\b(review|audit)\b[^.]*\b(pr|pull request|before (release|merge|ship\w*|launch)|architecture|security|release)\b|\b(security|architecture|release) (review|audit)\b/
const REVIEW = /\b(review|audit|critique|second opinion)\b/
const DEBUG = /\b(fix\w*|bugs?|errors?|failing|fails|failed|broken|crash\w*|exceptions?|stack ?traces?|doesn'?t work|not working|regressions?|debug\w*|issues?)\b/
const TEST = /\b(write|add|generate|create|update|extend) (some |more |the )?(unit |ui |integration |snapshot |e2e |end-to-end |widget |instrumented )?tests?\b|\btest coverage\b|\bunit tests?\b|\bxctest\b|\bespresso\b|\bdetox\b|\bmaestro\b|\bwidget tests?\b/
const IMPLEMENT = /\b(implement\w*|add(s|ing)?|build(s|ing)? (a|an|the|out|new)|create(s|ing)?|integrat\w*|wire (it |this |them )?(up|to|into)|hook (it |this |them )?up|support for|new (screen|view|feature|component|endpoint|page|flow))\b/
const REFACTOR = /\b(refactor\w*|extract (a |the |this )?(function|method|component|view|hook|class|module)|rename\w*|clean ?up|simplif\w*|de-?duplicat\w*|split (this|the) (file|function|component|view))\b/
const DOCS = /\b(readme|documentation|docs|docstrings?|code comments|add comments|comments? (to|for|in)|changelog|release notes)\b/
const MECHANICAL = /\b(typos?|spelling|misspell\w*|reformat\w*|format (the|this|all)|prettier|swiftformat|ktlint --format|lint ?fix|sort (the )?imports|remove unused (imports|variables|code)|bump (the )?(app )?version|update (the )?(version|copyright|year|build number)|rename \S+ to \S+|convert (this |the )?(json|yaml|csv|plist|xml)|change (the )?([\w-]+ ){0,2}(colou?r|text|label|string|title|copy|font size|padding|margin|icon)s?|capitali[sz]\w*|translate (the |these )?strings?|locali[sz]\w* (string|key)s?)\b/
/** Debugging beyond the bare word "fix": a mechanical "fix the typo" is not a bug fix. */
const DEBUG_BEYOND_FIX = /\b(bugs?|errors?|failing|fails|failed|broken|crash\w*|exceptions?|stack ?traces?|doesn'?t work|not working|regressions?|debug\w*|issues?)\b/
/** Restructuring code, not just renaming it. */
const REFACTOR_BEYOND_RENAME = /\b(refactor\w*|extract (a |the |this )?(function|method|component|view|hook|class|module)|simplif\w*|de-?duplicat\w*|split (this|the) (file|function|component|view)|replac\w* .{1,60}? with|rewrit\w*|restructur\w*|migrat\w*)\b/
/** Words that make an edit a change of behaviour rather than of text. */
const LOGIC = /\b(so (that|it|the)|validat\w*|reject\w*|handl\w*|when|unless|only if|should|logic|behaviou?r|condition\w*|calculat\w*|instead of)\b/
const SUMMARIZE = /\b(summari[sz]\w*|summary|tl;?dr|recap)\b/
const EXTRACTION = /\b(list (all|the|every)|find (all|every|where)|which files|where is|where are|grep|search for|count (the |how many)|extract (the |all )?(strings|values|keys|names|data)|show me)\b/
const CLASSIFY = /\b(classify|categori[sz]e|label (these|the|each)|triage)\b/
const QUESTION = /^(what|why|how|where|when|which|who|explain)\b|\?\s*$/
const EDIT_VERBS = /\b(fix|change|add|implement|write|update|create|remove|delete|rename|refactor|migrate|replace|build|make|convert|move|bump|install|upgrade|merge|recreate|rewrite|combine|consolidate|draft|compose|reorgani[sz]e|restructure)\b/
const VAGUE = /^(please )?(make it (better|work|nicer)|improve( it| this| things)?|clean (it|this|things) up|fix (it|this|that|everything)|make this better|polish( it| this)?|optimi[sz]e( it| this)?|update it|do it|handle it|sort (it|this) out|tidy (it|this) up)\b/
const HEDGES = /\b(something|somehow|not sure|maybe|i think|kind of|sort of|whatever|etc)\b/
const TDD = /\b(tdd|test[- ]driven|red[- ]green|failing tests? first|write (a |the )?failing tests?|tests? (should|will|must) fail (first|initially))\b/

const CONTINUATION_WORDS = new Set(['y', 'yes', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'ahead', 'on', 'continue', 'proceed', 'keep', 'going', 'do', 'it', 'sounds', 'good', 'lgtm', 'looks', 'please', 'carry', 'next', 'thanks', 'thank', 'you', 'great', 'perfect', 'try', 'again', 'retry', 'resume', 'approved', 'approve', 'that', 'works', 'fine'])

/** Low-risk categories each mode lets run on the cheap tier. */
const CHEAP_OK: Record<RouterMode, readonly Category[]> = {
  'quality-first': ['mechanical', 'extraction', 'summarize', 'classify'],
  balanced: ['mechanical', 'extraction', 'summarize', 'classify', 'docs'],
  economy: ['mechanical', 'extraction', 'summarize', 'classify', 'docs', 'question'],
}

/** Below this confidence a choice is uncertain and moves one tier up. */
export const CONFIDENCE_FLOOR: Record<RouterMode, number> = {
  'quality-first': 0.6,
  balanced: 0.5,
  economy: 0.4,
}

/** Rules confidence under which the optional classifier is worth its cost. */
export const CLASSIFY_BELOW: Record<RouterMode, number> = {
  'quality-first': 0.7,
  balanced: 0.65,
  economy: 0.6,
}

export function isContinuation(text: string): boolean {
  const words = text.trim().toLowerCase().replace(/[.!,]+/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  return words.length <= 6 && words.every(w => CONTINUATION_WORDS.has(w))
}

/** A short reply that points back at the work in hand rather than naming new work. */
const REFERS_BACK = /^(ok(ay)?|yes|yep|yeah|sure|great|perfect|thanks|looks good|sounds good|lgtm|go ahead|please|proceed|continue|now)\b|\b(the plan|that plan|this plan|the fix|that fix|the change|those changes|these changes|the approach|that approach|the same|it still|still (fails?|failing|broken|crash\w*|doesn'?t|not|happens|wrong)|(try|do) (it |that |this )?again|instead|try (a |another |a different )|different approach|as (you|we) (said|discussed|planned|suggested|recommended|proposed)|as (recommended|suggested|planned|proposed|discussed)|implement (it|that|this|the plan|them)|do (it|that|this|them|both|all|everything)|go (ahead )?with (option|that|it|the|your|all|everything)|option \d|both of them|all of them|what('?s| is) next|next steps?|keep going|carry on|your (recommendations?|suggestions?|plan))\b/

/**
 * A prompt that carries on the task in hand: a bare continuation ("yes", "go
 * on"), a background task reporting back, or a short reply that points at the
 * current work ("ok implement it", "the test still fails, try a different
 * approach"). It keeps the task's risk, tier and escalations instead of being
 * judged as new work from its few words, and a reply that reports the bug is
 * still there raises the task. A reply that names a file, or brings its own
 * high risk or design work, is new work.
 */
export function isFollowUp(text: string, a: Analysis): boolean {
  if (isContinuation(text)) return true
  const t = text.trim().toLowerCase()
  if (t.startsWith('<task-notification')) return true
  if (t.length > 200) return false
  if (a.risk === 'high' || a.category === 'architecture') return false
  if ((t.match(FILE_REF) ?? []).length > 0) return false
  return REFERS_BACK.test(t)
}

/**
 * The more demanding of two analyses of the same task, field by field: the
 * higher tier and risk, the wider breadth. A follow-up can raise what the
 * task needs, never lower it.
 */
export function strongerAnalysis(a: Analysis, b: Analysis, mode: RouterMode): Analysis {
  const riskRank = (r: Risk) => (r === 'high' ? 2 : r === 'medium' ? 1 : 0)
  const breadthRank = (x: Analysis['breadth']) => (x === 'broad' ? 2 : x === 'few' ? 1 : 0)
  const ta = applyMode(a, mode).tier
  const tb = applyMode(b, mode).tier
  const lead = tierRank(tb) > tierRank(ta) || (tierRank(tb) === tierRank(ta) && riskRank(b.risk) > riskRank(a.risk)) ? b : a
  return {
    ...lead,
    tier: maxTier(a.tier, b.tier),
    risk: riskRank(b.risk) > riskRank(a.risk) ? b.risk : a.risk,
    breadth: breadthRank(b.breadth) > breadthRank(a.breadth) ? b.breadth : a.breadth,
    readOnly: a.readOnly && b.readOnly,
    tdd: a.tdd || b.tdd,
    signals: [...new Set([...a.signals, ...b.signals])].slice(0, 8),
  }
}

/** Whether `b` asks more of the task than `a` (a higher tier in this mode, or higher risk). */
export function raisesTask(a: Analysis, b: Analysis, mode: RouterMode): boolean {
  const riskRank = (r: Risk) => (r === 'high' ? 2 : r === 'medium' ? 1 : 0)
  // A reply that says nothing recognisable ("ok thanks") raises nothing: its
  // low-confidence strong tier is the rules' uncertainty, not a new demand.
  if (b.category === 'unknown' && b.risk === 'low' && b.breadth !== 'broad') return false
  return tierRank(applyMode(b, mode).tier) > tierRank(applyMode(a, mode).tier) || riskRank(b.risk) > riskRank(a.risk)
}

/** A reply that sets the proposed work going, not one that asks about it. */
const EXECUTES = /\b(start\w*|begin|implement\w*|build|do|work(ing)?|execute|proceed|go ahead|continue|carry on|keep going|apply|finish|complete|ship|fix|set (it |them |that )?up|make (it|that|them|those|these|the changes?))\b/

/**
 * Whether a follow-up sets in motion the work Claude's last answer proposed:
 * "yes", "let's start working the plan", "continue with what you recommend",
 * "do it for me". "What's next?" asks about it and is not.
 */
export function isExecution(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.length === 0 || t.startsWith('<task-notification')) return false
  if (isContinuation(t)) return true
  return EXECUTES.test(t) && !/^(what|why|how|which|when|where|who|is|are|does|did|can|could|should)\b/.test(t)
}

/** How much of Claude's answer is read: its opening states the subject, its end what it proposes. */
const ANSWER_HEAD = 1500
const ANSWER_TAIL = 2500

/**
 * What the work Claude's last answer proposed demands, when that is more than
 * its words would be judged as on their own: high risk (it plans iCloud sync,
 * a payment flow, a store submission) or design work. Null otherwise, and for
 * an empty answer. Only this verdict is kept, never the answer's text.
 */
export function answerDemands(answer: string): Analysis | null {
  const text = answer.length <= ANSWER_HEAD + ANSWER_TAIL ? answer : `${answer.slice(0, ANSWER_HEAD)}\n${answer.slice(-ANSWER_TAIL)}`
  if (text.trim().length === 0) return null
  const a = analyzePrompt(text)
  // Design work, not the word "plan": answers lay out plans all the time.
  const design = hits(ARCHITECTURE, text.toLowerCase()).filter(s => s !== 'planning')
  if (a.risk !== 'high' && design.length === 0) return null
  return {
    ...a,
    category: a.risk === 'high' ? a.category : 'architecture',
    tier: 'strong',
    confidence: Math.max(a.confidence, 0.8),
    signals: [...new Set(['proposed in the last answer', ...a.signals])].slice(0, 8),
  }
}

const PLAN_PROMPT =/^(please\s+)?(let'?s\s+)?(?<verb>(start|begin|do|run|execute|continue( with)?|move (on )?to|go (on )?to|proceed (to|with)|on to|now)\s+)?(the\s+)?(?<next>next\s+)?(phase|step|stage|milestone|part|sprint)(\s+(?<num>\d+|[ivx]+|one|two|three|four|five|six|seven|eight|nine|ten))?\s*[.!]?\s*$/i

/**
 * A prompt that starts a step of an earlier plan: "start phase 3", "next
 * phase", "do step 2". The whole prompt must be that (short), and it needs a
 * verb, "next" or a number, so "phase out the old API" is not one.
 */
export function isPlanPrompt(text: string): boolean {
  const t = text.trim()
  if (t.length === 0 || t.length > 60) return false
  const m = PLAN_PROMPT.exec(t)
  return m !== null && Boolean(m.groups?.verb || m.groups?.next || m.groups?.num)
}

/**
 * When a phase's prompt says too little ("start phase 3"), the task list
 * Claude writes for it says what the work is. Each task is analysed on its
 * own and the phase takes the hardest of them (quality-first): the strongest
 * tier, the highest risk. Null when none of the tasks is recognisable.
 */
export function assessFromTasks(subjects: readonly string[]): Analysis | null {
  const tasks = subjects.map(s => s.trim()).filter(s => s.length > 0).slice(0, 40)
  if (tasks.length === 0) return null
  const parts = tasks.map(analyzePrompt)
  const known = parts.filter(a => a.category !== 'unknown')
  if (known.length === 0) return null
  const rank = (t: Tier) => (t === 'strong' ? 2 : t === 'middle' ? 1 : 0)
  const riskRank = (r: Risk) => (r === 'high' ? 2 : r === 'medium' ? 1 : 0)
  const hardest = known.reduce((x, y) => (rank(y.tier) > rank(x.tier) || (rank(y.tier) === rank(x.tier) && riskRank(y.risk) > riskRank(x.risk)) ? y : x))
  const risk = parts.reduce<Risk>((r, a) => (riskRank(a.risk) > riskRank(r) ? a.risk : r), 'low')
  // Unrecognised tasks lower confidence: the phase may hold work the rules cannot see.
  const coverage = known.length / parts.length
  const confidence = Math.max(0, Math.min(1, Number((Math.min(...known.map(a => a.confidence)) - (coverage < 1 ? 0.3 * (1 - coverage) : 0)).toFixed(2))))
  return {
    ...hardest,
    risk,
    tier: risk === 'high' ? 'strong' : hardest.tier,
    breadth: parts.some(a => a.breadth === 'broad') ? 'broad' : hardest.breadth,
    readOnly: parts.every(a => a.readOnly),
    tdd: parts.some(a => a.tdd),
    confidence,
    signals: [...new Set(['from task list', ...known.flatMap(a => a.signals)])].slice(0, 8),
  }
}

function hits(rules: Rule[], text: string): string[] {
  return rules.filter(rule => rule.re.test(text)).map(rule => rule.signal)
}

/**
 * Reads a task's text and says what kind of task it is, how risky, how broad,
 * how ambiguous, and which tier the rules would give it with what confidence.
 */
export function analyzePrompt(raw: string): Analysis {
  const text = raw.toLowerCase().slice(0, 20_000)
  const signals: string[] = []

  let riskSignals = hits(HIGH_RISK, text)
  let risk: Risk = riskSignals.length > 0 ? 'high' : 'low'
  if (
    risk === 'high' &&
    riskSignals.every(s => s === 'authentication') &&
    PRESENTATION_ONLY.test(text) &&
    !AUTH_LOGIC.test(text)
  ) {
    risk = 'medium'
    riskSignals = ['authentication screen (presentation only)']
  }
  signals.push(...riskSignals)

  const architecture = hits(ARCHITECTURE, text)
  const diagnosis = hits(DIAGNOSIS, text)
  signals.push(...architecture, ...diagnosis)

  const files = new Set(text.match(FILE_REF) ?? [])
  const broad = BROAD.test(text) || files.size >= 4
  const breadth: Analysis['breadth'] = broad ? 'broad' : files.size >= 2 ? 'few' : 'single'
  if (broad) signals.push('broad scope')

  const flags = {
    review: REVIEW.test(text),
    consequentialReview: CONSEQUENTIAL_REVIEW.test(text),
    debug: DEBUG.test(text),
    test: TEST.test(text),
    implement: IMPLEMENT.test(text),
    refactor: REFACTOR.test(text) || REFACTOR_BEYOND_RENAME.test(text),
    docs: DOCS.test(text),
    mechanical: MECHANICAL.test(text),
    summarize: SUMMARIZE.test(text),
    extraction: EXTRACTION.test(text),
    classify: CLASSIFY.test(text),
    question: QUESTION.test(text.trim()),
  }
  const editing = EDIT_VERBS.test(text)
  const kinds = Object.entries(flags).filter(([k, v]) => v && k !== 'consequentialReview').length

  let category: Category
  let tier: Tier
  let confidence: number
  if (architecture.length > 0) {
    ;[category, tier, confidence] = ['architecture', 'strong', 0.8]
  } else if (diagnosis.length > 0) {
    ;[category, tier, confidence] = ['diagnosis', 'strong', 0.8]
  } else if (flags.consequentialReview || (flags.review && risk === 'high')) {
    ;[category, tier, confidence] = ['review', 'strong', 0.8]
  } else if (flags.mechanical && !flags.implement && !flags.test && !DEBUG_BEYOND_FIX.test(text) && !REFACTOR_BEYOND_RENAME.test(text) && !LOGIC.test(text)) {
    ;[category, tier, confidence] = ['mechanical', 'cheap', 0.8]
  } else if (flags.debug) {
    ;[category, tier, confidence] = ['debug', 'middle', 0.75]
  } else if (flags.test) {
    ;[category, tier, confidence] = ['test', 'middle', 0.75]
  } else if (flags.classify) {
    ;[category, tier, confidence] = ['classify', 'cheap', 0.8]
  } else if (flags.summarize && !editing) {
    ;[category, tier, confidence] = ['summarize', 'cheap', 0.8]
  } else if (flags.extraction && !editing) {
    ;[category, tier, confidence] = ['extraction', 'cheap', 0.8]
  } else if (flags.docs) {
    ;[category, tier, confidence] = ['docs', 'cheap', 0.7]
  } else if (flags.implement) {
    ;[category, tier, confidence] = ['implement', 'middle', 0.75]
  } else if (flags.refactor) {
    ;[category, tier, confidence] = ['refactor', 'middle', 0.75]
  } else if (flags.review) {
    ;[category, tier, confidence] = ['review', 'middle', 0.7]
  } else if (flags.question && !editing) {
    ;[category, tier, confidence] = ['question', 'middle', 0.7]
  } else {
    ;[category, tier, confidence] = ['unknown', 'middle', 0.35]
  }
  if (category !== 'unknown') signals.push(category)

  // Mixed signals (a refactor that is also a migration, say) lower confidence.
  if (kinds >= 3) confidence -= 0.1

  // Breadth: a broad implementation, refactor or fix has real dependencies.
  if (breadth === 'broad' && ['implement', 'refactor', 'debug', 'test', 'mechanical'].includes(category)) {
    tier = category === 'mechanical' ? 'middle' : 'strong'
  }

  // Ambiguity is read from vague asks and hedges, never from length alone.
  const vague = VAGUE.test(text.trim()) && files.size === 0
  const hedges = (text.match(new RegExp(HEDGES.source, 'g')) ?? []).length
  const ambiguity: Risk = vague ? 'high' : hedges >= 2 ? 'medium' : 'low'
  if (ambiguity === 'high') {
    signals.push('ambiguous request')
    confidence -= 0.25
  } else if (ambiguity === 'medium') {
    confidence -= 0.1
  }

  if (risk === 'high') {
    tier = 'strong'
    confidence = Math.max(confidence, 0.85)
  } else if (risk === 'medium') {
    tier = maxTier(tier, 'middle')
  }

  const readOnly = !editing && ['question', 'extraction', 'summarize', 'classify', 'review'].includes(category)
  return {
    category,
    risk,
    ambiguity,
    breadth,
    readOnly,
    tdd: TDD.test(text),
    tier,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
    signals: [...new Set(signals)].slice(0, 8),
  }
}

/** A subagent's task: its prompt, its type, and the risk of the phase that spawned it. */
export function analyzeSubagent(prompt: string, subagentType: string, parentRisk: Risk): Analysis {
  const a = analyzePrompt(prompt)
  const type = subagentType.toLowerCase()
  let { tier, category, confidence } = a
  let readOnly = a.readOnly
  const signals = [...a.signals]
  if (type === 'explore' && !a.signals.some(s => s === 'architecture')) {
    readOnly = true
    if (category === 'unknown' || category === 'question') {
      category = 'extraction'
      tier = a.risk === 'high' ? 'strong' : 'cheap'
      confidence = 0.75
    }
    signals.push('read-only explorer')
  } else if (type === 'plan') {
    category = 'architecture'
    tier = 'strong'
    confidence = Math.max(confidence, 0.75)
    signals.push('planning agent')
  } else if (/review|security|audit/.test(type)) {
    category = 'review'
    tier = 'strong'
    confidence = Math.max(confidence, 0.75)
    signals.push('review agent')
  }
  if (parentRisk === 'high') {
    tier = maxTier(tier, readOnly ? 'middle' : 'strong')
    signals.push('high-risk parent task')
  }
  return { ...a, tier, category, confidence, readOnly, signals: [...new Set(signals)].slice(0, 8) }
}

/** The rules' tier after the mode's thresholds, and why. */
export function applyMode(a: Analysis, mode: RouterMode): { tier: Tier; reason: string } {
  let tier = a.tier
  const notes: string[] = []
  if (mode === 'economy' && a.risk !== 'high') {
    if (tier === 'middle' && (a.category === 'question' || a.category === 'docs')) tier = 'cheap'
    if (tier === 'strong' && a.category !== 'architecture' && a.category !== 'diagnosis' && a.category !== 'review') {
      tier = 'middle'
    }
  }
  if (tier === 'cheap' && !CHEAP_OK[mode].includes(a.category)) {
    tier = 'middle'
    notes.push(`${a.category} is not cheap-tier work in ${mode}`)
  }
  if (a.confidence < CONFIDENCE_FLOOR[mode]) {
    tier = raiseTier(tier, 1)
    notes.push('low confidence, stronger tier')
  }
  if (a.risk === 'high') tier = 'strong'
  const what = a.signals.length > 0 ? a.signals.slice(0, 3).join(', ') : 'no clear signal'
  return { tier, reason: [what, ...notes].join('; ') }
}

export type DecideInput = {
  prefs: Prefs
  analysis: Analysis
  verdict: ClassifierVerdict | null
  escalations: number
  escalationReason?: string
  projectFloor: Tier | null
  /**
   * A floor the work itself set while it ran (escalation.scopeFloor): strong
   * once it touched a sensitive file or ran a destructive command, middle once
   * a cheap-tier task wrote code. It lasts for the rest of the task.
   */
  scopeFloor?: Tier | null
  /** The tier the last main request ran at, when known. */
  previousTier: Tier | null
  /** Prompt tokens of the last main request: what a model switch resends uncached. */
  promptTokens: number
  epoch: number
  now: number
  /** The session's own effort level for these requests (null: none, or not known yet). */
  sessionEffort?: string | null
  /** A check failed in this task: effort is not lowered for the rest of it. */
  phaseFailed?: boolean
  /** The classifier failed and the rules decided conservatively. */
  fallback?: boolean
  /**
   * Whether moving the main conversation down to `toTier` pays for the cache
   * it throws away (economics.switchPays); null when it cannot tell (no
   * price), in which case the plain prompt-size rule applies.
   */
  holdCheck?: (toTier: Tier, toModel: string) => { hold: boolean; reason: string } | null
  /** Effort is not lowered: a large prompt the cache still holds (changing effort may re-send it). */
  holdEffortLowering?: boolean
}

/**
 * The decision for a phase or a subagent. Precedence, highest first: the
 * person's manual override; safety floors (high risk, the configured floor);
 * escalation; then the rules or the classifier within the bounds the rules
 * set; finally a held downgrade when switching would resend a large prompt.
 */
export function decide(input: DecideInput): Decision {
  const { prefs, analysis, verdict } = input
  const base = { category: analysis.category, risk: analysis.risk, epoch: input.epoch, at: input.now }

  if (prefs.override.kind !== 'auto') {
    const tier: Tier =
      prefs.override.kind === 'tier' ? prefs.override.tier : (tierOfModel(prefs.override.model, prefs) ?? 'strong')
    const model = prefs.override.kind === 'model' ? prefs.override.model : prefs.models[tier]
    const effort = prefs.effort[tier]
    const warn = analysis.risk === 'high' && tier !== 'strong' ? ' (below the safety recommendation for this task)' : ''
    return {
      ...base,
      tier,
      model,
      ...(effort ? { effort, effortSource: 'preference' as const, effortReason: `your ${tier}-tier setting` } : {}),
      baseEffort: input.sessionEffort ?? null,
      source: 'override',
      confidence: 1,
      reason: `manual override${warn}`,
    }
  }

  const ruled = applyMode(analysis, prefs.mode)
  let tier = ruled.tier
  let source: DecisionSource = 'rules'
  let confidence = analysis.confidence
  let reason = ruled.reason

  if (verdict) {
    const riskFloor: Tier =
      analysis.risk === 'high' || verdict.risk === 'high' ? 'strong' : analysis.risk === 'medium' ? 'middle' : 'cheap'
    let proposed = verdict.tier
    if (proposed === 'cheap' && !CHEAP_OK[prefs.mode].includes(verdict.category)) proposed = 'middle'
    if (verdict.confidence < CONFIDENCE_FLOOR[prefs.mode]) proposed = raiseTier(proposed, 1)
    // In quality-first the classifier can only add caution: it may raise the
    // rules' tier, never lower it.
    tier = prefs.mode === 'quality-first' ? maxTier(maxTier(proposed, riskFloor), ruled.tier) : maxTier(proposed, riskFloor)
    source = 'classifier'
    confidence = verdict.confidence
    reason = `classifier: ${verdict.reason}`
  }

  if (input.escalations > 0) {
    tier = raiseTier(tier, input.escalations)
    // An escalation never lands below the tier the work was already running on.
    if (input.previousTier) tier = maxTier(tier, input.previousTier)
    source = 'escalation'
    reason = input.escalationReason ? `escalated: ${input.escalationReason}` : `escalated ${input.escalations}x`
  }

  for (const floor of [prefs.floor, input.projectFloor, input.scopeFloor ?? null]) {
    if (floor && tierRank(tier) < tierRank(floor)) {
      tier = floor
      reason = `${reason}; floor ${floor}`
    }
  }

  if (input.previousTier && tierRank(tier) < tierRank(input.previousTier)) {
    const verdict = input.holdCheck?.(tier, prefs.models[tier]) ?? null
    if (verdict) {
      if (verdict.hold) {
        reason = `kept ${input.previousTier}: ${verdict.reason} (proposed ${tier})`
        tier = input.previousTier
        source = 'held'
      } else {
        reason = `${reason}; ${verdict.reason}`
      }
    } else if (input.promptTokens > prefs.downgradeContextLimit) {
      const k = Math.round(input.promptTokens / 1000)
      reason = `held at ${input.previousTier}: switching down would resend ~${k}k prompt tokens uncached (proposed ${tier})`
      tier = input.previousTier
      source = 'held'
    }
  }

  const e = chooseEffort({
    prefs,
    analysis,
    tier,
    confidence,
    fallback: input.fallback ?? false,
    escalations: input.escalations,
    phaseFailed: input.phaseFailed ?? false,
    sessionEffort: input.sessionEffort ?? null,
    holdLowering: input.holdEffortLowering ?? false,
  })
  return {
    ...base,
    tier,
    model: prefs.models[tier],
    ...(e.effort ? { effort: e.effort, effortSource: e.effortSource, ...(e.effortReason ? { effortReason: e.effortReason } : {}) } : {}),
    baseEffort: input.sessionEffort ?? null,
    source,
    confidence,
    reason: reason.slice(0, 200),
  }
}

