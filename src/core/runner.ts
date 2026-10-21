import { answersFor } from "./answers.ts";
import { MARKER, renderComment, type CommentMeta } from "./comment.ts";
import type { IssueClient } from "./github.ts";
import type { ModelClient } from "./model.ts";
import { extractReproLinks } from "./links.ts";
import { detectKind, detectTemplate, parseSections, requiredMissing } from "./parse.ts";
import { applyPolicy, modeFor, type PolicyInput } from "./policy.ts";
import { buildState } from "./state.ts";
import type {
  AnyAnswer,
  Check,
  CommentMode,
  Ctx,
  Issue,
  Kind,
  KindSource,
  ParsedIssue,
  Report,
  ResolvedConfig,
} from "./types.ts";
import { PRIORITY_SLOTS } from "./types.ts";
import { kindQuestion } from "../questions/kind.ts";

import type { Questions } from "@typesafe-ai/sdk";

export interface RunInput {
  issue: Issue;
  config: ResolvedConfig;
  client: ModelClient;
  /** All registered checks; `config.checks` picks and orders the enabled ones. */
  checks: Check[];
  /** Run even when `needs-triage` is absent (local dry-runs, evals). */
  force?: boolean;
}

const KIND_KEY = "core:kind";

export function selectChecks(all: Check[], config: ResolvedConfig): Check[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  return config.checks.map((id) => {
    const check = byId.get(id);
    if (!check)
      throw new Error(
        `unknown check ${JSON.stringify(id)}; available: ${[...byId.keys()].join(", ")}`,
      );
    return check;
  });
}

export function parseIssue(issue: Issue): ParsedIssue & { kind: Kind; kindSource: KindSource } {
  const { sections, headings } = parseSections(issue.body);
  const template = detectTemplate(headings, issue.title);
  const { kind, source } = detectKind(issue, template);
  return {
    template,
    sections,
    requiredMissing: requiredMissing(template, sections),
    links: extractReproLinks(issue.body),
    kind,
    kindSource: source,
  };
}

export async function runTriage(input: RunInput): Promise<Report> {
  const { issue, config, client } = input;
  const base: Omit<
    Report,
    "kind" | "kindSource" | "kindConfidence" | "flags" | "results" | "plan" | "questionsAsked"
  > = {
    issue: { number: issue.number, title: issue.title, htmlUrl: issue.htmlUrl },
    model: null,
    usage: null,
  };

  const { kind: kind0, kindSource: kindSource0, ...parsed } = parseIssue(issue);
  const { state, flags } = buildState(issue, parsed, kind0);

  if (!input.force && !issue.labels.includes(config.labels.needsTriage)) {
    return {
      ...base,
      kind: kind0,
      kindSource: kindSource0,
      kindConfidence: null,
      flags,
      results: [],
      plan: { add: [], remove: [] },
      questionsAsked: 0,
      shortCircuit: "already-triaged",
    };
  }

  const enabled = selectChecks(input.checks, config).filter(
    (c) => modeFor(c, config.modes) !== "off",
  );
  const ctxFor = (
    check: Check,
    kind: Kind,
    kindSource: KindSource,
    kindConfidence: number | null,
  ): Ctx => ({
    issue,
    parsed,
    state,
    flags,
    kind,
    kindSource,
    kindConfidence,
    config,
    options: {
      ...(check.defaultOptions as object | undefined),
      ...(config.options[check.id] as object | undefined),
    },
  });

  // Collect every check's questions into one request.
  const merged: Questions = {};
  const asked = new Map<string, boolean>();
  for (const check of enabled) {
    const q = check.questions(ctxFor(check, kind0, kindSource0, null));
    asked.set(check.id, q !== null);
    if (!q) continue;
    for (const [key, question] of Object.entries(q)) {
      if (key.includes(":"))
        throw new Error(
          `check ${check.id}: question key ${JSON.stringify(key)} must not contain ':'`,
        );
      merged[`${check.id}:${key}`] = question;
    }
  }
  if (kind0 === "unknown" && [...asked.values()].some(Boolean)) merged[KIND_KEY] = kindQuestion;

  let answers: Record<string, AnyAnswer> = {};
  let model: string | null = null;
  let usage: Report["usage"] = null;
  const questionsAsked = Object.keys(merged).length;
  if (questionsAsked > 0) {
    const result = await client.ask(state, merged, config.model);
    answers = result.answers;
    model = result.model;
    usage = result.usage;
  }

  let kind = kind0;
  let kindSource = kindSource0;
  let kindConfidence: number | null = null;
  const kindAnswer = answers[KIND_KEY];
  if (kind === "unknown" && kindAnswer?.type === "choice") {
    const map: Record<string, Kind> = {
      bug: "bug",
      feature: "feature",
      question: "question",
      other: "unknown",
    };
    kind = map[kindAnswer.choice] ?? "unknown";
    kindSource = "model";
    kindConfidence = kindAnswer.confidence;
  }

  const inputs: PolicyInput[] = enabled.map((check) => ({
    check,
    verdict: check.decide(
      answersFor(answers, check.id),
      ctxFor(check, kind, kindSource, kindConfidence),
    ),
  }));
  const anyCheck = enabled[0];
  const { results, plan } = anyCheck
    ? applyPolicy(inputs, ctxFor(anyCheck, kind, kindSource, kindConfidence))
    : { results: [], plan: { add: [], remove: [] } };

  return {
    ...base,
    kind,
    kindSource,
    kindConfidence,
    flags,
    results,
    plan,
    model,
    usage,
    questionsAsked,
    ...(questionsAsked === 0 && results.every((r) => r.effective === "skipped")
      ? { shortCircuit: "no-questions" as const }
      : {}),
  };
}

