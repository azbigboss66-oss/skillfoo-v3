import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_U1_SCORING_PROFILE,
  SEMANTIC_RESPONSE_BINDING_VERSION,
} from "../types.js";
import {
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
} from "../evolution/directBaseline.js";
import { aggregateU1TechnicalSuiteReport } from "./suiteReport.js";
import { calculateStageBudgets } from "../providers/stageBudgets.js";
import { PublicSelectionResultArtifactSchema } from "../evolution/publicSelectionResume.js";

const CASES = [
  { id: "low-case", directory: "low" , contractSha256: "a".repeat(64) },
  { id: "medium-case", directory: "nested/medium", contractSha256: "b".repeat(64) },
  { id: "high-case", directory: "high", contractSha256: "c".repeat(64) },
] as const;
const TASK_HASH = "d".repeat(64);
const REVIEW_HASH = "e".repeat(64);

function scoringIdentity(contractSha256: string) {
  return {
    contractSha256,
    profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
    taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
    rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
  };
}

function providerTokens(responses: number) {
  return {
    promptTokens: responses * 10,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    completionTokens: responses * 5,
    responses,
    responsesWithUsage: responses,
    responsesMissingUsage: 0,
    byStageRoleModel: [{
      tags: { stage: "fixture", role: "semantic-judge", model: "deepseek-v4-flash" },
      telemetry: {
        promptTokens: responses * 10,
        promptCacheHitTokens: null,
        promptCacheMissTokens: null,
        completionTokens: responses * 5,
        responses,
        responsesWithUsage: responses,
        responsesMissingUsage: 0,
      },
    }],
  };
}

function passScores(passIndex: 1 | 2) {
  return {
    pass: true,
    minAdjacentGap: 10,
    passIndex,
    scores: { good: 90, borderline: 70, unsafe: 40 },
    orderingPreserved: true,
  };
}

function calibrationEvidence(contractSha256: string) {
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: "2026-08-30T00:00:00.000Z",
    status: "passed",
    contractSha256,
    calibrationTripletSha256: "f".repeat(64),
    provider: { name: "deepseek", model: "deepseek-v4-flash", configFingerprint: "1".repeat(24) },
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
    result: {
      pass: true,
      minAdjacentGap: 10,
      passes: [passScores(1), passScores(2)],
      medianScores: { good: 90, borderline: 70, unsafe: 40 },
      bothPassesPreserved: true,
      medianGapPreserved: true,
    },
    passes: [
      { scores: { good: 90, borderline: 70, unsafe: 40 }, requestFingerprint: "2".repeat(64), resultFingerprint: "3".repeat(64) },
      { scores: { good: 90, borderline: 70, unsafe: 40 }, requestFingerprint: "4".repeat(64), resultFingerprint: "5".repeat(64) },
    ],
    actualApplicationRecoveryAttempts: 0,
    applicationRecoveryAttempts: [],
    structureRecoveryDiagnostics: [],
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    tokenTelemetry: { promptTokens: 20, completionTokens: 10, responses: 2 },
    providerTokenTelemetry: providerTokens(2),
  };
}

function stageBudget(recoveryReserve: number) {
  return {
    minimum: 10,
    authorized: 24,
    independent: true,
    envelope: {
      estimationVersion: "candidate-item-envelope-v3",
      baselineEstimate: 10,
      authorizedLogicalCalls: 24,
      existingRecoveryReserve: recoveryReserve,
    },
  };
}

