# Evaluating Quality Router safely

The goal is to learn whether routing keeps quality while using fewer tokens, without risking real work. Each stage below is opt-in. The router never runs a baseline, never repeats work, and never spends money on its own initiative beyond the optional classifier call when ON.

## Stage 1: dry run (no model changes, no extra calls)

1. Load the mod (README, *Try it in dry-run mode*). The band shows `◐ Router DRY RUN`.
2. Work normally for a few days on your mobile projects.
3. Watch the band's *Proposed* model and `why:` line. `/quality-router usage` shows the decision history.
4. Look for proposals you disagree with:
   - a cheap tier for something you consider risky, or
   - a strong tier for trivial work.

   Add sensitive paths or checks in `<project>/.claude/quality-router.json`, or set `/quality-router floor middle`.

Dry run uses the deterministic rules only. To see what the classifier would add, you can enable paid dry-run analysis with `/quality-router classifier dry-run on`. It makes one small cheap-tier call per uncertain phase, and that usage is recorded as classifier overhead.

## Stage 2: verify a routed request live

1. In a throwaway session, run `/quality-router on`.
2. Ask something mechanical: *"Summarize the README in three bullet points."*
3. Open `/quality-router usage`. Under *A. OBSERVED TOKEN USAGE*, a row for `claude-haiku-5-5` (as reported by the API) confirms the override was accepted.
4. If the band shows `⚠ Degraded: … did not answer`, the routed model ID isn't available to your account. Fix it with `/quality-router models cheap=<id>`.

## Stage 3: ON in quality-first, on low-stakes work

Use `ON` with `mode quality-first` on routine tasks: UI tweaks, tests, small fixes. Keep `review suggest`.

At the end of each day, check the pane:
- the phase verdicts (verified / failed / unverified),
- escalations and fallbacks,
- section B. If B is negative, routing cost more by list price.

## Stage 4: comparable experiments (optional; you run both arms)

A token-reduction number is only meaningful between comparable runs. The router records; you run both arms yourself:

1. Pick a task with a clear spec and checks, e.g. "Add a pull-to-refresh to OrdersList; `xcodebuild … test` passes".
2. Note the starting commit, then create two isolated worktrees from it:

```bash
git worktree add ../app-routed <commit>
```

```bash
git worktree add ../app-baseline <commit>
```

3. In a session in `../app-routed`:

```
/quality-router on
/quality-router experiment start pull-refresh routed spec="pull-to-refresh on OrdersList" start=<commit> validation="xcodebuild test" env="iPhone 16 sim, Xcode 26"
```

   Do the task and let the agent run the checks, then run `/quality-router experiment stop`.

4. In a session in `../app-baseline`, run `/quality-router off`, then the same `experiment start` line with `baseline` instead of `routed`. Give the same prompt, then run `experiment stop`.
5. Run `/quality-router experiment report pull-refresh`. It shows, per run on average:
   - per-category token differences (negative means routing used more),
   - classifier overhead, retries, escalations and duration,
   - validation outcomes for both arms.

   If any declared condition differs, it says *No comparable baseline*. If the routed run failed validation where the baseline passed, it says this is not a successful optimization.

Each arm makes paid model calls of its own. One run per arm is noisy, so repeat to see a trend.

## What not to conclude

- Section B is an estimate at list prices for the same token volumes. It isn't what the baseline model would have spent, and it isn't subscription quota.
- The weekly-limit date is an extrapolation of provider readings, not a promise.
- A stronger review doesn't guarantee correctness, and the router never labels work verified because an agent said it succeeded.
