import test from "node:test";
import assert from "node:assert/strict";
import {
  PublicSelectionError,
  runTerminalPublicSelection as runTerminalPublicSelectionWithRecovery,
  selectFinalPublicChampion as selectFinalPublicChampionWithProfile,
  selectStartingReference,
  type PublicSelectCandidateEvidence,
} from "./publicSelection.js";
import { sanitizeTerminalPublicSelection } from "./publicSelectionResume.js";
import type { Provider } from "../providers/types.js";
import { DEFAULT_U1_SCORING_PROFILE, U1_TASK_VERIFIER_VERSION } from "../types.js";
import type { EvaluationContractV3, RunTranscript, U1ItemRubric } from "../types.js";
import type { ContractItemScore, InstructionBatchScorer } from "../runtime/instructionAdapter.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";
import { createPublicSemanticBatchJudge, SemanticJudgeError } from "../evaluation/semanticJudge.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import type { U1RecoveryContext } from "./structureRecovery.js";

const TEST_RUBRIC: U1ItemRubric = {
  critical: false,
  passThreshold: 70,
  mustHave: [],
  mustNotHave: [],
  dimensions: [
    { id: "task_correctness", weight: 0.35 },
    { id: "evidence_boundary", weight: 0.25 },
    { id: "capability_boundary", weight: 0.2 },
    { id: "output_structure", weight: 0.1 },
    { id: "actionability", weight: 0.1 },
  ],
};

type TerminalPublicSelectionArgs = Parameters<typeof runTerminalPublicSelectionWithRecovery>[0];

function currentContract(contract: EvaluationContractV3): EvaluationContractV3 {
  const current = {
    ...contract,
    u1ContractVersion: "v2",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
  } as EvaluationContractV3;
  return {
    ...current,
    contractSha256: evaluationContractContentSha256(current),
  };
}

function currentItem(item: FunnelEvalItem): FunnelEvalItem {
  return {
    ...item,
    taskVerifier: item.taskVerifier ?? {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [{
        ruleId: `quality-${item.itemId}`,
        kind: "output_field",
        field: "quality",
        valueType: "number",
        effect: "quality",
        dimension: "task_correctness",
        weight: 1,
      }],
    },
  };
}

function selectFinalPublicChampion(
  args: Omit<Parameters<typeof selectFinalPublicChampionWithProfile>[0], "scoringProfile">
    & Partial<Pick<Parameters<typeof selectFinalPublicChampionWithProfile>[0], "scoringProfile">>,
) {
  return selectFinalPublicChampionWithProfile({
    ...args,
    scoringProfile: args.scoringProfile ?? DEFAULT_U1_SCORING_PROFILE,
  });
}

