# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GitHub Action (plus a local CLI over the same core) that triages new rolldown issues with TypeSafe's Jev
model: one batched request per issue, code decides, one comment, labels applied under strict invariants.
README.md has the user-facing description and the measured accuracy; this file is about working in the code.

## Commands

```
pnpm install                       # pnpm 10 via corepack (packageManager field)
pnpm lint                          # oxlint + oxfmt --check   (pnpm fmt fixes both)
pnpm typecheck                     # tsgo --noEmit; erasableSyntaxOnly is on (see below)
pnpm test                          # vitest, fully offline (recorded answers in test/fixtures/answers)
pnpm test -- test/priority.test.ts # one file;  pnpm test -- -t "unsure band"  for one test name
pnpm build                         # node build.ts → dist/index.js (rolldown, everything bundled but node builtins)
pnpm cli state|run|record|eval ... # loads .env (JEV_KEY or TYPESAFE_API_KEY); GitHub token from gh auth
```

`pnpm cli run --issue N` is a dry run and forces the run even without `needs-triage`; `--apply` writes for
real and then respects the label. Only `record` and `eval` (first time) spend Jev tokens; both are cheap.
`--model clef` or `--model clef-flash` runs on Cloudflare's Clef instead (`createClefClient`, same System One
shapes; needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). CLI only for now: the thresholds are tuned
on Jev, and the eval keeps a separate answer cache per model so the two can be compared.

## Architecture

**One request per issue.** `src/core/runner.ts` collects `questions(ctx)` from every enabled check, prefixes
keys with `${check.id}:`, adds `core:kind` only when the issue kind is unknown, and makes a single
`systemOne` call. Extra questions are nearly free and answers are independent, so checks never need a
second round trip. Each check then gets `answersFor(id)` — its own keys, prefix stripped — and returns a
`Verdict` of label _slots_ (`p2`, `needsReproduction`), never label names.

**Checks are the extension seam** (`src/core/types.ts` `Check`, `src/checks/`). A check is `questions(ctx)`

- `decide(answers, ctx)`; it knows nothing about other checks, modes, or label names. `questions` returning
  `null` means "not applicable", `{}` means "decide without the model" (reproduction does this when a runnable
  link was found in code). Question text lives in `src/questions/` and is shared (has-workaround reuses
  `bugQuestions.workaround`).

**Every invariant is in `src/core/policy.ts`** — never p0, `p*` ⇒ remove `needs-triage`, only
`needs-triage` is ever removed, existing `p*` ⇒ suggest, model-guessed kind with low confidence ⇒ suggest, `forceSuggest` from a check ⇒ suggest, per-check
`mode`. Add a rule there, not in a check.

**Deterministic first, model second.** `parse.ts` (form sections from `### ` headings, template detection,
required fields), `links.ts` (repro links by host; REPL hashes decoded by `repl.ts`, a port of the
`rolldown-repl` skill decoder), `detectKind` (native issue `type` › template › title prefix) all run before
any question is written. `sanitize.ts` + `state.ts` build the _only_ thing the model sees: title, kind, template,
capped sections. Labels, author, comments, dates, and the link list are never sent — Jev's accuracy drops
with irrelevant state, and issue bodies are attacker-controlled (a report saying "P0 blocker" only trips
`argues_priority`, which forces suggest).

**Checks never suppress each other.** A missing reproduction says the report is hard to verify; it says
nothing about how severe the problem is, and the two used to be conflated — a `gating` flag downgraded every
other check when reproduction failed _or was merely unsure_, throwing away 19 of 40 confident priorities on a
100-issue sample. `verdict.gate` is still reported in the summary; it no longer changes what gets applied. A
maintainer fixes a wrong priority in one click, so the cost of offering one is far below the cost of silence.

