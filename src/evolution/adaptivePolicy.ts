// ── V3.1 T16: adaptive-scheduling policy (pure functions) ─────────
//
// Routing rules for the adaptive evolution loop. Pure and explainable by
// design: the runner (T18) supplies the observed state, this module
// decides the next step and always says WHY. Budget number ranges are
// reuse the current LiveRunPolicy authorization — there is no second budget system.

import {
  LIVE_BUDGET_RANGES,
  LIVE_ROLE_RANGES,
  maxHttpAttemptsOf,
} from "../providers/liveRunPolicy.js";
import type { CallEnvelope } from "../providers/stageBudgets.js";
export type AdaptiveMode = "standard";
export type EarlyRepairMode = "auto" | "off" | "force";

/** The five explainable routes of the decision table (plan §5.C). */
export type AdaptiveRoute =
  | "killed_rebuild"
  | "refine_elite"
  | "targeted_mutation"
  | "root_rebuild"
  | "stop";

/** What the operator should resubmit after a stop. */
export type RecoverySuggestion = "refine" | "mutate" | "rebuild";

export class AdaptivePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdaptivePolicyError";
  }
}

export interface AdaptivePolicyParams {
  /**
   * Internal authority set only after the public CLI has verified a frozen,
   * real-human current U1 contract. It is deliberately not a CLI option.
   */
  formalHumanU1B?: true;
  maxGenerations: number;
  maxRefinementsPerCandidate: number;
  /** Minimum public-score improvement a repair must show, in absolute points (0, 100]; the CLI passes 2 points by default. */
  minRepairProgress: number;
  stagnationPatience: number;
  mode: AdaptiveMode;
  earlyRepair: EarlyRepairMode;
  /** Current-U1 dynamic authorization and the sole source of the logical-call cap. */
  u1CallEnvelope: CallEnvelope;
  maxRetryAttempts: number;
  /** Proposer-role per-request timeout (V3.1 P2: validated against LIVE_ROLE_RANGES.proposer). */
  requestTimeoutMs: number;
  /** Proposer-role per-response ceiling (V3.1 P2: validated against LIVE_ROLE_RANGES.proposer). */
  maxOutputTokens?: number;
}

/** Immutable parsed policy. `explorationOnly` marks fast-mode products as never-releasable. */
export interface AdaptivePolicy {
  readonly minChildGenerations: 2;
  /** Current formal Adaptive always uses the existing one-attempt structure-recovery hooks. */
  readonly structureRecoveryEnabled: true;
  readonly maxGenerations: number;
  readonly maxRefinementsPerCandidate: number;
  readonly minRepairProgress: number;
  readonly stagnationPatience: number;
  readonly mode: AdaptiveMode;
  readonly earlyRepair: EarlyRepairMode;
  readonly maxLogicalCalls: number;
  readonly maxRetryAttempts: number;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens?: number;
  readonly explorationOnly: false;
  /** Run-wide HTTP ceiling, derived via maxHttpAttemptsOf — never restated here. */
  readonly maxHttpAttempts: number;
}

/**
 * Parse the current adaptive parameters. Every field is explicit — no
 * silent defaults or manual logical-call fallback.
 */
