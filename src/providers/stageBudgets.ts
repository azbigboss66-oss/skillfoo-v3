export interface StageBudgetInputs {
  shortlistCandidates: number;
  selectItems: number;
  holdoutItems: number;
  semanticBatchSize: number;
  directProposerCalls: number;
  /** Raw candidate/item runtime bounds used to calculate r. */
  maxModelTurns: number;
  /** Maximum tool calls charged per candidate/item interaction. */
  maxToolCalls: number;
  /** Safety multiplier used by both r -> p and the stage's complete raw primary workload. Defaults to 2.0. */
  budgetMultiplier?: number;
}

export interface StageBudgetAssumptions extends Omit<StageBudgetInputs, "budgetMultiplier"> {
  /** Persisted effective multiplier, including the current default when the input omits it. */
  budgetMultiplier: number;
}

export interface StageBudgetPlan {
  publicSelect: number;
  direct: number;
  sealed: number;
  assumptions: StageBudgetAssumptions;
  envelope: Readonly<{
    publicSelect: CallEnvelope;
    direct: CallEnvelope;
    sealed: CallEnvelope;
  }>;
}

export interface AuthorizedStageBudgets {
  publicSelect: number;
  direct: number;
  sealed: number;
}

export interface CalibrationBudgetPlan {
  readonly primaryPasses: 2;
  readonly schemaRecoveryReserve: 2;
  readonly authorizedLogicalCalls: 4;
  readonly transportRetries: 0;
}

/** Current formal calibration has two independent passes and one repair slot per pass. */
export function calculateCalibrationBudget(): CalibrationBudgetPlan {
  return Object.freeze({
    primaryPasses: 2,
    schemaRecoveryReserve: 2,
    authorizedLogicalCalls: 4,
    transportRetries: 0,
  });
}

export type IndependentStageBudgetName = keyof AuthorizedStageBudgets;

export class StageFundingError extends Error {
  constructor(
    readonly stage: IndependentStageBudgetName,
    readonly minimum: number,
    readonly authorized: number,
  ) {
    super(
      `STAGE_UNDERFUNDED: ${stage} requires at least ${minimum} logical calls for its complete frozen protocol, but only ${authorized} are authorized; no call from this stage may start.`,
    );
    this.name = "StageFundingError";
  }
}

function requireNonNegativeInteger(name: keyof StageBudgetInputs, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`STAGE_BUDGET_INPUT_INVALID: ${name} must be a non-negative integer`);
  }
}

export const CANDIDATE_ITEM_ESTIMATION_VERSION = "candidate-item-envelope-v2" as const;

export interface ScenarioCallAuthorization {
  /** Raw single-attempt model-call estimate r. */
  readonly rawScenarioEstimate: number;
  /** Multiplier M used for this candidate-item's r -> p authorization. */
  readonly callEnvelopeMultiplier: number;
  /** Per-attempt authorization p = ceil(r * M). */
  readonly authorizedModelCallsPerAttempt: number;
  /** Runtime turn authorization; equals p so accounting and execution share one bound. */
  readonly authorizedMaxTurns: number;
  /** Runtime tool-call authorization; equals max(0, p - 1). */
  readonly authorizedMaxToolCalls: number;
  /** One primary attempt plus at most one clean application retry. */
  readonly maxApplicationAttempts: 1 | 2;
  /** Per-scenario reserve for attempt 2; zero when retries are forbidden. */
  readonly scenarioRetryReserve: number;
}

export interface CallEnvelope {
  readonly estimationVersion: typeof CANDIDATE_ITEM_ESTIMATION_VERSION;
  /** Compatibility alias. It is calculated from, and always equals, rawStageEstimate. */
  readonly baselineEstimate: number;
  readonly rawStageEstimate: number;
  /** Compatibility projection of scenarioAuthorization.callEnvelopeMultiplier. */
  readonly callEnvelopeMultiplier: number;
  readonly stagePrimaryAuthorization: number;
  readonly stageLoopRetryReserve: number;
  readonly existingRecoveryReserve: number;
  readonly headroom: number;
  readonly authorizedLogicalCalls: number;
  readonly scenarioAuthorization: ScenarioCallAuthorization;
}

export interface CallEnvelopeInput {
  readonly rawStageEstimate: number;
  readonly stagePrimaryAuthorization: number;
  readonly stageLoopRetryReserve: number;
  readonly existingRecoveryReserve: number;
  readonly scenarioAuthorization: ScenarioCallAuthorization;
}

/**
 * A candidate starts with one model turn; each tool call can enable at most
 * one following turn.  The actual bounded estimate therefore cannot exceed
 * either declared model turns or maxToolCalls + 1.
 */
