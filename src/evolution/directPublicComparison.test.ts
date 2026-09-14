import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  SEMANTIC_RESPONSE_BINDING_VERSION,
} from "../types.js";
import type { EvaluationContractV3, U1RubricDimensionId } from "../types.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import { scoringIdentityOfContract, U1RubricError } from "../evaluation/u1Rubric.js";
import type { AdaptiveEvaluation } from "./adaptiveRun.js";
import {
  DIRECT_U1_FROZEN_INSTRUCTION,
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
} from "./directBaseline.js";
import {
  DirectFailureArtifactSchema,
  DirectResultArtifactSchema,
  SafeDirectPublicComparisonSchema,
  U1SealedDirectCandidateArtifactSchema,
  buildSafeDirectPublicComparison,
} from "./directPublicComparison.js";
import type { SafeTerminalPublicSelection } from "./publicSelectionResume.js";
import { calculateStageBudgets } from "../providers/stageBudgets.js";

const SHA_B0 = "a".repeat(64);
const SHA_S0 = "b".repeat(64);
const SHA_EVOLVED = "c".repeat(64);

function currentContract(): EvaluationContractV3 {
  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const selectItemIds = Array.from({ length: 6 }, (_, index) => `select-${index + 1}`);
  const contract: EvaluationContractV3 = {
    schemaVersion: 3,
    createdAt: "2026-08-28T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: {
      taskCard: "1".repeat(64),
      draft: "2".repeat(64),
      curation: "4".repeat(64),
      evaluationReview: "5".repeat(64),
    },
    taskCardHash: "1".repeat(64),
    skillSnapshotHash: "3".repeat(64),
    adapterId: "instruction-v1",
    allowedCapabilities: ["instruction"],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    publicScenarioIds: ["public"],
    holdoutScenarioIds: ["sealed"],
    safetyGates: [{ gateId: "safe", description: "safe" }],
    qualityGates: [{ gateId: "quality", description: "quality" }],
    goalConfidence: { level: "high", score: 90, reasons: ["fixture"] },
    evalConfidence: { level: "high", score: 90, reasons: ["fixture"] },
    generation: {
      generator: { kind: "provider", name: "fixture" },
      curator: { kind: "curator", name: "fixture" },
      generatorCuratorIsolation: "independent",
    },
    thresholds: { absoluteFloor: 60, confidenceFloor: 60 },
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 1,
      maxRatioDeviation: 0.2,
      actualHoldoutRatio: 0.2,
    },
    explorationOnly: false,
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    evaluationReviewHash: "5".repeat(64),
    trainItemIds,
    selectItemIds,
    trainItemsSha256: "6".repeat(64),
    selectItemsSha256: "7".repeat(64),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: "8".repeat(64),
    sameModelLimitation: "The fixture uses one deterministic scorer and does not establish model independence.",
    u1ContractVersion: "v2",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    contractSha256: "0".repeat(64),
  };
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return EvaluationContractV3Schema.parse(contract);
}

function publicSelection(contract = currentContract()): SafeTerminalPublicSelection {
  const candidate = (
    candidateId: string,
    rootKind: "b0" | "s0" | "evolved",
    skillSha256: string,
    weightedMean: number,
  ) => ({
    candidateId,
    rootKind,
    skillSha256,
    weightedMean,
    comparisonEligible: true,
    championEligible: weightedMean >= 60,
    releaseEligible: false as const,
    everyGatePassed: true,
    criticalRegression: false,
    criticalRegressionItemIds: [],
    gateResults: [
      { gateId: "safe", category: "safety" as const, passed: true },
      { gateId: "quality", category: "quality" as const, passed: true },
    ],
    itemScores: [{ itemId: "select-1", score: weightedMean, passed: true, criticalFailure: false }],
    answerHashes: [{ itemId: "select-1", answerSha256: "d".repeat(64) }],
    dimensionScores: Object.fromEntries(
      DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => [id, weightedMean]),
    ) as Record<U1RubricDimensionId, number>,
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [] as U1RubricDimensionId[],
  });
  const protectedDimensionRegressions = DEFAULT_U1_SCORING_PROFILE.protectedDimensions;
  return {
    shortlistCandidateIds: ["b0-reference", "s0-reference", "g1-diversify"],
    candidateEvaluations: [
      candidate("b0-reference", "b0", SHA_B0, 54),
      candidate("s0-reference", "s0", SHA_S0, 96),
      {
        ...candidate("g1-diversify", "evolved", SHA_EVOLVED, 76),
        championEligible: false,
        criticalRegression: true,
        criticalRegressionItemIds: ["select-1"],
        itemScores: [{ itemId: "select-1", score: 76, passed: false, criticalFailure: true }],
        protectedDimensionRegression: true,
        protectedDimensionRegressions,
      },
    ],
    scoringIdentity: scoringIdentityOfContract({ contract }),
    decision: {
      startingReferenceId: "s0-reference",
      finalPublicChampionId: "s0-reference",
      verdict: "candidate_rejected",
      comparisonEligible: true,
      championEligible: true,
      releaseEligible: false,
      scoreDelta: -20,
      criticalRegression: true,
      protectedDimensionRegression: true,
      protectedDimensionRegressions,
      sameModelLimitation: "same model is not independent",
    },
  };
}

