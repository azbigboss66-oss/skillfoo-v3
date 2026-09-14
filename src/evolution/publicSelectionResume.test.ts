import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { SEMANTIC_RESPONSE_BINDING_VERSION } from "../types.js";
import { calculateStageBudgets, type CallEnvelope } from "../providers/stageBudgets.js";
import { calculateAdaptiveClosureBudget } from "./adaptiveClosureProtocol.js";
import {
  PublicSelectionFailureArtifactSchema,
  PublicSelectionResultArtifactSchema,
  parseAdaptiveResultArtifact,
  validateAdaptiveResultForPublicSelectResume,
  validatePublicSelectionFailureForResume,
} from "./publicSelectionResume.js";
import * as publicSelectionResumeModule from "./publicSelectionResume.js";

const B0 = "# B0\n\nKeep the answer bounded.\n";
const S0 = "# S0\n\nState the boundary before answering.\n";
const CONTRACT_SHA256 = "c".repeat(64);
const SELECT_SHA256 = "b".repeat(64);
const FINGERPRINT = "f".repeat(24);

test("all Adaptive stop reasons share one comparison-or-failure disposition table", () => {
  const dispositionOf = (
    publicSelectionResumeModule as unknown as {
      adaptiveStopDispositionOf?: (reason: string) => "comparison" | "failure";
    }
  ).adaptiveStopDispositionOf;
  assert.equal(
    typeof dispositionOf,
    "function",
    "the current Adaptive producer and every downstream consumer need one shared stop disposition",
  );
  if (!dispositionOf) return;

  const cases = [
    ["public_goal_met", "comparison"],
    ["generations_completed", "comparison"],
    ["stagnation_stop", "comparison"],
    ["no_valid_child", "comparison"],
    ["proposer_failure", "failure"],
    ["safety_kill", "failure"],
    ["budget_exhausted", "failure"],
    ["root_rebuild", "failure"],
  ] as const;
  for (const [reason, expected] of cases) {
    assert.equal(dispositionOf(reason), expected, reason);
  }
});
const TRAIN_ITEM = {
  itemId: "train-1",
  scenarioId: "scenario-1",
  split: "public" as const,
  itemType: "trigger",
  input: "public input",
  judgingRule: "public judging rule",
};

function tokenTelemetry(stage: string, responses = 1) {
  return {
    promptTokens: 10,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: 5,
    responses,
    responsesWithUsage: responses,
    responsesMissingUsage: 0,
    byStageRoleModel: [{
      tags: { stage, role: "evaluator", model: "deepseek-test" },
      telemetry: {
        promptTokens: 10,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        completionTokens: 5,
        responses,
        responsesWithUsage: responses,
        responsesMissingUsage: 0,
      },
    }],
  };
}

function applicationEvidence(itemId: string, envelope: CallEnvelope) {
  const scenario = envelope.scenarioAuthorization;
  return {
    itemId,
    outcome: "no_retry_needed" as const,
    attempts: [{
      attempt: 1 as const,
      attemptIdentitySha256: "1".repeat(64),
      terminalReason: "final" as const,
      modelCalls: 1,
      transcriptSha256: "2".repeat(64),
      successfulToolCalls: 0,
      failedToolCalls: 0,
      uniqueSuccessfulToolRequests: 0,
      repeatedSuccessfulToolRequests: 0,
      trajectorySha256: "3".repeat(64),
    }],
    retryTriggered: false,
    rawScenarioEstimate: scenario.rawScenarioEstimate,
    callEnvelopeMultiplier: scenario.callEnvelopeMultiplier,
    authorizedModelCallsPerAttempt: scenario.authorizedModelCallsPerAttempt,
    maxApplicationAttempts: scenario.maxApplicationAttempts,
    scenarioRetryReserve: scenario.scenarioRetryReserve,
    unusedRetryReserve: scenario.scenarioRetryReserve,
    classification: null,
  };
}

