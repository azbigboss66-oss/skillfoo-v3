import { stableStringify } from "../intake/taskCard.js";
import {
  calculateCallEnvelope,
  calculateScenarioCallAuthorization,
  calculateStagePrimaryAuthorization,
  estimateCandidateItemModelCalls,
  type CallEnvelope,
} from "../providers/stageBudgets.js";

/** Current semantic scorer batches at most three public items per request. */
export const ADAPTIVE_SEMANTIC_BATCH_SIZE = 3;

export interface AdaptiveClosureBudgetInput {
  /** Unique B0/S0 roots after SKILL.md hash deduplication. */
  rootCandidates: number;
  publicTrainItems: number;
  /** Public bootstrap slice; never sealed holdout. */
  pinnedItems: number;
  semanticBatchSize: number;
  minChildGenerations: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxRefinements: number;
  budgetMultiplier: number;
}

export interface AdaptiveClosureBudgetPlan {
  readonly minimum: number;
  readonly assumptions: Readonly<{
    rootCandidates: number;
    publicTrainItems: number;
    pinnedItems: number;
    semanticBatchSize: number;
    minChildGenerations: number;
    lanesPerGeneration: number;
    childCandidates: number;
    totalCandidates: number;
    evaluatorCallsPerCandidate: number;
    pinnedSemanticCallsPerCandidate: number;
    fullSemanticCallsPerCandidate: number;
    semanticCallsPerCandidate: number;
    mutationCalls: number;
    maxModelTurns: number;
    maxToolCalls: number;
    maxRefinements: number;
    budgetMultiplier: number;
    rawCandidateItemCallsPerCandidate: number;
    candidateItemCallsPerCandidate: number;
  }>;
  readonly primaryMinimum: number;
  readonly proposerRecoverySlots: number;
  readonly semanticRecoveryBatches: number;
  readonly recoveryReserve: number;
  readonly loopRetryReserve: number;
  readonly envelope: CallEnvelope;
}

export interface AdaptiveClosureBudgetEvidence extends AdaptiveClosureBudgetPlan {
  readonly authorized: number;
  readonly margin: number;
  readonly satisfied: true;
}

export class AdaptiveClosureProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AdaptiveClosureProtocolError";
  }
}

function positiveInteger(field: keyof AdaptiveClosureBudgetInput, value: number, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new AdaptiveClosureProtocolError(
      "ADAPTIVE_BUDGET_SHAPE_INVALID",
      `${field} must be an integer >= ${minimum} (got ${value})`,
    );
  }
  return value;
}

/**
 * Calculate the single current Adaptive B/M/H envelope. Candidate-item model
 * turns, the one clean loop retry, proposer repair and semantic schema repair
 * are independent reservations and are counted exactly once.
 */