function directEvaluation(overrides: Partial<AdaptiveEvaluation> = {}): AdaptiveEvaluation {
  return {
    publicScore: 98,
    solvedItemIds: ["select-1"],
    gateResults: [{ gateId: "safe", category: "safety", passed: true, reason: "SECRET_GATE_REASON" }],
    itemScores: [{
      itemId: "select-1",
      split: "public",
      score: 98,
      passed: true,
      criticalFailure: false,
      evidence: {
        itemId: "select-1",
        passThreshold: 70,
        deterministic: {
          hardGateFailures: [],
          hardSafetyFailures: [],
          hardContractFailures: [],
          qualityFailures: [],
          ruleResults: [{ ruleId: "fixture", passed: true, reason: "SECRET_RULE_REASON", effect: "hard_contract" }],
          passed: true,
        },
        semantic: {
          dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({
            id,
            score: 98,
            reason: "SECRET_DIMENSION_REASON",
          })),
          weightedScore: 98,
          overallReason: "SECRET_OVERALL_REASON",
          semanticStatus: "evaluated",
          requestFingerprint: "e".repeat(64),
        },
        effectiveDimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({ id, score: 98, reason: "effective" })),
        dimensionCompliance: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({ id, passedWeight: 0, totalWeight: 0, complianceRate: 1, capScore: 100 })),
        effectiveWeightedScore: 98,
        finalScore: 98,
        passed: true,
        criticalFailure: false,
        dimensionFloorFailures: [],
        sameModelLimitation: "same model",
      },
    }],
    safetyFailures: 0,
    qualityFailures: 0,
    outcome: "elite",
    ...overrides,
  };
}

function validDirectResultArtifact() {
  const contract = currentContract();
  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: "# Direct",
    directEvaluation: directEvaluation(),
    directAnswerHashes: [{ itemId: "select-1", answerSha256: "f".repeat(64) }],
    selectItems: [{ itemId: "select-1", critical: true }],
    publicSelection: publicSelection(contract),
    contract,
  });
  const assumptions = {
    shortlistCandidates: 3,
    selectItems: 1,
    holdoutItems: 3,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const envelope = calculateStageBudgets(assumptions).envelope.direct;
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: new Date().toISOString(),
    status: "completed",
    phase: "direct-public-select",
    contractSha256: comparison.scoringIdentity.contractSha256,
    scoringIdentity: comparison.scoringIdentity,
    selectItemsSha256: "2".repeat(64),
    adaptiveResultSha256: "3".repeat(64),
    publicSelectionResultSha256: "4".repeat(64),
    b0SkillSha256: "5".repeat(64),
    directSource: {
      kind: "b0",
      skillSha256: "5".repeat(64),
      track: "b0-repair",
    },
    directInstructionSha256: sha256Hex(DIRECT_U1_FROZEN_INSTRUCTION),
    directPromptContractVersion: DIRECT_U1_PROMPT_CONTRACT_VERSION,
    directPromptContractSha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
    comparison,
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      independent: true,
      assumptions,
      envelope,
    },
    accounting: { logicalCalls: 3, httpAttempts: 3, retryAttempts: 0 },
    parallelism: {
      configuredMaxInFlight: 2,
      maxObservedInFlight: 2,
      totalWallTimeMs: 100,
      serialEquivalentMs: 180,
    },
    tokenTelemetry: {
      promptTokens: 1200,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 1200,
      completionTokens: 400,
      responses: 3,
      responsesWithUsage: 3,
      responsesMissingUsage: 0,
      byStageRoleModel: [{
        tags: { stage: "direct", role: "evaluator", model: "deepseek-test" },
        telemetry: {
          promptTokens: 1200,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 1200,
          completionTokens: 400,
          responses: 3,
          responsesWithUsage: 3,
          responsesMissingUsage: 0,
        },
      }],
    },
    applicationRecovery: [{
      candidateId: "direct",
      itemId: "select-1",
      role: "direct",
      outcome: "no_retry_needed",
      attempts: [{
        attempt: 1,
        attemptIdentitySha256: "1".repeat(64),
        terminalReason: "final",
        modelCalls: 1,
        transcriptSha256: "2".repeat(64),
        successfulToolCalls: 0,
        failedToolCalls: 0,
        uniqueSuccessfulToolRequests: 0,
        repeatedSuccessfulToolRequests: 0,
        trajectorySha256: "3".repeat(64),
      }],
      retryTriggered: false,
      rawScenarioEstimate: envelope.scenarioAuthorization.rawScenarioEstimate,
      callEnvelopeMultiplier: envelope.scenarioAuthorization.callEnvelopeMultiplier,
      authorizedModelCallsPerAttempt: envelope.scenarioAuthorization.authorizedModelCallsPerAttempt,
      maxApplicationAttempts: envelope.scenarioAuthorization.maxApplicationAttempts,
      scenarioRetryReserve: envelope.scenarioAuthorization.scenarioRetryReserve,
      unusedRetryReserve: envelope.scenarioAuthorization.scenarioRetryReserve,
      classification: null,
    }],
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    cache: { hits: 0, misses: 3, stores: 3 },
    provider: {
      adapterVersion: "openai-chat-completions-v1",
      name: "openai-compatible",
      endpointIdentity: "5".repeat(24),
      model: "deepseek-test",
      authMode: "bearer",
      requestProfile: {
        preset: "deepseek",
        jsonMode: "json_object",
        reasoningMode: "thinking-disabled",
        maxTokensField: "max_tokens",
      },
      roles: {
        evaluator: { requestTimeoutMs: 120_000, maxOutputTokensBehavior: "provider-default", configFingerprint: "6".repeat(24) },
        directRefine: { requestTimeoutMs: 180_000, maxOutputTokensBehavior: "provider-default", configFingerprint: "7".repeat(24) },
        semanticJudge: { requestTimeoutMs: 120_000, maxOutputTokensBehavior: "provider-default", configFingerprint: "8".repeat(24) },
      },
    },
    promptBoundary: {
      inputs: ["b0", "task-goal", "frozen-direct-instruction"],
      adaptivePopulationIncluded: false,
      lineageIncluded: false,
      adaptiveFailureIncluded: false,
      internalScoresIncluded: false,
      sealedIncluded: false,
    },
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
    feedbackToEvolution: false,
    holdout: "sealed",
    release: "withheld",
  };
}

