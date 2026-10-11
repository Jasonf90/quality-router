// Escalation and validation tracking: what a tool result means, which checks
// ran against which state of the code, and when repeated failures are
// credible evidence that a stronger model is needed. Pure.
//
// The router observes tool calls; it never runs, replays or blocks one. An
// escalation changes the model of the scope's NEXT request and nothing else.

import type {
  CheckKind,
  CheckRecord,
  CheckStatus,
  ProjectConfig,
  RepairTrack,
  RouterMode,
  ScopeRoute,
  Tier,
  Validation,
} from '../types'

export type Outcome =
  | 'ok'
  | 'cancelled'
  | 'denied'
  | 'environment'
  | 'missing-dependency'
  | 'timeout'
  | 'no-tests'
  | 'check-failed'
  | 'command-failed'

/** Commands that are checks, mobile toolchains first. Projects add their own. */
export const DEFAULT_CHECKS: { kind: CheckKind; pattern: string }[] = [
  { kind: 'test', pattern: String.raw`\bxcodebuild\b.*\btest(-without-building)?\b` },
  { kind: 'build', pattern: String.raw`\bxcodebuild\b.*\b(build|archive)\b` },
  { kind: 'test', pattern: String.raw`\bswift test\b` },
  { kind: 'build', pattern: String.raw`\bswift build\b` },
  { kind: 'test', pattern: String.raw`\bgradlew?\b.*\b(test\w*|connected\w*AndroidTest|check)\b` },
  { kind: 'lint', pattern: String.raw`\bgradlew?\b.*\b(lint\w*|ktlintCheck|detekt)\b` },
  { kind: 'build', pattern: String.raw`\bgradlew?\b.*\b(assemble\w*|bundle\w*|build)\b` },
  { kind: 'test', pattern: String.raw`\bflutter test\b|\bdart test\b` },
  { kind: 'lint', pattern: String.raw`\bflutter analyze\b|\bdart analyze\b` },
  { kind: 'build', pattern: String.raw`\bflutter build\b` },
  { kind: 'test', pattern: String.raw`\b(npm|pnpm|yarn|bun)( run)? test\b|\bnpx (jest|vitest)\b|\b(jest|vitest)\b|\bdetox test\b|\bmaestro test\b|\bpytest\b|\bfastlane (scan|test)\b` },
  { kind: 'typecheck', pattern: String.raw`\btsc\b|\b(npm|pnpm|yarn)( run)? (typecheck|type-check|tsc)\b` },
  { kind: 'lint', pattern: String.raw`\beslint\b|\bswiftlint\b|\bktlint\b|\b(npm|pnpm|yarn)( run)? lint\b` },
  { kind: 'build', pattern: String.raw`\b(npm|pnpm|yarn)( run)? build\b|\bexpo (prebuild|export)\b|\beas build\b` },
]

