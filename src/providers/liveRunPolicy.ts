// ── P0 Task 1: live-run authorization and budget policy ──────────
//
// The single gate between "offline by default" and one real
// OpenAI-compatible provider call. Real mode exists only when the operator
// selects the portable provider path (or its DeepSeek request preset) and
// passes every gate:
// --allow-network, the exact confirmation phrase, --no-release, and the
// centrally calculated current-U1 authorization. All errors are desensitized by construction —
// field names and ranges only, never keys, prompts, or URLs.

import type { CallEnvelope } from "./stageBudgets.js";

/** The exact confirmation phrase; anything else (case included) is rejected. */
export const LIVE_CONFIRM_PHRASE = "I_UNDERSTAND_REAL_PROVIDER_COSTS";

/** Allowed budget ranges. Anything outside fails with the range spelled out. */
export const LIVE_BUDGET_RANGES = {
  maxRetryAttempts: { min: 0, max: 8 },
} as const;

/**
 * V3.1 P2: per-role output/timeout ranges. The evaluator answers short
 * judged envelopes; the proposer (bootstrap / mutation / repair /
 * direct-refine) must be able to emit a full SKILL.md strict-JSON document —
 * T22-R2 proved a shared 3000-token ceiling truncates it (finishReason=length).
 */
export const LIVE_ROLE_RANGES = {
  evaluator: {
    maxOutputTokens: { min: 512, max: 4_096 },
    requestTimeoutMs: { min: 1_000, max: 2_147_483_647 },
  },
  proposer: {
    maxOutputTokens: { min: 1_024, max: 16_384 },
    requestTimeoutMs: { min: 1_000, max: 2_147_483_647 },
  },
} as const;

export type LiveRoleName = keyof typeof LIVE_ROLE_RANGES;

/**
 * Concrete provider roles are distinct from output-policy groups. The
 * semantic judge retains its own ledger label while reusing the short
 * evaluator-sized response envelope: it scores completed answers and never
 * writes a replacement SKILL.md.
 */
export type LiveProviderRole = "evaluator" | "mutation" | "repair" | "direct-refine" | "semantic-judge";

/** One frozen per-role output group. The proposer group covers bootstrap / mutation / repair / direct-refine. */
export interface LiveRoleOutput {
  /** Omitted means omit max_tokens and observe the provider's actual usage. */
  readonly maxOutputTokens?: number;
  readonly requestTimeoutMs: number;
}

export function maxOutputTokensBehaviorOf(output: LiveRoleOutput): number | "provider-default" {
  return output.maxOutputTokens ?? "provider-default";
}

/** Where the two role groups' numbers came from — always stated, never guessed. */
export type LiveRoleOutputSource =
  | "explicit-role-params"
  | "u1-provider-default-tokens";

export class LiveRunPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LiveRunPolicyError";
  }
}

/** Raw CLI-facing input; current live execution always carries centralized U1 authorization. */
export interface LiveRunPolicyInput {
  provider: string;
  allowNetwork?: boolean;
  confirmRealProvider?: string;
  noRelease?: boolean;
  maxRetryAttempts?: number;
  /** Role-scoped output ceilings are optional; omission uses provider-default observation. */
  evaluatorMaxOutputTokens?: number;
  evaluatorRequestTimeoutMs?: number;
  proposerMaxOutputTokens?: number;
  proposerRequestTimeoutMs?: number;
  /** Internal current-U1 authorization calculated from one B/M/H envelope. */
  u1DynamicAuthorizedLogicalCalls: number;
  /** Complete current-U1 B/M/H identity; exact calibration does not use this field. */
  u1CallEnvelope?: CallEnvelope;
}

