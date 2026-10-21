import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { checks } from "./checks/index.ts";
import { renderComment, renderLine } from "./core/comment.ts";
import { ConfigError, resolveApiKey, resolveConfig } from "./core/config.ts";
import { formatError } from "./core/errors.ts";
import { createGitHubClient, type IssueClient } from "./core/github.ts";
import {
  createClefClient,
  createRecordedClient,
  createTypeSafeClient,
  isClefModel,
  type ModelClient,
} from "./core/model.ts";
import { applyReport, parseIssue, runTriage } from "./core/runner.ts";
import { buildState } from "./core/state.ts";
import type { Issue, Report, ResolvedConfig } from "./core/types.ts";
import { runEval } from "./eval/eval.ts";

const USAGE = `rolldown-triager CLI

  pnpm cli state  --issue N [--repo owner/repo]        parsed sections, links, flags and the exact model state
  pnpm cli run    --issue N [--apply] [--force] [--json] dry-run by default; --apply writes labels/comment
  pnpm cli record --issue N [--issue M ...]             save issue JSON + model answers under test/fixtures
  pnpm cli eval   [--since YYYY-MM-DD] [--limit N] [--sweep] [--include-untriaged]  replay triaged issues, print agreement

  Shared: --repo (default rolldown/rolldown) --checks --modes --options --labels --thresholds --comment --model
  Env:    GH_TOKEN or GITHUB_TOKEN (else \`gh auth token\`), TYPESAFE_API_KEY or JEV_KEY
          --model clef|clef-flash: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID instead of the TypeSafe key
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    issue: { type: "string", multiple: true, short: "i" },
    repo: { type: "string", default: "rolldown/rolldown" },
    apply: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    checks: { type: "string" },
    modes: { type: "string" },
    options: { type: "string" },
    labels: { type: "string" },
    thresholds: { type: "string" },
    comment: { type: "string" },
    model: { type: "string" },
    answers: { type: "string", default: "test/fixtures/answers" },
    since: { type: "string" },
    limit: { type: "string" },
    sweep: { type: "boolean", default: false },
    "include-untriaged": { type: "boolean", default: false },
    cache: { type: "string", default: ".cache/eval" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function githubToken(): string {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("no GitHub token: set GH_TOKEN or log in with `gh auth login`");
  }
}

function typesafeKey(): string {
  return resolveApiKey(
    process.env.TYPESAFE_API_KEY ?? process.env.JEV_KEY,
    "a TypeSafe key (TYPESAFE_API_KEY, or JEV_KEY in .env)",
  );
}

/** The model name picks the provider: `clef` / `clef-flash` run on Workers AI, anything else on TypeSafe. */
function liveClient(model: string): ModelClient {
  if (!isClefModel(model)) return createTypeSafeClient(typesafeKey());
  return createClefClient(
    resolveApiKey(
      process.env.CLOUDFLARE_API_TOKEN,
      "a Cloudflare API token (CLOUDFLARE_API_TOKEN)",
    ),
    resolveApiKey(
      process.env.CLOUDFLARE_ACCOUNT_ID,
      "a Cloudflare account id (CLOUDFLARE_ACCOUNT_ID)",
    ),
  );
}

function issueNumbers(): number[] {
  const numbers = (values.issue ?? []).map((s) => Number.parseInt(s, 10));
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error("pass at least one --issue N");
  }
  return numbers;
}

function config(): ResolvedConfig {
  return resolveConfig({
    checks: values.checks,
    modes: values.modes,
    options: values.options,
    labels: values.labels,
    thresholds: values.thresholds,
    comment: values.comment,
    model: values.model,
  });
}

function printReport(report: Report, cfg: ResolvedConfig): void {
  const { issue } = report;
  console.log(`#${issue.number} ${issue.title}\n  ${issue.htmlUrl}`);
  if (report.shortCircuit) console.log(`  short-circuit: ${report.shortCircuit}`);
  console.log(
    `  kind: ${report.kind} (from ${report.kindSource}${report.kindConfidence === null ? "" : `, ${report.kindConfidence.toFixed(2)}`})` +
      ` · template followed: ${report.flags.templateFollowed} · runnable links: ${report.flags.runnableLinks.length}` +
      ` · priority words: ${report.flags.priorityWords}`,
  );
  console.log(
    `  model: ${report.model ?? "none"} · questions: ${report.questionsAsked} · tokens: ${report.usage ? `${report.usage.input_tokens} in` : "0"}`,
  );
  for (const r of report.results)
    console.log(`  ${renderLine(r, cfg.labels).replace(/^- /, "")} [${r.effective}]`);
  console.log(`  labels: +[${report.plan.add.join(", ")}] -[${report.plan.remove.join(", ")}]`);
}