function currentAdaptiveArtifact() {
  const adaptiveBudget = calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: 1,
    pinnedItems: 1,
    semanticBatchSize: 3,
    minChildGenerations: 1,
    maxModelTurns: 6,
    maxToolCalls: 4,
    maxRefinements: 0,
    budgetMultiplier: 2,
  });
  const recovery = applicationEvidence(TRAIN_ITEM.itemId, adaptiveBudget.envelope);
  const candidate = (candidateId: string, originRoot: "b0" | "s0", skillMd: string) => ({
    candidateId,
    originRoot,
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd,
    evaluation: {
      publicScore: originRoot === "b0" ? 80 : 81,
      solvedItemIds: [TRAIN_ITEM.itemId],
      evaluatedItemIds: [TRAIN_ITEM.itemId],
      applicationRecoveries: [{
        ...recovery,
        attempts: [{
          ...recovery.attempts[0],
          attemptIdentitySha256: originRoot === "b0" ? "1".repeat(64) : "4".repeat(64),
        }],
      }],
      gateResults: [],
      safetyFailures: 0,
      qualityFailures: 0,
      outcome: "elite" as const,
    },
  });
  const b0 = candidate("b0", "b0", B0);
  const s0 = candidate("s0", "s0", S0);
  return {
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    stopReason: "public_goal_met",
    stopDetail: "current fixture",
    candidates: [b0, s0],
    population: {
      anchorCandidateId: "b0",
      eliteId: "s0",
      diversityId: "b0",
      eliteReason: "current fixture",
      diversityReason: "current fixture",
    },
    generations: [],
    finalElite: s0,
    explorationOnly: false,
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    events: [{ type: "run_start", contractSha256: CONTRACT_SHA256 }],
    pinnedItemIds: [TRAIN_ITEM.itemId],
    totalWallTimeMs: 1,
    serialEquivalentMs: 1,
    maxObservedInFlight: 1,
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    u1Intake: {
      lane: "eligible_b0_repair",
      track: "b0-repair",
      reasons: [],
      violationCategories: [],
      b0EvidenceSha256: sha256Hex(B0),
      s0SkillSha256: sha256Hex(S0),
      reportingNote: "current fixture",
    },
    publicContract: { version: "v3" },
    adaptiveBudget,
    liveRun: {
      provider: { name: "deepseek", model: "deepseek-test", configFingerprint: FINGERPRINT },
      authorizedBudget: { maxLogicalCalls: adaptiveBudget.envelope.authorizedLogicalCalls },
      callEnvelope: adaptiveBudget.envelope,
      providerTokenTelemetry: tokenTelemetry("adaptive", 2),
    },
    evidence: {
      confirmationMode: "human",
      explorationOnly: false,
      humanConfirmationBypassed: false,
    },
    scoringIdentity: {
      contractSha256: CONTRACT_SHA256,
      profileVersion: "u1-scoring-profile-v3",
      taskVerifierVersion: "u1-task-verifier-v3",
      rubricVersion: "u1-five-dimension-rubric-v2",
    },
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
  };
}

function resumeBindings(raw: string) {
  return {
    expectedAdaptiveResultSha256: sha256Hex(raw),
    contractSha256: CONTRACT_SHA256,
    currentTrainItemIds: [TRAIN_ITEM.itemId],
    currentTrainItems: [TRAIN_ITEM],
    b0SkillMd: B0,
    s0SkillMd: S0,
    publicContract: { version: "v3" as const },
    confirmationMode: "human" as const,
    providerModel: "deepseek-test",
    acceptedEvaluatorConfigFingerprints: [FINGERPRINT],
    expectedU1Intake: {
      track: "b0-repair" as const,
      b0EvidenceSha256: sha256Hex(B0),
      s0SkillSha256: sha256Hex(S0),
    },
  };
}

