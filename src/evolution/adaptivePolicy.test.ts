import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptivePolicyError,
  advanceStagnation,
  parseAdaptivePolicy,
  progressCertificateOf,
  recoverySuggestionForStop,
  routeAdaptiveStep,
  type AdaptivePolicyParams,
  type AdaptiveRouteState,
} from "./adaptivePolicy.js";
import { LIVE_BUDGET_RANGES, LIVE_ROLE_RANGES } from "../providers/liveRunPolicy.js";
import { calculateCallEnvelope, calculateScenarioCallAuthorization } from "../providers/stageBudgets.js";

const DEFAULT_CALL_ENVELOPE = calculateCallEnvelope({
  rawStageEstimate: 20,
  stagePrimaryAuthorization: 40,
  stageLoopRetryReserve: 0,
  existingRecoveryReserve: 0,
  scenarioAuthorization: calculateScenarioCallAuthorization(2, 1, 2, 2),
});

function fullParams(overrides: Partial<AdaptivePolicyParams> = {}): AdaptivePolicyParams {
  return {
    formalHumanU1B: true,
    maxGenerations: 2,
    maxRefinementsPerCandidate: 1,
    minRepairProgress: 2,
    stagnationPatience: 1,
    mode: "standard",
    earlyRepair: "auto",
    u1CallEnvelope: DEFAULT_CALL_ENVELOPE,
    maxRetryAttempts: 1,
    requestTimeoutMs: 8_000,
    maxOutputTokens: 1_200,
    ...overrides,
  };
}

function healthyState(overrides: Partial<AdaptiveRouteState> = {}): AdaptiveRouteState {
  return {
    budgetRemainingLogicalCalls: 30,
    safetyViolations: 0,
    b0s0SameCoreFailure: false,
    contractConfidenceLow: false,
    failureClasses: ["output_structure"],
    protectedDimensionRegression: false,
    lastRepairProgressed: null,
    refinementsUsed: 0,
    consecutiveStagnation: 0,
    ...overrides,
  };
}

// ── parseAdaptivePolicy: manual parameters, explicit everything ──

test("parseAdaptivePolicy accepts only the current formal-human standard policy and derives the HTTP ceiling", () => {
  const policy = parseAdaptivePolicy(fullParams());
  assert.equal(policy.explorationOnly, false);
  assert.equal(policy.maxHttpAttempts, 41, "logical 40 + run-wide retry 1");
  assert.equal(policy.mode, "standard");
  assert.equal(policy.earlyRepair, "auto");
  assert.equal(policy.minChildGenerations, 2);
  assert.equal(policy.structureRecoveryEnabled, true);
});

test("current policy rejects a missing human authority, fast mode, or fewer than two generations", () => {
  for (const invalid of [
    { formalHumanU1B: undefined },
    { maxGenerations: 1 },
    { mode: "fast" },
  ] as Array<Record<string, unknown>>) {
    assert.throws(
      () => parseAdaptivePolicy({
        ...fullParams(),
        ...invalid,
      } as unknown as AdaptivePolicyParams),
      (error: unknown) =>
        error instanceof AdaptivePolicyError &&
        (error.code === "ADAPTIVE_FORMAL_U1_POLICY_INVALID" || error.code === "ADAPTIVE_POLICY_INVALID"),
    );
  }
});

test("out-of-range generation/refinement/patience values are rejected with the field spelled out", () => {
  for (const bad of [0, 5, 1.5, -1]) {
    assert.throws(
      () => parseAdaptivePolicy(fullParams({ maxGenerations: bad })),
      (e: unknown) => e instanceof AdaptivePolicyError && /maxGenerations/.test(e.message),
    );
  }
  for (const bad of [-1, 5, 2.5]) {
    assert.throws(
      () => parseAdaptivePolicy(fullParams({ maxRefinementsPerCandidate: bad })),
      (e: unknown) => e instanceof AdaptivePolicyError && /maxRefinementsPerCandidate/.test(e.message),
    );
  }
  for (const bad of [0, 4, 1.5]) {
    assert.throws(
      () => parseAdaptivePolicy(fullParams({ stagnationPatience: bad })),
      (e: unknown) => e instanceof AdaptivePolicyError && /stagnationPatience/.test(e.message),
    );
  }
});