/** Immutable, fully-authorized live-run policy. */
export interface LiveRunPolicy {
  readonly mode: "live";
  readonly providerName: "openai-compatible";
  /** `deepseek` changes request defaults only; execution remains one provider path. */
  readonly requestPreset: "portable" | "deepseek";
  readonly maxLogicalCalls: number;
  readonly maxRetryAttempts: number;
  /** Present only when this stage is governed by the current-U1 dynamic envelope. */
  readonly u1CallEnvelope?: CallEnvelope;
  /** Evaluator-role output group (judged scenario answers). */
  readonly evaluator: LiveRoleOutput;
  /** Proposer-role output group (bootstrap / mutation / repair / direct-refine). */
  readonly proposer: LiveRoleOutput;
  /** How the two groups were sourced. */
  readonly roleOutputSource: LiveRoleOutputSource;
  readonly noRelease: true;
}

/**
 * The output/timeout group one provider role must use. The CLI wiring is the
 * only caller: evaluator and semantic-judge instances get the evaluator
 * group, while bootstrap / mutation / repair / direct-refine get the proposer
 * group — there is no third path and no silent default.
 */
export function roleGroupOf(policy: LiveRunPolicy, role: LiveProviderRole): LiveRoleOutput {
  return role === "evaluator" || role === "semantic-judge" ? policy.evaluator : policy.proposer;
}

/**
 * Parse and validate a live-run request. Throws {@link LiveRunPolicyError}
 * (desensitized) when any gate is missing — BEFORE any config is read or any
 * fetch could happen. Returns a frozen policy object on success.
 */