**The reproduction check turns on runnability, not writing quality.** `runnable` asks whether a maintainer
could run the report as written; `self_evident` asks whether the report settles _both_ the defect and the
correct behaviour — not merely where the fault is. A panic naming a file and line localises the crash but
never says whether the input should have been rejected or supported, so it is explicitly `not_for`; an
earlier draft accepted it and waved through reports with no reproduction at all — that axis is what keeps precision at
1.00, and every false positive before it existed was a report of that shape. A body under 80 characters with
no link is labelled in code, without the model, and an issue whose `author_association` is OWNER/MEMBER/
COLLABORATOR is skipped entirely (`options.reproduction.skipAuthors`) — a maintainer filing a roadmap issue
is not a reporter who forgot a repro. Together those two give precision 1.00 / recall 1.00 on the 100-issue
set; treat that as fitted, not as a result. Re-tune with `pnpm cli run --json` over a labelled set and
compare against `.cache/compare/`; do not tune `repro_quality`, which is now only a secondary gate.

**Crashes get their own priority branch** (`src/questions/panic.ts`, `decidePanic`). Every panic is
`broken: yes`, so the general tree could only reach p1/p2 through `via_vite`/`regression` — both read low for
CLI, plugin and dev-engine crashes — and p3 was structurally unreachable. Measured over the 40 panics
rolldown has prioritised (`.cache/panics/truth.tsv`), that collapsed 21 of 31 decisions onto p2 at 32% exact.
The branch sorts on how _ordinary the conditions reaching the crash are_, not how violent it is: 60% exact,
p1 precision 30%→57%, p2 33%→70%, p3 now reachable at all. `isPanic` matches the crash output (`panicked at`,
`SIGSEGV`), never the word — a report can discuss panics without being one. An unplaceable crash falls back
to p1 (`options.priority.panicFallback`): those abstentions are 73% p0/p1, so the fallback deliberately errs
upward. Do not change it to p2 without re-measuring — p2 scores 20% there and under-rates 11 of 15.

**Kind resolution.** When kind is unknown, priority asks both branches and reproduction asks its rubric;
`decide` uses the kind the model settled on. Still one request.

**Recorded answers.** `createRecordedClient` keys recordings by `requestHash(state, questions, model)`. Any
change to sanitizing, question text, or the model invalidates them on purpose: tests throw `FixtureStale`
until you run `pnpm cli record --issue <n>` for the 12 fixtures in `test/fixtures/issues`. The eval cache in
`.cache/eval` works the same way, so threshold and decision-code changes re-evaluate offline for free.

**Priority mapping is empirical.** `checks/priority.ts` `decideBug` is `.github/issue-workflow.md` adjusted to
what maintainers actually label (numbers in README and in `DEFAULT_MODES`' comment). If you change it, run
`pnpm cli eval --since 2026-03-01` and update both.

## Things that bite

- Node runs `src/**/*.ts` with type stripping, so no enums, namespaces, or constructor parameter properties
  (`erasableSyntaxOnly` makes typecheck catch it); imports use `.ts` extensions.
- `dist/index.js` is what the Action executes, but it is **not** on `master` — `.github/workflows/release.yml`
  builds it when a `v*` tag is pushed, commits it, and moves the tag onto that commit. So a tag is runnable
  and `master` is not; never point a workflow at a branch. `pnpm build` locally is for testing only.
- The consumer workflow triggers on `labeled` == `needs-triage`, not `opened` (templates add the label ~1 s
  after creation, so `opened` double-fires; re-adding the label is the re-run mechanism).
- `GITHUB_TOKEN` writes don't trigger rolldown's other workflows; the comment text therefore includes the
  repro request itself, and must never contain ``Issues marked with `needs-reproduction` `` (rolldown's
  comment bot greps for it and would overwrite ours).
- Labels are written with `addLabels`/`removeLabel`, never a PUT of the whole set: a PUT reverts any label
  a human changed while the model was thinking. The comment is written _before_ the labels, because removing
  `needs-triage` makes a rerun short-circuit, so a comment that failed after it could never be retried.
- The comment to edit is found by the marker _at position 0_ plus a Bot author — a reporter quoting the bot
  puts the marker in their own comment behind `> `.
- Priorities are recognised by configured label name, never by a `p0`-`p3` prefix; `labels` can rename any slot.
- The REPL hash is attacker-controlled: `inflateSync` is capped (a 10 KB URL inflates 1000x without it) and
  the version string is flattened to one short token before it reaches a comment or the job summary.
- `test/fixtures/**` is excluded from oxfmt; recordings stay byte-for-byte as captured.
- Question keys must not contain `:`; the runner uses it as the namespace separator and the API accepts it.