test("minRepairProgress is absolute public-score points in (0, 100]: 2 passes; 0, negative, and >100 are rejected with points in the message", () => {
  parseAdaptivePolicy(fullParams({ minRepairProgress: 2 }));
  parseAdaptivePolicy(fullParams({ minRepairProgress: 100 }));
  for (const bad of [0, -0.5, -1, 100.01, 101, Infinity, NaN]) {
    assert.throws(
      () => parseAdaptivePolicy(fullParams({ minRepairProgress: bad })),
      (e: unknown) => e instanceof AdaptivePolicyError && /minRepairProgress/.test(e.message) && /points/.test(e.message),
      `minRepairProgress=${bad} must be rejected`,
    );
  }
});

test("mode and earlyRepair must be from the closed enum", () => {
  for (const bad of ["fast", "turbo", "", "FAST"] as unknown as AdaptivePolicyParams["mode"][]) {
    assert.throws(() => parseAdaptivePolicy(fullParams({ mode: bad })), AdaptivePolicyError);
  }
  for (const bad of ["on", "", "AUTO"] as unknown as AdaptivePolicyParams["earlyRepair"][]) {
    assert.throws(() => parseAdaptivePolicy(fullParams({ earlyRepair: bad })), AdaptivePolicyError);
  }
});

test("transport and proposer-role numbers reuse the exact LiveRunPolicy ranges — no second budget system", () => {
  // requestTimeoutMs/maxOutputTokens use the proposer role range so an
  // Adaptive run can authorize a full SKILL.md output.
  const outOfRange = {
    maxRetryAttempts: LIVE_BUDGET_RANGES.maxRetryAttempts.max + 1,
    requestTimeoutMs: LIVE_ROLE_RANGES.proposer.requestTimeoutMs.max + 1,
    maxOutputTokens: LIVE_ROLE_RANGES.proposer.maxOutputTokens.max + 1,
  } as const;
  for (const [field, value] of Object.entries(outOfRange)) {
    assert.throws(
      () => parseAdaptivePolicy(fullParams({ [field]: value } as Partial<AdaptivePolicyParams>)),
      (e: unknown) => e instanceof AdaptivePolicyError && e.message.includes(field),
    );
  }
});

test("current U1 derives H from the shared dynamic envelope and rejects a missing envelope", () => {
  const scenario = calculateScenarioCallAuthorization(6, 4, 2, 2);
  const envelope = calculateCallEnvelope({
    rawStageEstimate: 300,
    stagePrimaryAuthorization: 600,
    stageLoopRetryReserve: 200,
    existingRecoveryReserve: 30,
    scenarioAuthorization: scenario,
  });
  assert.equal(envelope.authorizedLogicalCalls, 830);
  assert.equal(parseAdaptivePolicy(fullParams({ u1CallEnvelope: envelope })).maxLogicalCalls, 830);
  assert.throws(
    () => parseAdaptivePolicy(fullParams({ u1CallEnvelope: undefined as unknown as AdaptivePolicyParams["u1CallEnvelope"] })),
    (error: unknown) =>
      error instanceof AdaptivePolicyError &&
      error.code === "ADAPTIVE_POLICY_DYNAMIC_ENVELOPE_MISMATCH",
    "a manual budget without the current dynamic envelope is rejected",
  );
});

// ── routing rule 5: budget exhausted or consecutive stagnation → stop ──

test("rule 5: zero remaining logical budget stops with a recovery suggestion", () => {
  const decision = routeAdaptiveStep(parseAdaptivePolicy(fullParams()), healthyState({ budgetRemainingLogicalCalls: 0 }));
  assert.equal(decision.route, "stop");
  assert.match(decision.reason, /budget_exhausted/);
  assert.ok(decision.recoverySuggestion, "a stop must tell the operator what to do on resubmission");
});

