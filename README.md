# rolldown-triager

A GitHub Action that gives new [rolldown](https://github.com/rolldown/rolldown) issues a first triage pass with
[TypeSafe](https://typesafe.ai)'s Jev model: it proposes a priority, checks whether the report has a usable
reproduction, and leaves one short comment explaining what it did and why. Jev returns typed judgments and
probabilities rather than prose, so every decision here is code over numbers, and the bot can say "not sure,
leave it for a human".

## What it does on an issue

```
labeled needs-triage ─► fetch issue (REST, incl. native type)
                        ├─ parse the form sections; find repro links; decode REPL hashes (code)
                        ├─ sanitize into a small `state` object (no labels, author, comments, dates)
                        ├─ ask every enabled check's questions in ONE Jev request
                        ├─ each check decides from its own answers → label slots + a note
                        ├─ policy applies the invariants (below) → label plan
                        └─ PUT labels once; upsert one comment; write the step summary
```

Checks shipped:

| check            | asks                                                                                                                                                                                                                                              | outcome                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reproduction`   | nothing when a runnable link (REPL, StackBlitz, CodeSandbox, vite.new, gist, GitHub repo) is found in code, or when the body is essentially empty; otherwise `runnable`, `self_evident`, a 4-level `repro_quality` score, and `explains_no_repro` | adds `needs-reproduction` when there is nothing a maintainer could run, the report carries no evidence they could start from, and the reporter gives no concrete reason a live repro is impossible |
| `priority`       | bugs: unusable? via Vite? regression? common setup? workaround? argues its own priority? — features: named framework blocked? usefulness (3 levels)                                                                                               | `p1` / `p2` / `p3`, or abstains when an axis on the taken path is in the unsure band; never `p0`                                                                                                   |
| `has-workaround` | reuses the `workaround` question                                                                                                                                                                                                                  | `has workaround` (suggest-only by default; exists to show how small a check is)                                                                                                                    |

Invariants live in one place (`src/core/policy.ts`) so every check inherits them: `p0` is never applied;
applying any `p*` removes `needs-triage`; nothing else is ever removed; an issue that already carries a `p*`
was decided by a human, so priority becomes suggest-only; a kind the model guessed with low confidence
blocks labels; a report that argues its own priority ("this is a P0") is suggest-only.

Checks do not suppress one another. A missing reproduction means the report is hard to verify, not that the
problem is less severe, so it no longer holds back a priority — a maintainer corrects a wrong priority in one
click, whereas one that was never applied is invisible.

## Using it

```yaml
# .github/workflows/triage.yml — see examples/rolldown-triage.yml for the full file
on:
  issues:
    types: [opened, labeled] # `labeled` for templated issues, `opened` for blank ones
jobs:
  triage:
    if: github.event.label.name == 'needs-triage'
    permissions:
      issues: write
    steps:
      - uses: IWANABETHATGUY/rolldown-triager@0ae1023269a92555b6d7a2acb65dacf689c9ebe4 # v0.9.1
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          modes: priority=suggest,reproduction=suggest # shadow mode first
```

Re-run on an issue by re-adding `needs-triage`. Manual labels always win: the bot never removes anything but
`needs-triage`, and never touches an issue that already has a priority.

Inputs (all optional except the key): `token`, `repository`, `issue-number`, `checks` (default
`reproduction,priority`), `modes` (`check=apply|suggest|off`), `options` (JSON per check, e.g.
`{"priority":{"applyLabels":["p2","p3"]}}`), `labels` (JSON overrides for label names), `thresholds` (JSON),
`comment` (`never` by default / `when-needed` / `when-acting` / `always`), `model` (pinned `jev-1.13.0`),
`dry-run`. Outputs: `report`
(JSON), `priority`, `needs-reproduction`, `comment-url`. See `action.yml`.

The bot does not comment by default (`comment: never`) — the labels are the outcome and the full report,
with every probability, goes to the job summary. One consequence to plan for: labels written with the default
`GITHUB_TOKEN` do not trigger other workflows, so under `never` a `needs-reproduction` reaches the reporter as
a bare label and a 14-day clock. Pass a GitHub App token as `token` so the repository's own comment automation
fires, or set `comment: when-needed` to have this bot carry the request itself.

## Measured against maintainers

`pnpm cli eval --since 2026-03-01` replays every issue that carried `needs-triage` since March through the
bot and compares with the labels maintainers ended up with (95 issues on 2026-09-22; answers cached under
`.cache/eval`, so re-running with different thresholds or decision code is free):

- **Reproduction**, re-measured on the 100 most recent issues, against the union of an independent read of
  every issue and the labels maintainers actually applied: **precision 1.00, recall 1.00**. Issues filed by
  the team are skipped outright — not one true case came from them, and they supplied both false positives — it flags 15 of 100 and catches all 6 the maintainers labelled. Against those 6 alone precision is
  0.40; the other 9 are issues with no reproduction that maintainers closed or fixed rather than chased, so
  read 0.40 as a floor. The decision rests on `runnable` (is there anything to run) rather than on how well
  the report is written: the previous prose-quality rubric scored unrunnable reports 1.1-2.6 out of 3 and
  fired **zero** times on the same 100 issues.
- **Priority, bugs** (54): agrees with maintainers on 57% of the issues it decides, decides 81%; p1 precision
  12/21. **Features** (25): 40%. That is why `priority` defaults to `suggest`.

Crash reports take a separate branch, because a panic is always an unusable build and the Vite/regression
axes cannot separate them. Over the 40 panics rolldown has prioritised, sorting on how ordinary the
conditions reaching the crash are gives 60% exact against 32% for the general tree (p1 precision 57%, p2 70%,
p3 reachable at all for the first time) — at 62% coverage rather than 78%.

A crash the model cannot place falls back to p1 (`options.priority.panicFallback`, `"off"` to abstain
instead). Those cases cluster at the p1/p2 boundary, where a high reach score means ordinary conditions means
severe, so on the measured set 73% of them are p0 or p1: p1 is right 47% of the time against 20% for p2, and
errs toward over-rating. Coverage 62%→95%, exact over the 40 38%→52%.

The bug mapping deliberately deviates from the literal `.github/issue-workflow.md` tree, which sends every
unusable build to p1 and over-predicts p1 about 2:1: here an unusable build is p1 when it is reached through
Vite or is a regression, p2 otherwise; usable builds are p3 with a workaround, p2 without.

## Adding a check

One file plus one entry in `src/checks/index.ts`:

```ts
export const myCheck = defineCheck({
  id: "my-check", // prefixes its question keys
  defaultMode: "suggest",
  questions: (ctx) => (ctx.kind === "bug" ? { thing: noul("Does the report …?") } : null),
  decide: (answers, ctx) => {
    const v = answers.noul("thing");
    if (v === undefined) return { status: "abstained", note: "no answer" };
    return v >= ctx.config.thresholds.noulYes
      ? { status: "decided", add: ["hasWorkaround"], note: "…", evidence: { thing: v } }
      : { status: "decided", add: [], note: "…" };
  },
});
```

Questions are batched with everyone else's into the same request; the check only sees its own answers;
policy applies the invariants. Question text and thresholds live in `src/questions/` and `src/core/config.ts`.

## Development

```
pnpm install
pnpm lint · pnpm typecheck · pnpm test         # oxlint + oxfmt, tsgo, vitest (offline, recorded answers)
pnpm cli state --issue N                       # parsed sections, links, flags, and the exact model state
pnpm cli run --issue N [--apply]               # dry run by default; --apply writes labels + comment
pnpm cli record --issue N …                    # refresh test fixtures (needs JEV_KEY / TYPESAFE_API_KEY)
pnpm cli eval --since 2026-03-01 [--sweep]     # agreement metrics; --sweep tries threshold grids
pnpm build                                     # dist/index.js; built again and tagged by release.yml
```

Put the key in `.env` as `JEV_KEY` (or `TYPESAFE_API_KEY`). Changing question text or sanitizing changes the
request hash, so recorded answers go stale on purpose — re-record with `pnpm cli record`.
