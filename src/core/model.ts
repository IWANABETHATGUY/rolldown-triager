import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { TypeSafeClient, type Questions, type Usage } from "@typesafe-ai/sdk";

import type { AnyAnswer, TriageState } from "./types.ts";

export interface ModelResult {
  model: string;
  answers: Record<string, AnyAnswer>;
  usage: Usage;
}

/** The one thing the runner needs from a model: answers to a batch of questions about a state. */
export interface ModelClient {
  ask(state: TriageState, questions: Questions, model: string): Promise<ModelResult>;
}

export interface TypeSafeClientOptions {
  /** Per attempt, ms. Triage is not latency-sensitive, so allow for a slow cold call. */
  timeout?: number;
  baseURL?: string;
  fetch?: typeof fetch;
}

export function createTypeSafeClient(
  apiKey: string,
  options: TypeSafeClientOptions = {},
): ModelClient {
  const client = new TypeSafeClient({
    apiKey,
    timeout: options.timeout ?? 30_000,
    logLevel: "off",
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    async ask(state, questions, model) {
      const result = await client.systemOne({ state, questions, model });
      return {
        model: result.model,
        answers: { ...(result.answers as Record<string, AnyAnswer>) },
        usage: result.usage,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Clef on Workers AI
// ---------------------------------------------------------------------------

// Clef implements the same System One request and answer shapes as Jev, so the
// runner, the checks and the recordings work unchanged. Only the transport
// differs: a per-model Cloudflare REST URL, answers wrapped in the usual
// `{ result, success, errors }` envelope, and question ids limited to letters,
// digits, `_`, `.` and `-`, so the runner's `check:key` namespace is renamed on
// the way out and back.

const CLEF_MODELS = new Set(["clef", "clef-flash"]);
const CLEF_KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const ATTEMPTS = 3;

export function isClefModel(model: string): boolean {
  return CLEF_MODELS.has(model);
}

export interface ClefClientOptions {
  /** Per attempt, ms. */
  timeout?: number;
  fetch?: typeof fetch;
}

interface CloudflareEnvelope {
  errors?: { code?: number; message?: string }[];
  result?: { model?: string; answers?: Record<string, AnyAnswer>; usage?: Usage };
}

/** The envelope's error list when there is one, else the raw body (an HTML page stays whole for `formatError`). */
function failureText(text: string): string {
  try {
    const errors = (JSON.parse(text) as CloudflareEnvelope).errors ?? [];
    if (errors.length === 0) return text;
    return errors.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
  } catch {
    return text;
  }
}

/** Rate limits and Workers AI capacity errors are worth another attempt; a rejected request is not. */
function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createClefClient(
  token: string,
  accountId: string,
  options: ClefClientOptions = {},
): ModelClient {
  // It becomes part of the URL path.
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new Error("the Cloudflare account id must be 32 lowercase hex characters");
  }
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeout ?? 30_000;

  async function post(url: string, body: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        if (attempt >= ATTEMPTS) throw error;
        await delay(attempt * 2000);
        continue;
      }
      const text = await response.text();
      if (response.ok) return text;
      if (attempt >= ATTEMPTS || !retryable(response.status)) {
        throw new Error(`${response.status} ${failureText(text)}`);
      }
      await delay(attempt * 2000);
    }
  }

  return {
    async ask(state, questions, model) {
      if (!isClefModel(model)) {
        throw new Error(`Clef serves clef and clef-flash, not ${JSON.stringify(model)}`);
      }
      const fromWire = new Map<string, string>();
      const wireQuestions: Questions = {};
      for (const [key, question] of Object.entries(questions)) {
        const wire = key.replaceAll(":", ".");
        if (!CLEF_KEY_RE.test(wire) || fromWire.has(wire)) {
          throw new Error(`question key ${JSON.stringify(key)} cannot be sent to Clef`);
        }
        fromWire.set(wire, key);
        wireQuestions[wire] = question;
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
      const text = await post(url, JSON.stringify({ model, state, questions: wireQuestions }));
      let result: CloudflareEnvelope["result"];
      try {
        result = (JSON.parse(text) as CloudflareEnvelope).result;
      } catch {
        throw new Error(`Clef answered with something other than JSON: ${text}`);
      }
      if (!result?.answers || !result.usage) {
        throw new Error(`Clef answered without answers or usage: ${text}`);
      }

      const answers: Record<string, AnyAnswer> = {};
      for (const [wire, answer] of Object.entries(result.answers)) {
        const key = fromWire.get(wire);
        if (key) answers[key] = answer;
      }
      return { model: result.model ?? model, answers, usage: result.usage };
    },
  };
}

// ---------------------------------------------------------------------------
// Recorded answers for offline tests and cached evals
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Stable hash of exactly what would be sent, so any change to state or question text invalidates a recording. */
export function requestHash(state: TriageState, questions: Questions, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ model, state, questions })))
    .digest("hex")
    .slice(0, 24);
}

export interface Recording {
  /** Free-form tag for humans, e.g. the issue number. */
  label: string;
  hash: string;
  model: string;
  questionKeys: string[];
  usage: Usage;
  answers: Record<string, AnyAnswer>;
}

export class FixtureStale extends Error {
  override name = "FixtureStale";
}

export interface RecordedClientOptions {
  /** Live client used to fill a missing recording; without it a miss throws `FixtureStale`. */
  recordThrough?: ModelClient;
  /** Name for new recordings; defaults to the request hash. */
  label?: string;
}

export function createRecordedClient(
  dir: string,
  options: RecordedClientOptions = {},
): ModelClient {
  const index = new Map<string, Recording>();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as Recording;
      index.set(rec.hash, rec);
    }
  }
  return {
    async ask(state, questions, model) {
      const hash = requestHash(state, questions, model);
      const hit = index.get(hash);
      if (hit) return { model: hit.model, answers: hit.answers, usage: hit.usage };
      if (!options.recordThrough) {
        throw new FixtureStale(
          `no recorded answers for ${options.label ?? hash} (hash ${hash}); re-record with \`pnpm cli record\``,
        );
      }
      const result = await options.recordThrough.ask(state, questions, model);
      const rec: Recording = {
        label: options.label ?? hash,
        hash,
        model: result.model,
        questionKeys: Object.keys(questions),
        usage: result.usage,
        answers: result.answers,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${rec.label}.json`), `${JSON.stringify(rec, null, 2)}\n`);
      index.set(hash, rec);
      return { model: rec.model, answers: rec.answers, usage: rec.usage };
    },
  };
}