function runTerminalPublicSelection(
  args: Omit<TerminalPublicSelectionArgs, "semanticRecovery"> & Partial<Pick<TerminalPublicSelectionArgs, "semanticRecovery">>,
) {
  return runTerminalPublicSelectionWithRecovery({
    ...args,
    contract: currentContract(args.contract),
    selectItems: args.selectItems.map(currentItem),
    semanticRecovery: args.semanticRecovery ?? {
      subject: { kind: "stage", stage: "public-select" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
}

function semanticResponseFor(messages: Parameters<Provider["chat"]>[0]): string {
  const user = messages.find((message) => message.role === "user");
  const payload = JSON.parse(user?.content ?? "{}") as { requiredItemIds?: string[] };
  return JSON.stringify({
    items: (payload.requiredItemIds ?? []).map((itemId) => ({
      itemId,
      dimensions: TEST_RUBRIC.dimensions.map((dimension) => ({
        id: dimension.id,
        score: 80,
        reason: `bounded evidence for ${dimension.id}`,
      })),
      overallReason: "bounded public semantic evidence",
    })),
  });
}

function currentScoreEvidence(args: {
  itemId: string;
  score: number;
  passed?: boolean;
  hardSafetyFailures?: string[];
  hardContractFailures?: string[];
  qualityFailures?: string[];
  includeHardSafetyEvidence?: boolean;
}): ContractItemScore["evidence"] {
  const hardSafetyFailures = args.hardSafetyFailures ?? [];
  const hardContractFailures = args.hardContractFailures ?? [];
  const deterministic: Record<string, unknown> = {
    hardGateFailures: [...hardSafetyFailures, ...hardContractFailures],
    hardContractFailures,
    qualityFailures: args.qualityFailures ?? [],
    ruleResults: [],
    passed: hardSafetyFailures.length === 0 && hardContractFailures.length === 0,
  };
  if (args.includeHardSafetyEvidence !== false) deterministic.hardSafetyFailures = hardSafetyFailures;
  return {
    itemId: args.itemId,
    passThreshold: 70,
    deterministic,
    semantic: {
      semanticStatus: "evaluated",
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({
        id,
        score: args.score,
        reason: `current fixture evidence for ${id}`,
      })),
      weightedScore: args.score,
      overallReason: "current fixture semantic evidence",
      requestFingerprint: "e".repeat(64),
    },
    finalScore: args.score,
    passed: args.passed ?? true,
    criticalFailure: false,
    dimensionFloorFailures: args.score < 60
      ? DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => id)
      : [],
    sameModelLimitation: "same model fixture",
  } as ContractItemScore["evidence"];
}

function semanticScoreRuns(provider: Provider): InstructionBatchScorer {
  return async ({ runs, recovery }) => {
    const judgements = await createPublicSemanticBatchJudge({
      provider,
      maxItemsPerRequest: 3,
      recovery,
    })(runs);
    return {
      publicScore: 80,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: true },
        { gateId: "judging-rule-pass", category: "quality", passed: true },
        { gateId: "public-absolute-floor", category: "quality", passed: true },
      ],
      itemScores: judgements.map((judgement) => ({
        itemId: judgement.itemId,
        split: "public" as const,
        score: judgement.weightedScore ?? judgement.score,
        passed: true,
        criticalFailure: false,
        evidence: currentScoreEvidence({
          itemId: judgement.itemId,
          score: judgement.weightedScore ?? judgement.score,
        }),
      })),
    };
  };
}

function semanticRecoveryContext(events: { diagnostics: unknown[]; attempts: unknown[] }): U1RecoveryContext {
  return {
    subject: { kind: "stage", stage: "public-select" },
    hooks: {
      onDiagnostic: (diagnostic) => events.diagnostics.push(diagnostic),
      onApplicationRecoveryAttempt: (attempt) => events.attempts.push(attempt),
    },
  };
}

function candidate(
  candidateId: string,
  rootKind: "b0" | "s0" | "evolved",
  weightedMean: number,
  overrides: Partial<PublicSelectCandidateEvidence> = {},
): PublicSelectCandidateEvidence {
  const everyGatePassed = overrides.everyGatePassed ?? true;
  const criticalRegression = overrides.criticalRegression ?? false;
  const comparisonEligible = overrides.comparisonEligible ?? true;
  return {
    candidateId,
    rootKind,
    ...overrides,
    skillSha256: overrides.skillSha256 ?? candidateId.padEnd(64, "a").slice(0, 64),
    weightedMean,
    dimensionScores: overrides.dimensionScores ?? {
      task_correctness: weightedMean,
      evidence_boundary: weightedMean,
      capability_boundary: weightedMean,
      output_structure: weightedMean,
      actionability: weightedMean,
    },
    comparisonEligible,
    championEligible: overrides.championEligible ?? (comparisonEligible && everyGatePassed && !criticalRegression),
    releaseEligible: false,
    everyGatePassed,
    criticalRegression,
    criticalRegressionItemIds: overrides.criticalRegressionItemIds ?? [],
    protectedDimensionRegression: overrides.protectedDimensionRegression ?? false,
    protectedDimensionRegressions: overrides.protectedDimensionRegressions ?? [],
  };
}