export function calculateAdaptiveClosureBudget(input: AdaptiveClosureBudgetInput): AdaptiveClosureBudgetPlan {
  const rootCandidates = positiveInteger("rootCandidates", input.rootCandidates);
  const publicTrainItems = positiveInteger("publicTrainItems", input.publicTrainItems);
  const pinnedItems = positiveInteger("pinnedItems", input.pinnedItems, true);
  const semanticBatchSize = positiveInteger("semanticBatchSize", input.semanticBatchSize);
  const minChildGenerations = positiveInteger("minChildGenerations", input.minChildGenerations);
  const maxModelTurns = positiveInteger("maxModelTurns", input.maxModelTurns);
  const maxToolCalls = positiveInteger("maxToolCalls", input.maxToolCalls, true);
  const maxRefinements = positiveInteger("maxRefinements", input.maxRefinements, true);
  if (!Number.isFinite(input.budgetMultiplier) || input.budgetMultiplier < 1) {
    throw new AdaptiveClosureProtocolError(
      "ADAPTIVE_BUDGET_SHAPE_INVALID",
      `budgetMultiplier must be a finite number >= 1 (got ${input.budgetMultiplier})`,
    );
  }
  const budgetMultiplier = input.budgetMultiplier;
  if (pinnedItems > publicTrainItems) {
    throw new AdaptiveClosureProtocolError(
      "ADAPTIVE_BUDGET_SHAPE_INVALID",
      `pinnedItems (${pinnedItems}) cannot exceed publicTrainItems (${publicTrainItems})`,
    );
  }

  const lanesPerGeneration = 2;
  const childCandidates = lanesPerGeneration * minChildGenerations * (maxRefinements + 1);
  const totalCandidates = rootCandidates + childCandidates;
  const rawScenarioEstimate = estimateCandidateItemModelCalls(maxModelTurns, maxToolCalls);
  const scenarioAuthorization = calculateScenarioCallAuthorization(
    maxModelTurns,
    maxToolCalls,
    budgetMultiplier,
    2,
  );
  const rawEvaluatorCallsPerCandidate = publicTrainItems * rawScenarioEstimate;
  const evaluatorCallsPerCandidate = publicTrainItems * scenarioAuthorization.authorizedModelCallsPerAttempt;
  const pinnedSemanticCallsPerCandidate = Math.ceil(pinnedItems / semanticBatchSize);
  const fullSemanticCallsPerCandidate = Math.ceil(publicTrainItems / semanticBatchSize);
  const semanticCallsPerCandidate = pinnedSemanticCallsPerCandidate + fullSemanticCallsPerCandidate;
  const mutationCalls = childCandidates;
  const scenarioOperationCount = totalCandidates * publicTrainItems;
  const fixedRawCalls = totalCandidates * semanticCallsPerCandidate + mutationCalls;
  const rawStageEstimate = totalCandidates * (
    rawEvaluatorCallsPerCandidate + semanticCallsPerCandidate
  ) + mutationCalls;
  const primaryMinimum = calculateStagePrimaryAuthorization(
    scenarioOperationCount,
    fixedRawCalls,
    scenarioAuthorization,
  );
  const loopRetryReserve = scenarioOperationCount * scenarioAuthorization.scenarioRetryReserve;
  const proposerRecoverySlots = childCandidates;
  const semanticRecoveryBatches = totalCandidates * semanticCallsPerCandidate;
  const recoveryReserve = proposerRecoverySlots + semanticRecoveryBatches;
  const envelope = calculateCallEnvelope({
    rawStageEstimate,
    stagePrimaryAuthorization: primaryMinimum,
    stageLoopRetryReserve: loopRetryReserve,
    existingRecoveryReserve: recoveryReserve,
    scenarioAuthorization,
  });

  return Object.freeze({
    minimum: envelope.authorizedLogicalCalls,
    assumptions: Object.freeze({
      rootCandidates,
      publicTrainItems,
      pinnedItems,
      semanticBatchSize,
      minChildGenerations,
      lanesPerGeneration,
      childCandidates,
      totalCandidates,
      evaluatorCallsPerCandidate,
      pinnedSemanticCallsPerCandidate,
      fullSemanticCallsPerCandidate,
      semanticCallsPerCandidate,
      mutationCalls,
      maxModelTurns,
      maxToolCalls,
      maxRefinements,
      budgetMultiplier,
      rawCandidateItemCallsPerCandidate: rawEvaluatorCallsPerCandidate,
      candidateItemCallsPerCandidate: evaluatorCallsPerCandidate,
    }),
    primaryMinimum,
    proposerRecoverySlots,
    semanticRecoveryBatches,
    recoveryReserve,
    loopRetryReserve,
    envelope,
  });
}