export function parseAdaptivePolicy(input: AdaptivePolicyParams): AdaptivePolicy {
  const int = (field: keyof AdaptivePolicyParams & string, value: number, min: number, max: number): number => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AdaptivePolicyError(
        "ADAPTIVE_POLICY_INVALID",
        `ADAPTIVE_POLICY_INVALID: ${field} must be an integer between ${min} and ${max} (got ${value})`,
      );
    }
    return value;
  };

  const maxGenerations = int("maxGenerations", input.maxGenerations, 1, 4);
  const maxRefinementsPerCandidate = int("maxRefinementsPerCandidate", input.maxRefinementsPerCandidate, 0, 4);
  const stagnationPatience = int("stagnationPatience", input.stagnationPatience, 1, 3);

  if (!Number.isFinite(input.minRepairProgress) || input.minRepairProgress <= 0 || input.minRepairProgress > 100) {
    throw new AdaptivePolicyError(
      "ADAPTIVE_POLICY_INVALID",
      `ADAPTIVE_POLICY_INVALID: minRepairProgress must be an absolute public-score improvement in points, greater than 0 and at most 100 (got ${input.minRepairProgress}); the CLI default is 2 points`,
    );
  }

  if (input.mode !== "standard") {
    throw new AdaptivePolicyError(
      "ADAPTIVE_POLICY_INVALID",
      `ADAPTIVE_POLICY_INVALID: current formal U1 mode must be "standard" (got "${input.mode}")`,
    );
  }
  if (input.earlyRepair !== "auto" && input.earlyRepair !== "off" && input.earlyRepair !== "force") {
    throw new AdaptivePolicyError(
      "ADAPTIVE_POLICY_INVALID",
      `ADAPTIVE_POLICY_INVALID: earlyRepair must be "auto", "off", or "force" (got "${input.earlyRepair}")`,
    );
  }

  if (input.formalHumanU1B !== true || maxGenerations < 2) {
    const invalid = [
      ...(input.formalHumanU1B === true ? [] : ["formalHumanU1B"]),
      ...(maxGenerations >= 2 ? [] : ["maxGenerations"]),
    ];
    throw new AdaptivePolicyError(
      "ADAPTIVE_FORMAL_U1_POLICY_INVALID",
      `ADAPTIVE_FORMAL_U1_POLICY_INVALID: ${invalid.join(", ")} conflicts with the current formal-human U1 minimum of two standard-mode child generations`,
    );
  }

  if (!input.u1CallEnvelope || !Number.isSafeInteger(input.u1CallEnvelope.authorizedLogicalCalls) || input.u1CallEnvelope.authorizedLogicalCalls < 1) {
    throw new AdaptivePolicyError(
      "ADAPTIVE_POLICY_DYNAMIC_ENVELOPE_MISMATCH",
      "ADAPTIVE_POLICY_DYNAMIC_ENVELOPE_MISMATCH: current U1 requires a positive safe authorized H from the shared call envelope",
    );
  }
  const maxLogicalCalls = input.u1CallEnvelope.authorizedLogicalCalls;

  for (const field of ["maxRetryAttempts", "requestTimeoutMs"] as const) {
    const value = input[field];
    // V3.1 P2: the adaptive loop's requestTimeoutMs/maxOutputTokens ARE the
    // proposer role group (mutation/repair/refine traffic) — validated against
    // the proposer range so the CLI cannot authorize below-floor ceilings.
    const range =
      field === "maxRetryAttempts"
        ? LIVE_BUDGET_RANGES.maxRetryAttempts
        : LIVE_ROLE_RANGES.proposer[field];
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
      throw new AdaptivePolicyError(
        "ADAPTIVE_POLICY_BUDGET_OUT_OF_RANGE",
        `ADAPTIVE_POLICY_BUDGET_OUT_OF_RANGE: ${field} must be between ${range.min} and ${range.max} (got ${value}); requestTimeoutMs/maxOutputTokens reuse the exact LiveRunPolicy proposer-role ranges`,
      );
    }
  }
  if (input.maxOutputTokens !== undefined) {
    const range = LIVE_ROLE_RANGES.proposer.maxOutputTokens;
    if (
      !Number.isFinite(input.maxOutputTokens) ||
      input.maxOutputTokens < range.min ||
      input.maxOutputTokens > range.max
    ) {
      throw new AdaptivePolicyError(
        "ADAPTIVE_POLICY_BUDGET_OUT_OF_RANGE",
        `ADAPTIVE_POLICY_BUDGET_OUT_OF_RANGE: maxOutputTokens must be between ${range.min} and ${range.max} (got ${input.maxOutputTokens}); omission selects the U1 provider-default observe-only policy`,
      );
    }
  }

  return Object.freeze({
    minChildGenerations: 2,
    structureRecoveryEnabled: true,
    maxGenerations,
    maxRefinementsPerCandidate,
    minRepairProgress: input.minRepairProgress,
    stagnationPatience,
    mode: input.mode,
    earlyRepair: input.earlyRepair,
    maxLogicalCalls,
    maxRetryAttempts: input.maxRetryAttempts,
    requestTimeoutMs: input.requestTimeoutMs,
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    explorationOnly: false,
    maxHttpAttempts: maxHttpAttemptsOf({ maxLogicalCalls, maxRetryAttempts: input.maxRetryAttempts }),
  });
}