export interface ApplyOptions {
  dryRun: boolean;
  commentMode: CommentMode;
  force?: boolean;
  meta?: CommentMeta;
}

export interface ApplyOutcome {
  labelsChanged: boolean;
  finalLabels?: string[];
  comment?: string;
  commentUrl?: string;
  skipped?: "already-triaged" | "no-questions" | "dry-run";
}

export async function applyReport(
  report: Report,
  config: ResolvedConfig,
  gh: IssueClient,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  if (report.shortCircuit === "already-triaged")
    return { labelsChanged: false, skipped: "already-triaged" };

  const suggested = report.results.some((r) => r.effective === "suggested" && r.labels.length > 0);
  const acted = report.plan.add.length > 0 || suggested;
  // A comment only earns its place when it says something the labels cannot.
  // An applied `p2` explains itself; a suggestion has nowhere else to go, and a
  // `needs-reproduction` has to carry the request for a reproduction itself,
  // because rolldown's comment bot never fires on our label — GITHUB_TOKEN
  // writes do not trigger workflows.
  const needed = suggested || report.plan.add.includes(config.labels.needsReproduction);
  const shouldComment =
    options.commentMode === "always" ||
    (options.commentMode === "when-acting" && acted) ||
    (options.commentMode === "when-needed" && needed);
  const comment = shouldComment ? renderComment(report, config.labels, options.meta) : undefined;

  if (options.dryRun)
    return { labelsChanged: false, ...(comment ? { comment } : {}), skipped: "dry-run" };

  // Re-read: a human may have triaged while the model was thinking.
  const fresh = await gh.getIssue(report.issue.number);
  if (!options.force && !fresh.labels.includes(config.labels.needsTriage)) {
    return { labelsChanged: false, skipped: "already-triaged" };
  }

  // Re-check the "a human already decided" rule against the labels as they are
  // now, not as they were before inference. Otherwise a priority added during
  // the run is joined by ours instead of overriding it.
  const priorityNames = new Set(PRIORITY_SLOTS.map((slot) => config.labels[slot]));
  const freshHasPriority = fresh.labels.some((l) => priorityNames.has(l));
  const add = report.plan.add.filter((l) => !(freshHasPriority && priorityNames.has(l)));
  const remove = add.some((l) => priorityNames.has(l)) ? report.plan.remove : [];

  // The comment goes first. Labels are the irreversible half — once
  // `needs-triage` is off, a rerun short-circuits as already-triaged — so a
  // comment that fails after them can never be retried.
  let commentUrl: string | undefined;
  if (comment) {
    const ours = (await gh.listComments(report.issue.number)).filter((c) =>
      c.body.startsWith(MARKER),
    );
    // Starting with the marker excludes a reporter quoting us, since a quote is
    // prefixed with "> "; preferring a Bot author excludes the rest.
    const existing = ours.find((c) => c.authorIsBot) ?? ours[0];
    const saved = existing
      ? await gh.updateComment(existing.id, comment)
      : await gh.createComment(report.issue.number, comment);
    commentUrl = saved.htmlUrl;
  }

  let labelsChanged = false;
  const toAdd = add.filter((l) => !fresh.labels.includes(l));
  const toRemove = remove.filter((l) => fresh.labels.includes(l));
  if (toAdd.length > 0) {
    await gh.addLabels(report.issue.number, toAdd);
    labelsChanged = true;
  }
  for (const label of toRemove) {
    await gh.removeLabel(report.issue.number, label);
    labelsChanged = true;
  }
  const finalLabels = [...fresh.labels.filter((l) => !toRemove.includes(l)), ...toAdd];

  return {
    labelsChanged,
    finalLabels,
    ...(comment ? { comment } : {}),
    ...(commentUrl ? { commentUrl } : {}),
  };
}