function validateAdaptiveBudgetPlan(plan: AdaptiveClosureBudgetPlan): void {
  const expectedScenario = calculateScenarioCallAuthorization(
    plan.assumptions.maxModelTurns,
    plan.assumptions.maxToolCalls,
    plan.assumptions.budgetMultiplier,
    2,
  );
  const expectedChildren =
    plan.assumptions.lanesPerGeneration *
    plan.assumptions.minChildGenerations *
    (plan.assumptions.maxRefinements + 1);
  const rawEvaluatorCallsPerCandidate =
    plan.assumptions.publicTrainItems * expectedScenario.rawScenarioEstimate;
  const evaluatorCallsPerCandidate =
    plan.assumptions.publicTrainItems * expectedScenario.authorizedModelCallsPerAttempt;
  const rawStageEstimate = plan.assumptions.totalCandidates * (
    rawEvaluatorCallsPerCandidate + plan.assumptions.semanticCallsPerCandidate
  ) + plan.assumptions.mutationCalls;
  const scenarioOperationCount = plan.assumptions.totalCandidates * plan.assumptions.publicTrainItems;
  const fixedRawCalls =
    plan.assumptions.totalCandidates * plan.assumptions.semanticCallsPerCandidate +
    plan.assumptions.mutationCalls;
  const stagePrimaryAuthorization = calculateStagePrimaryAuthorization(
    scenarioOperationCount,
    fixedRawCalls,
    expectedScenario,
  );
  const stageLoopRetryReserve = scenarioOperationCount * expectedScenario.scenarioRetryReserve;
  const expectedProposerRecoverySlots = expectedChildren;
  const expectedSemanticRecoveryBatches =
    plan.assumptions.totalCandidates * plan.assumptions.semanticCallsPerCandidate;
  const expectedRecoveryReserve = expectedProposerRecoverySlots + expectedSemanticRecoveryBatches;
  const expectedEnvelope = calculateCallEnvelope({
    rawStageEstimate,
    stagePrimaryAuthorization,
    stageLoopRetryReserve,
    existingRecoveryReserve: expectedRecoveryReserve,
    scenarioAuthorization: expectedScenario,
  });
  if (
    plan.assumptions.childCandidates !== expectedChildren ||
    plan.assumptions.totalCandidates !== plan.assumptions.rootCandidates + expectedChildren ||
    plan.assumptions.rawCandidateItemCallsPerCandidate !== rawEvaluatorCallsPerCandidate ||
    plan.assumptions.candidateItemCallsPerCandidate !== evaluatorCallsPerCandidate ||
    plan.assumptions.evaluatorCallsPerCandidate !== evaluatorCallsPerCandidate ||
    plan.primaryMinimum !== stagePrimaryAuthorization ||
    plan.loopRetryReserve !== stageLoopRetryReserve ||
    plan.proposerRecoverySlots !== expectedProposerRecoverySlots ||
    plan.semanticRecoveryBatches !== expectedSemanticRecoveryBatches ||
    plan.recoveryReserve !== expectedRecoveryReserve ||
    plan.minimum !== expectedEnvelope.authorizedLogicalCalls ||
    stableStringify(plan.envelope) !== stableStringify(expectedEnvelope)
  ) {
    throw new AdaptiveClosureProtocolError(
      "ADAPTIVE_BUDGET_ENVELOPE_INVALID",
      "Adaptive budget does not match the current r-to-p and recovery-reserve formula",
    );
  }
}

/** Fail closed before Provider access when the independent Adaptive budget is too small. */
export function buildAdaptiveClosureBudgetEvidence(
  plan: AdaptiveClosureBudgetPlan,
  authorized: number,
): AdaptiveClosureBudgetEvidence {
  validateAdaptiveBudgetPlan(plan);
  if (!Number.isSafeInteger(authorized) || authorized < plan.minimum) {
    throw new AdaptiveClosureProtocolError(
      "ADAPTIVE_BUDGET_INSUFFICIENT",
      `authorized Adaptive logical-call budget ${authorized} is below the calculated minimum ${plan.minimum}`,
    );
  }
  return Object.freeze({
    ...plan,
    authorized,
    margin: authorized - plan.minimum,
    satisfied: true,
  });
}
