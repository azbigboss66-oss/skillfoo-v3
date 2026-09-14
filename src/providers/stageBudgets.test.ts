import test from "node:test";
import assert from "node:assert/strict";
import {
  StageFundingError,
  assertStageBudgetsFunded,
  calculateScenarioCallAuthorization,
  calculateStageBudgets,
  estimateCandidateItemModelCalls,
} from "./stageBudgets.js";

const input = {
  shortlistCandidates: 4,
  selectItems: 6,
  holdoutItems: 3,
  semanticBatchSize: 3,
  directProposerCalls: 1,
  maxModelTurns: 6,
  maxToolCalls: 4,
};

test("current stage budgets always persist the default multiplier and a complete B/M/H envelope", () => {
  const plan = calculateStageBudgets(input);
  assert.deepEqual(plan.assumptions, { ...input, budgetMultiplier: 2 });
  assert.equal(plan.publicSelect, plan.envelope.publicSelect.authorizedLogicalCalls);
  assert.equal(plan.direct, plan.envelope.direct.authorizedLogicalCalls);
  assert.equal(plan.sealed, plan.envelope.sealed.authorizedLogicalCalls);
  assert.deepEqual(
    { publicSelect: plan.publicSelect, direct: plan.direct, sealed: plan.sealed },
    { publicSelect: 504, direct: 128, sealed: 96 },
  );
});

test("multi-turn candidate-item envelopes vary with declared turns and tool calls", () => {
  const oneTurn = calculateStageBudgets({
    shortlistCandidates: 2,
    selectItems: 2,
    holdoutItems: 1,
    semanticBatchSize: 2,
    directProposerCalls: 1,
    maxModelTurns: 2,
    maxToolCalls: 1,
  });
  const manyTurns = calculateStageBudgets({
    shortlistCandidates: 2,
    selectItems: 2,
    holdoutItems: 1,
    semanticBatchSize: 2,
    directProposerCalls: 1,
    maxModelTurns: 3,
    maxToolCalls: 2,
  });

  assert.deepEqual(oneTurn.envelope, {
    publicSelect: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 10,
      rawStageEstimate: 10,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 20,
      stageLoopRetryReserve: 16,
      existingRecoveryReserve: 2,
      headroom: 28,
      authorizedLogicalCalls: 38,
      scenarioAuthorization: {
        rawScenarioEstimate: 2,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 4,
        authorizedMaxTurns: 4,
        authorizedMaxToolCalls: 3,
        maxApplicationAttempts: 2,
        scenarioRetryReserve: 4,
      },
    },
    direct: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 6,
      rawStageEstimate: 6,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 12,
      stageLoopRetryReserve: 8,
      existingRecoveryReserve: 1,
      headroom: 15,
      authorizedLogicalCalls: 21,
      scenarioAuthorization: {
        rawScenarioEstimate: 2,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 4,
        authorizedMaxTurns: 4,
        authorizedMaxToolCalls: 3,
        maxApplicationAttempts: 2,
        scenarioRetryReserve: 4,
      },
    },
    sealed: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 9,
      rawStageEstimate: 9,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 18,
      stageLoopRetryReserve: 0,
      existingRecoveryReserve: 0,
      headroom: 9,
      authorizedLogicalCalls: 18,
      scenarioAuthorization: {
        rawScenarioEstimate: 2,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 4,
        authorizedMaxTurns: 4,
        authorizedMaxToolCalls: 3,
        maxApplicationAttempts: 1,
        scenarioRetryReserve: 0,
      },
    },
  });
  assert.deepEqual(manyTurns.envelope, {
    publicSelect: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 14,
      rawStageEstimate: 14,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 28,
      stageLoopRetryReserve: 24,
      existingRecoveryReserve: 2,
      headroom: 40,
      authorizedLogicalCalls: 54,
      scenarioAuthorization: {
        rawScenarioEstimate: 3,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 6,
        authorizedMaxTurns: 6,
        authorizedMaxToolCalls: 5,
        maxApplicationAttempts: 2,
        scenarioRetryReserve: 6,
      },
    },
    direct: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 8,
      rawStageEstimate: 8,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 16,
      stageLoopRetryReserve: 12,
      existingRecoveryReserve: 1,
      headroom: 21,
      authorizedLogicalCalls: 29,
      scenarioAuthorization: {
        rawScenarioEstimate: 3,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 6,
        authorizedMaxTurns: 6,
        authorizedMaxToolCalls: 5,
        maxApplicationAttempts: 2,
        scenarioRetryReserve: 6,
      },
    },
    sealed: {
      estimationVersion: "candidate-item-envelope-v2",
      baselineEstimate: 12,
      rawStageEstimate: 12,
      callEnvelopeMultiplier: 2,
      stagePrimaryAuthorization: 24,
      stageLoopRetryReserve: 0,
      existingRecoveryReserve: 0,
      headroom: 12,
      authorizedLogicalCalls: 24,
      scenarioAuthorization: {
        rawScenarioEstimate: 3,
        callEnvelopeMultiplier: 2,
        authorizedModelCallsPerAttempt: 6,
        authorizedMaxTurns: 6,
        authorizedMaxToolCalls: 5,
        maxApplicationAttempts: 1,
        scenarioRetryReserve: 0,
      },
    },
  });
  assert.equal(oneTurn.publicSelect, 38);
  assert.equal(manyTurns.publicSelect, 54);
});