test("rule 5: stagnation at patience stops, single un-progressed local cause suggests mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ stagnationPatience: 2 })),
    healthyState({ consecutiveStagnation: 2, lastRepairProgressed: false, refinementsUsed: 1 }),
  );
  assert.equal(decision.route, "stop");
  assert.match(decision.reason, /stagnation/);
  assert.equal(decision.recoverySuggestion, "mutate");
});

// ── routing rule 1: safety/permission failure kills refinement entirely ──

test("rule 1: a safety violation routes to killed_rebuild even when earlyRepair=force and budget is fine", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ earlyRepair: "force" })),
    healthyState({ safetyViolations: 1 }),
  );
  assert.equal(decision.route, "killed_rebuild");
  assert.match(decision.reason, /safety/);
  assert.equal(decision.recoverySuggestion, "rebuild");
});

// ── routing rule 4: same core failure / low contract confidence → root rebuild ──

test("rule 4: B0/S0 sharing one core failure routes to root_rebuild, never blind refinement", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams()),
    healthyState({ b0s0SameCoreFailure: true }),
  );
  assert.equal(decision.route, "root_rebuild");
  assert.equal(decision.recoverySuggestion, "rebuild");
});

test("rule 4: low task-contract confidence routes to root_rebuild (re-intake)", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams()),
    healthyState({ contractConfidenceLow: true }),
  );
  assert.equal(decision.route, "root_rebuild");
  assert.match(decision.reason, /contract/);
});

// ── routing rule 3: two or more failure classes → targeted mutation ──

test("rule 3: two failure classes route to targeted mutation from elite + diversity, not a random restart", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams()),
    healthyState({ failureClasses: ["trigger", "task_path"] }),
  );
  assert.equal(decision.route, "targeted_mutation");
  assert.match(decision.reason, /failure classes|failureClasses|classes/);
});

test("rule 3: a stalled refinement (attempted, no progress) routes to targeted mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams()),
    healthyState({ lastRepairProgressed: false, refinementsUsed: 1 }),
  );
  assert.equal(decision.route, "targeted_mutation");
  assert.match(decision.reason, /stall|progress/);
});

// ── routing rule 2: single local cause → refine the current elite ──

test("rule 2 auto: first refinement of a single local cause is allowed with no prior-repair requirement", () => {
  const decision = routeAdaptiveStep(parseAdaptivePolicy(fullParams()), healthyState());
  assert.equal(decision.route, "refine_elite");
  assert.equal(decision.requiresProgressCertificate, false, "the FIRST refinement needs no certificate");
});

test("rule 2: earlyRepair=off never refines — a single local cause still routes to mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ earlyRepair: "off" })),
    healthyState(),
  );
  assert.equal(decision.route, "targeted_mutation");
});

test("rule 2 force: the FIRST refinement is forced even with multiple failure classes; safety still wins", () => {
  const first = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ earlyRepair: "force" })),
    healthyState({ failureClasses: ["trigger", "output_structure"] }),
  );
  assert.equal(first.route, "refine_elite");
  const killed = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ earlyRepair: "force" })),
    healthyState({ failureClasses: ["trigger"], safetyViolations: 1 }),
  );
  assert.equal(killed.route, "killed_rebuild");
});

test("rule 2 force applies to the first refinement only: a stalled second attempt still switches to mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ earlyRepair: "force", maxRefinementsPerCandidate: 2 })),
    healthyState({ refinementsUsed: 1, lastRepairProgressed: false }),
  );
  assert.equal(decision.route, "targeted_mutation");
});

test("rule 2: a protected-dimension regression blocks refinement and routes to mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams()),
    healthyState({ protectedDimensionRegression: true }),
  );
  assert.equal(decision.route, "targeted_mutation");
});

test("rule 2: the second refinement carries a mandatory progress certificate", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ maxRefinementsPerCandidate: 2 })),
    healthyState({ refinementsUsed: 1, lastRepairProgressed: true }),
  );
  assert.equal(decision.route, "refine_elite");
  assert.equal(decision.requiresProgressCertificate, true);
});