const STAGE_ASSUMPTIONS = {
  shortlistCandidates: 2,
  selectItems: 1,
  holdoutItems: 1,
  semanticBatchSize: 1,
  directProposerCalls: 1,
  maxModelTurns: 6,
  maxToolCalls: 4,
  budgetMultiplier: 2,
};

function recoveryDiagnostic(stage: "public-select" | "direct", attempt: 1 | 2 = 1) {
  return {
    subject: { kind: "stage" as const, stage },
    attempt,
    failureCode: "SEMANTIC_JUDGE_INVALID_JSON",
    findingCodes: [],
    responseLength: 7,
    finishReason: "stop" as const,
    responseSha256: (attempt === 1 ? "d" : "e").repeat(64),
  };
}

function currentPublicFailure() {
  const envelope = calculateStageBudgets(STAGE_ASSUMPTIONS).envelope.publicSelect;
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    status: "failed",
    phase: "public-select",
    feedbackToEvolution: false,
    adaptiveResultSha256: "a".repeat(64),
    contractSha256: CONTRACT_SHA256,
    selectItemsSha256: SELECT_SHA256,
    safeError: { code: "PROVIDER_TRUNCATED_OUTPUT", message: "sanitized" },
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      assumptions: STAGE_ASSUMPTIONS,
      envelope,
    },
    accounting: { logicalCalls: 1, httpAttempts: 1, retryAttempts: 0 },
    providerTokenTelemetry: tokenTelemetry("public-select"),
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    provider: {
      name: "deepseek",
      model: "deepseek-test",
      evaluatorConfigFingerprint: FINGERPRINT,
      semanticJudgeConfigFingerprint: FINGERPRINT,
    },
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
    holdout: "sealed",
    release: "withheld",
  };
}