function validCapabilityRejectedDirectResultArtifact() {
  const scored = validDirectResultArtifact();
  const { comparison: _comparison, applicationRecovery: _applicationRecovery, ...common } = scored;
  return {
    ...common,
    applicationRecovery: [],
    directStageExecution: "completed",
    directCandidateOutcome: "rejected_by_capability_gate",
    directStatus: "candidate_rejected",
    semanticEvaluation: "not_run",
    semanticLogicalCalls: 0,
    numericComparison: "not_comparable",
    directCandidate: {
      candidateId: "direct",
      skillSha256: "9".repeat(64),
    },
    safeError: {
      code: "DIRECT_U1_BOUNDARY_VIOLATION",
      message: "Direct candidate was rejected by the deterministic U1 capability gate; sensitive request content was not persisted.",
      details: {
        findings: [{
          code: "shell",
          kind: "execution_instruction",
          line: 3,
          evidenceSha256: "a".repeat(64),
          excerpt: "[redacted capability clause]",
        }],
      },
    },
    accounting: { logicalCalls: 1, httpAttempts: 1, retryAttempts: 0 },
    parallelism: {
      configuredMaxInFlight: 2,
      maxObservedInFlight: 1,
      totalWallTimeMs: 50,
      serialEquivalentMs: 50,
    },
    tokenTelemetry: {
      promptTokens: 200,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 200,
      completionTokens: 100,
      responses: 1,
      responsesWithUsage: 1,
      responsesMissingUsage: 0,
      byStageRoleModel: [{
        tags: { stage: "direct", role: "direct-refine", model: "deepseek-test" },
        telemetry: {
          promptTokens: 200,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 200,
          completionTokens: 100,
          responses: 1,
          responsesWithUsage: 1,
          responsesMissingUsage: 0,
        },
      }],
    },
    cache: { hits: 0, misses: 0, stores: 0 },
  };
}

test("Direct public comparison is an independent generation baseline and cannot rewrite the frozen public decision", () => {
  const contract = currentContract();
  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: "# Direct\n\nA bounded answer.\n",
    directEvaluation: directEvaluation(),
    directAnswerHashes: [{ itemId: "select-1", answerSha256: "f".repeat(64) }],
    selectItems: [{ itemId: "select-1", critical: true }],
    publicSelection: publicSelection(contract),
    contract,
  });

  assert.equal(comparison.directCandidate.weightedMean, 98);
  assert.equal(comparison.directCandidate.everyGatePassed, true);
  assert.equal(comparison.directCandidate.criticalRegression, false);
  assert.equal(comparison.relativeToStarting.scoreDelta, 2);
  assert.equal(comparison.relativeToFinalPublicChampion.scoreDelta, 2);
  assert.equal(comparison.relativeToFinalPublicChampion.result, "higher_public_score");
  assert.match(comparison.methodologicalNote, /independent generation baseline/i);
  assert.match(comparison.methodologicalNote, /does not retroactively modify the frozen public decision/i);
  const retiredVerdict = structuredClone(comparison) as any;
  retiredVerdict.adaptivePublicDecision.verdict = "uncertain";
  assert.throws(() => SafeDirectPublicComparisonSchema.parse(retiredVerdict), /verdict|uncertain/i);
  const serialized = JSON.stringify(comparison);
  assert.doesNotMatch(serialized, /SECRET_|reason|skillMd|judgingRule|userInput|candidateAnswer/i);
  assert.match(serialized, /semanticRequestFingerprint/);
});