test("rule 2: refinement budget exhausted (maxRefinementsPerCandidate reached) routes to mutation", () => {
  const decision = routeAdaptiveStep(
    parseAdaptivePolicy(fullParams({ maxRefinementsPerCandidate: 1 })),
    healthyState({ refinementsUsed: 1, lastRepairProgressed: true }),
  );
  assert.equal(decision.route, "targeted_mutation");
});

// ── progress certificate: three conditions, all mandatory ──

test("certificate: granted when hard gates are clean and failures dropped, even with a flat score", () => {
  const cert = progressCertificateOf({
    hardGateViolations: 0,
    criticalFailureDrop: 1,
    scoreImprovement: 0,
    protectedDimensionRegression: false,
    minRepairProgress: 2,
  });
  assert.equal(cert.granted, true);
  assert.deepEqual(cert.failedConditions, []);
});

test("certificate: a score improvement of exactly minRepairProgress points grants (boundary is >=)", () => {
  const cert = progressCertificateOf({
    hardGateViolations: 0,
    criticalFailureDrop: 0,
    scoreImprovement: 2,
    protectedDimensionRegression: false,
    minRepairProgress: 2,
  });
  assert.equal(cert.granted, true);
});

test("certificate: 1.9 points against a 2-point minimum is refused — near-threshold wobble cannot unlock refinements", () => {
  const cert = progressCertificateOf({
    hardGateViolations: 0,
    criticalFailureDrop: 0,
    scoreImprovement: 1.9,
    protectedDimensionRegression: false,
    minRepairProgress: 2,
  });
  assert.equal(cert.granted, false);
  const progressFailure = cert.failedConditions.find((condition) => condition.startsWith("progress"));
  assert.ok(progressFailure, "the progress condition must be reported");
  assert.match(progressFailure, /points/, "the denial reason must state the unit in points");
});

test("certificate: each missing condition is reported by name, never silently waived", () => {
  const cert = progressCertificateOf({
    hardGateViolations: 1,
    criticalFailureDrop: 0,
    scoreImprovement: 0.5,
    protectedDimensionRegression: true,
    minRepairProgress: 2,
  });
  assert.equal(cert.granted, false);
  assert.ok(cert.failedConditions.includes("hard_gate_zero"));
  assert.ok(cert.failedConditions.some((condition) => condition.startsWith("progress")));
  assert.ok(cert.failedConditions.includes("protected_dimensions_unchanged"));
});

test("certificate: the spec's OR holds — a critical-failure increase is offset only by sufficient score progress", () => {
  const granted = progressCertificateOf({
    hardGateViolations: 0,
    criticalFailureDrop: -1,
    scoreImprovement: 5,
    protectedDimensionRegression: false,
    minRepairProgress: 2,
  });
  assert.equal(granted.granted, true, "score progress at/above minRepairProgress points satisfies the spec's OR condition");

  const refused = progressCertificateOf({
    hardGateViolations: 0,
    criticalFailureDrop: -1,
    scoreImprovement: 1,
    protectedDimensionRegression: false,
    minRepairProgress: 2,
  });
  assert.equal(refused.granted, false);
  assert.ok(refused.failedConditions.some((condition) => condition.startsWith("progress")));
});

// ── stagnation counter and stop-suggestion mapping ──

test("advanceStagnation resets on progress and counts consecutive stalls", () => {
  assert.equal(advanceStagnation(2, true), 0);
  assert.equal(advanceStagnation(0, false), 1);
  assert.equal(advanceStagnation(1, false), 2);
});

test("recoverySuggestionForStop maps stop causes to the resubmission advice the report must print", () => {
  assert.equal(recoverySuggestionForStop(healthyState({ b0s0SameCoreFailure: true })), "rebuild");
  assert.equal(recoverySuggestionForStop(healthyState({ safetyViolations: 1 })), "rebuild");
  assert.equal(
    recoverySuggestionForStop(healthyState({ failureClasses: ["trigger", "task_path"] })),
    "mutate",
  );
  assert.equal(
    recoverySuggestionForStop(healthyState({ lastRepairProgressed: false, refinementsUsed: 1 })),
    "mutate",
  );
  assert.equal(recoverySuggestionForStop(healthyState()), "refine");
});
