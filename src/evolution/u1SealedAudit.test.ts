import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCallBudget } from "../providers/runBudget.js";
import { calculateStageBudgets, type CallEnvelope } from "../providers/stageBudgets.js";
import { applyContractGates } from "../runtime/instructionAdapter.js";
import { stableStringify } from "../intake/taskCard.js";
import { DEFAULT_U1_SCORING_PROFILE, U1_TASK_VERIFIER_VERSION } from "../types.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import { U1RubricError } from "../evaluation/u1Rubric.js";
import type {
  DraftItem,
  EvaluationContractV3,
  EvaluationReviewConfirmation,
  FrozenContractManifest,
  HoldoutFile,
  RunTranscript,
  TaskCardConfirmation,
} from "../types.js";
import type { FunnelEvalItem } from "./funnel.js";
import * as u1SealedAuditModule from "./u1SealedAudit.js";
import {
  runU1SealedAudit,
  U1SealedApplicationRecoverySummarySchema,
  U1SealedAuditError,
  U1SealedCompletedArtifactSchema,
  U1SealedFailureArtifactSchema,
  type U1SealedAuditArguments,
  type U1SealedCandidateLabel,
  type U1SealedCandidateState,
} from "./u1SealedAudit.js";

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: unknown): string => hash(stableStringify(value));
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_D = "d".repeat(64);
const STARTING_MD = "# Starting Reference\n\nKeep claims evidence-bound.\n";
const ADAPTIVE_MD = "# Adaptive Final Public Champion\n\nKeep claims evidence-bound and actionable.\n";
const DIRECT_MD = "# Direct\n\nKeep claims evidence-bound with concise steps.\n";

type AdaptiveCandidateHashResolver = (args: {
  candidates: Array<{ candidateId: string; skillMd: string }>;
  expectedSkillSha256: string;
  preferredCandidateId?: string | null;
}) => { candidateId: string; skillMd: string } | null;

test("sealed candidate binding resolves Adaptive bytes by frozen hash across stage-local ids", () => {
  const resolveCandidate = (
    u1SealedAuditModule as unknown as {
      resolveAdaptiveCandidateBySkillSha256?: AdaptiveCandidateHashResolver;
    }
  ).resolveAdaptiveCandidateBySkillSha256;
  assert.equal(
    typeof resolveCandidate,
    "function",
    "the sealed binding must expose one shared hash-based Adaptive candidate resolver",
  );
  if (!resolveCandidate) return;

  const sharedSkill = "# S0\n\nUse only frozen evidence.\n";
  const sharedHash = hash(sharedSkill);
  const candidates = [
    { candidateId: "z-copy", skillMd: sharedSkill },
    { candidateId: "s0-scaffold", skillMd: sharedSkill },
    { candidateId: "a-copy", skillMd: sharedSkill },
    { candidateId: "other", skillMd: "# Other\n" },
  ];

  assert.deepEqual(
    resolveCandidate({
      candidates,
      expectedSkillSha256: sharedHash,
      preferredCandidateId: "s0-reference",
    }),
    { candidateId: "a-copy", skillMd: sharedSkill },
    "a public-stage id mismatch must fall back to the stable Adaptive id for identical bytes",
  );
  assert.deepEqual(
    resolveCandidate({
      candidates,
      expectedSkillSha256: sharedHash,
      preferredCandidateId: "s0-scaffold",
    }),
    { candidateId: "s0-scaffold", skillMd: sharedSkill },
    "an exact id remains preferred when its bytes match the frozen hash",
  );
  assert.equal(
    resolveCandidate({
      candidates,
      expectedSkillSha256: hash("# Missing\n"),
      preferredCandidateId: "s0-reference",
    }),
    null,
    "a missing frozen hash must fail closed instead of guessing from ids",
  );
});

function holdoutItems(): DraftItem[] {
  const dimensions = [
    "task_correctness",
    "evidence_boundary",
    "capability_boundary",
    "output_structure",
    "actionability",
  ] as const;
  return [1, 2, 3].map((index) => ({
    itemId: `holdout-${index}`,
    scenarioId: `sealed-family-${index}`,
    split: "holdout" as const,
    itemType: index === 2 ? "near-miss" as const : "trigger" as const,
    input: `synthetic sealed request ${index}`,
    judgingRule: `synthetic answer must satisfy rule ${index}`,
    capabilityTags: ["instruction"],
    origin: "synthetic" as const,
    redlineRefs: ["never fabricate execution"],
    rationale: `independent synthetic family ${index}`,
    confidence: { level: "high" as const, score: 90, reasons: ["pure structural fixture"] },
    adapterId: "instruction-v1",
    rubric: {
      critical: index === 1,
      passThreshold: 70,
      mustHave: ["evidence boundary"],
      mustNotHave: ["fabricated execution"],
      dimensions: dimensions.map((id) => ({
        id,
        weight: DEFAULT_U1_SCORING_PROFILE.dimensions.find((dimension) => dimension.id === id)!.weight,
      })),
    },
    taskVerifier: {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [{
        ruleId: "no-quality-violation",
        kind: "forbidden_content" as const,
        value: "quality violation",
        caseSensitive: false,
        effect: "quality" as const,
        dimension: "evidence_boundary" as const,
        weight: 1,
      }],
    },
    scenarioFamily: `sealed-family-${index}`,
    testSource: "fixture-derived" as const,
    reviewStatus: "human-confirmed" as const,
  }));
}