test("Case1 authorizes two candidate-loop attempts but never a sealed application retry", () => {
  const plan = calculateStageBudgets({
    ...input,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  });

  assert.deepEqual(
    {
      publicSelect: plan.publicSelect,
      direct: plan.direct,
      sealed: plan.sealed,
      publicAttempts: plan.envelope.publicSelect.scenarioAuthorization.maxApplicationAttempts,
      directAttempts: plan.envelope.direct.scenarioAuthorization.maxApplicationAttempts,
      sealedAttempts: plan.envelope.sealed.scenarioAuthorization.maxApplicationAttempts,
      sealedRetryReserve: plan.envelope.sealed.stageLoopRetryReserve,
      authorizedMaxTurns: plan.envelope.publicSelect.scenarioAuthorization.authorizedMaxTurns,
      authorizedMaxToolCalls: plan.envelope.publicSelect.scenarioAuthorization.authorizedMaxToolCalls,
    },
    {
      publicSelect: 504,
      direct: 128,
      sealed: 96,
      publicAttempts: 2,
      directAttempts: 2,
      sealedAttempts: 1,
      sealedRetryReserve: 0,
      authorizedMaxTurns: 10,
      authorizedMaxToolCalls: 9,
    },
  );
});

test("public-select and Direct reserve one semantic schema repair per candidate batch while sealed reserves none", () => {
  const plan = calculateStageBudgets({
    ...input,
    shortlistCandidates: 2,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  });

  assert.deepEqual(
    {
      publicRecovery: plan.envelope.publicSelect.existingRecoveryReserve,
      publicAuthorized: plan.publicSelect,
      directRecovery: plan.envelope.direct.existingRecoveryReserve,
      directAuthorized: plan.direct,
      sealedRecovery: plan.envelope.sealed.existingRecoveryReserve,
      sealedAuthorized: plan.sealed,
    },
    {
      publicRecovery: 4,
      publicAuthorized: 252,
      directRecovery: 2,
      directAuthorized: 128,
      sealedRecovery: 0,
      sealedAuthorized: 96,
    },
  );
});

test("candidate-item estimate is bounded by turns and tool-enabled follow-up turns, never a fixed constant", () => {
  assert.equal(estimateCandidateItemModelCalls(2, 1), 2);
  assert.equal(estimateCandidateItemModelCalls(9, 1), 2);
  assert.equal(estimateCandidateItemModelCalls(9, 6), 7);
});