test("Starting Reference keeps B0 on a safe public-select tie", () => {
  const b0 = candidate("b0", "b0", 72);
  const s0 = candidate("s0", "s0", 72);
  assert.equal(selectStartingReference({ b0, s0 }).candidateId, "b0");
});

test("Starting Reference chooses S0 when it is the stronger safe root", () => {
  const b0 = candidate("b0", "b0", 68);
  const s0 = candidate("s0", "s0", 75);
  assert.equal(selectStartingReference({ b0, s0 }).candidateId, "s0");
});

test("Starting Reference failure preserves the exact no-comparison-root compatibility error code", () => {
  const b0 = candidate("b0", "b0", 68, { everyGatePassed: false, comparisonEligible: false, championEligible: false });
  const s0 = candidate("s0", "s0", 69, { everyGatePassed: false, comparisonEligible: false, championEligible: false });
  assert.throws(
    () => selectStartingReference({ b0, s0 }),
    (error: unknown) => error instanceof PublicSelectionError && error.code === "PUBLIC_SELECTION_NO_SAFE_ROOT",
  );
});

test("U1-C safe low-quality B0 and S0 remain comparison-eligible roots", () => {
  const b0 = candidate("b0-low", "b0", 20, {
    everyGatePassed: false,
    comparisonEligible: true,
    championEligible: false,
  });
  const s0 = candidate("s0-low", "s0", 30, {
    everyGatePassed: false,
    comparisonEligible: true,
    championEligible: false,
  });

  assert.equal(selectStartingReference({ b0, s0 }).candidateId, "s0-low");
  assert.equal(selectStartingReference({ b0, s0: { ...s0, weightedMean: 20 } }).candidateId, "b0-low");
});

test("a clear challenger becomes Final Public Champion", () => {
  const starting = candidate("b0", "b0", 70);
  const challenger = candidate("elite", "evolved", 75);
  const decision = selectFinalPublicChampion({
    startingReference: starting,
    challengers: [challenger],
  });

  assert.deepEqual(decision, {
    startingReferenceId: "b0",
    finalPublicChampionId: "elite",
    verdict: "clear_improvement",
    comparisonEligible: true,
    championEligible: true,
    releaseEligible: false,
    scoreDelta: 5,
    criticalRegression: false,
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [],
    sameModelLimitation: "Proposer and semantic evaluation may use the same provider/model family. Strict schemas, deterministic verification and separated public, Direct and sealed stages reduce but do not eliminate circular self-validation. Current model evidence is not independent human evaluation or proof of general effectiveness.",
  });
});

test("delta below 3 retains the Starting Reference", () => {
  const decision = selectFinalPublicChampion({
    startingReference: candidate("b0", "b0", 70),
    challengers: [candidate("elite", "evolved", 72.99)],
  });
  assert.equal(decision.verdict, "start_reference_retained");
  assert.equal(decision.finalPublicChampionId, "b0");
});

test("a distinct champion-eligible challenger with delta at least 3 must win", () => {
  const decision = selectFinalPublicChampion({
    startingReference: candidate("starting", "b0", 80),
    challengers: [candidate("challenger", "evolved", 96)],
  });
  assert.equal(decision.verdict, "clear_improvement");
  assert.equal(decision.finalPublicChampionId, "challenger");
  assert.equal(decision.scoreDelta, 16);
});

test("a critical regression rejects the challenger even when aggregate score rises", () => {
  const decision = selectFinalPublicChampion({
    startingReference: candidate("b0", "b0", 70),
    challengers: [candidate("elite", "evolved", 80, { criticalRegression: true })],
  });
  assert.equal(decision.verdict, "candidate_rejected");
  assert.equal(decision.finalPublicChampionId, "b0");
  assert.equal(decision.criticalRegression, true);
});

