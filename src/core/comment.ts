import type { CheckResult, LabelNames, Report } from "./types.ts";
import { PRIORITY_SLOTS } from "./types.ts";

// One comment per issue, found again by MARKER and edited in place. Plain and
// short; it never quotes the issue, so nothing in the body is reflected back.

export const MARKER = "<!-- rolldown-triager -->";

export interface CommentMeta {
  runUrl?: string;
  version?: string;
}

/** Text added when a label is *applied*; the reporter needs to know what to do next. */
const APPLIED_ADVICE: Partial<Record<keyof LabelNames, string>> = {
  needsReproduction:
    "Please add a REPL, StackBlitz or repository link; the label closes the issue after 14 days without activity.",
};

function code(label: string): string {
  return `\`${label}\``;
}

function evidenceOf(result: CheckResult): string {
  const v = result.verdict;
  if (v.status === "skipped" || !v.evidence) return "";
  const parts = Object.entries(v.evidence).map(([k, val]) => `${k} ${val}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export function renderLine(result: CheckResult, labels: LabelNames): string {
  const v = result.verdict;
  const head = `- ${result.id}:`;
  if (v.status === "skipped" || result.effective === "skipped") {
    return `${head} skipped (${v.status === "skipped" ? v.reason : "off"})`;
  }
  if (v.status === "abstained") return `${head} ${v.note}${evidenceOf(result)}`;

  const parts: string[] = [];
  if (result.labels.length > 0) {
    const verb = result.effective === "applied" ? "set" : "suggest";
    const removed =
      result.effective === "applied" &&
      result.labels.some((l) => PRIORITY_SLOTS.some((slot) => labels[slot] === l))
        ? `, removed ${code(labels.needsTriage)}`
        : "";
    parts.push(`${verb} ${result.labels.map(code).join(", ")}${removed} — ${v.note}`);
  } else {
    parts.push(v.note);
  }
  if (v.humanNote) parts.push(`; ${v.humanNote}`);
  let line = `${head} ${parts.join("")}${evidenceOf(result)}`;
  if (result.effective === "applied") {
    for (const [slot, advice] of Object.entries(APPLIED_ADVICE)) {
      if (result.labels.includes(labels[slot as keyof LabelNames])) line += ` ${advice}`;
    }
  }
  if (result.effective === "suggested" && result.downgradedBecause.length > 0) {
    line += ` [not applied: ${result.downgradedBecause.join("; ")}]`;
  }
  return line;
}

export function renderComment(report: Report, labels: LabelNames, meta: CommentMeta = {}): string {
  const model = report.model ?? "no model call";
  const lines = [
    MARKER,
    `Automated triage by rolldown-triager (${model}). A maintainer will confirm.`,
    "",
    ...report.results.map((r) => renderLine(r, labels)),
    "",
  ];
  const footer = [`Re-run: re-add ${code(labels.needsTriage)}. Manual labels win.`];
  if (meta.runUrl) footer.push(`[run](${meta.runUrl})`);
  lines.push(footer.join(" "));
  return lines.join("\n");
}

/** Everything, for `$GITHUB_STEP_SUMMARY`. */
export function renderSummary(report: Report, labels: LabelNames): string {
  const rows = report.results.map((r) => {
    const v = r.verdict;
    const note = v.status === "skipped" ? v.reason : v.note;
    const evidence =
      v.status !== "skipped" && v.evidence
        ? Object.entries(v.evidence)
            .map(([k, x]) => `${k}=${x}`)
            .join(", ")
        : "";
    return `| ${r.id} | ${r.mode} | ${r.effective} | ${r.labels.map(code).join(", ")} | ${note} | ${evidence} | ${r.downgradedBecause.join("; ")} |`;
  });
  const usage = report.usage
    ? `${report.usage.input_tokens} in / ${report.usage.output_tokens} out`
    : "—";
  return [
    `## rolldown-triager: [#${report.issue.number}](${report.issue.htmlUrl}) ${report.issue.title}`,
    "",
    report.shortCircuit ? `Short-circuit: **${report.shortCircuit}**` : "",
    `- kind: **${report.kind}** (from ${report.kindSource}${report.kindConfidence === null ? "" : `, confidence ${report.kindConfidence.toFixed(2)}`})`,
    `- model: ${report.model ?? "none"} · questions: ${report.questionsAsked} · tokens: ${usage}`,
    `- flags: template followed ${report.flags.templateFollowed}, runnable links ${report.flags.runnableLinks.length}, priority words ${report.flags.priorityWords}, truncated [${report.flags.truncated.join(", ")}]`,
    `- labels: add [${report.plan.add.map(code).join(", ")}] remove [${report.plan.remove.map(code).join(", ")}]`,
    "",
    "| check | mode | result | labels | note | evidence | downgraded |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "```",
    renderComment(report, labels),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
