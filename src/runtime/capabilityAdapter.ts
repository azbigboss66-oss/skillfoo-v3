import { createHash } from "node:crypto";

// ── Current capability-adapter boundary ─────────────────
//
// Current U1 runtime and scoring code depend on this interface rather than a
// concrete adapter implementation.

/** Where a tool execution gets its data from. */
export type EnvironmentMode = "fixture" | "replay" | "record";

/** A tool call requested by the model, before adapter-side validation. */
export interface RequestedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Provenance of one tool execution, recorded for evidence grading. */
export interface AdapterEvidence {
  /** Human-auditable origin: fixture path, recorded request URL, … */
  source: string;
  /** Present for live-fetched or replayed payloads, absent for fixtures. */
  fetchedAt?: string;
  /** SHA-256 of the exact payload served to the model. */
  contentSha256: string;
  /** Stable key of the normalized request; identical across modes. */
  replayKey: string;
}

export interface AdapterResult {
  result: unknown;
  evidence: AdapterEvidence;
}

/** Adapter-owned prompt material; shared runners never hard-code tool names. */
export interface AdapterPromptContract {
  readonly toolContractSection: string;
  readonly usageInstructions?: string;
}

export type AdapterContext = {
  mode: EnvironmentMode;
  maxResponseBytes: number;
  timeoutMs: number;
  recordDir?: string;
  /**
   * Kernel-computed live-network authorization. It is true only when the
   * operator combined `--environment record`, `--confirm-live-fetch` and
   * `SKILLFOO_ALLOW_NETWORK=true`; adapters must refuse record-mode
   * execution without it.
   */
  allowNetwork: boolean;
};

export interface CapabilityAdapter {
  readonly id: string;
  readonly allowedToolNames: readonly string[];
  readonly promptContract: AdapterPromptContract;
  execute(call: RequestedToolCall, ctx: AdapterContext): Promise<AdapterResult>;
}

/** Plan constants: record-mode live fetches are capped at 1 MiB and 8 s. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Minimal fetch surface adapters rely on. Tests inject a mock; production
 * defaults to globalThis.fetch. Kept structural so adapters never see
 * DOM-specific types.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** An adapter failure with a stable, greppable machine code. */
export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AdapterError";
    this.code = code;
  }
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * SHA-256 of the exact payload served to the model: strings verbatim,
 * structured bodies as compact JSON. Record mode writes it into the
 * recording; replay recomputes and refuses any mismatch (Task 7 Step 4).
 */
export function canonicalPayloadHash(body: unknown): string {
  return sha256Hex(typeof body === "string" ? body : JSON.stringify(body));
}

/** Fallback live-request cap when a policy omits recordPolicy.maxRequests. */
export const DEFAULT_MAX_REQUESTS = 32;

/** Deterministic JSON: object keys sorted recursively. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Stable cross-mode key for one normalized tool request. The same logical
 * request yields the same replayKey in fixture, replay and record modes,
 * which is what makes a recorded fixture interchangeable with a fixture.
 */
export function computeReplayKey(
  adapterId: string,
  tool: string,
  normalizedArgs: Record<string, unknown>,
): string {
  return sha256Hex(`${adapterId}\n${tool}\n${stableStringify(normalizedArgs)}`).slice(0, 16);
}