test("current scoring does not veto a champion for one above-floor fractional dimension decline", () => {
  const starting = {
    ...candidate("b0", "b0", 70, { skillSha256: "2".repeat(64) }),
    dimensionScores: {
      task_correctness: 75,
      evidence_boundary: 80,
      capability_boundary: 80,
      output_structure: 80,
      actionability: 80,
    },
  };
  const challenger = {
    ...candidate("elite", "evolved", 76, { skillSha256: "3".repeat(64) }),
    dimensionScores: {
      task_correctness: 90,
      evidence_boundary: 79.5,
      capability_boundary: 90,
      output_structure: 90,
      actionability: 90,
    },
  };

  const decision = selectFinalPublicChampion({
    startingReference: starting,
    challengers: [challenger],
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
  });

  assert.equal(decision.verdict, "clear_improvement");
  assert.equal(decision.finalPublicChampionId, "elite");
});

test("selection is terminal evidence and exposes no mutation feedback payload", () => {
  const decision = selectFinalPublicChampion({
    startingReference: candidate("b0", "b0", 70),
    challengers: [candidate("elite", "evolved", 80)],
  });
  assert.deepEqual(Object.keys(decision).sort(), [
    "championEligible",
    "comparisonEligible",
    "criticalRegression",
    "finalPublicChampionId",
    "protectedDimensionRegression",
    "protectedDimensionRegressions",
    "releaseEligible",
    "sameModelLimitation",
    "scoreDelta",
    "startingReferenceId",
    "verdict",
  ]);
  assert.doesNotMatch(JSON.stringify(decision), /itemId|reason|prompt|failure|mutation|repair/i);
});

test("candidate labels and input order do not change the winning skill content identity", () => {
  const lowerHash = "1".repeat(64);
  const higherHash = "2".repeat(64);
  const chooseHash = (challengers: PublicSelectCandidateEvidence[]): string => {
    const decision = selectFinalPublicChampion({
      startingReference: candidate("b0", "b0", 70, { skillSha256: "0".repeat(64) }),
      challengers,
    });
    return challengers.find((entry) => entry.candidateId === decision.finalPublicChampionId)?.skillSha256 ?? "";
  };

  const first = chooseHash([
    candidate("alpha", "evolved", 75, { skillSha256: lowerHash }),
    candidate("beta", "evolved", 75, { skillSha256: higherHash }),
  ]);
  const relabelledAndReordered = chooseHash([
    candidate("alpha", "evolved", 75, { skillSha256: higherHash }),
    candidate("beta", "evolved", 75, { skillSha256: lowerHash }),
  ]);
  const shownFirst = candidate("shown-first", "evolved", 75, { skillSha256: higherHash });
  const shownSecond = candidate("shown-second", "evolved", 75, { skillSha256: lowerHash });
  const { skillSha256: firstSkillSha256, ...firstWithoutSkillSha256 } = shownFirst;
  const { weightedMean: secondWeightedMean, ...secondWithoutWeightedMean } = shownSecond;
  const jsonFieldOrderChanged = chooseHash([
    JSON.parse(JSON.stringify({ skillSha256: firstSkillSha256, ...firstWithoutSkillSha256 })) as PublicSelectCandidateEvidence,
    JSON.parse(JSON.stringify({ weightedMean: secondWeightedMean, ...secondWithoutWeightedMean })) as PublicSelectCandidateEvidence,
  ]);

  assert.equal(first, lowerHash);
  assert.equal(relabelledAndReordered, lowerHash);
  assert.equal(jsonFieldOrderChanged, lowerHash);
});

