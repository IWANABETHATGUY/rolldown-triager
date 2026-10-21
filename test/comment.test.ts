import { describe, expect, it } from "vitest";

import { MARKER, renderComment, renderSummary } from "../src/core/comment.ts";
import { ROLLDOWN_LABELS } from "../src/core/config.ts";
import type { CheckResult, Report } from "../src/core/types.ts";
import { flags } from "./support.ts";

const result = (over: Partial<CheckResult>): CheckResult => ({
  id: "x",
  verdict: { status: "skipped", reason: "r" },
  mode: "apply",
  effective: "skipped",
  labels: [],
  downgradedBecause: [],
  ...over,
});

const report = (results: CheckResult[], over: Partial<Report> = {}): Report => ({
  issue: { number: 7, title: "[Bug]: t", htmlUrl: "https://github.com/o/r/issues/7" },
  kind: "bug",
  kindSource: "type",
  kindConfidence: null,
  flags: flags(),
  results,
  plan: { add: [], remove: [] },
  model: "jev-1.13.0",
  usage: { input_tokens: 10, output_tokens: 0 },
  questionsAsked: 3,
  ...over,
});

describe("renderComment", () => {
  it("renders every result shape on one line each", () => {
    const text = renderComment(
      report([
        result({
          id: "reproduction",
          effective: "applied",
          labels: ["needs-reproduction"],
          verdict: {
            status: "decided",
            add: ["needsReproduction"],
            note: "no reproduction found",
            evidence: { steps: "0.6/3" },
            gate: "fail",
          },
        }),
        result({
          id: "priority",
          effective: "suggested",
          labels: ["p1: important"],
          downgradedBecause: ["could be p0", "issue already has a priority label"],
          verdict: {
            status: "decided",
            add: ["p1"],
            note: "build unusable in a common setup",
            evidence: { unusable: 0.91, "common setup": 0.8 },
            humanNote: "could be p0 if it hits most users",
            forceSuggest: "could be p0",
          },
        }),
        result({
          id: "has-workaround",
          effective: "abstained",
          verdict: { status: "abstained", note: "unsure", evidence: { workaround: 0.5 } },
        }),
        result({
          id: "other",
          effective: "skipped",
          verdict: { status: "skipped", reason: "feature request" },
        }),
      ]),
      ROLLDOWN_LABELS,
      { runUrl: "https://github.com/o/r/actions/runs/1" },
    );
    expect(text).toBe(
      [
        MARKER,
        "Automated triage by rolldown-triager (jev-1.13.0). A maintainer will confirm.",
        "",
        "- reproduction: set `needs-reproduction` — no reproduction found (steps 0.6/3) Please add a REPL, StackBlitz or repository link; the label closes the issue after 14 days without activity.",
        "- priority: suggest `p1: important` — build unusable in a common setup; could be p0 if it hits most users (unusable 0.91, common setup 0.8) [not applied: could be p0; issue already has a priority label]",
        "- has-workaround: unsure (workaround 0.5)",
        "- other: skipped (feature request)",
        "",
        "Re-run: re-add `needs-triage`. Manual labels win. [run](https://github.com/o/r/actions/runs/1)",
      ].join("\n"),
    );
  });

  it("says a priority removed needs-triage only when applied", () => {
    const applied = result({
      id: "priority",
      effective: "applied",
      labels: ["p3: nice to have / edge case"],
      verdict: { status: "decided", add: ["p3"], note: "n" },
    });
    expect(renderComment(report([applied]), ROLLDOWN_LABELS)).toContain(
      "set `p3: nice to have / edge case`, removed `needs-triage` — n",
    );
    const suggested = { ...applied, effective: "suggested" as const };
    expect(renderComment(report([suggested]), ROLLDOWN_LABELS)).toContain(
      "suggest `p3: nice to have / edge case` — n",
    );
    expect(renderComment(report([suggested]), ROLLDOWN_LABELS)).not.toContain("removed");
  });

  it("never contains the phrase rolldown's other bot greps for", () => {
    const text = renderComment(
      report([
        result({
          id: "reproduction",
          effective: "applied",
          labels: ["needs-reproduction"],
          verdict: { status: "decided", add: ["needsReproduction"], note: "n" },
        }),
      ]),
      ROLLDOWN_LABELS,
    );
    expect(text).not.toContain("Issues marked with `needs-reproduction`");
  });
});

describe("renderSummary", () => {
  it("includes kind, tokens, flags, plan, a table row per check and the comment", () => {
    const text = renderSummary(
      report(
        [
          result({
            id: "priority",
            effective: "applied",
            labels: ["p2: significant / minor bug"],
            verdict: { status: "decided", add: ["p2"], note: "n", evidence: { unusable: 0.1 } },
          }),
        ],
        {
          plan: { add: ["p2: significant / minor bug"], remove: ["needs-triage"] },
        },
      ),
      ROLLDOWN_LABELS,
    );
    expect(text).toContain("kind: **bug** (from type)");
    expect(text).toContain("tokens: 10 in / 0 out");
    expect(text).toContain(
      "| priority | apply | applied | `p2: significant / minor bug` | n | unusable=0.1 |  |",
    );
    expect(text).toContain(MARKER);
  });
});
