import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checks } from "../src/checks/index.ts";
import { MARKER } from "../src/core/comment.ts";
import { resolveConfig } from "../src/core/config.ts";
import type { IssueClient, IssueComment } from "../src/core/github.ts";
import { createRecordedClient, FixtureStale } from "../src/core/model.ts";
import { applyReport, runTriage, selectChecks } from "../src/core/runner.ts";
import type { Issue, Report } from "../src/core/types.ts";
import { FIXTURES, loadIssue } from "./helpers.ts";
import { issue as makeIssue } from "./support.ts";

const client = createRecordedClient(join(FIXTURES, "answers"));
const config = resolveConfig();

async function replay(number: number, over: Partial<Issue> = {}): Promise<Report> {
  return runTriage({
    issue: { ...loadIssue(number), ...over },
    config,
    client,
    checks,
    force: true,
  });
}

const effective = (r: Report): Record<string, string> =>
  Object.fromEntries(r.results.map((x) => [x.id, x.effective]));

describe("runTriage on recorded fixtures (offline)", () => {
  it("#10938: webcontainer link settles reproduction in code; priority is suggested by default", async () => {
    const r = await replay(10938);
    expect(r.questionsAsked).toBe(6);
    expect(effective(r)).toEqual({ reproduction: "applied", priority: "suggested" });
    expect(r.results[0]?.verdict).toMatchObject({ note: "vite.new link (+1 more)", gate: "pass" });
    expect(r.results[1]?.labels[0]).toMatch(/^p[12]/);
    expect(r.plan).toEqual({ add: [], remove: [] });
  });

  it("#10938 with priority=apply: the label is applied and needs-triage removed", async () => {
    const applyConfig = resolveConfig({ modes: "priority=apply" });
    const r = await runTriage({
      issue: loadIssue(10938),
      config: applyConfig,
      client,
      checks,
      force: true,
    });
    expect(r.results[1]?.effective).toBe("applied");
    expect(r.plan.add).toEqual([r.results[1]?.labels[0]]);
    expect(r.plan.remove).toEqual(["needs-triage"]);
  });

  it("#10812: no link, but complete steps and an explanation; existing p2 keeps priority suggest-only", async () => {
    const r = await replay(10812);
    expect(r.results[0]?.verdict).toMatchObject({
      status: "decided",
      gate: "pass",
      note: "no link, but the report is runnable as written",
    });
    expect(r.results[1]).toMatchObject({
      effective: "suggested",
      downgradedBecause: ["issue already has a priority label"],
    });
    expect(r.plan).toEqual({ add: [], remove: [] });
  });

  it("#10119: feature request skips reproduction and gets a priority", async () => {
    const r = await replay(10119);
    expect(r.kind).toBe("feature");
    expect(r.questionsAsked).toBe(2);
    expect(effective(r).reproduction).toBe("skipped");
    expect(r.results[1]?.labels[0]).toMatch(/^p[23]/);
  });

  it("#10697: untyped, no template — kind comes from the model in the same request", async () => {
    const r = await replay(10697);
    // Filed by a rolldown member, so reproduction asks nothing at all:
    // 6 bug + 2 feature + core:kind, and no repro rubric.
    expect(r.questionsAsked).toBe(9);
    expect(effective(r).reproduction).toBe("skipped");
    expect(r.kindSource).toBe("model");
    expect(r.kind).toBe("bug");
    expect(r.kindConfidence).toBeGreaterThan(0);
  });

  it("#10384/#10464: a crash location is not a reproduction, however precise", async () => {
    // Both are thin panic reports. #10384 names a source file and line and
    // #10464 is an `<unknown>` address dump, but neither says what the correct
    // behaviour would be — you can see where execution stopped, not whether the
    // input should have been accepted. So both are asked for a reproduction.
    for (const n of [10384, 10464]) {
      const r = await replay(n);
      expect(r.results[0]).toMatchObject({ effective: "applied" });
      expect(r.results[0]?.verdict).toMatchObject({ gate: "fail" });
      expect(r.plan.add).toContain("needs-reproduction");
      // And priority is not held back by it.
      expect(r.results[1]?.downgradedBecause).toEqual([]);
    }
  });

  it("short-circuits when needs-triage is absent and force is off", async () => {
    const r = await runTriage({ issue: loadIssue(10812), config, client, checks });
    expect(r.shortCircuit).toBe("already-triaged");
    expect(r.results).toEqual([]);
  });

  it("asks nothing for a task and reports no-questions", async () => {
    const r = await replay(10938, { typeName: "Task" });
    expect(r.questionsAsked).toBe(0);
    expect(r.model).toBeNull();
    expect(r.shortCircuit).toBe("no-questions");
  });

  it("a changed state invalidates the recording", async () => {
    await expect(replay(10938, { title: "[Bug]: edited" })).rejects.toBeInstanceOf(FixtureStale);
  });

  it("selectChecks rejects unknown ids", () => {
    expect(() => selectChecks(checks, { ...config, checks: ["nope"] })).toThrow(
      /unknown check "nope"; available: reproduction, priority, has-workaround/,
    );
    expect(
      selectChecks(checks, { ...config, checks: ["priority", "reproduction"] }).map((c) => c.id),
    ).toEqual(["priority", "reproduction"]);
  });
});

// ---------------------------------------------------------------------------