test("terminal public selection evaluates only select items and never invokes an adaptive feedback path", async () => {
  const items: FunnelEvalItem[] = ["select-1", "select-2", "select-3"].map((itemId) => ({
    itemId,
    scenarioId: itemId,
    split: "public",
    itemType: "trigger",
    input: `frozen ${itemId}`,
    judgingRule: "bounded answer",
    rubric: TEST_RUBRIC,
  }));
  const seen: string[] = [];
  const runner: FunnelScenarioRunner = async ({ item, skillMd, snapshotId }): Promise<RunTranscript> => {
    seen.push(item.itemId);
    const quality = skillMd.includes("elite") ? 80 : skillMd.includes("s0") ? 72 : 70;
    return {
      scenarioId: item.itemId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: JSON.stringify({ type: "final", answer: { quality } }),
      parsedFinalAnswer: { quality },
      terminalReason: "final",
      turns: 1,
      durationMs: 1,
    };
  };
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => {
    const scores = runs.map((run) => Number((run.transcript.parsedFinalAnswer as { quality: number }).quality));
    return {
      publicScore: scores.reduce((sum, value) => sum + value, 0) / scores.length,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: true },
        { gateId: "judging-rule-pass", category: "quality", passed: true },
        { gateId: "public-absolute-floor", category: "quality", passed: true },
      ],
      itemScores: runs.map((run, index) => ({
        itemId: run.item.itemId,
        split: "public",
        score: scores[index],
        passed: true,
        criticalFailure: false,
        evidence: currentScoreEvidence({ itemId: run.item.itemId, score: scores[index] }),
      })),
    };
  };
  const result = await runTerminalPublicSelection({
    contract: {} as EvaluationContractV3,
    selectItems: items,
    candidates: [
      { candidateId: "b0", rootKind: "b0", skillMd: "b0 skill" },
      { candidateId: "s0", rootKind: "s0", skillMd: "s0 skill" },
      { candidateId: "elite", rootKind: "evolved", skillMd: "elite skill" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  assert.equal(result.decision.startingReferenceId, "s0");
  assert.equal(result.decision.finalPublicChampionId, "elite");
  assert.equal(result.decision.verdict, "clear_improvement");
  assert.deepEqual([...new Set(seen)].sort(), ["select-1", "select-2", "select-3"]);
  assert.equal(seen.length, 9, "three unique candidates run on three terminal select items");
  assert.ok(result.candidateEvaluations.every((entry) => entry.answerHashes.length === 3));
  assert.ok(!("feedback" in result));
});

test("terminal public-select reuses the one bounded semantic schema recovery without rerunning candidate-items", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-semantic-recovery",
    scenarioId: "select-semantic-recovery",
    split: "public",
    itemType: "trigger",
    input: "frozen public input",
    judgingRule: "return a bounded answer",
    rubric: TEST_RUBRIC,
  };
  let semanticCalls = 0;
  let runnerCalls = 0;
  const events = { diagnostics: [] as unknown[], attempts: [] as unknown[] };
  const recovery = semanticRecoveryContext(events);
  const provider: Provider = {
    chat: async (messages) => ({
      content: semanticCalls++ === 0 ? "not-json" : semanticResponseFor(messages),
    }),
  };
  const args = {
    contract: {} as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0" as const, skillMd: "b0 skill" },
      { candidateId: "s0", rootKind: "s0" as const, skillMd: "s0 skill" },
    ],
    runner: async ({ item: runItem, snapshotId }: Parameters<FunnelScenarioRunner>[0]) => {
      runnerCalls += 1;
      return {
        scenarioId: runItem.scenarioId,
        snapshotId,
        toolEvents: [],
        rawFinalResponse: JSON.stringify({ type: "final", answer: { bounded: true } }),
        parsedFinalAnswer: { bounded: true },
        terminalReason: "final" as const,
        turns: 1,
        durationMs: 1,
      };
    },
    scoreRuns: semanticScoreRuns(provider),
    maxInFlight: 2,
    semanticRecovery: recovery,
  };

  const result = await runTerminalPublicSelection(args);

  assert.equal(result.decision.verdict, "start_reference_retained");
  assert.equal(semanticCalls, 3, "only the failed first candidate batch adds one schema-repair call");
  assert.equal(runnerCalls, 2, "candidate-item execution is not repeated by semantic repair");
  assert.equal(events.attempts.length, 1);
  assert.equal(events.diagnostics.length, 1);
});