/** What the runner observed about the current elite candidate and the run. */
export interface AdaptiveRouteState {
  budgetRemainingLogicalCalls: number;
  /** Safety/permission hard-gate failures this generation. >0 kills refinement entirely. */
  safetyViolations: number;
  b0s0SameCoreFailure: boolean;
  contractConfidenceLow: boolean;
  /** Distinct failure categories observed, e.g. ["trigger", "task_path", "output_structure"]. */
  failureClasses: string[];
  protectedDimensionRegression: boolean;
  /** null = no repair attempted yet on this candidate. */
  lastRepairProgressed: boolean | null;
  refinementsUsed: number;
  consecutiveStagnation: number;
}

export interface AdaptiveRouteDecision {
  route: AdaptiveRoute;
  reason: string;
  recoverySuggestion?: RecoverySuggestion;
  /** True when this refinement is the 2nd-or-later and must present a progress certificate. */
  requiresProgressCertificate: boolean;
}

/**
 * The explainable decision table, evaluated in fixed priority order so
 * every outcome has exactly one justification:
 * budget → safety → root cause → stagnation stop → mutation triggers → refine → fallback.
 */
export function routeAdaptiveStep(policy: AdaptivePolicy, state: AdaptiveRouteState): AdaptiveRouteDecision {
  if (state.budgetRemainingLogicalCalls <= 0) {
    return {
      route: "stop",
      reason: "budget_exhausted: no logical calls remain; stopping with a resubmission suggestion",
      recoverySuggestion: recoverySuggestionForStop(state),
      requiresProgressCertificate: false,
    };
  }
  if (state.safetyViolations > 0) {
    return {
      route: "killed_rebuild",
      reason: `safety: ${state.safetyViolations} safety/permission violation(s); the candidate is killed and must be rebuilt — refinement is forbidden for safety failures`,
      recoverySuggestion: "rebuild",
      requiresProgressCertificate: false,
    };
  }
  if (state.b0s0SameCoreFailure || state.contractConfidenceLow) {
    const why = state.b0s0SameCoreFailure
      ? "B0 and S0 share the same core failure"
      : "task-contract confidence is low";
    return {
      route: "root_rebuild",
      reason: `root_rebuild: ${why}; re-intake or rebuild the root instead of blind refinement`,
      recoverySuggestion: "rebuild",
      requiresProgressCertificate: false,
    };
  }
  if (state.consecutiveStagnation >= policy.stagnationPatience) {
    return {
      route: "stop",
      reason: `stagnation: ${state.consecutiveStagnation} consecutive generation(s) without progress reached the patience limit (${policy.stagnationPatience}); stopping`,
      recoverySuggestion: recoverySuggestionForStop(state),
      requiresProgressCertificate: false,
    };
  }

  const firstRefinement = state.refinementsUsed === 0;
  const multiClass = state.failureClasses.length >= 2;
  const refinementStalled = state.refinementsUsed > 0 && state.lastRepairProgressed === false;
  const refinementBudgetLeft = state.refinementsUsed < policy.maxRefinementsPerCandidate;

  if (multiClass && !(firstRefinement && policy.earlyRepair === "force")) {
    return {
      route: "targeted_mutation",
      reason: `failure classes: ${state.failureClasses.length} distinct classes (${state.failureClasses.join(", ")}) — targeted mutation from elite + diversity, not a random restart`,
      recoverySuggestion: "mutate",
      requiresProgressCertificate: false,
    };
  }
  if (refinementStalled) {
    return {
      route: "targeted_mutation",
      reason: "refinement stall: the last repair made no progress — switch to targeted mutation instead of repeating it",
      recoverySuggestion: "mutate",
      requiresProgressCertificate: false,
    };
  }

  if (policy.earlyRepair === "off") {
    return {
      route: "targeted_mutation",
      reason: "earlyRepair=off: refinement is disabled for this run; routing the single local cause to targeted mutation",
      recoverySuggestion: "mutate",
      requiresProgressCertificate: false,
    };
  }
  if (state.protectedDimensionRegression) {
    return {
      route: "targeted_mutation",
      reason: "protected-dimension regression: a protected dimension regressed, so refining further is unsafe; targeted mutation explores an alternative",
      recoverySuggestion: "mutate",
      requiresProgressCertificate: false,
    };
  }
  if (!refinementBudgetLeft) {
    return {
      route: "targeted_mutation",
      reason: `refinement budget: ${state.refinementsUsed}/${policy.maxRefinementsPerCandidate} refinements used for this candidate; targeted mutation continues the search`,
      recoverySuggestion: "mutate",
      requiresProgressCertificate: false,
    };
  }
  if (firstRefinement) {
    const forced = policy.earlyRepair === "force";
    return {
      route: "refine_elite",
      reason: forced
        ? "earlyRepair=force: the first refinement is forced on the current elite (certificate still required from the second refinement on)"
        : "single local cause with no protected-dimension regression: refine the current elite",
      requiresProgressCertificate: false,
    };
  }
  return {
    route: "refine_elite",
    reason: `last repair progressed and the failure stays a single local cause: refine the current elite (attempt ${state.refinementsUsed + 1})`,
    requiresProgressCertificate: true,
  };
}

