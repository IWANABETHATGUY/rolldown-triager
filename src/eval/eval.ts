import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checks } from "../checks/index.ts";
import type { IssueClient, ListedIssue } from "../core/github.ts";
import { createRecordedClient, type ModelClient } from "../core/model.ts";
import { runTriage } from "../core/runner.ts";
import type { PrioritySlot, Report, ResolvedConfig, Thresholds } from "../core/types.ts";
import { PRIORITY_SLOTS } from "../core/types.ts";
import { Confusion, pct, precisionRecall } from "./metrics.ts";

// Replays historically triaged issues through the bot and compares its
// decisions with what maintainers did. Answers are cached by request hash, so
// a re-run with different thresholds or decision code costs nothing.

export interface EvalOptions {
  gh: IssueClient;
  repo: string;
  config: ResolvedConfig;
  client: ModelClient;
  cacheDir: string;
  since?: string | undefined;
  limit?: number | undefined;
  sweep: boolean;
  /** Also score issues that never carried `needs-triage` (maintainer-filed); the bot never sees those. */
  includeUntriaged?: boolean;
}

interface Sample {
  issue: ListedIssue;
  truthPriority: PrioritySlot | null;
  truthNeedsRepro: boolean;
}

interface Prediction {
  priority: PrioritySlot | "abstain";
  priorityApplied: boolean;
  needsRepro: "yes" | "no" | "abstain";
  argues: boolean;
  kind: string;
}

type Row = { s: Sample; p: Prediction };

function slotOf(labels: string[], names: ResolvedConfig["labels"]): PrioritySlot | null {
  for (const slot of PRIORITY_SLOTS) if (labels.includes(names[slot])) return slot;
  return null;
}