function publicSelectionArtifact(entry: typeof CASES[number], retainedQualifiedChallenger = false) {
  const itemIds = Array.from({ length: 6 }, (_, index) => `${entry.id}-select-${index + 1}`);
  const candidate = (
    candidateId: string,
    rootKind: "b0" | "s0" | "evolved",
    hashDigit: string,
    score: number,
  ) => ({
    candidateId,
    rootKind,
    skillSha256: hashDigit.repeat(64),
    weightedMean: score,
    comparisonEligible: true,
    championEligible: true,
    releaseEligible: false,
    everyGatePassed: true,
    criticalRegression: false,
    criticalRegressionItemIds: [],
    gateResults: [{ gateId: "safe", category: "safety", passed: true }],
    itemScores: itemIds.map((itemId) => ({ itemId, score, passed: true, criticalFailure: false })),
    answerHashes: itemIds.map((itemId) => ({ itemId, answerSha256: hashDigit.repeat(64) })),
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
  const candidates = [
    candidate("b0-reference", "b0", "1", 81),
    candidate("s0-reference", "s0", "2", 80),
    ...(retainedQualifiedChallenger ? [candidate("qualified-challenger", "evolved", "3", 97)] : []),
  ];
  const assumptions = {
    shortlistCandidates: candidates.length,
    selectItems: itemIds.length,
    holdoutItems: 3,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const envelope = calculateStageBudgets(assumptions).envelope.publicSelect;
  const scenario = envelope.scenarioAuthorization;
  const applicationRecovery = candidates.flatMap((entryCandidate, candidateIndex) =>
    itemIds.map((itemId, itemIndex) => ({
      candidateId: entryCandidate.candidateId,
      itemId,
      role: "public-select",
      outcome: "no_retry_needed",
      attempts: [{
        attempt: 1,
        attemptIdentitySha256: (candidateIndex * itemIds.length + itemIndex + 1).toString(16).padStart(64, "0"),
        terminalReason: "final",
        modelCalls: 1,
        transcriptSha256: "4".repeat(64),
        successfulToolCalls: 0,
        failedToolCalls: 0,
        uniqueSuccessfulToolRequests: 0,
        repeatedSuccessfulToolRequests: 0,
        trajectorySha256: "5".repeat(64),
      }],
      retryTriggered: false,
      rawScenarioEstimate: scenario.rawScenarioEstimate,
      callEnvelopeMultiplier: scenario.callEnvelopeMultiplier,
      authorizedModelCallsPerAttempt: scenario.authorizedModelCallsPerAttempt,
      maxApplicationAttempts: scenario.maxApplicationAttempts,
      scenarioRetryReserve: scenario.scenarioRetryReserve,
      unusedRetryReserve: scenario.scenarioRetryReserve,
      classification: null,
    }))
  );
  return {
    schemaVersion: 2,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: "2026-08-30T00:00:00.000Z",
    status: "completed",
    phase: "public-select",
    adaptiveResultSha256: "8".repeat(64),
    contractSha256: entry.contractSha256,
    selectItemsSha256: "9".repeat(64),
    selection: {
      shortlistCandidateIds: candidates.map(({ candidateId }) => candidateId),
      candidateEvaluations: candidates,
      decision: {
        startingReferenceId: "b0-reference",
        finalPublicChampionId: "b0-reference",
        verdict: "start_reference_retained",
        comparisonEligible: true,
        championEligible: true,
        releaseEligible: false,
        scoreDelta: retainedQualifiedChallenger ? 16 : 0,
        criticalRegression: false,
        protectedDimensionRegression: false,
        protectedDimensionRegressions: [],
        sameModelLimitation: "same-provider/model evidence is not independent human evaluation",
      },
      scoringIdentity: scoringIdentity(entry.contractSha256),
    },
    budget: {
      minimum: envelope.baselineEstimate,
      authorized: envelope.authorizedLogicalCalls,
      independent: true,
      assumptions,
      envelope,
    },
    accounting: {
      logicalCalls: candidates.length * itemIds.length,
      httpAttempts: candidates.length * itemIds.length,
      retryAttempts: 0,
    },
    provider: {
      name: "deepseek",
      model: "deepseek-v4-flash",
      evaluatorConfigFingerprint: "a".repeat(24),
      semanticJudgeConfigFingerprint: "a".repeat(24),
    },
    applicationRecovery,
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    providerTokenTelemetry: providerTokens(candidates.length * itemIds.length),
    resumeEvidence: { mode: "terminal-after-adaptive", adaptiveCalls: 0, adaptiveArtifactPreserved: true },
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

async function writeFormalCase(root: string, entry: typeof CASES[number]): Promise<void> {
  const caseDir = join(root, ...entry.directory.split("/"));
  const formalDir = join(caseDir, "formal-evidence");
  const stageDir = join(formalDir, "adaptive");
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(formalDir, "evaluation-manifest.v3.json"), JSON.stringify({
    schemaVersion: 3,
    contractSha256: entry.contractSha256,
    taskCardHash: TASK_HASH,
    evaluationReviewHash: REVIEW_HASH,
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    trainItemIds: Array.from({ length: 8 }, (_, index) => `${entry.id}-train-${index + 1}`),
    selectItemIds: Array.from({ length: 6 }, (_, index) => `${entry.id}-select-${index + 1}`),
    holdoutItemIds: Array.from({ length: 3 }, (_, index) => `${entry.id}-holdout-${index + 1}`),
  }), "utf8");
  await writeFile(join(formalDir, "evaluation-contract.v3.json"), JSON.stringify({
    schemaVersion: 3,
    contractSha256: entry.contractSha256,
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
  }), "utf8");
  await writeFile(join(formalDir, "task-card.confirmed.json"), JSON.stringify({
    confirmation: {
      status: "confirmed",
      confirmationMode: "human",
      confirmedBy: "private-owner-identity",
      confirmedContentSha256: TASK_HASH,
    },
  }), "utf8");
  await writeFile(join(formalDir, "evaluation-review.confirmed.json"), JSON.stringify({
    confirmation: {
      status: "confirmed",
      confirmationMode: "human",
      humanReviewed: true,
      confirmedBy: "private-owner-identity",
      confirmedContentSha256: REVIEW_HASH,
    },
  }), "utf8");
  await writeFile(join(formalDir, "formal-evaluation-approval.v3.json"), JSON.stringify({
    kind: "u1-formal-evaluation-approval",
    confirmationMode: "human",
    humanReviewed: true,
    formalEligible: true,
    confirmedBy: "private-owner-identity",
    formal: {
      taskCardSha256: TASK_HASH,
      evaluationReviewBindingSha256: REVIEW_HASH,
    },
  }), "utf8");
  await writeFile(join(stageDir, "calibration-evidence.json"), JSON.stringify(calibrationEvidence(entry.contractSha256)), "utf8");
  await writeFile(join(stageDir, "adaptive-result.json"), JSON.stringify({
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    stopReason: "generations_completed",
    scoringIdentity: scoringIdentity(entry.contractSha256),
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    formalEvidence: true,
    accounting: { logicalCalls: 20, httpAttempts: 20, retryAttempts: 0 },
    totalWallTimeMs: 1000,
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    adaptiveBudget: {
      envelope: {
        baselineEstimate: 10,
        authorizedLogicalCalls: 40,
        existingRecoveryReserve: 4,
      },
    },
    liveRun: { providerTokenTelemetry: providerTokens(20) },
  }), "utf8");
  const publicArtifact = PublicSelectionResultArtifactSchema.parse(publicSelectionArtifact(entry));
  await writeFile(
    join(stageDir, "public-selection-result.json"),
    JSON.stringify(publicArtifact),
    "utf8",
  );
  await writeFile(join(stageDir, "direct-result.json"), JSON.stringify({
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    status: "completed",
    phase: "direct-public-select",
    contractSha256: entry.contractSha256,
    scoringIdentity: scoringIdentity(entry.contractSha256),
    directPromptContractVersion: DIRECT_U1_PROMPT_CONTRACT_VERSION,
    directPromptContractSha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
    comparison: {
      relativeToStarting: { result: "tied_public_score", scoreDelta: 0 },
    },
    budget: stageBudget(1),
    accounting: { logicalCalls: 4, httpAttempts: 4, retryAttempts: 0 },
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    tokenTelemetry: providerTokens(4),
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    formalEvidence: true,
  }), "utf8");
  await writeFile(join(stageDir, "audit-compare.json"), JSON.stringify({
    status: "holdout_not_entered",
    reason: "no_novel_public_champion",
    contractSha256: entry.contractSha256,
    bodyReads: 0,
    verificationMode: "live-formal",
    formalEvidence: true,
  }), "utf8");
}

async function writeCurrentSuite(root: string): Promise<void> {
  await writeFile(join(root, "SUITE_MANIFEST.json"), JSON.stringify({
    schemaVersion: 1,
    suite: "u1-current-formal",
    cases: CASES.map((entry, index) => ({ ...entry, order: index + 1 })),
  }), "utf8");
  for (const entry of CASES) await writeFormalCase(root, entry);
}

test("aggregates three arbitrary current formal cases without legacy or sensitive report paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-current-suite-"));
  try {
    await writeCurrentSuite(root);
    const report = await aggregateU1TechnicalSuiteReport({
      suiteDir: root,
      now: () => "2026-08-30T01:00:00.000Z",
    });
    assert.equal(report.reportKind, "u1-current-formal");
    assert.equal(report.suite, "u1-current-formal");
    assert.deepEqual(report.cases.map((entry) => entry.caseId), ["low-case", "medium-case", "high-case"]);
    assert.deepEqual(report.calibrationBudget, {
      primaryPasses: 2,
      schemaRecoveryReserve: 2,
      authorizedLogicalCalls: 4,
    });
    for (const row of report.cases) {
      assert.deepEqual(row.formalEvidence, {
        confirmationMode: "human",
        humanConfirmations: { required: 2, completed: 2 },
        humanConfirmationBypassed: false,
      });
      assert.equal(row.stages.calibration.budget?.authorizedLogicalCalls, 4);
      assert.equal(row.stages.publicSelect.budget?.existingRecoveryReserve, 4);
      assert.equal(row.stages.direct.budget?.existingRecoveryReserve, 1);
      assert.deepEqual(row.stages.sealed.semanticRecovery, { reserve: 0, actual: 0, diagnosticsObserved: 0 });
      assert.deepEqual(row.sealed, {
        status: "holdout_not_entered",
        bodyReads: 0,
        applicationRecoveryReserve: 0,
        applicationRecoveryAttempts: 0,
      });
    }
    assert.equal(report.cases[0]?.stages.publicSelect.semanticRecovery.actual, 0);
    assert.equal(report.totals.semanticSchemaRepairs, 0);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes("private-owner-identity"), false);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("development-evidence"), false);
    assert.equal(serialized.includes("selfRefine"), false);
    assert.equal(serialized.includes("holdout-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a current formal case whose public evidence drifts to a retired scoring identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-current-suite-drift-"));
  try {
    await writeCurrentSuite(root);
    const path = join(root, "low", "formal-evidence", "adaptive", "public-selection-result.json");
    const drifted = {
      schemaVersion: 2,
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      status: "completed",
      phase: "public-select",
      contractSha256: CASES[0].contractSha256,
      selection: {
        scoringIdentity: {
          ...scoringIdentity(CASES[0].contractSha256),
          profileVersion: "u1-scoring-profile-v2",
        },
        decision: { verdict: "start_reference_retained" },
      },
      budget: stageBudget(2),
      accounting: { logicalCalls: 1, httpAttempts: 1, retryAttempts: 0 },
      actualApplicationRecoveryAttempts: 0,
      structureRecoveryDiagnostics: [],
      confirmationMode: "human",
      humanConfirmationBypassed: false,
      formalEvidence: true,
    };
    await writeFile(path, JSON.stringify(drifted), "utf8");
    await assert.rejects(
      aggregateU1TechnicalSuiteReport({ suiteDir: root }),
      /SUITE_REPORT_PUBLIC_SELECTION_INVALID: artifact does not carry the current scoring identity/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a retained public artifact when a qualified challenger improves by at least 3", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-current-suite-selection-policy-"));
  try {
    await writeCurrentSuite(root);
    const path = join(root, "low", "formal-evidence", "adaptive", "public-selection-result.json");
    await writeFile(path, JSON.stringify(publicSelectionArtifact(CASES[0], true)), "utf8");
    await assert.rejects(
      aggregateU1TechnicalSuiteReport({ suiteDir: root }),
      /SUITE_REPORT_PUBLIC_SELECTION_INVALID: completed public-select result fails current relational validation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