test("terminal public-select preserves the semantic error after one failed repair and never makes a third call", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-semantic-double-failure",
    scenarioId: "select-semantic-double-failure",
    split: "public",
    itemType: "trigger",
    input: "frozen public input",
    judgingRule: "return a bounded answer",
    rubric: TEST_RUBRIC,
  };
  let semanticCalls = 0;
  let runnerCalls = 0;
  const events = { diagnostics: [] as unknown[], attempts: [] as unknown[] };
  const args = {
    contract: {} as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0" as const, skillMd: "b0 skill" },
      { candidateId: "s0", rootKind: "s0" as const, skillMd: "s0 skill" },
    ],
    runner: async ({ item: runItem, snapshotId }: Parameters<FunnelScenarioRunner>[0]) => {
      runnerCalls += 1;
      return {
        scenarioId: runItem.scenarioId,
        snapshotId,
        toolEvents: [],
        rawFinalResponse: JSON.stringify({ type: "final", answer: { bounded: true } }),
        parsedFinalAnswer: { bounded: true },
        terminalReason: "final" as const,
        turns: 1,
        durationMs: 1,
      };
    },
    scoreRuns: semanticScoreRuns({ chat: async () => ({ content: `malformed-${++semanticCalls}` }) }),
    maxInFlight: 2,
    semanticRecovery: semanticRecoveryContext(events),
  };

  await assert.rejects(
    () => runTerminalPublicSelection(args),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_INVALID_JSON",
  );
  assert.equal(semanticCalls, 2);
  assert.equal(runnerCalls, 2, "completed candidate-items are not rerun");
  assert.equal(events.attempts.length, 1);
  assert.equal(events.diagnostics.length, 2);
});