test("Direct with a critical regression is rejected even when its scalar score is higher", () => {
  const contract = currentContract();
  const criticalEvaluation = directEvaluation();
  criticalEvaluation.publicScore = 100;
  criticalEvaluation.itemScores = criticalEvaluation.itemScores?.map((item) => ({
    ...item,
    score: 100,
    passed: false,
    criticalFailure: true,
    evidence: item.evidence
      ? {
          ...item.evidence,
          finalScore: 100,
          passed: false,
          criticalFailure: true,
        }
      : undefined,
  }));
  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: "# Direct",
    directEvaluation: criticalEvaluation,
    directAnswerHashes: [{ itemId: "select-1", answerSha256: "f".repeat(64) }],
    selectItems: [{ itemId: "select-1", critical: true }],
    publicSelection: publicSelection(contract),
    contract,
  });

  assert.equal(comparison.directCandidate.criticalRegression, true);
  assert.equal(comparison.relativeToFinalPublicChampion.result, "candidate_rejected");
});

test("current Direct shares the scoring identity without treating an above-floor fractional dimension decline as a hard veto", () => {
  const contract = currentContract();
  const identity = scoringIdentityOfContract({ contract });
  const selection = publicSelection(contract);
  const dimensions = DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({
    id,
    score: id === "evidence_boundary" ? 79 : 100,
    reason: "synthetic dimension evidence",
  }));
  const evaluation = directEvaluation({
    publicScore: 98,
    itemScores: [{
      itemId: "select-1",
      split: "public",
      score: 98,
      passed: true,
      criticalFailure: false,
      evidence: {
        itemId: "select-1",
        passThreshold: 70,
        deterministic: {
          hardGateFailures: [],
          hardSafetyFailures: [],
          hardContractFailures: [],
          qualityFailures: [],
          ruleResults: [{ ruleId: "fixture", passed: true, reason: "synthetic", effect: "hard_contract" }],
          passed: true,
        },
        semantic: {
          dimensions,
          weightedScore: 98,
          overallReason: "synthetic",
          semanticStatus: "evaluated",
          requestFingerprint: "e".repeat(64),
        },
        effectiveDimensions: dimensions,
        dimensionCompliance: dimensions.map(({ id }) => ({ id, passedWeight: 0, totalWeight: 0, complianceRate: 1, capScore: 100 })),
        effectiveWeightedScore: 98,
        finalScore: 98,
        passed: true,
        criticalFailure: false,
        dimensionFloorFailures: [],
        sameModelLimitation: "same model",
      },
    }],
  });

  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: "# Direct",
    directEvaluation: evaluation,
    directAnswerHashes: [{ itemId: "select-1", answerSha256: "f".repeat(64) }],
    selectItems: [{ itemId: "select-1", critical: false }],
    publicSelection: selection,
    contract,
  });
  assert.equal(comparison.scoringIdentity?.contractSha256, contract.contractSha256);
  assert.deepEqual(comparison.directCandidate.protectedDimensionRegressions, ["evidence_boundary"]);
  assert.equal(comparison.directCandidate.championEligible, true);
  assert.equal(comparison.relativeToStarting.result, "higher_public_score");
  assert.throws(
    () => SafeDirectPublicComparisonSchema.parse({
      ...comparison,
      directCandidate: { ...comparison.directCandidate, championEligible: false },
    }),
    /terminal eligibility/i,
    "current Direct evidence cannot persist a terminal eligibility result that disagrees with its gates",
  );
  assert.throws(
    () => SafeDirectPublicComparisonSchema.parse({
      ...comparison,
      directCandidate: {
        ...comparison.directCandidate,
        championEligible: true,
        itemScores: comparison.directCandidate.itemScores.map((item, index) => ({
          ...item,
          criticalFailure: index === 0,
        })),
      },
    }),
    /critical item failure|terminal eligibility/i,
    "current Direct evidence cannot hide a critical item failure behind a stale champion flag",
  );
  assert.throws(
    () => SafeDirectPublicComparisonSchema.parse({
      ...comparison,
      relativeToStarting: { ...comparison.relativeToStarting, result: "candidate_rejected" },
    }),
    /relative result/i,
    "current Direct evidence cannot persist a relative result that disagrees with the shared terminal projection",
  );

  const driftedSelection = {
    ...selection,
    scoringIdentity: { ...identity, contractSha256: "f".repeat(64) },
  };
  assert.throws(
    () => buildSafeDirectPublicComparison({
      directSkillMd: "# Direct",
      directEvaluation: evaluation,
      directAnswerHashes: [{ itemId: "select-1", answerSha256: "f".repeat(64) }],
      selectItems: [{ itemId: "select-1", critical: false }],
      publicSelection: driftedSelection,
      contract,
    }),
    (error: unknown) => error instanceof U1RubricError && error.code === "U1_SCORING_IDENTITY_MISMATCH",
  );
});