export interface ProgressCertificateInput {
  hardGateViolations: number;
  /** Drop in critical-failure count versus before the repair; negative = increase. */
  criticalFailureDrop: number;
  /** Public-score improvement versus before the repair, in absolute points on the 0–100 scale. */
  scoreImprovement: number;
  protectedDimensionRegression: boolean;
  /** Minimum absolute public-score improvement in points (0, 100]; must match the parsed policy. */
  minRepairProgress: number;
}

export interface ProgressCertificate {
  granted: boolean;
  /**
   * Failed conditions, printed verbatim in the report. `hard_gate_zero` and
   * `protected_dimensions_unchanged` are stable names; the `progress` entry
   * carries the numbers with the unit spelled out in points.
   */
  failedConditions: string[];
}

/**
 * The 2nd/3rd refinement must prove itself: hard gates clean AND (critical
 * failures dropped OR score improved by at least minRepairProgress) AND no
 * protected-dimension regression. One failed condition denies the
 * certificate; nothing is waived.
 */
export function progressCertificateOf(input: ProgressCertificateInput): ProgressCertificate {
  const failed: string[] = [];
  if (input.hardGateViolations !== 0) {
    failed.push("hard_gate_zero");
  }
  if (!(input.criticalFailureDrop > 0 || input.scoreImprovement >= input.minRepairProgress)) {
    failed.push(
      `progress: score improved ${input.scoreImprovement} points, below the required ${input.minRepairProgress} points, and critical failures did not drop`,
    );
  }
  if (input.protectedDimensionRegression) {
    failed.push("protected_dimensions_unchanged");
  }
  return { granted: failed.length === 0, failedConditions: failed };
}

/** Stagnation counter: progress resets it, stagnation increments it. */
export function advanceStagnation(previousCount: number, progressed: boolean): number {
  return progressed ? 0 : previousCount + 1;
}

/**
 * Map a stop state to the one-line resubmission advice the report must
 * print: refine | mutate | rebuild.
 */
export function recoverySuggestionForStop(state: AdaptiveRouteState): RecoverySuggestion {
  if (state.safetyViolations > 0 || state.b0s0SameCoreFailure || state.contractConfidenceLow) {
    return "rebuild";
  }
  if (state.failureClasses.length >= 2) {
    return "mutate";
  }
  if (state.refinementsUsed > 0 && state.lastRepairProgressed === false) {
    return "mutate";
  }
  return "refine";
}