test("scenario authorization applies M to raw r and gives the runner the same p bound", () => {
  assert.deepEqual(calculateScenarioCallAuthorization(9, 1, 1.1, 2), {
    rawScenarioEstimate: 2,
    callEnvelopeMultiplier: 1.1,
    authorizedModelCallsPerAttempt: 3,
    authorizedMaxTurns: 3,
    authorizedMaxToolCalls: 2,
    maxApplicationAttempts: 2,
    scenarioRetryReserve: 3,
  });
  assert.throws(
    () => calculateScenarioCallAuthorization(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2, 2),
    /BUDGET_ENVELOPE_AUTHORIZATION_INVALID/,
  );
});

test("fractional multipliers sum independently rounded scenario p capacity before stage authorization", () => {
  const plan = calculateStageBudgets({
    ...input,
    maxModelTurns: 3,
    maxToolCalls: 2,
    budgetMultiplier: 1.5,
  });
  assert.equal(plan.envelope.publicSelect.callEnvelopeMultiplier, 1.5);
  assert.equal(plan.envelope.publicSelect.rawStageEstimate, 80);
  assert.equal(plan.envelope.publicSelect.scenarioAuthorization.authorizedModelCallsPerAttempt, 5);
  // 24 candidate-items each receive p=5, then the 8 fixed calls receive
  // ceil(8*1.5)=12. A single ceil(80*1.5)=120 would underfund p by 12.
  assert.equal(plan.envelope.publicSelect.stagePrimaryAuthorization, 132);
  assert.equal(plan.envelope.publicSelect.stageLoopRetryReserve, 120);
  assert.equal(plan.envelope.publicSelect.existingRecoveryReserve, 8);
  assert.equal(plan.envelope.publicSelect.authorizedLogicalCalls, 260);
});

test("ceilings are applied independently inside the current dynamic envelope", () => {
  const plan = calculateStageBudgets({
    shortlistCandidates: 3,
    selectItems: 7,
    holdoutItems: 4,
    semanticBatchSize: 3,
    directProposerCalls: 2,
    maxModelTurns: 6,
    maxToolCalls: 4,
  });
  assert.equal(plan.publicSelect, 447);
  assert.equal(plan.direct, 156);
  assert.equal(plan.sealed, 132);
});

test("preflight rejects every independently underfunded stage", () => {
  const plan = calculateStageBudgets(input);
  for (const stage of ["publicSelect", "direct", "sealed"] as const) {
    const authorized = { publicSelect: plan.publicSelect, direct: plan.direct, sealed: plan.sealed };
    authorized[stage] -= 1;
    assert.throws(
      () => assertStageBudgetsFunded(plan, authorized),
      (error: unknown) => error instanceof StageFundingError && error.stage === stage && error.minimum === plan[stage],
    );
  }
});

test("unused capacity from one stage cannot fund another stage", () => {
  const plan = calculateStageBudgets(input);
  assert.throws(
    () => assertStageBudgetsFunded(plan, {
      publicSelect: plan.publicSelect + 100,
      direct: plan.direct - 1,
      sealed: plan.sealed,
    }),
    (error: unknown) => error instanceof StageFundingError && error.stage === "direct",
  );
});

test("budget calculation refuses invalid or zero protocol dimensions", () => {
  assert.throws(
    () => calculateStageBudgets({ ...input, semanticBatchSize: 0 }),
    /STAGE_BUDGET_INPUT_INVALID/,
  );
  assert.throws(
    () => calculateStageBudgets({ ...input, shortlistCandidates: 1.5 }),
    /STAGE_BUDGET_INPUT_INVALID/,
  );
  const missingRuntimeBounds = { ...input } as Record<string, unknown>;
  delete missingRuntimeBounds.maxModelTurns;
  delete missingRuntimeBounds.maxToolCalls;
  assert.throws(
    () => calculateStageBudgets(missingRuntimeBounds as never),
    /STAGE_BUDGET_INPUT_INVALID/,
  );
});