function currentPublicResult() {
  const envelope = calculateStageBudgets(STAGE_ASSUMPTIONS).envelope.publicSelect;
  const candidate = (candidateId: string, rootKind: "b0" | "s0", hash: string, score: number) => ({
    candidateId,
    rootKind,
    skillSha256: hash,
    weightedMean: score,
    comparisonEligible: true,
    championEligible: true,
    releaseEligible: false,
    everyGatePassed: true,
    criticalRegression: false,
    criticalRegressionItemIds: [],
    gateResults: [{ gateId: "safe", category: "safety", passed: true }],
    itemScores: [{ itemId: "select-1", score, passed: true, criticalFailure: false }],
    answerHashes: [{ itemId: "select-1", answerSha256: hash }],
    dimensionScores: {
      task_correctness: score,
      evidence_boundary: score,
      capability_boundary: score,
      output_structure: score,
      actionability: score,
    },
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [],
  });
  const b0 = candidate("b0", "b0", "1".repeat(64), 81);
  const s0 = candidate("s0", "s0", "2".repeat(64), 80);
  const applicationRecovery = [b0, s0].map((entry, index) => {
    const base = applicationEvidence("select-1", envelope);
    return {
      candidateId: entry.candidateId,
      role: "public-select" as const,
      ...base,
      attempts: [{ ...base.attempts[0], attemptIdentitySha256: `${index + 4}`.repeat(64) }],
    };
  });
  return {
    schemaVersion: 2,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: new Date().toISOString(),
    status: "completed",
    phase: "public-select",
    adaptiveResultSha256: "a".repeat(64),
    contractSha256: CONTRACT_SHA256,
    selectItemsSha256: SELECT_SHA256,
    selection: {
      shortlistCandidateIds: ["b0", "s0"],
      candidateEvaluations: [b0, s0],
      decision: {
        startingReferenceId: "b0",
        finalPublicChampionId: "b0",
        verdict: "start_reference_retained",
        comparisonEligible: true,
        championEligible: true,
        releaseEligible: false,
        scoreDelta: 0,
        criticalRegression: false,
        protectedDimensionRegression: false,
        protectedDimensionRegressions: [],
        sameModelLimitation: "same-model limitation",
      },
      scoringIdentity: {
        contractSha256: CONTRACT_SHA256,
        profileVersion: "u1-scoring-profile-v3",
        taskVerifierVersion: "u1-task-verifier-v3",
        rubricVersion: "u1-five-dimension-rubric-v2",
      },
    },
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      independent: true,
      assumptions: STAGE_ASSUMPTIONS,
      envelope,
    },
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    provider: {
      name: "deepseek",
      model: "deepseek-test",
      evaluatorConfigFingerprint: FINGERPRINT,
      semanticJudgeConfigFingerprint: FINGERPRINT,
    },
    applicationRecovery,
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    providerTokenTelemetry: tokenTelemetry("public-select", 2),
    resumeEvidence: { mode: "public-select-only", adaptiveCalls: 0, adaptiveArtifactPreserved: true },
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

function diagnosticClearImprovementResult() {
  const result = structuredClone(currentPublicResult()) as any;
  const assumptions = { ...STAGE_ASSUMPTIONS, shortlistCandidates: 3 };
  const envelope = calculateStageBudgets(assumptions).envelope.publicSelect;
  result.budget = {
    ...result.budget,
    minimum: envelope.baselineEstimate,
    authorized: envelope.authorizedLogicalCalls,
    assumptions,
    envelope,
  };
  const root = result.selection.candidateEvaluations[0];
  const challenger = {
    ...structuredClone(root),
    candidateId: "challenger",
    rootKind: "evolved",
    skillSha256: "3".repeat(64),
    weightedMean: 97,
    itemScores: root.itemScores.map((item: any) => ({ ...item, score: 97 })),
    answerHashes: root.answerHashes.map((item: any) => ({ ...item, answerSha256: "3".repeat(64) })),
    dimensionScores: {
      task_correctness: 97,
      evidence_boundary: 97,
      capability_boundary: 97,
      output_structure: 97,
      actionability: 97,
    },
  };
  result.selection.shortlistCandidateIds.push(challenger.candidateId);
  result.selection.candidateEvaluations.push(challenger);
  result.selection.decision = {
    ...result.selection.decision,
    finalPublicChampionId: challenger.candidateId,
    verdict: "clear_improvement",
    scoreDelta: 16,
  };
  const base = applicationEvidence("select-1", envelope);
  result.applicationRecovery.push({
    candidateId: challenger.candidateId,
    role: "public-select",
    ...base,
    attempts: [{ ...base.attempts[0], attemptIdentitySha256: "9".repeat(64) }],
  });
  return result;
}

test("current Adaptive resume requires human H evidence and candidate generation/lane recovery", () => {
  const artifact = currentAdaptiveArtifact();
  const raw = `${JSON.stringify(artifact)}\n`;
  assert.doesNotThrow(() => parseAdaptiveResultArtifact(artifact));
  assert.equal(validateAdaptiveResultForPublicSelectResume(raw, resumeBindings(raw)).adaptiveResultSha256, sha256Hex(raw));

  const repaired = structuredClone(artifact) as any;
  repaired.actualApplicationRecoveryAttempts = 1;
  repaired.structureRecoveryDiagnostics = [{
    subject: { kind: "candidate", generation: 1, lane: "exploit" },
    attempt: 1,
    failureCode: "SEMANTIC_JUDGE_INVALID_JSON",
    findingCodes: [],
    responseLength: 7,
    finishReason: "stop",
    responseSha256: "d".repeat(64),
  }];
  assert.doesNotThrow(() => parseAdaptiveResultArtifact(repaired));
  assert.throws(
    () => parseAdaptiveResultArtifact({ ...artifact, structureRecoveryDiagnostics: [recoveryDiagnostic("public-select")] }),
    /Adaptive recovery diagnostics|candidate/i,
  );
  const missing = structuredClone(artifact) as any;
  delete missing.structureRecoveryDiagnostics;
  assert.throws(() => parseAdaptiveResultArtifact(missing));
  assert.throws(
    () => parseAdaptiveResultArtifact({ ...artifact, adaptiveProtocolBinding: {} }),
    /retired adaptiveProtocolBinding/i,
  );
});

test("completed Adaptive evidence keeps multiple bounded recoveries and a locally rejected repair in one lane", () => {
  const artifact = currentAdaptiveArtifact() as any;
  const primary = {
    subject: { kind: "candidate", generation: 1, lane: "exploit" },
    attempt: 1,
    failureCode: "SEMANTIC_JUDGE_INVALID_JSON",
    findingCodes: [],
    responseLength: 7,
    finishReason: "stop",
    responseSha256: "d".repeat(64),
  };
  artifact.actualApplicationRecoveryAttempts = 2;
  artifact.structureRecoveryDiagnostics = [
    primary,
    { ...primary, responseSha256: "e".repeat(64) },
    { ...primary, attempt: 2, responseSha256: "f".repeat(64) },
  ];
  assert.doesNotThrow(() => parseAdaptiveResultArtifact(artifact));

  artifact.structureRecoveryDiagnostics.push({
    ...primary,
    attempt: 2,
    responseSha256: "9".repeat(64),
  });
  artifact.structureRecoveryDiagnostics.push({
    ...primary,
    attempt: 2,
    responseSha256: "8".repeat(64),
  });
  assert.throws(() => parseAdaptiveResultArtifact(artifact), /repair diagnostics cannot exceed rejected primaries/i);
});

test("current public-select failure requires one bounded stage repair and exact resume identity", () => {
  const failure = currentPublicFailure();
  assert.doesNotThrow(() => PublicSelectionFailureArtifactSchema.parse(failure));
  const oldBudgetFailure = structuredClone(failure) as any;
  delete oldBudgetFailure.budget.assumptions.maxModelTurns;
  delete oldBudgetFailure.budget.assumptions.maxToolCalls;
  delete oldBudgetFailure.budget.assumptions.budgetMultiplier;
  assert.throws(
    () => PublicSelectionFailureArtifactSchema.parse(oldBudgetFailure),
    /maxModelTurns|maxToolCalls|budgetMultiplier/i,
  );
  assert.doesNotThrow(() => validatePublicSelectionFailureForResume(
    JSON.stringify(failure),
    failure.adaptiveResultSha256,
    {
      contractSha256: CONTRACT_SHA256,
      selectItemsSha256: SELECT_SHA256,
      providerModel: "deepseek-test",
      confirmationMode: "human",
    },
  ));

  const exhaustedRepair = {
    ...failure,
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    actualApplicationRecoveryAttempts: 1,
    structureRecoveryDiagnostics: [recoveryDiagnostic("public-select", 1), recoveryDiagnostic("public-select", 2)],
  };
  assert.doesNotThrow(() => PublicSelectionFailureArtifactSchema.parse(exhaustedRepair));
  assert.throws(
    () => PublicSelectionFailureArtifactSchema.parse({
      ...failure,
      actualApplicationRecoveryAttempts: 1,
      structureRecoveryDiagnostics: [recoveryDiagnostic("direct")],
    }),
    /public-select|recovery/i,
  );
  assert.throws(
    () => validatePublicSelectionFailureForResume(JSON.stringify(failure), failure.adaptiveResultSha256, {
      contractSha256: "0".repeat(64),
      selectItemsSha256: SELECT_SHA256,
      providerModel: "deepseek-test",
      confirmationMode: "human",
    }),
    /IDENTITY_DRIFT/,
  );
});

test("current public-select result makes recovery mandatory, stage-specific and reserve-bound", () => {
  const result = currentPublicResult();
  assert.doesNotThrow(() => PublicSelectionResultArtifactSchema.parse(result));
  const oldBudgetResult = structuredClone(result) as any;
  delete oldBudgetResult.budget.assumptions.maxModelTurns;
  delete oldBudgetResult.budget.assumptions.maxToolCalls;
  delete oldBudgetResult.budget.assumptions.budgetMultiplier;
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse(oldBudgetResult),
    /maxModelTurns|maxToolCalls|budgetMultiplier/i,
  );

  const repaired = {
    ...result,
    accounting: { logicalCalls: 3, httpAttempts: 3, retryAttempts: 0 },
    actualApplicationRecoveryAttempts: 1,
    structureRecoveryDiagnostics: [recoveryDiagnostic("public-select")],
  };
  assert.doesNotThrow(() => PublicSelectionResultArtifactSchema.parse(repaired));
  const missing = structuredClone(result) as any;
  delete missing.actualApplicationRecoveryAttempts;
  assert.throws(() => PublicSelectionResultArtifactSchema.parse(missing));
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse({
      ...repaired,
      actualApplicationRecoveryAttempts: 2,
      structureRecoveryDiagnostics: [
        recoveryDiagnostic("public-select"),
        { ...recoveryDiagnostic("public-select"), responseSha256: "9".repeat(64) },
      ],
    }),
    /one primary|recovery count|reserve/i,
  );
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse({
      ...result,
      actualApplicationRecoveryAttempts: 1,
      structureRecoveryDiagnostics: [recoveryDiagnostic("direct")],
    }),
    /public-select|recovery/i,
  );
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse({ ...result, executionProtocol: {} }),
    /retired executionProtocol/i,
  );
  const unknownSelectionField = structuredClone(result) as any;
  unknownSelectionField.selection.unexpectedSelectionField = true;
  assert.throws(() => PublicSelectionResultArtifactSchema.parse(unknownSelectionField), /unrecognized|unexpectedSelectionField/i);
  const unknownDecisionField = structuredClone(result) as any;
  unknownDecisionField.selection.decision.unexpectedDecisionField = true;
  assert.throws(() => PublicSelectionResultArtifactSchema.parse(unknownDecisionField), /unrecognized|unexpectedDecisionField/i);
  const unknownCandidateField = structuredClone(result) as any;
  unknownCandidateField.selection.candidateEvaluations[0].unexpectedCandidateField = true;
  assert.throws(() => PublicSelectionResultArtifactSchema.parse(unknownCandidateField), /unrecognized|unexpectedCandidateField/i);
});

