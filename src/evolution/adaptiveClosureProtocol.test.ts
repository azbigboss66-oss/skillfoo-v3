import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdaptiveClosureBudgetEvidence,
  calculateAdaptiveClosureBudget,
} from "./adaptiveClosureProtocol.js";

test("Adaptive B/M/H includes lanes, generations, refinements, multi-turn calls, and recovery", () => {
  const bounded = calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: 2,
    pinnedItems: 1,
    semanticBatchSize: 1,
    minChildGenerations: 2,
    maxModelTurns: 2,
    maxToolCalls: 1,
    maxRefinements: 1,
    budgetMultiplier: 2,
  });
  const expandedTurns = calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: 2,
    pinnedItems: 1,
    semanticBatchSize: 1,
    minChildGenerations: 2,
    maxModelTurns: 3,
    maxToolCalls: 2,
    maxRefinements: 1,
    budgetMultiplier: 2,
  });

  assert.equal(bounded.assumptions.lanesPerGeneration, 2);
  assert.equal(bounded.assumptions.childCandidates, 8);
  assert.equal(bounded.assumptions.rawCandidateItemCallsPerCandidate, 4);
  assert.equal(bounded.assumptions.candidateItemCallsPerCandidate, 8);
  assert.equal(bounded.primaryMinimum, 156);
  assert.equal(bounded.loopRetryReserve, 80);
  assert.equal(bounded.recoveryReserve, 38);
  assert.deepEqual(bounded.envelope, {
    estimationVersion: "candidate-item-envelope-v2",
    baselineEstimate: 78,
    rawStageEstimate: 78,
    callEnvelopeMultiplier: 2,
    stagePrimaryAuthorization: 156,
    stageLoopRetryReserve: 80,
    existingRecoveryReserve: 38,
    headroom: 196,
    authorizedLogicalCalls: 274,
    scenarioAuthorization: {
      rawScenarioEstimate: 2,
      callEnvelopeMultiplier: 2,
      authorizedModelCallsPerAttempt: 4,
      authorizedMaxTurns: 4,
      authorizedMaxToolCalls: 3,
      maxApplicationAttempts: 2,
      scenarioRetryReserve: 4,
    },
  });
  assert.equal(bounded.minimum, 274);
  assert.equal(buildAdaptiveClosureBudgetEvidence(bounded, 274).margin, 0);
  assert.deepEqual(expandedTurns.envelope, {
    estimationVersion: "candidate-item-envelope-v2",
    baselineEstimate: 98,
    rawStageEstimate: 98,
    callEnvelopeMultiplier: 2,
    stagePrimaryAuthorization: 196,
    stageLoopRetryReserve: 120,
    existingRecoveryReserve: 38,
    headroom: 256,
    authorizedLogicalCalls: 354,
    scenarioAuthorization: {
      rawScenarioEstimate: 3,
      callEnvelopeMultiplier: 2,
      authorizedModelCallsPerAttempt: 6,
      authorizedMaxTurns: 6,
      authorizedMaxToolCalls: 5,
      maxApplicationAttempts: 2,
      scenarioRetryReserve: 6,
    },
  });
  assert.equal(expandedTurns.minimum, 354);
});

test("Adaptive fractional M reserves the sum of each scenario p instead of rounding the raw stage once", () => {
  const plan = calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: 2,
    pinnedItems: 1,
    semanticBatchSize: 1,
    minChildGenerations: 2,
    maxModelTurns: 3,
    maxToolCalls: 2,
    maxRefinements: 1,
    budgetMultiplier: 1.5,
  });

  assert.equal(plan.envelope.rawStageEstimate, 98);
  assert.equal(plan.envelope.scenarioAuthorization.authorizedModelCallsPerAttempt, 5);
  // 20 candidate-items * p=5 plus ceil(38 fixed calls * 1.5).
  assert.equal(plan.envelope.stagePrimaryAuthorization, 157);
  assert.equal(plan.envelope.stageLoopRetryReserve, 100);
  assert.equal(plan.envelope.existingRecoveryReserve, 38);
  assert.equal(plan.minimum, 295);
});
