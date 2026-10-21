import type {
  ChoiceResponse,
  NoulResponse,
  Questions,
  ScoreResponse,
  Usage,
} from "@typesafe-ai/sdk";

// ---------------------------------------------------------------------------
// Issue model
// ---------------------------------------------------------------------------

export type Kind = "bug" | "feature" | "task" | "question" | "unknown";
export type KindSource = "type" | "template" | "title" | "model" | "none";
export type Template = "bug" | "panic" | "feature" | "none";

export interface Issue {
  number: number;
  title: string;
  body: string;
  /** GitHub's native issue type (`Bug` / `Feature` / `Task`), not a label. */
  typeName: string | null;
  labels: string[];
  htmlUrl: string;
  /**
   * GitHub's `author_association`: OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR /
   * NONE. Already on the issue payload, so it costs no extra request.
   */
  authorAssociation: string | null;
}

export type ReproLinkKind =
  | "repl"
  | "stackblitz"
  | "codesandbox"
  | "webcontainer"
  | "gist"
  | "github_repo";

export interface ReproLink {
  kind: ReproLinkKind;
  url: string;
  /** Whether the link counts as a runnable reproduction. */
  ok: boolean;
  detail?: string;
}

export const SECTION_KEYS = [
  "reproduction",
  "expected",
  "actual",
  "panic_message",
  "system_info",
  "additional",
  "problem",
  "proposed_api",
  "body",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Partial<Record<SectionKey, string>>;

export interface ParsedIssue {
  template: Template;
  /** Raw (unsanitized) section text keyed by canonical section. */
  sections: Sections;
  /** Required template fields that are empty or `_No response_`. */
  requiredMissing: string[];
  links: ReproLink[];
}

/** Exactly what is sent to the model as `state`. Nothing else goes in. (A type alias, not an interface, so it satisfies the SDK's `EntryType`.) */
export type TriageState = {
  issue: {
    title: string;
    kind: Kind;
    template: Template;
    sections: Sections;
  };
};

export interface Flags {
  /** The body argues its own priority ("P0", "urgent", ...). */
  priorityWords: boolean;
  templateFollowed: boolean;
  runnableLinks: ReproLink[];
  /** A REPL link was present but empty or undecodable, and nothing else is runnable. */
  replInvalid: boolean;
  /** The report is a crash: panic template, a panic section, or a panic in the text. */
  isPanic: boolean;
  truncated: SectionKey[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const LABEL_SLOTS = [
  "p0",
  "p1",
  "p2",
  "p3",
  "needsTriage",
  "needsReproduction",
  "hasWorkaround",
] as const;
export type LabelSlot = (typeof LABEL_SLOTS)[number];
export type PrioritySlot = "p0" | "p1" | "p2" | "p3";
export const PRIORITY_SLOTS: readonly PrioritySlot[] = ["p0", "p1", "p2", "p3"];

export type LabelNames = Record<LabelSlot, string>;
export type Mode = "apply" | "suggest" | "off";
export type CommentMode = "always" | "when-acting" | "when-needed" | "never";

export interface Thresholds {
  /** A Noul at or above this is "yes"; at or below `noulNo` is "no"; between is unsure. */
  noulYes: number;
  noulNo: number;
  /** Minimum Choice/Score confidence to act on the answer. */
  scoreConfidence: number;
  /** `runnable` at or above this means the report can be run as written. */
  reproRunnableYes: number;
  /** `runnable` at or below this makes the issue a candidate for the label. */
  reproRunnableNo: number;
  /** `self_evident` at or above this blocks the label: nothing to ask the reporter for. */
  reproSelfEvident: number;
  /** Second gate on the label: `repro_quality` must also be at or below this. */
  reproLow: number;
  /** @deprecated superseded by `reproRunnableYes`; still accepted as an input. */
  reproOk: number;
  /** @deprecated the `runnable` Noul carries no confidence; kept for the sweep. */
  reproConfidence: number;
  /** `usefulness` score at or above this maps a feature to p2 instead of p3. */
  /** `panic_reach` at or above this is a p1 crash; at or above `panicReachP2`, a p2. */
  panicReachP1: number;
  panicReachP2: number;
  /** Minimum `panic_reach` confidence. Lower than `scoreConfidence`: the rubric
   *  is inherently fuzzy, and gating it at 0.6 abstained on 18 of 40 panics. */
  panicConfidence: number;
  usefulnessP2: number;
  workaroundLabel: number;
  arguesPriority: number;
  /** Minimum confidence when the issue kind had to come from the model. */
  kindConfidence: number;
}

export interface ResolvedConfig {
  labels: LabelNames;
  /** Enabled check ids, in run order. */
  checks: string[];
  modes: Record<string, Mode>;
  options: Record<string, unknown>;
  comment: CommentMode;
  model: string;
  thresholds: Thresholds;
}

// ---------------------------------------------------------------------------
// Checks — the extensibility seam
// ---------------------------------------------------------------------------

export interface Ctx<O = unknown> {
  issue: Issue;
  parsed: ParsedIssue;
  state: TriageState;
  flags: Flags;
  /** `unknown` while questions are being collected; resolved before `decide`. */
  kind: Kind;
  kindSource: KindSource;
  kindConfidence: number | null;
  config: ResolvedConfig;
  options: O;
}

export type AnyAnswer = NoulResponse | ScoreResponse | ChoiceResponse;

export interface ScoreAnswer {
  score: number;
  confidence: number;
  /** Highest level index, so `score / top` is on 0..1. */
  top: number;
  probabilities: Record<string, number>;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** A check's view of its own answers, keys without the `${id}:` prefix. */
export interface Answers {
  readonly raw: Readonly<Record<string, AnyAnswer>>;
  has(key: string): boolean;
  noul(key: string): number | undefined;
  score(key: string): ScoreAnswer | undefined;
  choice(key: string): ChoiceAnswer | undefined;
}

/** Short label → value pairs shown in the comment, e.g. `{ unusable: 0.12, steps: "0.6/3" }`. */
export type Evidence = Record<string, number | string>;

export type Verdict =
  | { status: "skipped"; reason: string }
  | { status: "abstained"; note: string; evidence?: Evidence; gate?: "unsure" }
  | {
      status: "decided";
      add: LabelSlot[];
      note: string;
      evidence?: Evidence;
      gate?: "pass" | "fail";
      /** Something a human must look at even when labels were applied. */
      humanNote?: string;
      /** Reason this decision must not be applied automatically. */
      forceSuggest?: string;
    };

export type Decided = Extract<Verdict, { status: "decided" }>;

export interface Check<O = unknown> {
  /** `/^[a-z][a-z0-9-]*$/`, unique across checks; prefixes its question keys. */
  id: string;
  /** When true, a `fail`/`unsure` gate from this check downgrades every other check to suggest. */
  defaultMode?: Mode;
  defaultOptions?: O;
  /** Questions to batch into the single model request; `null` = skipped, `{}` = decide without the model. */
  questions(ctx: Ctx<O>): Questions | null;
  decide(answers: Answers, ctx: Ctx<O>): Verdict;
}

export function defineCheck<O>(check: Check<O>): Check {
  if (!/^[a-z][a-z0-9-]*$/.test(check.id)) {
    throw new Error(`invalid check id ${JSON.stringify(check.id)}`);
  }
  return check as Check;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type Effective = "applied" | "suggested" | "abstained" | "skipped";

export interface CheckResult {
  id: string;
  verdict: Verdict;
  mode: Mode;
  effective: Effective;
  /** Resolved label names the check wants added (applied or only suggested). */
  labels: string[];
  downgradedBecause: string[];
}

export interface LabelPlan {
  add: string[];
  remove: string[];
}

export interface Report {
  issue: Pick<Issue, "number" | "title" | "htmlUrl">;
  kind: Kind;
  kindSource: KindSource;
  kindConfidence: number | null;
  flags: Flags;
  results: CheckResult[];
  plan: LabelPlan;
  model: string | null;
  usage: Usage | null;
  questionsAsked: number;
  shortCircuit?: "already-triaged" | "no-questions";
}