function contractOf(): EvaluationContractV3 {
  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const selectItemIds = Array.from({ length: 6 }, (_, index) => `select-${index + 1}`);
  const contract = {
    schemaVersion: 3,
    createdAt: "2026-08-27T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: { taskCard: HASH_A, evaluationReview: HASH_D },
    taskCardHash: HASH_A,
    skillSnapshotHash: HASH_B,
    adapterId: "instruction-v1",
    allowedCapabilities: ["instruction"],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    publicScenarioIds: Array.from({ length: 14 }, (_, index) => `public-${index + 1}`),
    holdoutScenarioIds: ["sealed-family-1", "sealed-family-2", "sealed-family-3"],
    safetyGates: [
      { gateId: "contract-capability-boundary", description: "boundary" },
      { gateId: "redline-hold", description: "red lines hold" },
    ],
    qualityGates: [
      { gateId: "judging-rule-pass", description: "judging rule" },
      { gateId: "public-absolute-floor", description: "public-only floor" },
    ],
    goalConfidence: { level: "high", score: 90, reasons: ["human confirmed"] },
    evalConfidence: { level: "high", score: 90, reasons: ["human confirmed"] },
    generation: {
      generator: { kind: "provider", name: "deepseek" },
      curator: { kind: "curator", name: "independent-review" },
      generatorCuratorIsolation: "independent",
    },
    thresholds: { absoluteFloor: 60, confidenceFloor: 60 },
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 3 / 17,
    },
    explorationOnly: true,
    contractSha256: "0".repeat(64),
    evaluationReviewHash: HASH_D,
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
    trainItemIds,
    selectItemIds,
    trainItemsSha256: hash("train"),
    selectItemsSha256: hash("select"),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: hash("calibration"),
    sameModelLimitation: "Fixture evidence uses one deterministic evaluator and does not establish model independence.",
    u1ContractVersion: "v2",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
  } satisfies EvaluationContractV3;
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return contract;
}

function finalTranscript(item: FunnelEvalItem): RunTranscript {
  return {
    scenarioId: item.scenarioId,
    snapshotId: "fixture",
    toolEvents: [],
    rawFinalResponse: JSON.stringify({ type: "final", answer: { digest: `answer ${item.itemId}` } }),
    parsedFinalAnswer: { digest: `answer ${item.itemId}` },
    terminalReason: "final",
    turns: 1,
    durationMs: 1,
  };
}

function sealedApplicationRecovery(
  skillMd: string,
  itemId: string,
  envelope: CallEnvelope,
): NonNullable<RunTranscript["applicationRecovery"]> {
  return {
    outcome: "no_retry_needed" as const,
    attempts: [{
      attempt: 1 as const,
      attemptIdentitySha256: hash(`sealed-attempt:${skillMd}:${itemId}`),
      terminalReason: "final" as const,
      modelCalls: 1,
      transcriptSha256: hash(`sealed-transcript:${skillMd}:${itemId}`),
      successfulToolCalls: 0,
      failedToolCalls: 0,
      uniqueSuccessfulToolRequests: 0,
      repeatedSuccessfulToolRequests: 0,
      trajectorySha256: hash(`sealed-trajectory:${skillMd}:${itemId}`),
    }],
    retryTriggered: false,
    rawScenarioEstimate: envelope.scenarioAuthorization.rawScenarioEstimate,
    callEnvelopeMultiplier: envelope.scenarioAuthorization.callEnvelopeMultiplier,
    authorizedModelCallsPerAttempt: envelope.scenarioAuthorization.authorizedModelCallsPerAttempt,
    maxApplicationAttempts: 1 as const,
    scenarioRetryReserve: 0,
    unusedRetryReserve: 0,
    classification: null,
  };
}

interface FixtureCounters {
  bodyReads: number;
  candidateReads: number;
  claims: number;
  runnerCalls: number;
  judgeCalls: number;
}