export function parseLiveRunPolicy(input: LiveRunPolicyInput): LiveRunPolicy {
  const provider = normalizeProvider(input.provider);
  if (provider !== "openai-compatible" && provider !== "deepseek") {
    throw new LiveRunPolicyError(
      "LIVE_PROVIDER_UNSUPPORTED",
      `LIVE_PROVIDER_UNSUPPORTED: real mode supports "openai-compatible" and the "deepseek" request preset only (got "${input.provider}")`,
    );
  }
  if (input.allowNetwork !== true) {
    throw new LiveRunPolicyError(
      "LIVE_NETWORK_NOT_ALLOWED",
      "LIVE_NETWORK_NOT_ALLOWED: a live run requires --allow-network; default and fixture modes never touch the network",
    );
  }
  if (input.confirmRealProvider !== LIVE_CONFIRM_PHRASE) {
    throw new LiveRunPolicyError(
      "LIVE_CONFIRM_PHRASE_REQUIRED",
      `LIVE_CONFIRM_PHRASE_REQUIRED: pass --confirm-real-provider ${LIVE_CONFIRM_PHRASE} exactly`,
    );
  }

  const maxLogicalCalls = input.u1DynamicAuthorizedLogicalCalls;
  if (!Number.isSafeInteger(maxLogicalCalls) || maxLogicalCalls < 1) {
    throw new LiveRunPolicyError(
      "LIVE_DYNAMIC_ENVELOPE_INVALID",
      "LIVE_DYNAMIC_ENVELOPE_INVALID: current U1 authorizedLogicalCalls must be a positive safe integer",
    );
  }
  if (
    input.u1CallEnvelope !== undefined &&
    input.u1CallEnvelope.authorizedLogicalCalls !== maxLogicalCalls
  ) {
    throw new LiveRunPolicyError(
      "LIVE_DYNAMIC_ENVELOPE_BINDING_INVALID",
      "LIVE_DYNAMIC_ENVELOPE_BINDING_INVALID: the complete B/M/H identity does not authorize the calculated current-U1 logical-call cap",
    );
  }

  let maxRetryAttempts!: number;
  for (const field of ["maxRetryAttempts"] as const) {
    const value = input[field];
    if (value === undefined || !Number.isFinite(value)) {
      throw new LiveRunPolicyError(
        "LIVE_BUDGET_REQUIRED",
        "LIVE_BUDGET_REQUIRED: a live run needs an explicit --max-retry-attempts (maxRetryAttempts); refusing to pick a silent default",
      );
    }
    const range = LIVE_BUDGET_RANGES[field];
    if (value < range.min || value > range.max) {
      throw new LiveRunPolicyError(
        "LIVE_BUDGET_OUT_OF_RANGE",
        `LIVE_BUDGET_OUT_OF_RANGE: ${field} must be between ${range.min} and ${range.max} (got ${value})`,
      );
    }
    maxRetryAttempts = value;
  }

  const evaluatorTimeout = input.evaluatorRequestTimeoutMs;
  const proposerTimeout = input.proposerRequestTimeoutMs;
  if (evaluatorTimeout === undefined || proposerTimeout === undefined) {
    throw new LiveRunPolicyError(
      "LIVE_ROLE_PARAMS_PARTIAL",
      "LIVE_ROLE_PARAMS_PARTIAL: current live runs require both evaluator and proposer request timeouts",
    );
  }
  for (const [role, value] of [["evaluator", evaluatorTimeout], ["proposer", proposerTimeout]] as const) {
    const range = LIVE_ROLE_RANGES[role].requestTimeoutMs;
    if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
      throw new LiveRunPolicyError(
        "LIVE_ROLE_OUT_OF_RANGE",
        `LIVE_ROLE_OUT_OF_RANGE: ${role}RequestTimeoutMs must be between ${range.min} and ${range.max} (got ${value})`,
      );
    }
  }

  const evaluatorTokens = input.evaluatorMaxOutputTokens;
  const proposerTokens = input.proposerMaxOutputTokens;
  if ((evaluatorTokens === undefined) !== (proposerTokens === undefined)) {
    throw new LiveRunPolicyError(
      "LIVE_ROLE_PARAMS_PARTIAL",
      "LIVE_ROLE_PARAMS_PARTIAL: evaluator/proposer max-output-token overrides must be supplied together or both omitted",
    );
  }

  let evaluator: LiveRoleOutput;
  let proposer: LiveRoleOutput;
  let roleOutputSource: LiveRoleOutputSource;
  if (evaluatorTokens === undefined || proposerTokens === undefined) {
    evaluator = Object.freeze({ requestTimeoutMs: evaluatorTimeout });
    proposer = Object.freeze({ requestTimeoutMs: proposerTimeout });
    roleOutputSource = "u1-provider-default-tokens";
  } else {
    for (const [role, value] of [["evaluator", evaluatorTokens], ["proposer", proposerTokens]] as const) {
      const range = LIVE_ROLE_RANGES[role].maxOutputTokens;
      if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
        throw new LiveRunPolicyError(
          "LIVE_ROLE_OUT_OF_RANGE",
          `LIVE_ROLE_OUT_OF_RANGE: ${role}MaxOutputTokens must be between ${range.min} and ${range.max} (got ${value})`,
        );
      }
    }
    evaluator = Object.freeze({ maxOutputTokens: evaluatorTokens, requestTimeoutMs: evaluatorTimeout });
    proposer = Object.freeze({ maxOutputTokens: proposerTokens, requestTimeoutMs: proposerTimeout });
    roleOutputSource = "explicit-role-params";
  }
  if (input.noRelease !== true) {
    throw new LiveRunPolicyError(
      "LIVE_RELEASE_MUST_BE_WITHHELD",
      "LIVE_RELEASE_MUST_BE_WITHHELD: a live run must pass --no-release; releases need separate authorization",
    );
  }

  return Object.freeze({
    mode: "live",
    providerName: "openai-compatible",
    requestPreset: provider === "deepseek" ? "deepseek" : "portable",
    maxLogicalCalls,
    maxRetryAttempts,
    ...(input.u1CallEnvelope ? { u1CallEnvelope: Object.freeze({ ...input.u1CallEnvelope }) } : {}),
    evaluator,
    proposer,
    roleOutputSource,
    noRelease: true,
  } satisfies LiveRunPolicy);
}

/**
 * The honest run-wide HTTP-attempt ceiling. RunCallBudget.enterRetry()
 * caps retries ACROSS the whole run — not one retry per logical call —
 * so the worst case is every logical call plus every allowed retry.
 * preflight and the live report both derive the ceiling from HERE; no
 * caller may restate the formula.
 */
export function maxHttpAttemptsOf(
  policy: Pick<LiveRunPolicy, "maxLogicalCalls" | "maxRetryAttempts">,
): number {
  return policy.maxLogicalCalls + policy.maxRetryAttempts;
}

function normalizeProvider(name: string): string {
  return name.trim().toLowerCase();
}