export function estimateCandidateItemModelCalls(maxModelTurns: number, maxToolCalls: number): number {
  if (!Number.isInteger(maxModelTurns) || maxModelTurns < 1) {
    throw new Error("CANDIDATE_ITEM_ESTIMATE_INVALID: maxModelTurns must be a positive integer");
  }
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new Error("CANDIDATE_ITEM_ESTIMATE_INVALID: maxToolCalls must be a non-negative integer");
  }
  return Math.min(maxModelTurns, maxToolCalls + 1);
}

function requireSafeNonNegativeInteger(name: string, value: number, positive = false): void {
  const minimum = positive ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`BUDGET_ENVELOPE_AUTHORIZATION_INVALID: ${name} must be a safe integer >= ${minimum}`);
  }
}

/**
 * Calculate the candidate-item multiplier boundary: raw scenario r becomes
 * per-attempt authorization p. Runtime bounds are derived from that same p;
 * stage-level primary capacity is calculated separately from the same M.
 */
export function calculateScenarioCallAuthorization(
  maxModelTurns: number,
  maxToolCalls: number,
  callEnvelopeMultiplier = 2,
  maxApplicationAttempts: 1 | 2 = 2,
): ScenarioCallAuthorization {
  const rawScenarioEstimate = estimateCandidateItemModelCalls(maxModelTurns, maxToolCalls);
  if (!Number.isFinite(callEnvelopeMultiplier) || callEnvelopeMultiplier < 1) {
    throw new Error("BUDGET_ENVELOPE_MULTIPLIER_INVALID: callEnvelopeMultiplier must be finite and >= 1");
  }
  if (maxApplicationAttempts !== 1 && maxApplicationAttempts !== 2) {
    throw new Error("BUDGET_ENVELOPE_ATTEMPTS_INVALID: maxApplicationAttempts must be 1 or 2");
  }
  const authorizedModelCallsPerAttempt = Math.ceil(rawScenarioEstimate * callEnvelopeMultiplier);
  requireSafeNonNegativeInteger("authorizedModelCallsPerAttempt", authorizedModelCallsPerAttempt, true);
  const scenarioRetryReserve = authorizedModelCallsPerAttempt * (maxApplicationAttempts - 1);
  requireSafeNonNegativeInteger("scenarioRetryReserve", scenarioRetryReserve);
  return Object.freeze({
    rawScenarioEstimate,
    callEnvelopeMultiplier,
    authorizedModelCallsPerAttempt,
    authorizedMaxTurns: authorizedModelCallsPerAttempt,
    authorizedMaxToolCalls: Math.max(0, authorizedModelCallsPerAttempt - 1),
    maxApplicationAttempts,
    scenarioRetryReserve,
  });
}

/**
 * Expand candidate-item primary work from each independently rounded p, then
 * add the multiplier headroom for the remaining fixed protocol calls. This
 * prevents a fractional M from authorizing p at the runner while underfunding
 * the same p at the stage boundary.
 */
export function calculateStagePrimaryAuthorization(
  scenarioOperationCount: number,
  fixedRawCalls: number,
  scenarioAuthorization: ScenarioCallAuthorization,
): number {
  requireSafeNonNegativeInteger("scenarioOperationCount", scenarioOperationCount);
  requireSafeNonNegativeInteger("fixedRawCalls", fixedRawCalls);
  const scenarioPrimary = scenarioOperationCount * scenarioAuthorization.authorizedModelCallsPerAttempt;
  const fixedPrimary = Math.ceil(fixedRawCalls * scenarioAuthorization.callEnvelopeMultiplier);
  requireSafeNonNegativeInteger("scenarioPrimaryAuthorization", scenarioPrimary);
  requireSafeNonNegativeInteger("fixedPrimaryAuthorization", fixedPrimary);
  const total = scenarioPrimary + fixedPrimary;
  requireSafeNonNegativeInteger("stagePrimaryAuthorization", total, true);
  return total;
}