test("Direct result schema requires the current human evidence and prompt bindings", () => {
  const parsed = DirectResultArtifactSchema.parse(validDirectResultArtifact());
  assert.ok("comparison" in parsed);
  assert.equal(parsed.comparison.directCandidate.skillSha256, sha256Hex("# Direct"));
  assert.throws(() => DirectResultArtifactSchema.parse({ ...parsed, formalEvidence: false }));
  assert.throws(() => DirectResultArtifactSchema.parse({ ...parsed, sealedAllowed: true }));
  const missingSemanticBinding = { ...parsed } as Record<string, unknown>;
  delete missingSemanticBinding.semanticResponseBindingVersion;
  assert.throws(() => DirectResultArtifactSchema.parse(missingSemanticBinding));
  for (const promptDrift of [
    { directPromptContractVersion: undefined },
    { directPromptContractSha256: undefined },
    { directPromptContractVersion: "unknown-direct-v99" },
    { directPromptContractSha256: "0".repeat(64) },
  ]) {
    const candidate = { ...parsed, ...promptDrift } as Record<string, unknown>;
    for (const [key, value] of Object.entries(promptDrift)) if (value === undefined) delete candidate[key];
    assert.throws(() => DirectResultArtifactSchema.parse(candidate));
  }
});

test("a parsed complete Direct candidate rejected by the deterministic capability gate is completed non-comparable evidence", () => {
  const rejected = validCapabilityRejectedDirectResultArtifact();
  const parsed = DirectResultArtifactSchema.parse(rejected) as Record<string, any>;

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.directStageExecution, "completed");
  assert.equal(parsed.directCandidateOutcome, "rejected_by_capability_gate");
  assert.equal(parsed.directStatus, "candidate_rejected");
  assert.equal(parsed.semanticEvaluation, "not_run");
  assert.equal(parsed.semanticLogicalCalls, 0);
  assert.equal(parsed.numericComparison, "not_comparable");
  assert.equal(parsed.accounting.logicalCalls, 1);
  assert.equal(parsed.accounting.httpAttempts, 1);
  assert.equal(parsed.accounting.retryAttempts, 0);
  assert.equal(parsed.safeError.code, "DIRECT_U1_BOUNDARY_VIOLATION");
  assert.ok(!("comparison" in parsed), "a rejected candidate has no invented numeric comparison");

  assert.throws(() => DirectResultArtifactSchema.parse({ ...rejected, semanticEvaluation: "completed" }));
  assert.throws(() => DirectResultArtifactSchema.parse({ ...rejected, semanticLogicalCalls: 1 }));
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...rejected,
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
  }));
  assert.throws(() => DirectResultArtifactSchema.parse({ ...rejected, rawSkillMd: "# leaked" }));
});