async function collect(options: EvalOptions): Promise<Sample[]> {
  const { gh, config, cacheDir } = options;
  const limit = options.limit ?? 250;
  const perLabel = Math.ceil(limit / 4);
  // Namespaced by repo: event histories keyed on issue number alone were
  // reused across repositories that share issue numbers.
  const dir = join(cacheDir, "issues", options.repo.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  const seen = new Map<number, Sample>();

  const wanted = [
    config.labels.p1,
    config.labels.p2,
    config.labels.p3,
    config.labels.needsReproduction,
  ];
  for (const label of wanted) {
    const listed = await gh.listIssues({ label, since: options.since, limit: perLabel });
    for (const issue of listed) {
      if (seen.has(issue.number)) continue;
      if (options.since && issue.createdAt < options.since) continue;
      const evFile = join(dir, `${issue.number}.events.json`);
      let everAdded: string[];
      if (existsSync(evFile)) {
        everAdded = JSON.parse(readFileSync(evFile, "utf8")) as string[];
      } else {
        everAdded = await gh.listLabelsEverAdded(issue.number);
        writeFileSync(evFile, JSON.stringify(everAdded));
      }
      writeFileSync(join(dir, `${issue.number}.json`), JSON.stringify(issue));
      const ever = (name: string): boolean =>
        everAdded.includes(name) || issue.labels.includes(name);
      if (!options.includeUntriaged && !ever(config.labels.needsTriage)) continue;
      seen.set(issue.number, {
        issue,
        truthPriority: slotOf(issue.labels, config.labels),
        truthNeedsRepro: ever(config.labels.needsReproduction),
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.issue.number - a.issue.number);
}

function predict(report: Report, config: ResolvedConfig): Prediction {
  const priority = report.results.find((r) => r.id === "priority");
  const repro = report.results.find((r) => r.id === "reproduction");
  const priorityNames = new Set(PRIORITY_SLOTS.map((slot) => config.labels[slot]));
  const pLabel = priority?.labels.find((l) => priorityNames.has(l));
  const pSlot = pLabel ? (PRIORITY_SLOTS.find((s) => config.labels[s] === pLabel) ?? null) : null;
  const arguesEvidence =
    priority?.verdict.status !== "skipped"
      ? priority?.verdict.evidence?.["argues priority"]
      : undefined;
  return {
    priority: pSlot ?? "abstain",
    priorityApplied: priority?.effective === "applied",
    needsRepro:
      repro?.verdict.status === "decided"
        ? repro.labels.includes(config.labels.needsReproduction)
          ? "yes"
          : "no"
        : "abstain",
    argues:
      report.flags.priorityWords ||
      (typeof arguesEvidence === "number" && arguesEvidence >= config.thresholds.arguesPriority),
    kind: report.kind,
  };
}

async function evaluate(
  samples: Sample[],
  options: EvalOptions,
  thresholds: Thresholds,
): Promise<Map<number, Prediction>> {
  const config: ResolvedConfig = {
    ...options.config,
    thresholds,
    // What would the bot do on a fresh issue? Apply everything, so `effective` is informative.
    modes: { ...options.config.modes, reproduction: "apply", priority: "apply" },
  };
  const out = new Map<number, Prediction>();
  for (const sample of samples) {
    // One directory per model: recordings are files named by issue number, so a
    // second model in the same directory overwrote the first one's answers.
    const client = createRecordedClient(join(options.cacheDir, "answers", config.model), {
      recordThrough: options.client,
      label: String(sample.issue.number),
    });
    // Strip the human's decision so the policy does not defer to it.
    const labels = sample.issue.labels.filter(
      (l) =>
        !PRIORITY_SLOTS.some((s) => config.labels[s] === l) &&
        l !== config.labels.needsReproduction,
    );
    const issue = { ...sample.issue, labels: [...new Set([config.labels.needsTriage, ...labels])] };
    const report = await runTriage({ issue, config, client, checks, force: true });
    out.set(sample.issue.number, predict(report, config));
  }
  return out;
}

function reproStats(bugs: Row[]): { tp: number; fp: number; fn: number } {
  return {
    tp: bugs.filter((r) => r.s.truthNeedsRepro && r.p.needsRepro === "yes").length,
    fp: bugs.filter((r) => !r.s.truthNeedsRepro && r.p.needsRepro === "yes").length,
    fn: bugs.filter((r) => r.s.truthNeedsRepro && r.p.needsRepro !== "yes").length,
  };
}

function summarize(samples: Sample[], predictions: Map<number, Prediction>, title: string): string {
  const lines: string[] = [`### ${title}`, ""];
  const rows: Row[] = samples.map((s) => ({ s, p: predictions.get(s.issue.number) as Prediction }));

  const withTruth = rows.filter((r) => r.s.truthPriority && r.s.truthPriority !== "p0");
  for (const [name, subset] of [
    ["all", withTruth],
    ["bugs", withTruth.filter((r) => r.p.kind === "bug")],
    ["features", withTruth.filter((r) => r.p.kind === "feature")],
  ] as const) {
    const c = new Confusion(["p1", "p2", "p3"], ["p1", "p2", "p3", "abstain"]);
    for (const { s, p } of subset) c.add(s.truthPriority as string, p.priority);
    const acc = c.accuracy(["p1", "p2", "p3"]);
    const applied = subset.filter((r) => r.p.priorityApplied);
    const appliedCorrect = applied.filter((r) => r.p.priority === r.s.truthPriority).length;
    lines.push(
      `**Priority (${name}, n=${subset.length})** — agreement on decided ${pct(acc.correct, acc.decided)}, coverage ${pct(acc.decided, subset.length)}, would-apply ${pct(applied.length, subset.length)} with agreement ${pct(appliedCorrect, applied.length)}`,
      "",
      c.table(),
      "",
    );
  }

  const bugs = rows.filter((r) => r.p.kind === "bug");
  const { tp, fp, fn } = reproStats(bugs);
  const list = (pred: (r: Row) => boolean): string =>
    bugs
      .filter(pred)
      .map((r) => `#${r.s.issue.number}`)
      .join(" ") || "none";
  lines.push(
    `**Reproduction (bugs, n=${bugs.length}, ${bugs.filter((r) => r.s.truthNeedsRepro).length} ever needs-reproduction)** — ${precisionRecall(tp, fp, fn)}; abstained on ${bugs.filter((r) => r.s.truthNeedsRepro && r.p.needsRepro === "abstain").length} positives and ${bugs.filter((r) => !r.s.truthNeedsRepro && r.p.needsRepro === "abstain").length} negatives`,
    "",
    `- would label (correct): ${list((r) => r.s.truthNeedsRepro && r.p.needsRepro === "yes")}`,
    `- would label (maintainers did not): ${list((r) => !r.s.truthNeedsRepro && r.p.needsRepro === "yes")}`,
    `- missed: ${list((r) => r.s.truthNeedsRepro && r.p.needsRepro !== "yes")}`,
    "",
    `**Argues own priority:** ${pct(rows.filter((r) => r.p.argues).length, rows.length)}`,
    "",
  );
  return lines.join("\n");
}

export async function runEval(options: EvalOptions): Promise<void> {
  const samples = await collect(options);
  console.log(
    `## rolldown-triager eval on ${options.repo} — ${samples.length} issues${options.since ? ` since ${options.since}` : ""}${options.includeUntriaged ? "" : " that carried needs-triage"}\n`,
  );
  const counts = { p1: 0, p2: 0, p3: 0, needsRepro: 0 };
  for (const s of samples) {
    if (s.truthPriority && s.truthPriority in counts)
      counts[s.truthPriority as keyof typeof counts]++;
    if (s.truthNeedsRepro) counts.needsRepro++;
  }
  console.log(
    `Ground truth: p1 ${counts.p1}, p2 ${counts.p2}, p3 ${counts.p3}, ever needs-reproduction ${counts.needsRepro}\n`,
  );

  const base = await evaluate(samples, options, options.config.thresholds);
  console.log(summarize(samples, base, `Thresholds ${JSON.stringify(options.config.thresholds)}`));

  if (options.sweep) {
    console.log(
      "### Sweep\n\n| noulYes | reproLow | reproConfidence | priority agreement (decided) | coverage | repro precision/recall |\n| --- | --- | --- | --- | --- | --- |",
    );
    for (const noulYes of [0.6, 0.7, 0.75, 0.8, 0.9]) {
      for (const reproLow of [1, 1.5, 2]) {
        for (const reproConfidence of [0.5, 0.7, 0.9]) {
          const thresholds: Thresholds = {
            ...options.config.thresholds,
            noulYes,
            noulNo: Number((1 - noulYes).toFixed(2)),
            reproLow,
            reproConfidence,
          };
          const preds = await evaluate(samples, options, thresholds);
          const rows: Row[] = samples.map((s) => ({
            s,
            p: preds.get(s.issue.number) as Prediction,
          }));
          const withTruth = rows.filter((r) => r.s.truthPriority && r.s.truthPriority !== "p0");
          const decided = withTruth.filter((r) => r.p.priority !== "abstain");
          const correct = decided.filter((r) => r.p.priority === r.s.truthPriority).length;
          const { tp, fp, fn } = reproStats(rows.filter((r) => r.p.kind === "bug"));
          console.log(
            `| ${noulYes} | ${reproLow} | ${reproConfidence} | ${pct(correct, decided.length)} | ${pct(decided.length, withTruth.length)} | ${precisionRecall(tp, fp, fn)} |`,
          );
        }
      }
    }
  }
}