/** Sum independently calculated primary, loop-retry, and existing recovery reserves. */
export function calculateCallEnvelope(input: CallEnvelopeInput): CallEnvelope {
  requireSafeNonNegativeInteger("rawStageEstimate", input.rawStageEstimate, true);
  requireSafeNonNegativeInteger("stagePrimaryAuthorization", input.stagePrimaryAuthorization, true);
  requireSafeNonNegativeInteger("stageLoopRetryReserve", input.stageLoopRetryReserve);
  requireSafeNonNegativeInteger("existingRecoveryReserve", input.existingRecoveryReserve);
  const scenario = input.scenarioAuthorization;
  if (
    (scenario.maxApplicationAttempts !== 1 && scenario.maxApplicationAttempts !== 2) ||
    !Number.isFinite(scenario.callEnvelopeMultiplier) ||
    scenario.callEnvelopeMultiplier < 1
  ) {
    throw new Error("BUDGET_ENVELOPE_AUTHORIZATION_INVALID: scenarioAuthorization bounds are invalid");
  }
  requireSafeNonNegativeInteger("rawScenarioEstimate", scenario.rawScenarioEstimate, true);
  requireSafeNonNegativeInteger(
    "authorizedModelCallsPerAttempt",
    scenario.authorizedModelCallsPerAttempt,
    true,
  );
  requireSafeNonNegativeInteger("authorizedMaxTurns", scenario.authorizedMaxTurns, true);
  requireSafeNonNegativeInteger("authorizedMaxToolCalls", scenario.authorizedMaxToolCalls);
  requireSafeNonNegativeInteger("scenarioRetryReserve", scenario.scenarioRetryReserve);
  if (
    scenario.authorizedModelCallsPerAttempt !==
      Math.ceil(scenario.rawScenarioEstimate * scenario.callEnvelopeMultiplier) ||
    scenario.authorizedMaxTurns !== scenario.authorizedModelCallsPerAttempt ||
    scenario.authorizedMaxToolCalls !== Math.max(0, scenario.authorizedModelCallsPerAttempt - 1) ||
    scenario.scenarioRetryReserve !==
      scenario.authorizedModelCallsPerAttempt * (scenario.maxApplicationAttempts - 1)
  ) {
    throw new Error("BUDGET_ENVELOPE_AUTHORIZATION_INVALID: scenarioAuthorization is internally inconsistent");
  }
  const minimumStagePrimaryAuthorization = Math.ceil(
    input.rawStageEstimate * scenario.callEnvelopeMultiplier,
  );
  requireSafeNonNegativeInteger(
    "minimumStagePrimaryAuthorization",
    minimumStagePrimaryAuthorization,
    true,
  );
  if (input.stagePrimaryAuthorization < minimumStagePrimaryAuthorization) {
    throw new Error(
      "BUDGET_ENVELOPE_AUTHORIZATION_INVALID: stagePrimaryAuthorization cannot underfund ceil(rawStageEstimate * callEnvelopeMultiplier)",
    );
  }
  if (scenario.maxApplicationAttempts === 1 && input.stageLoopRetryReserve !== 0) {
    throw new Error("BUDGET_ENVELOPE_AUTHORIZATION_INVALID: a single-attempt stage cannot reserve a loop retry");
  }
  const authorizedLogicalCalls =
    input.stagePrimaryAuthorization + input.stageLoopRetryReserve + input.existingRecoveryReserve;
  requireSafeNonNegativeInteger("authorizedLogicalCalls", authorizedLogicalCalls, true);
  const headroom = authorizedLogicalCalls - input.rawStageEstimate;
  requireSafeNonNegativeInteger("headroom", headroom);
  return Object.freeze({
    estimationVersion: CANDIDATE_ITEM_ESTIMATION_VERSION,
    baselineEstimate: input.rawStageEstimate,
    rawStageEstimate: input.rawStageEstimate,
    callEnvelopeMultiplier: scenario.callEnvelopeMultiplier,
    stagePrimaryAuthorization: input.stagePrimaryAuthorization,
    stageLoopRetryReserve: input.stageLoopRetryReserve,
    existingRecoveryReserve: input.existingRecoveryReserve,
    headroom,
    authorizedLogicalCalls,
    scenarioAuthorization: Object.freeze({ ...scenario }),
  });
}