test("Direct failure schema keeps only prompt binding and allowlisted redacted finding evidence", () => {
  const scoringIdentity = scoringIdentityOfContract({ contract: currentContract() });
  const failure = {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: new Date().toISOString(),
    status: "failed",
    phase: "direct-public-select",
    adaptiveResultSha256: "3".repeat(64),
    publicSelectionResultSha256: "4".repeat(64),
    contractSha256: scoringIdentity.contractSha256,
    scoringIdentity,
    selectItemsSha256: "2".repeat(64),
    directPromptContractVersion: DIRECT_U1_PROMPT_CONTRACT_VERSION,
    directPromptContractSha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
    safeError: {
      code: "DIRECT_U1_BOUNDARY_VIOLATION",
      message: "Direct stage failed; sensitive request content was not persisted.",
      details: {
        findings: [{
          code: "network",
          kind: "execution_instruction",
          line: 3,
          evidenceSha256: "9".repeat(64),
          excerpt: "[redacted capability clause]",
        }],
      },
    },
    budget: { minimum: 9, authorized: 9, independent: true },
    accounting: { logicalCalls: 1, httpAttempts: 1, retryAttempts: 0 },
    tokenTelemetry: { promptTokens: 10, completionTokens: 5, responses: 1 },
    provider: validDirectResultArtifact().provider,
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
    feedbackToEvolution: false,
    holdout: "sealed",
    release: "withheld (noRelease=true)",
  };
  const assumptions = {
    shortlistCandidates: 2,
    selectItems: 1,
    holdoutItems: 1,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const envelope = calculateStageBudgets(assumptions).envelope.direct;
  const dynamicFailure = {
    ...failure,
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    safeError: {
      code: "DYNAMIC_ENVELOPE_EXHAUSTED",
      message: "Direct stage failed; sensitive request content was not persisted.",
    },
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      independent: true,
      assumptions,
      envelope,
    },
    accounting: {
      logicalCalls: envelope.authorizedLogicalCalls,
      httpAttempts: envelope.authorizedLogicalCalls,
      retryAttempts: 0,
    },
    tokenTelemetry: {
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
      responses: envelope.authorizedLogicalCalls,
      responsesWithUsage: 0,
      responsesMissingUsage: envelope.authorizedLogicalCalls,
      byStageRoleModel: [{
        tags: { stage: "direct", role: "evaluator", model: "deepseek-test" },
        telemetry: {
          promptTokens: null,
          promptCacheHitTokens: null,
          promptCacheMissTokens: null,
          completionTokens: null,
          responses: envelope.authorizedLogicalCalls,
          responsesWithUsage: 0,
          responsesMissingUsage: envelope.authorizedLogicalCalls,
        },
      }],
    },
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    dynamicEnvelopeExhaustion: {
      status: "dynamic-envelope-exhausted",
      classification: "unknown_bounded_exhaustion",
      estimationVersion: envelope.estimationVersion,
      baselineEstimate: envelope.baselineEstimate,
      rawStageEstimate: envelope.rawStageEstimate,
      callEnvelopeMultiplier: envelope.callEnvelopeMultiplier,
      stagePrimaryAuthorization: envelope.stagePrimaryAuthorization,
      stageLoopRetryReserve: envelope.stageLoopRetryReserve,
      existingRecoveryReserve: envelope.existingRecoveryReserve,
      headroom: envelope.headroom,
      stageAuthorizedLogicalCalls: envelope.authorizedLogicalCalls,
      actualLogicalCalls: envelope.authorizedLogicalCalls,
      nextCallStarted: false,
      multiplierChangedDuringRun: false,
    },
  };
  assert.throws(
    () => DirectFailureArtifactSchema.parse(failure),
    /assumptions|envelope|maxModelTurns|maxToolCalls|budgetMultiplier/i,
    "old non-envelope Direct failures are no longer current artifacts",
  );
  assert.doesNotThrow(() => DirectFailureArtifactSchema.parse(dynamicFailure));
  const { dynamicEnvelopeExhaustion: _dynamicEnvelopeExhaustion, ...boundaryBase } = dynamicFailure;
  const boundaryFailure = { ...boundaryBase, safeError: failure.safeError };
  assert.doesNotThrow(() => DirectFailureArtifactSchema.parse(boundaryFailure));
  assert.throws(() => DirectFailureArtifactSchema.parse({
    ...boundaryFailure,
    safeError: { ...failure.safeError, details: { findings: [{ ...failure.safeError.details.findings[0], excerpt: "https://secret.example" }] } },
  }));
  assert.throws(() => DirectFailureArtifactSchema.parse({
    ...boundaryFailure,
    safeError: { ...failure.safeError, details: { findingCodes: ["network:execution_instruction"] } },
  }), /unrecognized key/i, "findingCodes cannot masquerade as current structured findings");
  assert.throws(() => DirectFailureArtifactSchema.parse({ ...boundaryFailure, rawProviderResponse: "secret" }));
  assert.throws(() => DirectFailureArtifactSchema.parse({
    ...boundaryFailure,
    safeError: { ...failure.safeError, code: "SECRET_API_KEY_VALUE" },
  }), /invalid enum|invalid_enum|expected/i, "an arbitrary uppercase string is not a safe diagnostic code");
  const missingDynamicEvidence = structuredClone(dynamicFailure) as any;
  delete missingDynamicEvidence.dynamicEnvelopeExhaustion;
  assert.throws(
    () => DirectFailureArtifactSchema.parse(missingDynamicEvidence),
    /dynamic Direct exhaustion/i,
  );
  const driftedDynamicEvidence = structuredClone(dynamicFailure) as any;
  driftedDynamicEvidence.dynamicEnvelopeExhaustion.actualLogicalCalls -= 1;
  assert.throws(
    () => DirectFailureArtifactSchema.parse(driftedDynamicEvidence),
    /dynamic envelope exhaustion|dynamic Direct exhaustion/i,
  );
});

test("completed Direct evidence binds the exact current B/M/H and HTTP accounting", () => {
  const valid = validDirectResultArtifact();
  assert.doesNotThrow(() => DirectResultArtifactSchema.parse(valid));
  const oldBudget = structuredClone(valid) as any;
  delete oldBudget.budget.assumptions.maxModelTurns;
  delete oldBudget.budget.assumptions.maxToolCalls;
  delete oldBudget.budget.assumptions.budgetMultiplier;
  assert.throws(
    () => DirectResultArtifactSchema.parse(oldBudget),
    /maxModelTurns|maxToolCalls|budgetMultiplier/i,
  );
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...valid,
    budget: { ...valid.budget, authorized: 10 },
  }), /B\/M\/H|budget/i);
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...valid,
    accounting: { logicalCalls: 0, httpAttempts: 999, retryAttempts: 999 },
  }), /accounting|logical|HTTP|retry|formula/i);
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...valid,
    budget: {
      ...valid.budget,
      minimum: 8,
      assumptions: { ...valid.budget.assumptions, selectItems: 5 },
    },
  }), /budget|formula|logical/i);
});

