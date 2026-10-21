import { isEmptyResponse } from "./parse.ts";
import { proseOnly, sanitizeSection, type SanitizeOptions } from "./sanitize.ts";
import type {
  Flags,
  Issue,
  Kind,
  ParsedIssue,
  SectionKey,
  Sections,
  TriageState,
} from "./types.ts";

// Builds the one object the model sees. Anything not listed here (labels, author,
// comments, dates, the link list) stays out on purpose.

const CAPS: Record<SectionKey, SanitizeOptions> = {
  reproduction: { cap: 4000 },
  expected: { cap: 1500 },
  actual: { cap: 3000 },
  panic_message: { cap: 2000, headLines: 30, tailLines: 10 },
  system_info: {
    cap: 600,
    keepLines: /\b(OS|CPU|Memory|Node|npm|pnpm|yarn|bun|deno|rolldown|vite|tsdown)\b/i,
  },
  additional: { cap: 2000 },
  problem: { cap: 3000 },
  proposed_api: { cap: 3000 },
  body: { cap: 8000 },
};

/** ~10k tokens; well under the 32k state budget even with every question attached. */
const STATE_BUDGET = 40_000;

// Matches the crash *output*, not the word: a report can discuss panics at
// length without being one ("confirmed not a panic — rolldown's panic hook ...").
const PANIC_RE =
  /panicked at|rolldown panicked|\bSIGSEGV\b|\bSIGBUS\b|\bsegmentation fault\b|\bbus error\b/i;

const PRIORITY_WORDS_RE =
  /\b(p[0-3]|urgent(ly)?|blocker|top priority|highest priority|asap|please prioriti[sz]e|show[- ]?stopper)\b/i;

export function buildState(
  issue: Pick<Issue, "title" | "body">,
  parsed: ParsedIssue,
  kind: Kind,
): { state: TriageState; flags: Flags } {
  const sections: Sections = {};
  const truncated: SectionKey[] = [];
  const caps: Record<SectionKey, number> = Object.fromEntries(
    Object.entries(CAPS).map(([k, v]) => [k, v.cap]),
  ) as Record<SectionKey, number>;

  const render = (): void => {
    for (const key of Object.keys(CAPS) as SectionKey[]) {
      const raw = parsed.sections[key];
      if (raw === undefined || isEmptyResponse(raw)) continue;
      const { text, truncated: cut } = sanitizeSection(raw, { ...CAPS[key], cap: caps[key] });
      if (text) sections[key] = text;
      else delete sections[key];
      if (cut && !truncated.includes(key)) truncated.push(key);
    }
  };

  render();
  const state: TriageState = {
    issue: { title: issue.title.trim().slice(0, 300), kind, template: parsed.template, sections },
  };
  // Budget guard: halve the largest section until the state fits.
  for (let i = 0; i < 12 && JSON.stringify(state).length > STATE_BUDGET; i++) {
    const largest = (Object.entries(sections) as [SectionKey, string][]).sort(
      (a, b) => b[1].length - a[1].length,
    )[0];
    if (!largest) break;
    caps[largest[0]] = Math.max(200, Math.floor(largest[1].length / 2));
    render();
  }

  const runnableLinks = parsed.links.filter((l) => l.ok);
  const flags: Flags = {
    priorityWords: PRIORITY_WORDS_RE.test(proseOnly(`${issue.title}\n${issue.body}`)),
    templateFollowed: parsed.template !== "none" && parsed.requiredMissing.length === 0,
    runnableLinks,
    replInvalid: runnableLinks.length === 0 && parsed.links.some((l) => l.kind === "repl" && !l.ok),
    // Half the crash reports predate the panic template or were filed as
    // `[Bug]:`, so the template alone misses them.
    isPanic:
      parsed.template === "panic" ||
      Boolean(parsed.sections.panic_message) ||
      PANIC_RE.test(`${issue.title}\n${issue.body}`),
    truncated,
  };
  return { state, flags };
}