export function callEnvelopesEqual(left: CallEnvelope, right: CallEnvelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Calculate independent minimum logical-call envelopes from the frozen protocol. */
export function calculateStageBudgets(input: StageBudgetInputs): StageBudgetPlan {
  const integerInputs = Object.entries(input).filter(
    ([name]) => name !== "budgetMultiplier",
  ) as Array<[keyof StageBudgetInputs, number]>;
  for (const [name, value] of integerInputs) {
    requireNonNegativeInteger(name, value);
  }
  if (input.shortlistCandidates < 1 || input.selectItems < 1 || input.holdoutItems < 1) {
    throw new Error("STAGE_BUDGET_INPUT_INVALID: shortlistCandidates, selectItems and holdoutItems must be positive");
  }
  if (input.semanticBatchSize < 1) {
    throw new Error("STAGE_BUDGET_INPUT_INVALID: semanticBatchSize must be positive");
  }
  if (input.directProposerCalls < 1) {
    throw new Error("STAGE_BUDGET_INPUT_INVALID: directProposerCalls must be positive");
  }

  const maxModelTurns = input.maxModelTurns;
  const maxToolCalls = input.maxToolCalls;
  requireNonNegativeInteger("maxModelTurns", maxModelTurns);
  requireNonNegativeInteger("maxToolCalls", maxToolCalls);
  if (maxModelTurns < 1) {
    throw new Error("STAGE_BUDGET_INPUT_INVALID: maxModelTurns must be positive");
  }

  const semanticSelectBatches = Math.ceil(input.selectItems / input.semanticBatchSize);
  const semanticHoldoutBatches = Math.ceil(input.holdoutItems / input.semanticBatchSize);
  const multiplier = input.budgetMultiplier ?? 2;
  const retryableScenario = calculateScenarioCallAuthorization(maxModelTurns, maxToolCalls, multiplier, 2);
  const sealedScenario = calculateScenarioCallAuthorization(maxModelTurns, maxToolCalls, multiplier, 1);
  const publicScenarioCount = input.shortlistCandidates * input.selectItems;
  const publicFixedCalls = input.shortlistCandidates * semanticSelectBatches;
  const publicSemanticRecoveryReserve = input.shortlistCandidates * semanticSelectBatches;
  const directScenarioCount = input.selectItems;
  const directFixedCalls = input.directProposerCalls + semanticSelectBatches;
  // U1 one-shot Direct produces one semantic-scored candidate per proposer
  // call. Each frozen semantic batch owns one, and only one, schema repair.
  const directSemanticRecoveryReserve = input.directProposerCalls * semanticSelectBatches;
  const sealedScenarioCount = 3 * input.holdoutItems;
  const sealedFixedCalls = 3 * semanticHoldoutBatches;
  const publicRawStageEstimate =
    publicScenarioCount * retryableScenario.rawScenarioEstimate + publicFixedCalls;
  const directRawStageEstimate =
    directScenarioCount * retryableScenario.rawScenarioEstimate + directFixedCalls;
  const sealedRawStageEstimate =
    sealedScenarioCount * sealedScenario.rawScenarioEstimate + sealedFixedCalls;
  const publicSelect = calculateCallEnvelope({
    rawStageEstimate: publicRawStageEstimate,
    stagePrimaryAuthorization: calculateStagePrimaryAuthorization(
      publicScenarioCount,
      publicFixedCalls,
      retryableScenario,
    ),
    stageLoopRetryReserve: publicScenarioCount * retryableScenario.scenarioRetryReserve,
    existingRecoveryReserve: publicSemanticRecoveryReserve,
    scenarioAuthorization: retryableScenario,
  });
  const direct = calculateCallEnvelope({
    rawStageEstimate: directRawStageEstimate,
    stagePrimaryAuthorization: calculateStagePrimaryAuthorization(
      directScenarioCount,
      directFixedCalls,
      retryableScenario,
    ),
    stageLoopRetryReserve: directScenarioCount * retryableScenario.scenarioRetryReserve,
    existingRecoveryReserve: directSemanticRecoveryReserve,
    scenarioAuthorization: retryableScenario,
  });
  const sealed = calculateCallEnvelope({
    rawStageEstimate: sealedRawStageEstimate,
    stagePrimaryAuthorization: calculateStagePrimaryAuthorization(
      sealedScenarioCount,
      sealedFixedCalls,
      sealedScenario,
    ),
    stageLoopRetryReserve: 0,
    existingRecoveryReserve: 0,
    scenarioAuthorization: sealedScenario,
  });
  return {
    publicSelect: publicSelect.authorizedLogicalCalls,
    direct: direct.authorizedLogicalCalls,
    sealed: sealed.authorizedLogicalCalls,
    assumptions: { ...input, budgetMultiplier: multiplier },
    envelope: Object.freeze({
      publicSelect,
      direct,
      sealed,
    }),
  };
}

/**
 * Fail closed per stage. Surplus in one stage is deliberately ignored and
 * cannot subsidize an underfunded public-select, Direct, or sealed protocol.
 */
export function assertStageBudgetsFunded(
  minimums: StageBudgetPlan,
  authorized: AuthorizedStageBudgets,
): void {
  for (const stage of ["publicSelect", "direct", "sealed"] as const) {
    const cap = authorized[stage];
    if (!Number.isInteger(cap) || cap < minimums[stage]) {
      throw new StageFundingError(stage, minimums[stage], cap);
    }
  }
}