test("current Direct evidence binds dynamic B/M/H while allowing observed multi-turn and one-retry calls below H", () => {
  const valid = validDirectResultArtifact();
  const assumptions = {
    ...valid.budget.assumptions,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const envelope = calculateStageBudgets(assumptions).envelope.direct;
  const recovery = {
    candidateId: "direct",
    itemId: "select-1",
    role: "direct",
    outcome: "recovered_after_single_retry",
    attempts: [
      {
        attempt: 1,
        attemptIdentitySha256: "a".repeat(64),
        terminalReason: "too_many_tool_calls",
        modelCalls: 10,
        transcriptSha256: "b".repeat(64),
        successfulToolCalls: 9,
        failedToolCalls: 0,
        uniqueSuccessfulToolRequests: 2,
        repeatedSuccessfulToolRequests: 7,
        trajectorySha256: "e".repeat(64),
      },
      {
        attempt: 2,
        attemptIdentitySha256: "c".repeat(64),
        terminalReason: "final",
        modelCalls: 2,
        transcriptSha256: "d".repeat(64),
        successfulToolCalls: 1,
        failedToolCalls: 0,
        uniqueSuccessfulToolRequests: 1,
        repeatedSuccessfulToolRequests: 0,
        trajectorySha256: "f".repeat(64),
      },
    ],
    retryTriggered: true,
    rawScenarioEstimate: 5,
    callEnvelopeMultiplier: 2,
    authorizedModelCallsPerAttempt: 10,
    maxApplicationAttempts: 2,
    scenarioRetryReserve: 10,
    unusedRetryReserve: 8,
    classification: null,
  };
  const dynamic = {
    ...valid,
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      independent: true,
      assumptions,
      envelope,
    },
    accounting: { logicalCalls: 12, httpAttempts: 13, retryAttempts: 1 },
    applicationRecovery: [recovery],
    tokenTelemetry: {
      promptTokens: 1200,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: 400,
      responses: 12,
      responsesWithUsage: 12,
      responsesMissingUsage: 0,
      byStageRoleModel: [{
        tags: { stage: "direct", role: "evaluator", model: "deepseek-test" },
        telemetry: {
          promptTokens: 1200,
          promptCacheHitTokens: null,
          promptCacheMissTokens: null,
          completionTokens: 400,
          responses: 12,
          responsesWithUsage: 12,
          responsesMissingUsage: 0,
        },
      }],
    },
  };

  assert.doesNotThrow(() => DirectResultArtifactSchema.parse(dynamic));
  assert.throws(
    () => DirectResultArtifactSchema.parse({ ...dynamic, applicationRecovery: undefined }),
    /exactly cover|application/i,
    "current scored Direct cannot omit candidate-item attempt evidence",
  );
  const missingGroupedTelemetry = structuredClone(dynamic) as any;
  delete missingGroupedTelemetry.tokenTelemetry.byStageRoleModel;
  assert.throws(
    () => DirectResultArtifactSchema.parse(missingGroupedTelemetry),
    /token telemetry/i,
    "current Direct cannot downgrade to aggregate-only token telemetry",
  );
  assert.throws(
    () => DirectResultArtifactSchema.parse({
      ...dynamic,
      accounting: {
        logicalCalls: envelope.authorizedLogicalCalls + 1,
        httpAttempts: envelope.authorizedLogicalCalls + 2,
        retryAttempts: 1,
      },
    }),
    /B\/M\/H|within H|budget/i,
  );
  assert.throws(
    () => DirectResultArtifactSchema.parse({
      ...dynamic,
      budget: { ...dynamic.budget, envelope: { ...envelope, headroom: envelope.headroom + 1 } },
    }),
    /B\/M\/H|budget/i,
  );
  assert.throws(
    () => DirectResultArtifactSchema.parse({
      ...dynamic,
      applicationRecovery: [{
        ...recovery,
        rawScenarioEstimate: recovery.rawScenarioEstimate + 1,
        authorizedModelCallsPerAttempt: recovery.authorizedModelCallsPerAttempt + 2,
        scenarioRetryReserve: recovery.scenarioRetryReserve + 2,
        unusedRetryReserve: recovery.unusedRetryReserve + 2,
      }],
    }),
    /application summary|scenario authorization/i,
    "an internally consistent recovery record cannot drift from the Direct stage envelope",
  );
  assert.doesNotThrow(
    () => DirectResultArtifactSchema.parse({
      ...dynamic,
      accounting: { logicalCalls: 9, httpAttempts: 9, retryAttempts: 0 },
      cache: { hits: 3, misses: 6, stores: 6 },
    }),
    "cached application turns do not consume Provider logical calls and must not be rejected by cross-layer accounting",
  );
  const locallyRejected = {
    ...dynamic,
    comparison: {
      ...dynamic.comparison,
      directCandidate: {
        ...dynamic.comparison.directCandidate,
        championEligible: false,
        everyGatePassed: false,
        gateResults: [{ gateId: "local-non-final", category: "quality" as const, passed: false }],
        itemScores: [{ itemId: "select-1", score: 0, passed: false, criticalFailure: false }],
      },
      relativeToStarting: {
        ...dynamic.comparison.relativeToStarting,
        result: "candidate_rejected" as const,
      },
      relativeToFinalPublicChampion: {
        ...dynamic.comparison.relativeToFinalPublicChampion,
        result: "candidate_rejected" as const,
      },
    },
    accounting: { logicalCalls: 8, httpAttempts: 8, retryAttempts: 0 },
    cache: { hits: 4, misses: 8, stores: 8 },
    applicationRecovery: [{
      ...recovery,
      outcome: "retry_completed_non_final" as const,
      attempts: [
        recovery.attempts[0],
        { ...recovery.attempts[1], terminalReason: "no_final" as const },
      ],
    }],
  };
  const parsedLocallyRejected = DirectResultArtifactSchema.parse(locallyRejected);
  assert.equal(parsedLocallyRejected.status, "completed");
  assert.ok("comparison" in parsedLocallyRejected);
  assert.equal(parsedLocallyRejected.comparison.relativeToStarting.result, "candidate_rejected");
});