async function cmdState(gh: IssueClient): Promise<void> {
  for (const n of issueNumbers()) {
    const issue = await gh.getIssue(n);
    const { kind, kindSource, ...parsed } = parseIssue(issue);
    const { state, flags } = buildState(issue, parsed, kind);
    console.log(
      JSON.stringify(
        {
          number: n,
          template: parsed.template,
          kind,
          kindSource,
          requiredMissing: parsed.requiredMissing,
          links: parsed.links,
          flags,
          stateChars: JSON.stringify(state).length,
          state,
        },
        null,
        2,
      ),
    );
  }
}

async function cmdRun(gh: IssueClient): Promise<void> {
  const cfg = config();
  const client: ModelClient = values.offline
    ? createRecordedClient(values.answers)
    : liveClient(cfg.model);
  const dryRun = !values.apply;
  for (const n of issueNumbers()) {
    const issue = await gh.getIssue(n);
    const report = await runTriage({
      issue,
      config: cfg,
      client,
      checks,
      force: values.force || dryRun,
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report, cfg);
    }
    const outcome = await applyReport(report, cfg, gh, {
      dryRun,
      commentMode: cfg.comment,
      force: values.force,
    });
    if (!values.json) {
      if (dryRun) console.log(`\n${renderComment(report, cfg.labels)}\n`);
      else
        console.log(
          `  applied: labels changed ${outcome.labelsChanged}${outcome.commentUrl ? `, comment ${outcome.commentUrl}` : ""}${outcome.skipped ? `, skipped (${outcome.skipped})` : ""}`,
        );
    }
  }
}

async function cmdRecord(gh: IssueClient): Promise<void> {
  const cfg = config();
  const live = liveClient(cfg.model);
  const issuesDir = join("test", "fixtures", "issues");
  mkdirSync(issuesDir, { recursive: true });
  for (const n of issueNumbers()) {
    const issue = await gh.getIssue(n);
    const fixture: Issue = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      typeName: issue.typeName,
      authorAssociation: issue.authorAssociation,
      labels: issue.labels,
      htmlUrl: issue.htmlUrl,
    };
    writeFileSync(join(issuesDir, `${n}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    const client = createRecordedClient(values.answers, { recordThrough: live, label: String(n) });
    const report = await runTriage({ issue, config: cfg, client, checks, force: true });
    console.log(
      `#${n}: ${report.questionsAsked} questions, kind ${report.kind}, ${report.results.map((r) => `${r.id}=${r.effective}`).join(" ")}`,
    );
  }
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const gh = createGitHubClient({ token: githubToken(), repo: values.repo });
  switch (command) {
    case "state":
      return cmdState(gh);
    case "run":
      return cmdRun(gh);
    case "record":
      return cmdRecord(gh);
    case "eval": {
      const cfg = config();
      return runEval({
        gh,
        repo: values.repo,
        config: cfg,
        client: liveClient(cfg.model),
        cacheDir: values.cache,
        since: values.since,
        limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
        sweep: values.sweep,
        includeUntriaged: values["include-untriaged"],
      });
    }
    default:
      throw new Error(`unknown command ${command}\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? `config: ${error.message}` : formatError(error);
  console.error(message);
  process.exitCode = 1;
});