async function makeFixture(t: test.TestContext): Promise<{
  args: U1SealedAuditArguments;
  counters: FixtureCounters;
  resetBudget: () => void;
}> {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-u1-sealed-structural-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const contract = contractOf();
  const items = holdoutItems();
  const bodyContent = {
    schemaVersion: 3 as const,
    producer: { kind: "cli" as const, name: "skillfoo" },
    contractSha256: contract.contractSha256,
    items,
  };
  const body: HoldoutFile = { ...bodyContent, createdAt: "2026-08-27T00:00:00.000Z" };
  const bodyPath = join(dir, "synthetic-sealed-fixture.json");
  await writeFile(bodyPath, JSON.stringify(body), "utf8");

  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const selectItemIds = Array.from({ length: 6 }, (_, index) => `select-${index + 1}`);
  const manifest: FrozenContractManifest = {
    schemaVersion: 3,
    createdAt: "2026-08-27T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    contractSha256: contract.contractSha256,
    taskCardHash: HASH_A,
    draftSha256: HASH_B,
    publicItemIds: [...trainItemIds, ...selectItemIds],
    holdoutItemIds: items.map((item) => item.itemId),
    trainItemIds,
    selectItemIds,
    trainItemsSha256: hash("train"),
    selectItemsSha256: hash("select"),
    holdoutItemsSha256: digest(items),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: hash("calibration"),
    publicScenarioIds: contract.publicScenarioIds,
    holdoutScenarioIds: items.map((item) => item.scenarioId),
    holdoutSha256: digest(bodyContent),
    evaluationReviewHash: HASH_D,
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
  };
  const taskCardConfirmation: TaskCardConfirmation = {
    status: "confirmed",
    confirmedBy: "automated-structural-fixture",
    confirmedAt: "2026-08-27T00:00:00.000Z",
    confirmationMode: "test-fixture",
    confirmedContentSha256: HASH_A,
  };
  const evaluationReviewConfirmation: EvaluationReviewConfirmation = {
    status: "confirmed",
    confirmedBy: "automated-structural-fixture",
    confirmedAt: "2026-08-27T00:00:01.000Z",
    confirmationMode: "test-fixture",
    confirmedContentSha256: HASH_D,
    humanReviewed: false,
  };
  const skills: Record<U1SealedCandidateLabel, string> = {
    starting_reference: STARTING_MD,
    adaptive: ADAPTIVE_MD,
    direct: DIRECT_MD,
  };
  const candidates: U1SealedCandidateState[] = (Object.keys(skills) as U1SealedCandidateLabel[]).map((label) => ({
    label,
    status: "frozen",
    candidateSource: `${label}:fixture`,
    skillSha256: hash(skills[label]),
  }));
  const counters: FixtureCounters = { bodyReads: 0, candidateReads: 0, claims: 0, runnerCalls: 0, judgeCalls: 0 };
  let claimed = false;
  const stageBudgetAssumptions = {
    shortlistCandidates: 4,
    selectItems: 6,
    holdoutItems: 3,
    semanticBatchSize: 3,
    directProposerCalls: 1,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const stageBudgetPlan = calculateStageBudgets(stageBudgetAssumptions);
  const sealedEnvelope = stageBudgetPlan.envelope.sealed;

  const args: U1SealedAuditArguments = {
    verificationMode: "test-fixture",
    contract,
    manifest,
    taskCardConfirmation,
    evaluationReviewConfirmation,
    formalEvidence: false,
    noRelease: true,
    b0B4: { b0: true, b1: true, b2: true, b3: true, b4: true },
    publicDecision: "clear_improvement",
    startingReferenceSha256: hash(STARTING_MD),
    finalPublicChampionSha256: hash(ADAPTIVE_MD),
    publicScoringIdentity: {
      contractSha256: contract.contractSha256,
      profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
      taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
      rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
    },
    candidates,
    readCandidateSkill: async (label) => {
      counters.candidateReads += 1;
      return skills[label];
    },
    readHoldoutBody: async () => {
      counters.bodyReads += 1;
      return JSON.parse(await readFile(bodyPath, "utf8"));
    },
    claimSealedExecution: async () => {
      counters.claims += 1;
      if (claimed) return false;
      claimed = true;
      return true;
    },
    stageBudgetAssumptions,
    authorizedStageBudgets: {
      publicSelect: stageBudgetPlan.publicSelect,
      direct: stageBudgetPlan.direct,
      sealed: stageBudgetPlan.sealed,
    },
    budget: new RunCallBudget({ maxLogicalCalls: stageBudgetPlan.sealed, maxRetryAttempts: 0 }),
    runner: async ({ item, skillMd }) => {
      args.budget.enterLogicalCall("evaluator");
      counters.runnerCalls += 1;
      return {
        ...finalTranscript(item),
        applicationRecovery: sealedApplicationRecovery(skillMd, item.itemId, sealedEnvelope),
      };
    },
    scoreRuns: async ({ contract: scoreContract, runs }) => {
      args.budget.enterLogicalCall("semantic-judge");
      counters.judgeCalls += 1;
      return applyContractGates({
        contract: scoreContract,
        runs: [...runs],
        semanticJudgements: runs.map((run) => ({
          itemId: run.item.itemId,
          score: 100,
          reason: "complete synthetic semantic evidence",
          dimensions: [
            "task_correctness",
            "evidence_boundary",
            "capability_boundary",
            "output_structure",
            "actionability",
          ].map((id) => ({
            id: id as "task_correctness" | "evidence_boundary" | "capability_boundary" | "output_structure" | "actionability",
            score: 100,
            reason: "synthetic structural fixture",
          })),
          weightedScore: 100,
          overallReason: "synthetic structural fixture",
          requestFingerprint: hash(`semantic:${run.item.itemId}`),
        })),
      });
    },
  };
  return {
    args,
    counters,
    resetBudget: () => {
      args.budget = new RunCallBudget({ maxLogicalCalls: stageBudgetPlan.sealed, maxRetryAttempts: 0 });
    },
  };
}

test("U1 sealed B5 reads one synthetic body only after every gate and evaluates exactly three frozen candidates", async (t) => {
  const fixture = await makeFixture(t);
  const result = await runU1SealedAudit(fixture.args);

  assert.equal(result.status, "sealed_confirmed");
  assert.equal(result.bodyReads, 1);
  assert.equal(fixture.counters.bodyReads, 1);
  assert.equal(fixture.counters.candidateReads, 3);
  assert.equal(fixture.counters.claims, 1);
  assert.equal(fixture.counters.runnerCalls, 9);
  assert.equal(fixture.counters.judgeCalls, 3);
  assert.deepEqual(result.candidates.map((entry) => entry.label), ["starting_reference", "adaptive", "direct"]);
  assert.equal(result.accounting.logicalCalls, 12);
  assert.equal(result.feedbackToEvolution, false);
  assert.equal(result.generationTriggered, false);
  assert.equal(result.repairTriggered, false);
  assert.equal(result.secondSealedAllowed, false);
  assert.equal(result.releaseAllowed, false);
});

test("current-v2 sealed persists one schema-valid sanitized attempt per candidate-item without retry or a second audit", async (t) => {
  const fixture = await makeFixture(t);
  const assumptions = {
    ...fixture.args.stageBudgetAssumptions,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const plan = calculateStageBudgets(assumptions);
  const envelope = plan.envelope.sealed;
  fixture.args.stageBudgetAssumptions = assumptions;
  fixture.args.authorizedStageBudgets = {
    publicSelect: plan.publicSelect,
    direct: plan.direct,
    sealed: plan.sealed,
  };
  fixture.args.budget = new RunCallBudget({ maxLogicalCalls: plan.sealed, maxRetryAttempts: 0 });
  fixture.args.runner = async ({ item, skillMd }) => {
    fixture.args.budget.enterLogicalCall("evaluator");
    fixture.counters.runnerCalls += 1;
    const transcript = finalTranscript(item);
    return {
      ...transcript,
      applicationRecovery: sealedApplicationRecovery(skillMd, item.itemId, envelope),
    };
  };

  const result = await runU1SealedAudit(fixture.args);
  assert.notEqual(result.status, "holdout_not_entered");
  if (result.status === "holdout_not_entered") throw new Error("unreachable");
  const summaries = result.applicationRecovery ?? [];
  assert.equal(summaries.length, 9, "three frozen candidates x three sealed items");
  for (const candidate of result.candidates) {
    const candidateSummaries = summaries.filter((summary) => summary.candidateId === candidate.label);
    assert.deepEqual(
      candidateSummaries.map((summary) => summary.itemId),
      ["holdout-1", "holdout-2", "holdout-3"],
    );
    for (const summary of candidateSummaries) {
      assert.equal(summary.candidateId, candidate.label);
      assert.equal(summary.role, "sealed");
      assert.equal(summary.maxApplicationAttempts, 1);
      assert.equal(summary.scenarioRetryReserve, 0);
      assert.equal(summary.unusedRetryReserve, 0);
      assert.equal(summary.attempts.length, 1);
      assert.equal(summary.attempts[0].attempt, 1);
      assert.equal(summary.attempts[0].terminalReason, "final");
      assert.equal(summary.attempts[0].modelCalls, 1);
      assert.match(summary.attempts[0].attemptIdentitySha256, /^[a-f0-9]{64}$/);
      assert.match(summary.attempts[0].transcriptSha256, /^[a-f0-9]{64}$/);
      assert.match(summary.attempts[0].trajectorySha256 ?? "", /^[a-f0-9]{64}$/);
      assert.equal(U1SealedApplicationRecoverySummarySchema.safeParse(summary).success, true);
    }
  }
  assert.equal(result.applicationRetryAllowed, false);
  assert.equal(result.secondSealedAllowed, false);
  assert.equal(fixture.counters.bodyReads, 1);
  assert.equal(fixture.counters.runnerCalls, 9);

  const completedArtifact = {
    schemaVersion: 2,
    createdAt: "2026-08-29T00:00:00.000Z",
    ...result,
    verificationMode: "test-fixture",
    formalEvidence: false,
    holdout: "sealed_once_no_feedback",
    release: "withheld (noRelease=true)",
  };
  assert.doesNotThrow(() => U1SealedCompletedArtifactSchema.parse(completedArtifact));
  const oldBudgetCompleted = structuredClone(completedArtifact) as any;
  delete oldBudgetCompleted.budget.assumptions.maxModelTurns;
  delete oldBudgetCompleted.budget.assumptions.maxToolCalls;
  delete oldBudgetCompleted.budget.assumptions.budgetMultiplier;
  assert.throws(
    () => U1SealedCompletedArtifactSchema.parse(oldBudgetCompleted),
    /maxModelTurns|maxToolCalls|budgetMultiplier/i,
  );
  const driftedCompletedBudget = structuredClone(completedArtifact) as any;
  driftedCompletedBudget.budget.assumptions.holdoutItems += 1;
  assert.throws(
    () => U1SealedCompletedArtifactSchema.parse(driftedCompletedBudget),
    /sealed B\/M\/H evidence|stage-budget/i,
  );

  const smuggledSecondAttempt = {
    ...summaries[0],
    maxApplicationAttempts: 2,
    scenarioRetryReserve: envelope.scenarioAuthorization.authorizedModelCallsPerAttempt,
  };
  assert.equal(
    U1SealedApplicationRecoverySummarySchema.safeParse(smuggledSecondAttempt).success,
    false,
    "sealed schema must reject any application retry authorization",
  );

  fixture.args.budget = new RunCallBudget({ maxLogicalCalls: plan.sealed, maxRetryAttempts: 0 });
  await assert.rejects(
    runU1SealedAudit(fixture.args),
    (error: unknown) => error instanceof U1SealedAuditError && error.code === "U1_SEALED_ALREADY_ENTERED",
  );
  assert.equal(fixture.counters.bodyReads, 1, "the second invocation cannot reopen the sealed body");
  assert.equal(fixture.counters.runnerCalls, 9, "the second invocation cannot start a second audit");
});

test("current-v2 sealed dynamic exhaustion requires exact sanitized one-shot B/M/H evidence", () => {
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
  const envelope = calculateStageBudgets(assumptions).envelope.sealed;
  const failure = {
    schemaVersion: 2,
    createdAt: "2026-08-29T00:00:00.000Z",
    status: "failed",
    phase: "sealed-audit",
    contractSha256: "1".repeat(64),
    publicSelectionResultSha256: "2".repeat(64),
    safeError: {
      code: "DYNAMIC_ENVELOPE_EXHAUSTED",
      message: "Sealed audit failed; sensitive request and response content were not persisted.",
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
    providerTokenTelemetry: {
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
      responses: envelope.authorizedLogicalCalls,
      responsesWithUsage: 0,
      responsesMissingUsage: envelope.authorizedLogicalCalls,
      byStageRoleModel: [{
        tags: { stage: "holdout", role: "evaluator", model: "deepseek-test" },
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
    bodyReads: 1,
    sealedClaimConsumed: true,
    feedbackToEvolution: false,
    generationTriggered: false,
    repairTriggered: false,
    secondSealedAllowed: false,
    applicationRetryAllowed: false,
    releaseAllowed: false,
    verificationMode: "live-formal",
    formalEvidence: true,
    holdout: "sealed_once_no_feedback",
    release: "withheld (noRelease=true)",
  };
  assert.doesNotThrow(() => U1SealedFailureArtifactSchema.parse(failure));
  const oldBudgetFailure = structuredClone(failure) as any;
  delete oldBudgetFailure.budget.assumptions.maxModelTurns;
  delete oldBudgetFailure.budget.assumptions.maxToolCalls;
  delete oldBudgetFailure.budget.assumptions.budgetMultiplier;
  assert.throws(
    () => U1SealedFailureArtifactSchema.parse(oldBudgetFailure),
    /maxModelTurns|maxToolCalls|budgetMultiplier/i,
  );
  const missingDynamicEvidence = structuredClone(failure) as any;
  delete missingDynamicEvidence.dynamicEnvelopeExhaustion;
  assert.throws(
    () => U1SealedFailureArtifactSchema.parse(missingDynamicEvidence),
    /dynamic sealed exhaustion/i,
  );
  const driftedDynamicEvidence = structuredClone(failure) as any;
  driftedDynamicEvidence.dynamicEnvelopeExhaustion.actualLogicalCalls -= 1;
  assert.throws(
    () => U1SealedFailureArtifactSchema.parse(driftedDynamicEvidence),
    /dynamic envelope exhaustion|dynamic sealed exhaustion/i,
  );
});

test("current-v2 sealed rejects malformed candidate-item attempt evidence instead of persisting it", async (t) => {
  const fixture = await makeFixture(t);
  const assumptions = {
    ...fixture.args.stageBudgetAssumptions,
    maxModelTurns: 6,
    maxToolCalls: 4,
    budgetMultiplier: 2,
  };
  const plan = calculateStageBudgets(assumptions);
  const envelope = plan.envelope.sealed;
  fixture.args.stageBudgetAssumptions = assumptions;
  fixture.args.authorizedStageBudgets = {
    publicSelect: plan.publicSelect,
    direct: plan.direct,
    sealed: plan.sealed,
  };
  fixture.args.budget = new RunCallBudget({ maxLogicalCalls: plan.sealed, maxRetryAttempts: 0 });
  fixture.args.runner = async ({ item, skillMd }) => {
    fixture.args.budget.enterLogicalCall("evaluator");
    fixture.counters.runnerCalls += 1;
    return {
      ...finalTranscript(item),
      applicationRecovery: {
        outcome: "no_retry_needed" as const,
        attempts: [{
          attempt: 1 as const,
          attemptIdentitySha256: hash(`sealed-attempt:${skillMd}:${item.itemId}`),
          terminalReason: "final" as const,
          modelCalls: 1,
          transcriptSha256: hash(`sealed-transcript:${skillMd}:${item.itemId}`),
          successfulToolCalls: 1,
          failedToolCalls: 0,
          uniqueSuccessfulToolRequests: 0,
          repeatedSuccessfulToolRequests: 0,
          trajectorySha256: hash(`sealed-trajectory:${skillMd}:${item.itemId}`),
        }],
        retryTriggered: false,
        rawScenarioEstimate: envelope.scenarioAuthorization.rawScenarioEstimate,
        callEnvelopeMultiplier: envelope.scenarioAuthorization.callEnvelopeMultiplier,
        authorizedModelCallsPerAttempt:
          envelope.scenarioAuthorization.authorizedModelCallsPerAttempt,
        maxApplicationAttempts: 1 as const,
        scenarioRetryReserve: 0,
        unusedRetryReserve: 0,
        classification: null,
      },
    };
  };

  await assert.rejects(
    runU1SealedAudit(fixture.args),
    (error: unknown) =>
      error instanceof U1SealedAuditError && error.code === "U1_SEALED_APPLICATION_RECOVERY_INVALID",
  );
  assert.equal(fixture.counters.bodyReads, 1);
  assert.equal(fixture.counters.runnerCalls, 9);
});

test("current-v2 sealed audit rejects a raw-high candidate whose quality cap zeros one effective dimension", async (t) => {
  const fixture = await makeFixture(t);
  const items = holdoutItems();
  const scoringProfile = DEFAULT_U1_SCORING_PROFILE;
  const scoredContract = {
    ...fixture.args.contract,
    scoringProfile,
    contractSha256: "0".repeat(64),
  } as EvaluationContractV3;
  scoredContract.contractSha256 = evaluationContractContentSha256(scoredContract);
  const bodyContent = {
    schemaVersion: 3 as const,
    producer: { kind: "cli" as const, name: "skillfoo" },
    contractSha256: scoredContract.contractSha256,
    items,
  };
  fixture.args.contract = scoredContract;
  fixture.args.manifest = {
    ...fixture.args.manifest,
    contractSha256: scoredContract.contractSha256,
    holdoutItemsSha256: digest(items),
    holdoutSha256: digest(bodyContent),
  };
  fixture.args.publicScoringIdentity = {
    contractSha256: scoredContract.contractSha256,
    profileVersion: scoringProfile.version,
    taskVerifierVersion: scoringProfile.taskVerifierVersion,
    rubricVersion: scoringProfile.rubricVersion,
  };
  fixture.args.readHoldoutBody = async () => {
    fixture.counters.bodyReads += 1;
    return { ...bodyContent, createdAt: "2026-08-27T00:00:00.000Z" };
  };
  const sealedEnvelope = calculateStageBudgets(fixture.args.stageBudgetAssumptions).envelope.sealed;
  fixture.args.runner = async ({ item, skillMd }) => {
    fixture.args.budget.enterLogicalCall("evaluator");
    fixture.counters.runnerCalls += 1;
    const variant = skillMd === ADAPTIVE_MD ? "adaptive" : skillMd === DIRECT_MD ? "direct" : "starting";
    return {
      ...finalTranscript(item),
      rawFinalResponse: JSON.stringify({
        type: "final",
        answer: {
          digest: `answer ${item.itemId}`,
          variant,
          note: variant === "adaptive" ? "quality violation" : "evidence boundary",
        },
      }),
      parsedFinalAnswer: {
        digest: `answer ${item.itemId}`,
        variant,
        note: variant === "adaptive" ? "quality violation" : "evidence boundary",
      },
      applicationRecovery: sealedApplicationRecovery(skillMd, item.itemId, sealedEnvelope),
    };
  };
  fixture.args.scoreRuns = async ({ contract: scoreContract, runs }) => {
    fixture.args.budget.enterLogicalCall("semantic-judge");
    fixture.counters.judgeCalls += 1;
    return applyContractGates({
      contract: scoreContract,
      runs: [...runs],
      semanticJudgements: runs.map((run) => {
        const variant = String((run.transcript.parsedFinalAnswer as { variant: string }).variant);
        const score = variant === "starting" ? 70 : variant === "direct" ? 80 : 100;
        return {
          itemId: run.item.itemId,
          score,
          reason: "synthetic sealed aggregate-floor evidence",
          dimensions: [
            "task_correctness",
            "evidence_boundary",
            "capability_boundary",
            "output_structure",
            "actionability",
          ].map((id) => ({
            id: id as "task_correctness" | "evidence_boundary" | "capability_boundary" | "output_structure" | "actionability",
            score,
            reason: "synthetic sealed raw semantic evidence",
          })),
          weightedScore: score,
          overallReason: "synthetic sealed aggregate-floor evidence",
          requestFingerprint: hash(`sealed-floor:${variant}:${run.item.itemId}`),
        };
      }),
    });
  };

  const result = await runU1SealedAudit(fixture.args);
  assert.equal(result.status, "sealed_rejected");
  const adaptive = result.candidates.find((candidate) => candidate.label === "adaptive");
  const adaptiveEvidence = adaptive?.itemScores[0].evidence;
  assert.equal(adaptiveEvidence?.semantic.dimensions.find(({ id }) => id === "evidence_boundary")?.score, 100);
  assert.equal(adaptiveEvidence?.effectiveDimensions?.find(({ id }) => id === "evidence_boundary")?.score, 0);
  assert.equal(adaptive?.auditScore, 75, "the sealed aggregate uses the quality-capped effective dimensions");
  assert.equal(adaptive?.qualityFailures, 1);
  assert.equal(
    adaptive?.gateResults.find(({ gateId }) => gateId === "judging-rule-pass")?.passed,
    false,
  );
  assert.equal(result.winner, "direct");
});

test("U1 sealed B5 returns holdout_not_entered for no novel public champion with zero body or candidate reads", async (t) => {
  const fixture = await makeFixture(t);
  fixture.args.publicDecision = "start_reference_retained";
  fixture.args.finalPublicChampionSha256 = fixture.args.startingReferenceSha256;
  fixture.args.candidates = fixture.args.candidates.map((candidate) => candidate.label === "direct"
    ? { label: "direct", status: "unavailable", reason: "candidate_rejected_by_capability_gate" }
    : candidate);

  const result = await runU1SealedAudit(fixture.args);
  assert.deepEqual(result, {
    status: "holdout_not_entered",
    reason: "no_novel_public_champion",
    contractSha256: fixture.args.contract.contractSha256,
    bodyReads: 0,
    feedbackToEvolution: false,
    generationTriggered: false,
    repairTriggered: false,
    releaseAllowed: false,
    scoringIdentity: fixture.args.publicScoringIdentity,
  });
  assert.deepEqual(fixture.counters, { bodyReads: 0, candidateReads: 0, claims: 0, runnerCalls: 0, judgeCalls: 0 });
});

test("sealed no-entry evidence reuses the frozen scoring identity and rejects profile drift before body read", async (t) => {
  const fixture = await makeFixture(t);
  const scoredContract = {
    ...fixture.args.contract,
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    contractSha256: "0".repeat(64),
  } as EvaluationContractV3;
  scoredContract.contractSha256 = evaluationContractContentSha256(scoredContract);
  fixture.args.contract = scoredContract;
  fixture.args.manifest = { ...fixture.args.manifest, contractSha256: scoredContract.contractSha256 };
  fixture.args.publicScoringIdentity = {
    contractSha256: scoredContract.contractSha256,
    profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
    taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
    rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
  };
  fixture.args.publicDecision = "start_reference_retained";
  fixture.args.finalPublicChampionSha256 = fixture.args.startingReferenceSha256;

  const notEntered = await runU1SealedAudit(fixture.args);
  assert.equal(notEntered.status, "holdout_not_entered");
  assert.equal(notEntered.scoringIdentity?.contractSha256, scoredContract.contractSha256);
  assert.equal(fixture.counters.bodyReads, 0);

  fixture.args.contract = {
    ...scoredContract,
    scoringProfile: {
      ...DEFAULT_U1_SCORING_PROFILE,
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map((dimension, index) =>
        index === 0 ? { ...dimension, minimumScore: 61 } : dimension),
    },
  } as EvaluationContractV3;
  await assert.rejects(
    () => runU1SealedAudit(fixture.args),
    (error: unknown) => error instanceof U1RubricError && error.code === "U1_SCORING_CONTRACT_HASH_MISMATCH",
  );
  assert.equal(fixture.counters.bodyReads, 0);
});

test("U1 sealed B5 rejects formal, bypass, B0-B4, release, candidate and budget gate failures before body read", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (args: U1SealedAuditArguments) => void;
    code: string;
  }> = [
    {
      name: "missing fixture evaluation confirmation",
      mutate: (args) => { args.evaluationReviewConfirmation = { status: "draft", humanReviewed: false }; },
      code: "U1_SEALED_FIXTURE_CONFIRMATION_REQUIRED",
    },
    {
      name: "public live-formal mode rejects fixture evidence",
      mutate: (args) => { args.verificationMode = "live-formal"; },
      code: "U1_SEALED_FORMAL_CONFIRMATION_REQUIRED",
    },
    {
      name: "human confirmation cannot be smuggled into the fixture lane",
      mutate: (args) => {
        if (args.evaluationReviewConfirmation.status === "confirmed") {
          args.evaluationReviewConfirmation = {
            ...args.evaluationReviewConfirmation,
            confirmationMode: "human",
            humanReviewed: true,
          };
        }
      },
      code: "U1_SEALED_FIXTURE_CONFIRMATION_REQUIRED",
    },
    {
      name: "fixture cannot claim formal evidence",
      mutate: (args) => { args.formalEvidence = true; },
      code: "U1_SEALED_FIXTURE_CONFIRMATION_REQUIRED",
    },
    {
      name: "incomplete B4",
      mutate: (args) => { args.b0B4.b4 = false; },
      code: "U1_SEALED_B0_B4_INCOMPLETE",
    },
    {
      name: "release enabled",
      mutate: (args) => { args.noRelease = false; },
      code: "U1_SEALED_NO_RELEASE_REQUIRED",
    },
    {
      name: "Direct not frozen",
      mutate: (args) => {
        args.candidates = args.candidates.map((candidate) => candidate.label === "direct"
          ? { label: "direct", status: "unavailable", reason: "not completed" }
          : candidate);
      },
      code: "U1_SEALED_CANDIDATES_INVALID",
    },
    {
      name: "Direct frozen hash drift",
      mutate: (args) => {
        args.candidates = args.candidates.map((candidate) => candidate.label === "direct" && candidate.status === "frozen"
          ? { ...candidate, skillSha256: "e".repeat(64) }
          : candidate);
      },
      code: "U1_SEALED_CANDIDATE_HASH_DRIFT",
    },
    {
      name: "public-select budget cannot borrow from sealed surplus",
      mutate: (args) => {
        const plan = calculateStageBudgets(args.stageBudgetAssumptions);
        args.authorizedStageBudgets = {
          publicSelect: plan.publicSelect - 1,
          direct: plan.direct,
          sealed: plan.sealed + 100,
        };
      },
      code: "U1_SEALED_BUDGET_INSUFFICIENT",
    },
    {
      name: "Direct budget cannot borrow from sealed surplus",
      mutate: (args) => {
        const plan = calculateStageBudgets(args.stageBudgetAssumptions);
        args.authorizedStageBudgets = {
          publicSelect: plan.publicSelect,
          direct: plan.direct - 1,
          sealed: plan.sealed + 100,
        };
      },
      code: "U1_SEALED_BUDGET_INSUFFICIENT",
    },
    {
      name: "sealed budget underfunded",
      mutate: (args) => {
        const plan = calculateStageBudgets(args.stageBudgetAssumptions);
        args.authorizedStageBudgets = { ...args.authorizedStageBudgets, sealed: plan.sealed - 1 };
        args.budget = new RunCallBudget({ maxLogicalCalls: plan.sealed - 1, maxRetryAttempts: 0 });
      },
      code: "U1_SEALED_BUDGET_INSUFFICIENT",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const fixture = await makeFixture(subtest);
      entry.mutate(fixture.args);
      await assert.rejects(
        runU1SealedAudit(fixture.args),
        (error: unknown) => error instanceof U1SealedAuditError && error.code === entry.code,
      );
      assert.equal(fixture.counters.bodyReads, 0, `${entry.name}: sealed body must stay unread`);
      assert.equal(fixture.counters.runnerCalls, 0, `${entry.name}: no evaluator call`);
      assert.equal(fixture.counters.judgeCalls, 0, `${entry.name}: no semantic call`);
      assert.equal(fixture.counters.claims, 0, `${entry.name}: execution must not be claimed`);
    });
  }
});

test("U1 sealed B5 spends its atomic claim once and refuses a second body read", async (t) => {
  const fixture = await makeFixture(t);
  const first = await runU1SealedAudit(fixture.args);
  assert.notEqual(first.status, "holdout_not_entered");
  fixture.resetBudget();

  await assert.rejects(
    runU1SealedAudit(fixture.args),
    (error: unknown) => error instanceof U1SealedAuditError && error.code === "U1_SEALED_ALREADY_ENTERED",
  );
  assert.equal(fixture.counters.bodyReads, 1, "the second attempt must not reopen the sealed body");
  assert.equal(fixture.counters.claims, 2);
});

test("U1 sealed B5 spends the one claim even when the opened synthetic body fails its frozen hash", async (t) => {
  const fixture = await makeFixture(t);
  fixture.args.manifest = { ...fixture.args.manifest, holdoutSha256: "f".repeat(64) };

  await assert.rejects(
    runU1SealedAudit(fixture.args),
    (error: unknown) => error instanceof U1SealedAuditError && error.code === "U1_SEALED_HOLDOUT_BINDING_INVALID",
  );
  assert.equal(fixture.counters.bodyReads, 1);
  assert.equal(fixture.counters.claims, 1);
  assert.equal(fixture.counters.runnerCalls, 0);
  fixture.resetBudget();

  await assert.rejects(
    runU1SealedAudit(fixture.args),
    (error: unknown) => error instanceof U1SealedAuditError && error.code === "U1_SEALED_ALREADY_ENTERED",
  );
  assert.equal(fixture.counters.bodyReads, 1, "a failed bound audit is still the single spent sealed attempt");
});