const ENVIRONMENT = /command not found|not recognized as an internal|ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EADDRINUSE|ENOSPC|could not resolve host|network is unreachable|unable to boot (the )?simulator|unable to find a destination|no simulators? (available|found)|xcrun: error|xcode-select: error|xcodebuild: error: .*(not found|unable to)|agree to the xcode license|sdk location not found|android_(home|sdk_root)|java_home is not set|no devices\/emulators found|adb: (no devices|device offline)|gradle could not start|daemon (disappeared|stopped)|out of memory|java heap space|killed: 9|signing for .* requires a development team|no profiles for|code ?sign(ing)? error/i
const MISSING_DEPENDENCY = /cannot find module|module not found|no module named|unable to resolve module|could not find (package|module|dependency)|pod install|sandbox is not in sync with the podfile\.lock|cocoapods could not find|could not resolve (all )?(dependencies|artifacts)|missing (package|dependency|dependencies)|npm err! (code )?(e404|eresolve|enoent)|package .* (is not installed|not found)|no such module/i
const NO_TESTS = /no tests found|executed 0 tests|0 tests? (ran|run|passed)|no test (files|suites) found|ran 0 tests/i
const DENIED = /permission to use .* (was )?denied|user (rejected|declined|denied)|doesn'?t want to (proceed|take this action)|the user doesn't want/i
const CANCELLED = /interrupted by user|request interrupted|\[request interrupted/i
const DESTRUCTIVE = /\brm\s+-[a-z]*r[a-z]*f|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bdrop\s+(table|database|column)\b|\btruncate\s+table\b|\b(prisma|rails|alembic|knex|sequelize)\b.*\bmigrat\w*|\bdb:(reset|drop)\b|\bfirebase deploy\b|\bfastlane\b.*\b(release|deliver|supply)\b|\bxcrun altool\b/i
/** Generated output a build recreates: deleting it is routine, not a risk to the work. */
const BUILD_OUTPUT = /(^|\/)(build|DerivedData|\.build|dist|out|node_modules|Pods|\.gradle|\.dart_tool|\.next|\.expo|coverage|\.cache|tmp|temp|archives?|exports?|\w+-(build|export|archive)s?)(\/|$)|\.(xcarchive|ipa|apk|aab|app|xcresult|log)\/?$|^(\/private)?\/tmp\/|^\$\{?TMPDIR/
/** Notes and documents: an edit to one cannot break the app, whatever its name says. */
const DOC_FILE = /\.(md|markdown|txt|rtf|pdf|csv|log)$/i

const DEFAULT_RISK_PATHS = [
  String.raw`(^|/)(auth|authentication|login|signin|session|oauth|sso)[^/]*(/|\.|$)`,
  String.raw`(keychain|keystore|crypto|encrypt|secret|credential|token)`,
  String.raw`(payment|billing|checkout|purchase|storekit|iap|subscription|revenuecat|stripe)`,
  String.raw`(privacy|consent|gdpr|permission)`,
  String.raw`(migration|migrations|schema)[^/]*(/|\.|$)`,
  String.raw`(\.entitlements$|Info\.plist$|AndroidManifest\.xml$|GoogleService-Info\.plist$|google-services\.json$|firestore\.rules$|\.env(\.|$))`,
]

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|androidTest|[A-Za-z]+Tests|[A-Za-z]+UITests)\/|\.(test|spec)\.[a-z]+$|Tests?\.(swift|kt|java)$|_test\.(dart|go|py)$/

/** Compiles the project's patterns, dropping (and reporting) any that do not compile. */
export function compileChecks(project: ProjectConfig | null): { kind: CheckKind; re: RegExp }[] {
  const list = [...(project?.checks ?? []), ...DEFAULT_CHECKS]
  const out: { kind: CheckKind; re: RegExp }[] = []
  for (const c of list) {
    try {
      if (c.pattern.length <= 300) out.push({ kind: c.kind, re: new RegExp(c.pattern, 'i') })
    } catch {
      // A pattern that does not compile is skipped; loadProject reports it.
    }
  }
  return out
}

export function matchCheck(command: string, checks: { kind: CheckKind; re: RegExp }[]): CheckKind | null {
  const cmd = command.slice(0, 2000)
  for (const c of checks) {
    if (c.re.test(cmd)) return c.kind
  }
  return null
}

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

export function riskyPath(path: string, project: ProjectConfig | null): string | null {
  if (DOC_FILE.test(path)) return null
  for (const p of [...(project?.riskPaths ?? []), ...DEFAULT_RISK_PATHS]) {
    try {
      if (p.length <= 300 && new RegExp(p, 'i').test(path)) return path.split('/').slice(-2).join('/')
    } catch {
      // Ignored, as above.
    }
  }
  return null
}

export function isDestructive(command: string): boolean {
  const cmd = command.slice(0, 2000)
  if (!DESTRUCTIVE.test(cmd)) return false
  // `rm -rf` of build output only (a clean build, an old archive) is routine.
  const others = cmd.replace(/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+([^;&|\n]+)/gi, (_m, targets: string) => {
    const paths = targets.trim().split(/\s+/).filter(t => t && !t.startsWith('-')).map(t => t.replace(/^['"]|['"]$/g, ''))
    return paths.length > 0 && paths.every(p => BUILD_OUTPUT.test(p)) ? ' ' : _m
  })
  return DESTRUCTIVE.test(others)
}

export type ToolOutcomeInput = {
  denied: boolean
  isError: boolean
  interrupted: boolean
  timedOut: boolean
  text: string
  isCheck: boolean
}

/**
 * What a shell result means. A nonzero exit is not a model failure by
 * itself: cancellations, permission denials, environment problems, missing
 * dependencies and empty test runs are told apart from a check that ran and
 * failed. Commands that are not checks never count as failures.
 */
export function classifyOutcome(r: ToolOutcomeInput): Outcome {
  const text = r.text.slice(0, 20_000)
  if (r.denied || DENIED.test(text)) return 'denied'
  if (r.interrupted || CANCELLED.test(text)) return 'cancelled'
  if (r.timedOut) return 'timeout'
  if (r.isCheck && NO_TESTS.test(text)) return 'no-tests'
  if (!r.isError) return 'ok'
  if (MISSING_DEPENDENCY.test(text)) return 'missing-dependency'
  if (ENVIRONMENT.test(text)) return 'environment'
  return r.isCheck ? 'check-failed' : 'command-failed'
}

/** Failed repair attempts before escalating, per mode. */
export const REPAIR_LIMIT: Record<RouterMode, number> = {
  'quality-first': 2,
  balanced: 2,
  economy: 3,
}

export function emptyScope(tdd: boolean): ScopeRoute {
  return {
    decision: null,
    escalations: 0,
    escalationReasons: [],
    sourceVersion: 0,
    testVersion: 0,
    startSourceVersion: 0,
    repair: {},
    riskTouched: [],
    tdd,
  }
}

export function recordEdit<S extends ScopeRoute>(scope: S, path: string): S {
  return isTestPath(path)
    ? { ...scope, testVersion: scope.testVersion + 1 }
    : { ...scope, sourceVersion: scope.sourceVersion + 1 }
}

export type CheckEffect = {
  scope: ScopeRoute
  escalate: string | null
  note: string | null
}

/**
 * Applies one check result to a scope. A failure counts as a failed repair
 * attempt only when source code changed since the previous failure of that
 * check (or since the phase began): a red test before any implementation, a
 * failing test written first under TDD, or the same failure re-run with no
 * edit in between is not evidence about the model.
 */
export function applyCheck(
  scope: ScopeRoute,
  kind: CheckKind,
  outcome: Outcome,
  mode: RouterMode,
  maxEscalations: number,
): CheckEffect {
  const track: RepairTrack = scope.repair[kind] ?? { failedAttempts: 0, lastFailureSourceVersion: null, envFailures: 0 }
  if (outcome === 'environment' || outcome === 'missing-dependency' || outcome === 'timeout') {
    const next = { ...track, envFailures: track.envFailures + 1 }
    const note = next.envFailures >= 3 ? `${kind}: repeated environment problems; a stronger model will not fix the environment` : null
    return { scope: { ...scope, repair: { ...scope.repair, [kind]: next } }, escalate: null, note }
  }
  if (outcome === 'ok') {
    return { scope: { ...scope, repair: { ...scope.repair, [kind]: { failedAttempts: 0, lastFailureSourceVersion: null, envFailures: 0 } } }, escalate: null, note: null }
  }
  if (outcome !== 'check-failed') return { scope, escalate: null, note: null }

  // A repair attempt is any change since the last failure, to source or to
  // tests (a test written wrong and rewritten is an attempt too), except the
  // expected red run of test-first work before any source change.
  const version = scope.sourceVersion + scope.testVersion
  const since = track.lastFailureSourceVersion ?? scope.startSourceVersion
  const changedSince = version > since
  const expectedRed = scope.tdd && scope.sourceVersion === scope.startSourceVersion
  const attempts = changedSince && !expectedRed ? track.failedAttempts + 1 : track.failedAttempts
  const nextTrack: RepairTrack = { ...track, failedAttempts: attempts, lastFailureSourceVersion: version }
  let next: ScopeRoute = { ...scope, repair: { ...scope.repair, [kind]: nextTrack } }

  if (attempts >= REPAIR_LIMIT[mode] && next.escalations < maxEscalations) {
    const reason = `${attempts} failed repair attempts on ${kind}`
    next = {
      ...next,
      escalations: next.escalations + 1,
      escalationReasons: [...next.escalationReasons, reason].slice(-4),
      repair: { ...next.repair, [kind]: { ...nextTrack, failedAttempts: 0 } },
    }
    return { scope: next, escalate: reason, note: null }
  }
  const note = expectedRed ? `${kind} failing before implementation (expected under TDD)` : null
  return { scope: next, escalate: null, note }
}

/**
 * Newly discovered risk: an edit to a sensitive path or a destructive command
 * raises the scope straight to the strong tier, once, for its remaining
 * requests. Bounded by the strong tier itself.
 */
export function applyRisk(scope: ScopeRoute, what: string, currentTierRank: number): { scope: ScopeRoute; escalate: string | null } {
  if (scope.riskTouched.includes(what)) return { scope, escalate: null }
  const touched = [...scope.riskTouched, what].slice(-6)
  const steps = Math.max(0, 2 - currentTierRank)
  if (steps === 0) return { scope: { ...scope, riskTouched: touched }, escalate: null }
  const reason = `risk discovered: ${what}`
  return {
    scope: {
      ...scope,
      riskTouched: touched,
      escalations: scope.escalations + steps,
      escalationReasons: [...scope.escalationReasons, reason].slice(-4),
    },
    escalate: reason,
  }
}

/** Source files: an edit to one is code work, whatever the task was judged to be. */
const CODE_FILE = /\.(swift|kt|kts|java|m|mm|h|c|cc|cpp|hpp|ts|tsx|js|jsx|mjs|cjs|dart|py|rb|go|rs|cs|scala|vue|svelte|gradle|metal|shader|gd)$/i

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path.trim())
}

/**
 * The source file a shell command plainly writes, if any: an in-place edit
 * (`sed -i`, `perl -i`), a redirect or `tee` into it. A heuristic: a write a
 * script does from inside (python, node) is not seen.
 */
export function bashWritesCode(command: string): string | null {
  const cmd = command.slice(0, 4000)
  const ext = CODE_FILE.source.slice(2, -1)
  const patterns = [
    new RegExp(String.raw`\b(?:sed|perl)\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*i[^;&|]*?\s['"]?([^\s;&|'"]+\.${ext})\b`, 'i'),
    new RegExp(String.raw`>>?\s*['"]?([^\s;&|'"]+\.${ext})\b`, 'i'),
    new RegExp(String.raw`\btee\s+(?:-a\s+)?['"]?([^\s;&|'"]+\.${ext})\b`, 'i'),
  ]
  for (const re of patterns) {
    const m = re.exec(cmd)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * Code written on the cheap tier by a task that was not judged a mechanical
 * edit (a look-up, summary or question that turned into a fix): the rest of
 * the task moves up one tier, once, so code is not written on the cheap tier
 * on the strength of how the request was worded. Mechanical edits (typos,
 * renames, version bumps) stay where they are.
 */
export function applyCodeEdit(scope: ScopeRoute, category: string, currentTierRank: number, file: string): { scope: ScopeRoute; escalate: string | null } {
  if (currentTierRank >= 1 || category === 'mechanical' || scope.riskTouched.includes('code edit')) return { scope, escalate: null }
  const name = file.split('/').slice(-1)[0] ?? file
  const reason = `code edited during ${category} work (${name})`
  return {
    scope: {
      ...scope,
      riskTouched: [...scope.riskTouched, 'code edit'].slice(-6),
      escalations: scope.escalations + 1,
      escalationReasons: [...scope.escalationReasons, reason].slice(-4),
    },
    escalate: reason,
  }
}

/**
 * The floor a scope's own work has set: strong once it touched a sensitive
 * path or ran a destructive command, middle once a cheap-tier task wrote
 * code. Lasts for the rest of the task, whatever is decided later.
 */
export function scopeFloor(scope: Pick<ScopeRoute, 'riskTouched'>): Tier | null {
  if (scope.riskTouched.some(r => r !== 'code edit')) return 'strong'
  if (scope.riskTouched.includes('code edit')) return 'middle'
  return null
}

// --- validation ---------------------------------------------------------

export function emptyValidation(phaseId: string | null, project: ProjectConfig | null): Validation {
  return { phaseId, checks: {}, required: project?.required ?? [], acceptance: project?.acceptance ?? [] }
}

export function recordCheck(
  v: Validation,
  kind: CheckKind,
  outcome: Outcome,
  label: string,
  at: number,
  versions: { sourceVersion: number; testVersion: number },
): Validation {
  if (outcome === 'cancelled' || outcome === 'denied' || outcome === 'command-failed') return v
  const status: CheckRecord['status'] =
    outcome === 'ok' ? 'passed' : outcome === 'check-failed' ? 'failed' : 'unavailable'
  const detail = outcome === 'ok' || outcome === 'check-failed' ? '' : outcome
  const record: CheckRecord = { kind, label: label.slice(0, 60), status, at, ...versions, detail }
  return { ...v, checks: { ...v.checks, [kind]: record } }
}

/**
 * A check's status against the code as it stands now: a pass recorded before
 * later edits is `stale`, never a verification of those edits.
 */
export function checkStatus(v: Validation, kind: CheckKind, now: { sourceVersion: number; testVersion: number }): CheckStatus {
  const r = v.checks[kind]
  if (!r) return 'not-run'
  if (r.status === 'passed' && (r.sourceVersion < now.sourceVersion || r.testVersion < now.testVersion)) return 'stale'
  return r.status
}

/**
 * The phase's verdict. `verified` needs every required check to have passed
 * against the current code; with none configured, a phase is verified only
 * when every observed check passed against the current code. An agent saying
 * it succeeded never counts.
 */
export function verdict(v: Validation, now: { sourceVersion: number; testVersion: number }): 'verified' | 'failed' | 'unverified' {
  const kinds = v.required.length > 0 ? v.required : (Object.keys(v.checks) as CheckKind[])
  if (kinds.length === 0) return 'unverified'
  const statuses = kinds.map(k => checkStatus(v, k, now))
  if (statuses.includes('failed')) return 'failed'
  return statuses.every(s => s === 'passed') ? 'verified' : 'unverified'
}