test("current public-select relationship rejects a retained result that hides a qualified challenger", () => {
  const clear = diagnosticClearImprovementResult();
  assert.doesNotThrow(() => PublicSelectionResultArtifactSchema.parse(clear));

  const retained = structuredClone(clear) as any;
  retained.selection.decision.verdict = "start_reference_retained";
  retained.selection.decision.finalPublicChampionId = retained.selection.decision.startingReferenceId;
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse(retained),
    /clear improvement|qualified challenger|delta/i,
  );

  const uncertain = structuredClone(clear) as any;
  uncertain.selection.decision.verdict = "uncertain";
  uncertain.selection.decision.finalPublicChampionId = uncertain.selection.decision.startingReferenceId;
  assert.throws(() => PublicSelectionResultArtifactSchema.parse(uncertain), /verdict|uncertain/i);

  const rejected = structuredClone(clear) as any;
  const challenger = rejected.selection.candidateEvaluations.find((candidate: any) => candidate.candidateId === "challenger");
  challenger.championEligible = false;
  challenger.everyGatePassed = false;
  challenger.gateResults.push({ gateId: "quality-floor", category: "quality", passed: false });
  rejected.selection.decision = {
    ...rejected.selection.decision,
    finalPublicChampionId: rejected.selection.decision.startingReferenceId,
    verdict: "candidate_rejected",
    championEligible: true,
  };
  assert.doesNotThrow(() => PublicSelectionResultArtifactSchema.parse(rejected));
  const misclassified = structuredClone(rejected) as any;
  misclassified.selection.decision.verdict = "start_reference_retained";
  assert.throws(
    () => PublicSelectionResultArtifactSchema.parse(misclassified),
    /rejection semantics|candidate_rejected/i,
  );
});