function fakeGitHub(initial: Issue) {
  let current = { ...initial, labels: [...initial.labels] };
  const comments: IssueComment[] = [];
  const calls: string[] = [];
  const gh: IssueClient = {
    getIssue: async () => {
      calls.push("getIssue");
      return { ...current, labels: [...current.labels] };
    },
    listComments: async () => {
      calls.push("listComments");
      return [...comments];
    },
    createComment: async (_n, body) => {
      calls.push("createComment");
      const c = {
        id: comments.length + 1,
        body,
        htmlUrl: `c${comments.length + 1}`,
        authorLogin: "github-actions[bot]",
        authorIsBot: true,
      };
      comments.push(c);
      return c;
    },
    updateComment: async (id, body) => {
      calls.push("updateComment");
      const c = comments.find((x) => x.id === id);
      if (!c) throw new Error("missing");
      c.body = body;
      return c;
    },
    addLabels: async (_n: number, labels: string[]) => {
      calls.push(`addLabels ${labels.join("|")}`);
      current = { ...current, labels: [...current.labels, ...labels] };
    },
    removeLabel: async (_n: number, label: string) => {
      calls.push(`removeLabel ${label}`);
      current = { ...current, labels: current.labels.filter((l) => l !== label) };
    },
    listIssues: async () => [],
    listLabelsEverAdded: async () => [],
  };
  return {
    gh,
    calls,
    comments,
    labels: () => current.labels,
    setLabels: (l: string[]) => (current = { ...current, labels: l }),
  };
}

describe("applyReport", () => {
  const applyConfig = resolveConfig({ modes: "priority=apply" });
  const report = async (): Promise<Report> =>
    runTriage({ issue: loadIssue(10938), config: applyConfig, client, checks, force: true });

  it("dry run writes nothing but returns the comment", async () => {
    const { gh, calls } = fakeGitHub(makeIssue({ number: 10938 }));
    const out = await applyReport(await report(), config, gh, {
      dryRun: true,
      commentMode: "always",
    });
    expect(out.skipped).toBe("dry-run");
    expect(out.comment).toContain(MARKER);
    expect(calls).toEqual([]);
  });

  it("sets labels once as (current − remove) ∪ add, creates then edits the same comment", async () => {
    const { gh, calls, comments } = fakeGitHub(
      makeIssue({ number: 10938, labels: ["needs-triage", "scope: wasi"] }),
    );
    const r = await report();
    const first = await applyReport(r, config, gh, {
      dryRun: false,
      commentMode: "always",
      meta: { runUrl: "https://run/1" },
    });
    expect(first).toMatchObject({
      labelsChanged: true,
      finalLabels: ["scope: wasi", "p1: important"],
      commentUrl: "c1",
    });
    // The comment goes first: labels are the irreversible half, and a comment
    // that failed after them could never be retried.
    expect(calls).toEqual([
      "getIssue",
      "listComments",
      "createComment",
      "addLabels p1: important",
      "removeLabel needs-triage",
    ]);
    expect(comments[0]?.body).toContain("[run](https://run/1)");

    // Second run: the label is gone, so a plain run is skipped; a forced one edits in place.
    const skipped = await applyReport(r, config, gh, { dryRun: false, commentMode: "always" });
    expect(skipped.skipped).toBe("already-triaged");
    calls.length = 0;
    const forced = await applyReport(r, config, gh, {
      dryRun: false,
      commentMode: "always",
      force: true,
    });
    expect(forced.labelsChanged).toBe(false);
    expect(calls).toEqual(["getIssue", "listComments", "updateComment"]);
    expect(comments).toHaveLength(1);
  });

  it("when-needed stays silent once the labels say everything", async () => {
    // Priority applied, nothing suggested, no reproduction request: the `p1`
    // label is the whole message, so a comment would only be noise.
    const applied = await report();
    const { gh, calls, comments } = fakeGitHub(
      makeIssue({ number: 10938, labels: ["needs-triage"] }),
    );
    const out = await applyReport(applied, config, gh, {
      dryRun: false,
      commentMode: "when-needed",
    });
    expect(out.labelsChanged).toBe(true);
    expect(out.comment).toBeUndefined();
    expect(calls).not.toContain("createComment");
    expect(comments).toHaveLength(0);
  });

  it("when-needed still carries a reproduction request", async () => {
    // Nothing else to say, but rolldown's comment bot never fires on our label,
    // so this comment is the only thing that asks the reporter for a repro.
    const applied = await report();
    const reproOnly: Report = {
      ...applied,
      plan: { add: ["needs-reproduction"], remove: [] },
      results: applied.results.map((r) => ({ ...r, effective: "applied" as const, labels: [] })),
    };
    const { gh, calls } = fakeGitHub(makeIssue({ number: 10938, labels: ["needs-triage"] }));
    const out = await applyReport(reproOnly, config, gh, {
      dryRun: false,
      commentMode: "when-needed",
    });
    expect(out.comment).toBeDefined();
    expect(calls).toContain("createComment");
  });

  it("respects the comment mode", async () => {
    const quiet = await replay(10812); // nothing applied, one suggestion
    const suggestion = {
      ...quiet,
      results: quiet.results.map((x) => ({ ...x, effective: "abstained" as const, labels: [] })),
    };
    for (const [mode, report_, expectComment] of [
      ["when-acting", quiet, true],
      ["when-acting", suggestion, false],
      ["when-needed", quiet, true],
      ["when-needed", suggestion, false],
      ["never", quiet, false],
      ["always", suggestion, true],
    ] as const) {
      const { gh, calls } = fakeGitHub(makeIssue({ number: 10812 }));
      const out = await applyReport(report_, config, gh, {
        dryRun: false,
        commentMode: mode,
        force: true,
      });
      expect(Boolean(out.comment)).toBe(expectComment);
      expect(calls.includes("createComment")).toBe(expectComment);
    }
  });
});
