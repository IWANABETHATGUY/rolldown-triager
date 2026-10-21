import { appendFileSync } from "node:fs";

import { checks } from "./checks/index.ts";
import { renderSummary } from "./core/comment.ts";
import { ConfigError, resolveApiKey, resolveConfig } from "./core/config.ts";
import { formatError } from "./core/errors.ts";
import { createGitHubClient } from "./core/github.ts";
import { PRIORITY_SLOTS, type ResolvedConfig } from "./core/types.ts";
import { createTypeSafeClient } from "./core/model.ts";
import { applyReport, runTriage } from "./core/runner.ts";
import type { Report } from "./core/types.ts";

// GitHub Actions entry point. Inputs arrive as INPUT_<NAME> env vars, outputs
// go to $GITHUB_OUTPUT, the full report to $GITHUB_STEP_SUMMARY. Kept
// dependency-free so the committed bundle stays reviewable.

function input(name: string): string {
  return (process.env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim();
}

function appendTo(envVar: string, text: string): void {
  const file = process.env[envVar];
  if (file) appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function setOutput(name: string, value: string): void {
  const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
  appendTo("GITHUB_OUTPUT", `${name}<<${delimiter}\n${value}\n${delimiter}`);
}

function isTrue(value: string): boolean {
  return /^(true|1|yes)$/i.test(value);
}

function priorityOutput(report: Report, labels: ResolvedConfig["labels"]): string {
  // By configured name, not by a `p0`-`p3` prefix: `labels` can rename any slot,
  // and a repo calling p2 "severity: medium" used to get an empty output.
  const names = new Set(PRIORITY_SLOTS.map((slot) => labels[slot]));
  for (const r of report.results) {
    const label = r.labels.find((l) => names.has(l));
    if (label && (r.effective === "applied" || r.effective === "suggested")) return label;
  }
  return "";
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey(input("typesafe-api-key"), "`typesafe-api-key`");
  const token = input("token") || (process.env.GITHUB_TOKEN ?? "");
  if (!token) throw new ConfigError("`token` is required");
  const repo = input("repository") || (process.env.GITHUB_REPOSITORY ?? "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
    throw new ConfigError(`\`repository\` must be owner/repo, got ${JSON.stringify(repo)}`);
  const issueNumber = Number.parseInt(input("issue-number"), 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new ConfigError(
      "`issue-number` is required (defaults to the issue of an `issues` event)",
    );
  }
  const dryRun = isTrue(input("dry-run"));

  const config = resolveConfig({
    checks: input("checks"),
    modes: input("modes"),
    options: input("options"),
    labels: input("labels"),
    thresholds: input("thresholds"),
    comment: input("comment"),
    model: input("model"),
  });

  const gh = createGitHubClient({ token, repo });
  const client = createTypeSafeClient(apiKey);
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  console.log(`::group::rolldown-triager on ${repo}#${issueNumber}${dryRun ? " (dry run)" : ""}`);
  const issue = await gh.getIssue(issueNumber);
  const report = await runTriage({ issue, config, client, checks });
  for (const r of report.results) {
    console.log(
      `${r.id}: ${r.effective}${r.labels.length ? ` ${r.labels.join(", ")}` : ""}${r.downgradedBecause.length ? ` (${r.downgradedBecause.join("; ")})` : ""}`,
    );
  }
  console.log(`labels: +[${report.plan.add.join(", ")}] -[${report.plan.remove.join(", ")}]`);
  const outcome = await applyReport(report, config, gh, {
    dryRun,
    commentMode: config.comment,
    ...(runUrl ? { meta: { runUrl } } : {}),
  });
  console.log("::endgroup::");

  if (report.shortCircuit === "already-triaged" || outcome.skipped === "already-triaged") {
    console.log(
      `::notice::#${issueNumber} no longer carries ${config.labels.needsTriage}; nothing done`,
    );
  } else if (outcome.skipped === "dry-run") {
    console.log(
      `::notice::dry run; would set labels +[${report.plan.add.join(", ")}] -[${report.plan.remove.join(", ")}]`,
    );
  } else if (outcome.labelsChanged) {
    console.log(`::notice::labels now [${(outcome.finalLabels ?? []).join(", ")}]`);
  }

  appendTo("GITHUB_STEP_SUMMARY", renderSummary(report, config.labels));
  setOutput("report", JSON.stringify(report));
  setOutput("priority", priorityOutput(report, config.labels));
  setOutput(
    "needs-reproduction",
    String(
      report.results.some(
        (r) => r.labels.includes(config.labels.needsReproduction) && r.effective !== "skipped",
      ),
    ),
  );
  setOutput("comment-url", outcome.commentUrl ?? "");
}

main().catch((error: unknown) => {
  console.log(`::error::${formatError(error)}`);
  process.exitCode = 1;
});