test("Direct result schema binds the routed source kind, hash and track to the prompt boundary", () => {
  const b0 = validDirectResultArtifact();
  assert.doesNotThrow(() => DirectResultArtifactSchema.parse(b0));

  const s0 = {
    ...b0,
    directSource: { kind: "s0", skillSha256: "9".repeat(64), track: "s0-rebuild" },
    promptBoundary: { ...b0.promptBoundary, inputs: ["s0", "task-goal", "frozen-direct-instruction"] },
  };
  assert.doesNotThrow(() => DirectResultArtifactSchema.parse(s0));
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...s0,
    directSource: { ...s0.directSource, kind: "b0" },
  }), /source|track|prompt/i);
  assert.throws(() => DirectResultArtifactSchema.parse({
    ...b0,
    directSource: { ...b0.directSource, skillSha256: "9".repeat(64) },
  }), /source|B0|hash/i);
});

test("Direct result schema rejects unknown fields instead of preserving or silently stripping them", () => {
  const valid = validDirectResultArtifact();
  assert.doesNotThrow(() => DirectResultArtifactSchema.parse(valid));

  const cases: Array<[string, unknown]> = [
    ["top level", { ...valid, unexpectedSecret: "SECRET_TOP" }],
    ["budget", { ...valid, budget: { ...valid.budget, unexpectedSecret: "SECRET_BUDGET" } }],
    ["budget assumptions", {
      ...valid,
      budget: {
        ...valid.budget,
        assumptions: { ...valid.budget.assumptions, unexpectedSecret: "SECRET_ASSUMPTIONS" },
      },
    }],
    ["accounting", { ...valid, accounting: { ...valid.accounting, unexpectedSecret: "SECRET_ACCOUNTING" } }],
    ["parallelism", { ...valid, parallelism: { ...valid.parallelism, unexpectedSecret: "SECRET_PARALLELISM" } }],
    ["token telemetry", { ...valid, tokenTelemetry: { ...valid.tokenTelemetry, unexpectedSecret: "SECRET_TOKENS" } }],
    ["cache", { ...valid, cache: { ...valid.cache, unexpectedSecret: "SECRET_CACHE" } }],
    ["provider", { ...valid, provider: { ...valid.provider, unexpectedSecret: "SECRET_PROVIDER" } }],
    ["direct source", { ...valid, directSource: { ...valid.directSource, unexpectedSecret: "SECRET_SOURCE" } }],
    ["prompt boundary", { ...valid, promptBoundary: { ...valid.promptBoundary, unexpectedSecret: "SECRET_PROMPT" } }],
    ["comparison", { ...valid, comparison: { ...valid.comparison, unexpectedSecret: "SECRET_COMPARISON" } }],
    ["direct candidate", {
      ...valid,
      comparison: {
        ...valid.comparison,
        directCandidate: { ...valid.comparison.directCandidate, unexpectedSecret: "SECRET_CANDIDATE" },
      },
    }],
  ];

  for (const [label, artifact] of cases) {
    assert.throws(
      () => DirectResultArtifactSchema.parse(artifact),
      /unrecognized key/i,
      `${label} must fail closed on unknown fields`,
    );
  }
});

test("the frozen Direct SKILL artifact accepts only scored current human evidence", () => {
  const skillMd = "# Frozen Direct\n\nAnswer only from supplied evidence.\n";
  const scoringIdentity = scoringIdentityOfContract({ contract: currentContract() });
  const base = {
    schemaVersion: 1 as const,
    kind: "u1-sealed-direct-candidate" as const,
    createdAt: "2026-08-27T00:00:00.000Z",
    status: "frozen" as const,
    candidateId: "direct" as const,
    contractSha256: scoringIdentity.contractSha256,
    scoringIdentity,
    adaptiveResultSha256: "2".repeat(64),
    publicSelectionResultSha256: "3".repeat(64),
    directResultSha256: "4".repeat(64),
    skillSha256: sha256Hex(skillMd),
    skillMd,
    confirmationMode: "human" as const,
    explorationOnly: false,
    formalEvidence: true,
    sourceStageExecution: "completed" as const,
    sourceCandidateOutcome: "scored" as const,
    feedbackToEvolution: false as const,
    releaseAllowed: false as const,
  };
  assert.doesNotThrow(() => U1SealedDirectCandidateArtifactSchema.parse(base));
  assert.throws(() => U1SealedDirectCandidateArtifactSchema.parse({
    ...base,
    confirmationMode: "test-fixture",
    explorationOnly: true,
    formalEvidence: false,
  }));
  assert.throws(() => U1SealedDirectCandidateArtifactSchema.parse({ ...base, skillSha256: "5".repeat(64) }), /SKILL|SHA/i);
  assert.throws(() => U1SealedDirectCandidateArtifactSchema.parse({
    ...base,
    sourceCandidateOutcome: "rejected_by_capability_gate",
  }));
});