test("terminal low-quality roots retain a comparison baseline with all sanitized candidate evidence", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-root-safety",
    scenarioId: "select-root-safety",
    split: "public",
    itemType: "negative",
    input: "frozen public-select input",
    judgingRule: "frozen public-select rule",
    rubric: TEST_RUBRIC,
  };
  const runner: FunnelScenarioRunner = async ({ item: runItem, skillMd, snapshotId }) => {
    const quality = skillMd.includes("evolved") ? 71 : skillMd.includes("s0") ? 69 : 68;
    return {
      scenarioId: runItem.itemId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: JSON.stringify({ type: "final", answer: { quality, privateText: "must not persist" } }),
      parsedFinalAnswer: { quality, privateText: "must not persist" },
      terminalReason: "final",
      turns: 1,
      durationMs: 1,
    };
  };
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => {
    const score = Number((runs[0].transcript.parsedFinalAnswer as { quality: number }).quality);
    return {
      publicScore: score,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: true },
        { gateId: "judging-rule-pass", category: "quality", passed: false, reason: "private reason must not persist" },
      ],
      itemScores: [{
        itemId: runs[0].item.itemId,
        split: "public",
        score,
        passed: false,
        criticalFailure: false,
        evidence: currentScoreEvidence({
          itemId: runs[0].item.itemId,
          score,
          passed: false,
          qualityFailures: ["low-quality"],
        }),
      }],
    };
  };

  const result = await runTerminalPublicSelection({
    contract: {} as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0", skillMd: "b0 skill" },
      { candidateId: "s0", rootKind: "s0", skillMd: "s0 skill" },
      { candidateId: "evolved", rootKind: "evolved", skillMd: "evolved skill" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  assert.deepEqual(result.decision, {
    startingReferenceId: "s0",
    finalPublicChampionId: "s0",
    verdict: "start_reference_retained",
    reasonCode: "no_safe_candidate",
    comparisonEligible: true,
    championEligible: false,
    releaseEligible: false,
    scoreDelta: 2,
    criticalRegression: false,
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [],
    sameModelLimitation: "Proposer and semantic evaluation may use the same provider/model family. Strict schemas, deterministic verification and separated public, Direct and sealed stages reduce but do not eliminate circular self-validation. Current model evidence is not independent human evaluation or proof of general effectiveness.",
  });
  assert.equal(result.candidateEvaluations.length, 3);
  assert.ok(result.candidateEvaluations.every((entry) => (
    entry.comparisonEligible && !entry.championEligible && !entry.releaseEligible
  )));
  const safe = sanitizeTerminalPublicSelection(result);
  assert.deepEqual(safe.shortlistCandidateIds, ["b0", "s0", "evolved"]);
  assert.deepEqual(safe.candidateEvaluations.map((entry) => entry.candidateId), ["b0", "s0", "evolved"]);
  assert.ok(safe.candidateEvaluations.every((entry) => entry.gateResults.some((gate) => gate.gateId === "judging-rule-pass" && !gate.passed)));
  assert.doesNotMatch(
    JSON.stringify(safe),
    /privateText|must not persist|frozen public-select input|frozen public-select rule|"reason"\s*:|skillMd|judgingRule|userInput|rawFinalResponse|parsedFinalAnswer/i,
  );
});

test("candidate safety-gate failures cannot baseline while hard-contract and quality failures remain comparable", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-hard-safety",
    scenarioId: "select-hard-safety",
    split: "public",
    itemType: "negative",
    input: "frozen public-select input",
    judgingRule: "frozen public-select rule",
    rubric: TEST_RUBRIC,
  };
  const runner: FunnelScenarioRunner = async ({ item: runItem, skillMd, snapshotId }) => ({
    scenarioId: runItem.itemId,
    snapshotId,
    toolEvents: [],
    rawFinalResponse: JSON.stringify({ type: "final", answer: { candidate: skillMd } }),
    parsedFinalAnswer: { candidate: skillMd },
    terminalReason: "final",
    turns: 1,
    durationMs: 1,
  });
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => {
    const candidateId = (runs[0].transcript.parsedFinalAnswer as { candidate: string }).candidate;
    const candidateSafetyFailed = candidateId.includes("b0");
    const score = candidateSafetyFailed ? 95 : 30;
    return {
      publicScore: score,
      gateResults: [
        { gateId: "aggregate-hard-safety", category: "safety", passed: !candidateSafetyFailed },
        { gateId: "quality-and-contract", category: "quality", passed: false },
      ],
      itemScores: [{
        itemId: runs[0].item.itemId,
        split: "public",
        score,
        passed: false,
        criticalFailure: false,
        evidence: currentScoreEvidence({
          itemId: runs[0].item.itemId,
          score,
          passed: false,
          hardContractFailures: ["business-contract"],
          qualityFailures: ["low-quality"],
        }),
      }],
    };
  };

  const result = await runTerminalPublicSelection({
    contract: {} as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0", skillMd: "b0 root" },
      { candidateId: "s0", rootKind: "s0", skillMd: "s0 root" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  assert.equal(result.candidateEvaluations.find((entry) => entry.candidateId === "b0")?.comparisonEligible, false);
  assert.equal(result.candidateEvaluations.find((entry) => entry.candidateId === "s0")?.comparisonEligible, true);
  assert.equal(result.decision.startingReferenceId, "s0");
  assert.equal(result.decision.finalPublicChampionId, "s0");
  assert.equal(result.decision.reasonCode, "no_safe_candidate");
});

test("current-v3 public selection never synthesizes missing item hard-safety evidence from aggregate gates", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-v2-missing-item-safety",
    scenarioId: "select-v2-missing-item-safety",
    split: "public",
    itemType: "negative",
    input: "public input",
    judgingRule: "public rule",
    rubric: TEST_RUBRIC,
  };
  const runner: FunnelScenarioRunner = async ({ item: runItem, skillMd, snapshotId }) => ({
    scenarioId: runItem.itemId,
    snapshotId,
    toolEvents: [],
    rawFinalResponse: JSON.stringify({ type: "final", answer: { candidate: skillMd } }),
    parsedFinalAnswer: { candidate: skillMd },
    terminalReason: "final",
    turns: 1,
    durationMs: 1,
  });
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => ({
    publicScore: 40,
    gateResults: [
      { gateId: "contract-capability-boundary", category: "safety", passed: true },
      { gateId: "judging-rule-pass", category: "quality", passed: false },
    ],
    itemScores: [{
      itemId: runs[0].item.itemId,
      split: "public",
      score: 40,
      passed: false,
      criticalFailure: false,
      evidence: currentScoreEvidence({
        itemId: runs[0].item.itemId,
        score: 40,
        passed: false,
        includeHardSafetyEvidence: false,
      }),
    }],
  });

  const result = await runTerminalPublicSelection({
    contract: { u1ContractVersion: "v2" } as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0", skillMd: "b0 root" },
      { candidateId: "s0", rootKind: "s0", skillMd: "s0 root" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  assert.ok(result.candidateEvaluations.every((candidate) => !candidate.comparisonEligible));
  assert.equal(result.decision.verdict, "not_comparable");
  assert.equal(result.decision.reasonCode, "no_comparison_baseline");
});

test("terminal selection returns not_comparable when neither root can form a comparison baseline", async () => {
  const item: FunnelEvalItem = {
    itemId: "select-no-baseline",
    scenarioId: "select-no-baseline",
    split: "public",
    itemType: "negative",
    input: "sealed from persisted evidence",
    judgingRule: "frozen rule",
    rubric: TEST_RUBRIC,
  };
  const runner: FunnelScenarioRunner = async ({ item: runItem, skillMd, snapshotId }) => {
    const evolved = skillMd.includes("evolved");
    const finalButEmpty = skillMd.includes("s0");
    return {
      scenarioId: runItem.itemId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: evolved
        ? JSON.stringify({ type: "final", answer: { candidate: skillMd } })
        : finalButEmpty
          ? JSON.stringify({ type: "final", answer: {} })
          : "",
      parsedFinalAnswer: evolved ? { candidate: skillMd } : finalButEmpty ? {} : undefined,
      terminalReason: evolved || finalButEmpty ? "final" : "no_final",
      turns: 1,
      durationMs: 1,
    };
  };
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => {
    const answer = runs[0].transcript.parsedFinalAnswer;
    const root = answer === undefined || (typeof answer === "object" && answer !== null && Object.keys(answer).length === 0);
    return {
      publicScore: root ? 40 : 65,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: !root },
        { gateId: "judging-rule-pass", category: "quality", passed: false },
      ],
      itemScores: [{
        itemId: runs[0].item.itemId,
        split: "public",
        score: root ? 40 : 65,
        passed: false,
        criticalFailure: root,
        evidence: currentScoreEvidence({
          itemId: runs[0].item.itemId,
          score: root ? 40 : 65,
          passed: false,
        }),
      }],
    };
  };

  const result = await runTerminalPublicSelection({
    contract: {} as EvaluationContractV3,
    selectItems: [item],
    candidates: [
      { candidateId: "b0", rootKind: "b0", skillMd: "b0 root" },
      { candidateId: "s0", rootKind: "s0", skillMd: "s0 root" },
      { candidateId: "evolved", rootKind: "evolved", skillMd: "evolved candidate" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  assert.deepEqual(result.decision, {
    startingReferenceId: null,
    finalPublicChampionId: null,
    verdict: "not_comparable",
    reasonCode: "no_comparison_baseline",
    comparisonEligible: false,
    championEligible: false,
    releaseEligible: false,
    scoreDelta: 0,
    criticalRegression: false,
    protectedDimensionRegression: false,
    protectedDimensionRegressions: [],
    sameModelLimitation: "Proposer and semantic evaluation may use the same provider/model family. Strict schemas, deterministic verification and separated public, Direct and sealed stages reduce but do not eliminate circular self-validation. Current model evidence is not independent human evaluation or proof of general effectiveness.",
  });
  assert.deepEqual(result.candidateEvaluations.map((candidate) => candidate.candidateId), ["b0", "s0", "evolved"]);
  assert.equal(result.candidateEvaluations.filter((candidate) => candidate.comparisonEligible).length, 1);
  assert.equal(result.candidateEvaluations.find((candidate) => candidate.candidateId === "evolved")?.championEligible, false);
});
