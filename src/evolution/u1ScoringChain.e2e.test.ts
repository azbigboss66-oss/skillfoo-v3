import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableStringify } from "../intake/taskCard.js";
import { RunCallBudget } from "../providers/runBudget.js";
import type { Provider } from "../providers/types.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import { createU1ScenarioRunnerFactory } from "../runtime/u1ScenarioRunner.js";
import type { FrozenRuntimeContextManifest } from "../runtime/frozenContext.js";
import { applyContractGates, type InstructionBatchScorer } from "../runtime/instructionAdapter.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  U1_TASK_VERIFIER_VERSION,
  type EvaluationContractV3,
  type U1RubricDimensionId,
} from "../types.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import { runDirectBaseline as runDirectBaselineWithRecovery, type DirectBaselineArgs } from "./directBaseline.js";
import { buildSafeDirectPublicComparison, DirectPublicComparisonError } from "./directPublicComparison.js";
import { runTerminalPublicSelection as runTerminalPublicSelectionWithRecovery } from "./publicSelection.js";
import { sanitizeTerminalPublicSelection } from "./publicSelectionResume.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";

const DIMENSIONS: readonly U1RubricDimensionId[] = DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => id);

type TerminalPublicSelectionArgs = Parameters<typeof runTerminalPublicSelectionWithRecovery>[0];

function runTerminalPublicSelection(args: Omit<TerminalPublicSelectionArgs, "semanticRecovery">) {
  return runTerminalPublicSelectionWithRecovery({
    ...args,
    semanticRecovery: {
      subject: { kind: "stage", stage: "public-select" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
}

function runDirectBaseline(args: Omit<DirectBaselineArgs, "semanticRecovery">) {
  return runDirectBaselineWithRecovery({
    ...args,
    semanticRecovery: {
      subject: { kind: "stage", stage: "direct" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
}

function contractOf(selectItemIds: string[]): EvaluationContractV3 {
  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const holdoutItemIds = Array.from({ length: 3 }, (_, index) => `holdout-${index + 1}`);
  const contract = {
    schemaVersion: 3,
    createdAt: "2026-08-28T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: {
      taskCard: "1".repeat(64),
      draft: "2".repeat(64),
      curation: "3".repeat(64),
      evaluationReview: "4".repeat(64),
    },
    taskCardHash: "1".repeat(64),
    skillSnapshotHash: "5".repeat(64),
    adapterId: "instruction-v1",
    allowedCapabilities: ["instruction"],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    publicScenarioIds: [...trainItemIds, ...selectItemIds],
    holdoutScenarioIds: holdoutItemIds,
    safetyGates: [
      { gateId: "contract-capability-boundary", description: "frozen capability boundary" },
      { gateId: "redline-hold", description: "frozen red lines" },
    ],
    qualityGates: [
      { gateId: "judging-rule-pass", description: "frozen deterministic and semantic item gates" },
      { gateId: "public-absolute-floor", description: "frozen public floor" },
    ],
    goalConfidence: { level: "high", score: 90, reasons: ["synthetic benchmark"] },
    evalConfidence: { level: "high", score: 90, reasons: ["synthetic benchmark"] },
    generation: {
      generator: { kind: "provider", name: "scripted" },
      curator: { kind: "curator", name: "fixture" },
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
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
    evaluationReviewHash: "4".repeat(64),
    u1ContractVersion: "v2",
    trainItemIds,
    selectItemIds,
    trainItemsSha256: "6".repeat(64),
    selectItemsSha256: "7".repeat(64),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: "8".repeat(64),
    sameModelLimitation: "ScriptedProvider is deterministic fixture evidence, not model independence.",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    contractSha256: "0".repeat(64),
  } as EvaluationContractV3;
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return EvaluationContractV3Schema.parse(contract);
}

function selectItems(): FunnelEvalItem[] {
  return Array.from({ length: 6 }, (_, index) => ({
    itemId: `select-${index + 1}`,
    scenarioId: `select-${index + 1}`,
    split: "public" as const,
    itemType: index === 0 ? "negative" : "trigger",
    input: `Return the frozen numeric answer for item ${index + 1}.`,
    judgingRule: "amount must equal 100 and the answer must remain evidence-bound",
    rubric: {
      critical: index === 0,
      passThreshold: 70,
      mustHave: ["amount"],
      mustNotHave: ["fabricated"],
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id, weight }) => ({ id, weight })),
    },
    taskVerifier: {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [
        {
          ruleId: "amount-equals-100",
          kind: "numeric_value" as const,
          field: "amount",
          expected: 100,
          tolerance: 0,
          effect: "hard_contract" as const,
        },
        {
          ruleId: "quality-marker-present",
          kind: "output_field" as const,
          field: "qualityMarker",
          valueType: "string" as const,
          effect: "quality" as const,
          dimension: "evidence_boundary" as const,
          weight: 1,
        },
      ],
    },
  }));
}

function finalAnswer(variant: string, amount: number, qualityMarker = true): Record<string, unknown> {
  return {
    amount,
    variant,
    note: "amount is evidence-bound",
    ...(qualityMarker ? { qualityMarker: "present" } : {}),
  };
}

function finalEnvelope(variant: string, amount: number, qualityMarker = true): string {
  return JSON.stringify({ type: "final", answer: finalAnswer(variant, amount, qualityMarker) });
}

function semanticScores(variant: string): Record<U1RubricDimensionId, number> {
  if (variant === "s0") return Object.fromEntries(DIMENSIONS.map((id) => [id, 78])) as Record<U1RubricDimensionId, number>;
  if (variant === "protected-regression") {
    return {
      task_correctness: 100,
      evidence_boundary: 79,
      capability_boundary: 100,
      output_structure: 100,
      actionability: 100,
    };
  }
  if (variant === "invalid" || variant === "direct-invalid") {
    return Object.fromEntries(DIMENSIONS.map((id) => [id, 100])) as Record<U1RubricDimensionId, number>;
  }
  return Object.fromEntries(DIMENSIONS.map((id) => [id, 80])) as Record<U1RubricDimensionId, number>;
}

test("zero-network scoring benchmark unifies verifier, five dimensions, public champion and Direct identity", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "skillfoo-u1-scoring-chain-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const skillFiles = {
    b0: join(fixtureRoot, "b0.SKILL.md"),
    s0: join(fixtureRoot, "s0.SKILL.md"),
    invalid: join(fixtureRoot, "invalid.SKILL.md"),
    regression: join(fixtureRoot, "regression.SKILL.md"),
    direct: join(fixtureRoot, "direct.SKILL.md"),
  };
  await Promise.all([
    writeFile(skillFiles.b0, "# B0\n", "utf8"),
    writeFile(skillFiles.s0, "# S0\n", "utf8"),
    writeFile(skillFiles.invalid, "# Evolved invalid verifier answer\n", "utf8"),
    writeFile(skillFiles.regression, "# Evolved protected-dimension regression\n", "utf8"),
    writeFile(skillFiles.direct, "# Direct invalid verifier answer\n", "utf8"),
  ]);
  const skills = {
    b0: await readFile(skillFiles.b0, "utf8"),
    s0: await readFile(skillFiles.s0, "utf8"),
    invalid: await readFile(skillFiles.invalid, "utf8"),
    regression: await readFile(skillFiles.regression, "utf8"),
    direct: await readFile(skillFiles.direct, "utf8"),
  };
  const items = selectItems();
  const contract = contractOf(items.map(({ itemId }) => itemId));
  const scenarioProvider: Provider = {
    async chat(messages) {
      const prompt = messages.map(({ content }) => content).join("\n");
      const name = Object.entries(skills).find(([, skillMd]) => prompt.includes(skillMd))?.[0];
      if (!name) throw new Error("zero-network scoring fixture could not identify the locked SKILL.md");
      const amount = name === "invalid" || name === "direct" ? 105 : 100;
      const variant = name === "regression" ? "protected-regression" : name === "direct" ? "direct-invalid" : name;
      return { content: finalEnvelope(variant, amount) };
    },
  };
  const factory = await createU1ScenarioRunnerFactory({ contract });
  const scoreRuns: InstructionBatchScorer = async ({ contract: scoringContract, runs }) => applyContractGates({
    contract: scoringContract,
    runs: [...runs],
    semanticJudgements: runs.map((run) => {
      const variant = String((run.transcript.parsedFinalAnswer as { variant: string }).variant);
      const scores = semanticScores(variant);
      return {
        itemId: run.item.itemId,
        score: Math.round(DIMENSIONS.reduce((sum, id) => sum + scores[id], 0) / DIMENSIONS.length),
        reason: "synthetic zero-network semantic evidence",
        dimensions: DIMENSIONS.map((id) => ({ id, score: scores[id], reason: `synthetic ${id}` })),
        weightedScore: 0,
        overallReason: "synthetic zero-network semantic evidence",
        requestFingerprint: sha256Hex(`${variant}:${run.item.itemId}`),
      };
    }),
  });
  const startingSmoke = await factory.runnerFor("starting-reference", scenarioProvider)({
    item: items[0],
    skillMd: skills.b0,
    snapshotId: sha256Hex(skills.b0).slice(0, 12),
  });
  const adaptiveSmoke = await factory.runnerFor("adaptive", scenarioProvider)({
    item: items[0],
    skillMd: skills.regression,
    snapshotId: sha256Hex(skills.regression).slice(0, 12),
  });
  assert.equal((startingSmoke.parsedFinalAnswer as { amount: number }).amount, 100);
  assert.equal((adaptiveSmoke.parsedFinalAnswer as { amount: number }).amount, 100);
  assert.equal(typeof factory.runnerFor("sealed", scenarioProvider), "function", "sealed reuses this factory without opening a body");

  const publicSelection = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates: [
      { candidateId: "b0-label", rootKind: "b0", skillMd: skills.b0 },
      { candidateId: "s0-label", rootKind: "s0", skillMd: skills.s0 },
      { candidateId: "invalid-label", rootKind: "evolved", skillMd: skills.invalid },
      { candidateId: "regression-label", rootKind: "evolved", skillMd: skills.regression },
    ],
    runner: factory.runnerFor("public-select", scenarioProvider),
    scoreRuns,
    maxInFlight: 1,
  });

  const invalidCandidate = publicSelection.candidateEvaluations.find(({ candidateId }) => candidateId === "invalid-label")!;
  assert.equal(invalidCandidate.weightedMean, 0, "semantic 100 cannot compensate verifier failure");
  assert.equal(invalidCandidate.everyGatePassed, false);
  assert.equal(publicSelection.decision.verdict, "clear_improvement");
  assert.equal(publicSelection.decision.finalPublicChampionId, "regression-label");
  assert.deepEqual(publicSelection.decision.protectedDimensionRegressions, ["evidence_boundary"]);
  assert.equal(publicSelection.scoringIdentity?.contractSha256, contract.contractSha256);

  const direct = await runDirectBaseline({
    strategy: "one_shot",
    contract,
    publicItems: items,
    baseSkillMd: skills.direct,
    runner: factory.runnerFor("direct", scenarioProvider),
    scoreRuns,
    budget: new RunCallBudget({ maxLogicalCalls: 100, maxRetryAttempts: 0 }),
    maxInFlight: 1,
  });
  assert.equal(direct.finalEvaluation.publicScore, 0);
  assert.equal(direct.finalEvaluation.outcome, "safe_non_elite");
  const directComparison = buildSafeDirectPublicComparison({
    directSkillMd: direct.finalSkillMd,
    directEvaluation: direct.finalEvaluation,
    directAnswerHashes: direct.finalAnswerHashes,
    selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
    publicSelection: sanitizeTerminalPublicSelection(publicSelection),
    contract,
  });
  assert.equal(directComparison.scoringIdentity?.contractSha256, publicSelection.scoringIdentity?.contractSha256);
  assert.equal(directComparison.relativeToStarting.result, "candidate_rejected");
  assert.equal(factory.binding.adapterId, "instruction-v1");
  assert.deepEqual(factory.binding.allowedTools, []);
});

test("current-v2 reference logical ids are readable while candidate mutation tools are denied", async (t) => {
  const items = selectItems();
  const contextRoot = await mkdtemp(join(tmpdir(), "skillfoo-u1-tool-denial-chain-"));
  t.after(() => rm(contextRoot, { recursive: true, force: true }));
  const referenceBody = "# Immutable logical-id reference\n";
  const referencePath = join(contextRoot, "reference.md");
  await writeFile(referencePath, referenceBody, "utf8");
  const manifestContent: Omit<FrozenRuntimeContextManifest, "manifestSha256"> = {
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "guide",
      kind: "reference",
      path: "reference.md",
      mediaType: "text/markdown",
      sha256: sha256Hex(referenceBody),
    }],
    replays: [],
  };
  const manifest: FrozenRuntimeContextManifest = {
    ...manifestContent,
    manifestSha256: sha256Hex(stableStringify(manifestContent)),
  };
  const manifestPath = join(contextRoot, "runtime-context.v1.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const baseContract = contractOf(items.map(({ itemId }) => itemId));
  const referenceContract = {
    ...baseContract,
    sourceHashes: {
      ...baseContract.sourceHashes,
      runtimeContextManifest: manifest.manifestSha256,
    },
    adapterId: "reference-v1",
    allowedCapabilities: ["reference"],
    capabilityBoundary: {
      allowedCapabilities: ["reference"],
      network: "forbidden",
      filesystem: "controlled",
      externalActions: "controlled",
    },
    contractSha256: "0".repeat(64),
  } as EvaluationContractV3;
  referenceContract.contractSha256 = evaluationContractContentSha256(referenceContract);
  const frozenContract = EvaluationContractV3Schema.parse(referenceContract);
  const skills = {
    b0: "# Safe B0 reference\n",
    s0: "# Safe S0 reference\n",
    evolved: "# Evolved candidate asks for an undeclared ROI tool\n",
  };
  const factory = await createU1ScenarioRunnerFactory({
    contract: frozenContract,
    runtimeContextPath: manifestPath,
  });
  const provider: Provider = {
    async chat(messages) {
      const prompt = messages.map(({ content }) => content).join("\n");
      if (prompt.includes(skills.evolved)) {
        return { content: JSON.stringify({
          type: "tool_call",
          tool: "reference.write",
          args: { id: "guide", content: "mutated" },
        }) };
      }
      if (prompt.includes(skills.s0)) return { content: finalEnvelope("s0", 100) };
      if (prompt.includes(skills.b0)) {
        const referenceAlreadyRead = messages.some(({ content }) =>
          content.includes("Tool result for reference.read:"),
        );
        return {
          content: referenceAlreadyRead
            ? finalEnvelope("b0", 100)
            : JSON.stringify({ type: "tool_call", tool: "reference.read", args: { id: "guide" } }),
        };
      }
      throw new Error("zero-network reference fixture could not identify the locked SKILL.md");
    },
  };
  const observed: Array<{ candidate: string; terminalReason: string }> = [];
  const boundRunner = factory.runnerFor("public-select", provider);
  const runner: FunnelScenarioRunner = async (args) => {
    const transcript = await boundRunner(args);
    observed.push({ candidate: args.skillMd, terminalReason: transcript.terminalReason });
    return transcript;
  };
  const scoreRuns: InstructionBatchScorer = async ({ contract: scoringContract, runs }) => applyContractGates({
    contract: scoringContract,
    runs: [...runs],
    semanticJudgements: runs.map((run) => run.transcript.terminalReason === "final"
      ? {
          itemId: run.item.itemId,
          score: 100,
          reason: "synthetic final semantic evidence",
          dimensions: DIMENSIONS.map((id) => ({ id, score: 100, reason: `synthetic ${id}` })),
          weightedScore: 100,
          overallReason: "synthetic high semantic evidence",
          requestFingerprint: sha256Hex(`tool-denial:${run.item.itemId}`),
        }
      : {
          itemId: run.item.itemId,
          score: 0,
          reason: "semantic provider skipped for a non-final transcript",
          dimensions: DIMENSIONS.map((id) => ({ id, score: 0, reason: `skipped ${id}` })),
          weightedScore: 0,
          overallReason: "skipped_non_final",
          semanticStatus: "skipped_non_final" as const,
        }),
  });
  const result = await runTerminalPublicSelection({
    contract: frozenContract,
    selectItems: items,
    candidates: [
      { candidateId: "b0-safe", rootKind: "b0", skillMd: skills.b0 },
      { candidateId: "s0-safe", rootKind: "s0", skillMd: skills.s0 },
      { candidateId: "evolved-tool-denied", rootKind: "evolved", skillMd: skills.evolved },
    ],
    runner,
    scoreRuns,
    maxInFlight: 1,
  });

  const denied = result.candidateEvaluations.find(({ candidateId }) => candidateId === "evolved-tool-denied")!;
  assert.equal(denied.everyGatePassed, false);
  assert.equal(denied.weightedMean, 0, "semantic 100 cannot compensate a candidate tool denial");
  assert.equal(denied.comparisonEligible, false);
  assert.equal(result.decision.verdict, "start_reference_retained");
  assert.equal(result.decision.finalPublicChampionId, "b0-safe");
  assert.equal(observed.filter(({ candidate }) => candidate === skills.evolved).length, items.length);
  assert.ok(observed.filter(({ candidate }) => candidate === skills.evolved).every(({ terminalReason }) => terminalReason === "tool_denied"));
  assert.ok(observed.filter(({ candidate }) => candidate !== skills.evolved).every(({ terminalReason }) => terminalReason === "final"));
  assert.equal(await readFile(referencePath, "utf8"), referenceBody);
  assert.equal(factory.binding.entryCount, 1);
});

test("candidate aggregate dimension floors block a high-total non-critical challenger", async () => {
  const items = selectItems().map((item) => ({
    ...item,
    rubric: { ...item.rubric!, critical: false },
  }));
  const contract = contractOf(items.map(({ itemId }) => itemId));
  const candidates = [
    { candidateId: "b0-low-floor", rootKind: "b0" as const, skillMd: "# B0 low aggregate floor\n" },
    { candidateId: "s0-safe", rootKind: "s0" as const, skillMd: "# S0 safe aggregate floor\n" },
    { candidateId: "challenger-low-floor", rootKind: "evolved" as const, skillMd: "# Challenger low aggregate floor\n" },
  ];
  const scoresByVariant: Record<string, Record<U1RubricDimensionId, number>> = {
    b0: {
      task_correctness: 90,
      evidence_boundary: 58,
      capability_boundary: 90,
      output_structure: 90,
      actionability: 90,
    },
    s0: {
      task_correctness: 70,
      evidence_boundary: 60,
      capability_boundary: 70,
      output_structure: 70,
      actionability: 70,
    },
    challenger: {
      task_correctness: 100,
      evidence_boundary: 59,
      capability_boundary: 100,
      output_structure: 100,
      actionability: 100,
    },
    mixed: {
      task_correctness: 80,
      evidence_boundary: 60,
      capability_boundary: 80,
      output_structure: 80,
      actionability: 80,
    },
  };
  const scoreRuns: InstructionBatchScorer = async ({ contract: scoringContract, runs }) => applyContractGates({
    contract: scoringContract,
    runs: [...runs],
    semanticJudgements: runs.map((run) => {
      const variant = String((run.transcript.parsedFinalAnswer as { variant: string }).variant);
      const scores = {
        ...scoresByVariant[variant],
        ...(variant === "mixed"
          ? { evidence_boundary: run.item.itemId === "select-1" ? 50 : 62 }
          : {}),
      };
      return {
        itemId: run.item.itemId,
        score: 100,
        reason: "synthetic aggregate-floor evidence",
        dimensions: DIMENSIONS.map((id) => ({ id, score: scores[id], reason: `synthetic ${id}` })),
        weightedScore: 100,
        overallReason: "synthetic aggregate-floor evidence",
        requestFingerprint: sha256Hex(`${variant}:${run.item.itemId}:aggregate-floor`),
      };
    }),
  });
  const runner: FunnelScenarioRunner = async ({ item, skillMd, snapshotId }) => {
    const variant = skillMd.includes("Challenger") || skillMd.includes("Direct")
      ? "challenger"
      : skillMd.includes("Mixed")
        ? "mixed"
        : skillMd.includes("S0")
          ? "s0"
          : "b0";
    return {
      scenarioId: item.scenarioId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: finalEnvelope(variant, 100),
      parsedFinalAnswer: finalAnswer(variant, 100),
      terminalReason: "final" as const,
      turns: 1,
      durationMs: 1,
    };
  };

  const result = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates,
    runner,
    scoreRuns,
    maxInFlight: 2,
  });

  const b0 = result.candidateEvaluations.find(({ candidateId }) => candidateId === "b0-low-floor")!;
  const s0 = result.candidateEvaluations.find(({ candidateId }) => candidateId === "s0-safe")!;
  const challenger = result.candidateEvaluations.find(({ candidateId }) => candidateId === "challenger-low-floor")!;
  assert.equal(b0.itemScores[0].passed, false, "the non-critical item keeps its floor diagnostic");
  assert.deepEqual(b0.itemScores[0].evidence?.dimensionFloorFailures, ["evidence_boundary"]);
  assert.equal(b0.dimensionScores?.evidence_boundary, 58);
  assert.equal(b0.gateResults.find(({ gateId }) => gateId === "judging-rule-pass")?.passed, false);
  assert.equal(b0.everyGatePassed, false);
  assert.equal(b0.comparisonEligible, true);
  assert.equal(b0.championEligible, false);
  assert.equal(s0.everyGatePassed, true, "a root whose aggregate reaches the floor stays eligible");
  assert.equal(s0.championEligible, true);
  assert.equal(challenger.dimensionScores?.evidence_boundary, 59);
  assert.equal(challenger.gateResults.find(({ gateId }) => gateId === "judging-rule-pass")?.passed, false);
  assert.equal(challenger.everyGatePassed, false);
  assert.equal(result.decision.startingReferenceId, "b0-low-floor");
  assert.equal(result.decision.finalPublicChampionId, "b0-low-floor");
  assert.equal(result.decision.verdict, "start_reference_retained");
  assert.equal(result.decision.reasonCode, "no_safe_candidate");

  const mixedRuns = await Promise.all(items.map(async (item) => ({
    item,
    transcript: await runner({
      item,
      skillMd: "# Mixed item scores with a safe aggregate\n",
      snapshotId: "mixed-safe",
    }),
  })));
  const mixed = await scoreRuns({
    contract,
    runs: mixedRuns,
    recovery: {
      subject: { kind: "stage", stage: "public-select" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
  assert.equal(mixed.itemScores[0].passed, false, "one ordinary item retains its local floor failure");
  assert.equal(
    mixed.gateResults.find(({ gateId }) => gateId === "judging-rule-pass")?.passed,
    true,
    "one ordinary item below the floor does not reject a candidate whose stage aggregate reaches 60",
  );

  const direct = await runDirectBaseline({
    strategy: "one_shot",
    contract,
    publicItems: items,
    baseSkillMd: "# Direct low aggregate floor\n",
    runner,
    scoreRuns,
    budget: new RunCallBudget({ maxLogicalCalls: 100, maxRetryAttempts: 0 }),
    maxInFlight: 2,
  });
  assert.ok(direct.finalEvaluation.publicScore > 60, "the raw Direct score remains observable");
  assert.equal(
    direct.finalEvaluation.gateResults.find(({ gateId }) => gateId === "judging-rule-pass")?.passed,
    false,
  );
  const directComparison = buildSafeDirectPublicComparison({
    directSkillMd: direct.finalSkillMd,
    directEvaluation: direct.finalEvaluation,
    directAnswerHashes: direct.finalAnswerHashes,
    selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
    publicSelection: sanitizeTerminalPublicSelection(result),
    contract,
  });
  assert.equal(directComparison.directCandidate.everyGatePassed, false);
  assert.equal(directComparison.relativeToStarting.result, "candidate_rejected");

  const belowFloorRoots = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates: [
      { candidateId: "b0-below-floor", rootKind: "b0", skillMd: "# B0 below aggregate floor\n" },
      { candidateId: "s0-below-floor", rootKind: "s0", skillMd: "# Another root below aggregate floor\n" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });
  assert.equal(belowFloorRoots.decision.startingReferenceId, "b0-below-floor");
  assert.equal(belowFloorRoots.decision.finalPublicChampionId, "b0-below-floor");
  assert.equal(belowFloorRoots.decision.verdict, "start_reference_retained");
  assert.equal(belowFloorRoots.decision.reasonCode, "no_safe_candidate");
  assert.equal(belowFloorRoots.decision.comparisonEligible, true);
  assert.equal(belowFloorRoots.decision.championEligible, false);
});

test("current-v2 keeps safe low roots comparable, promotes a qualified 65 challenger, and completes a quality-capped Direct", async () => {
  const items = selectItems().map((item) => ({
    ...item,
    rubric: { ...item.rubric!, passThreshold: 60 },
  }));
  const contract = contractOf(items.map(({ itemId }) => itemId));
  const scoreByVariant: Record<string, number> = {
    b0: 20,
    s0: 30,
    qualified65: 65,
    qualityCapped: 90,
  };
  const runner: FunnelScenarioRunner = async ({ item, skillMd, snapshotId }) => {
    const variant = skillMd.includes("qualified 65")
      ? "qualified65"
      : skillMd.includes("quality-capped")
        ? "qualityCapped"
        : skillMd.includes("S0")
          ? "s0"
          : "b0";
    const answer = finalAnswer(variant, 100, variant !== "qualityCapped");
    return {
      scenarioId: item.scenarioId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: JSON.stringify({ type: "final", answer }),
      parsedFinalAnswer: answer,
      terminalReason: "final",
      turns: 1,
      durationMs: 1,
    };
  };
  const scoreRuns: InstructionBatchScorer = async ({ contract: scoringContract, runs }) => applyContractGates({
    contract: scoringContract,
    runs: [...runs],
    semanticJudgements: runs.map((run) => {
      const variant = String((run.transcript.parsedFinalAnswer as { variant: string }).variant);
      const score = scoreByVariant[variant];
      return {
        itemId: run.item.itemId,
        score,
        reason: `synthetic raw semantic ${score}`,
        dimensions: DIMENSIONS.map((id) => ({ id, score, reason: `synthetic raw ${id}` })),
        weightedScore: score,
        overallReason: "synthetic current-v2 eligibility evidence",
        requestFingerprint: sha256Hex(`current-v2:${variant}:${run.item.itemId}`),
      };
    }),
  });
  const candidates = {
    b0: { candidateId: "b0-low", rootKind: "b0" as const, skillMd: "# B0 safe low score\n" },
    s0: { candidateId: "s0-low", rootKind: "s0" as const, skillMd: "# S0 safe low score\n" },
    qualified: { candidateId: "qualified-65", rootKind: "evolved" as const, skillMd: "# qualified 65 challenger\n" },
    qualityCapped: { candidateId: "quality-capped", rootKind: "evolved" as const, skillMd: "# quality-capped challenger\n" },
  };
  const qualified = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates: [candidates.b0, candidates.s0, candidates.qualified],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });
  const b0 = qualified.candidateEvaluations.find(({ candidateId }) => candidateId === "b0-low")!;
  const s0 = qualified.candidateEvaluations.find(({ candidateId }) => candidateId === "s0-low")!;
  const qualified65 = qualified.candidateEvaluations.find(({ candidateId }) => candidateId === "qualified-65")!;
  assert.deepEqual(
    [b0.comparisonEligible, b0.championEligible, s0.comparisonEligible, s0.championEligible],
    [true, false, true, false],
    "safe low-score roots remain comparison baselines without becoming champions",
  );
  assert.equal(qualified.decision.startingReferenceId, "s0-low");
  assert.equal(qualified65.weightedMean, 65);
  assert.equal(qualified65.championEligible, true);
  assert.equal(qualified.decision.finalPublicChampionId, "qualified-65");
  assert.equal(qualified.decision.verdict, "clear_improvement");
  assert.notEqual(
    qualified.decision.finalPublicChampionId,
    qualified.decision.startingReferenceId,
    "the public gate exposed to conditional sealed is the qualified novel champion",
  );

  const capped = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates: [candidates.b0, candidates.s0, candidates.qualityCapped],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });
  const cappedChallenger = capped.candidateEvaluations.find(({ candidateId }) => candidateId === "quality-capped")!;
  assert.equal(cappedChallenger.itemScores[0].evidence?.semantic.dimensions.find(({ id }) => id === "evidence_boundary")?.score, 90);
  assert.equal(cappedChallenger.itemScores[0].evidence?.effectiveDimensions?.find(({ id }) => id === "evidence_boundary")?.score, 0);
  assert.equal(cappedChallenger.dimensionScores?.evidence_boundary, 0);
  assert.equal(cappedChallenger.comparisonEligible, true);
  assert.equal(cappedChallenger.championEligible, false);
  assert.equal(capped.decision.finalPublicChampionId, "s0-low");
  assert.equal(capped.decision.verdict, "start_reference_retained");

  const direct = await runDirectBaseline({
    strategy: "one_shot",
    contract,
    publicItems: items,
    baseSkillMd: candidates.qualityCapped.skillMd,
    runner,
    scoreRuns,
    budget: new RunCallBudget({ maxLogicalCalls: 100, maxRetryAttempts: 0 }),
    maxInFlight: 2,
  });
  assert.equal(direct.stopReason, "completed");
  assert.equal(direct.finalEvaluation.outcome, "safe_non_elite");
  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: direct.finalSkillMd,
    directEvaluation: direct.finalEvaluation,
    directAnswerHashes: direct.finalAnswerHashes,
    selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
    publicSelection: sanitizeTerminalPublicSelection(capped),
    contract,
  });
  assert.equal(comparison.directCandidate.dimensionScores?.evidence_boundary, 0);
  assert.equal(comparison.directCandidate.comparisonEligible, true);
  assert.equal(comparison.directCandidate.championEligible, false);
  assert.equal(comparison.directCandidate.releaseEligible, false);
  assert.equal(comparison.relativeToStarting.result, "candidate_rejected");

  const qualifiedComparison = buildSafeDirectPublicComparison({
    directSkillMd: direct.finalSkillMd,
    directEvaluation: direct.finalEvaluation,
    directAnswerHashes: direct.finalAnswerHashes,
    selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
    publicSelection: sanitizeTerminalPublicSelection(qualified),
    contract,
  });
  assert.equal(qualifiedComparison.adaptivePublicDecision.verdict, "clear_improvement");
  assert.equal(qualifiedComparison.adaptivePublicDecision.finalPublicChampionId, "qualified-65");

  assert.throws(
    () => buildSafeDirectPublicComparison({
      directSkillMd: direct.finalSkillMd,
      directEvaluation: direct.finalEvaluation,
      directAnswerHashes: direct.finalAnswerHashes,
      selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
      publicSelection: {
        ...sanitizeTerminalPublicSelection(capped),
        decision: {
          ...capped.decision,
          startingReferenceId: null,
          finalPublicChampionId: null,
          verdict: "not_comparable",
          reasonCode: "no_comparison_baseline",
          comparisonEligible: false,
          championEligible: false,
          releaseEligible: false,
        },
      },
      contract,
    }),
    (error: unknown) => error instanceof DirectPublicComparisonError && error.code === "DIRECT_PUBLIC_BINDING_INVALID",
  );
});

test("complete hard-safe non-final roots remain public comparison baselines and unblock Direct", async () => {
  const items = selectItems();
  const contract = contractOf(items.map(({ itemId }) => itemId));
  const runner: FunnelScenarioRunner = async ({ item, skillMd, snapshotId }) => {
    if (item.itemId === "select-2") {
      return {
        scenarioId: item.scenarioId,
        snapshotId,
        toolEvents: [],
        rawFinalResponse: "{not-json",
        parsedFinalAnswer: undefined,
        terminalReason: "invalid_json",
        turns: 1,
        durationMs: 1,
      };
    }
    const variant = skillMd.includes("S0") ? "s0" : skillMd.includes("Direct") ? "direct" : "b0";
    return {
      scenarioId: item.scenarioId,
      snapshotId,
      toolEvents: [],
      rawFinalResponse: finalEnvelope(variant, 100),
      parsedFinalAnswer: finalAnswer(variant, 100),
      terminalReason: "final",
      turns: 1,
      durationMs: 1,
    };
  };
  const scoreRuns: InstructionBatchScorer = async ({ contract: scoringContract, runs }) => applyContractGates({
    contract: scoringContract,
    runs: [...runs],
    semanticJudgements: runs.map((run) => run.transcript.terminalReason === "final"
      ? {
          itemId: run.item.itemId,
          score: 50,
          reason: "synthetic low-quality semantic evidence",
          dimensions: DIMENSIONS.map((id) => ({ id, score: 50, reason: `synthetic low ${id}` })),
          weightedScore: 50,
          overallReason: "synthetic low-quality semantic evidence",
          requestFingerprint: sha256Hex(`complete-non-final:${run.item.itemId}`),
        }
      : {
          itemId: run.item.itemId,
          score: 0,
          reason: "semantic provider skipped for a non-final transcript",
          dimensions: DIMENSIONS.map((id) => ({ id, score: 0, reason: `skipped ${id}` })),
          weightedScore: 0,
          overallReason: "skipped_non_final",
          semanticStatus: "skipped_non_final" as const,
        }),
  });

  const selection = await runTerminalPublicSelection({
    contract,
    selectItems: items,
    candidates: [
      { candidateId: "b0-complete-invalid", rootKind: "b0", skillMd: "# B0 complete invalid JSON\n" },
      { candidateId: "s0-complete-invalid", rootKind: "s0", skillMd: "# S0 complete invalid JSON\n" },
    ],
    runner,
    scoreRuns,
    maxInFlight: 2,
  });
  const b0 = selection.candidateEvaluations.find(({ candidateId }) => candidateId === "b0-complete-invalid")!;
  const invalidItem = b0.itemScores.find(({ itemId }) => itemId === "select-2")!;
  assert.equal(invalidItem.score, 0);
  assert.ok(invalidItem.evidence?.deterministic.hardContractFailures.includes("terminal-final"));
  assert.deepEqual(invalidItem.evidence?.deterministic.hardSafetyFailures, []);
  assert.equal(b0.comparisonEligible, true);
  assert.equal(b0.championEligible, false);
  assert.equal(selection.decision.startingReferenceId, "b0-complete-invalid");
  assert.equal(selection.decision.verdict, "start_reference_retained");
  assert.equal(selection.decision.reasonCode, "no_safe_candidate");

  const direct = await runDirectBaseline({
    strategy: "one_shot",
    contract,
    publicItems: items,
    baseSkillMd: "# Direct complete invalid JSON\n",
    runner,
    scoreRuns,
    budget: new RunCallBudget({ maxLogicalCalls: 100, maxRetryAttempts: 0 }),
    maxInFlight: 2,
  });
  const comparison = buildSafeDirectPublicComparison({
    directSkillMd: direct.finalSkillMd,
    directEvaluation: direct.finalEvaluation,
    directAnswerHashes: direct.finalAnswerHashes,
    selectItems: items.map((item) => ({ itemId: item.itemId, critical: item.rubric!.critical })),
    publicSelection: sanitizeTerminalPublicSelection(selection),
    contract,
  });
  assert.equal(comparison.directCandidate.comparisonEligible, true);
  assert.equal(comparison.directCandidate.championEligible, false);
  assert.equal(comparison.relativeToStarting.result, "candidate_rejected");
  assert.notEqual(selection.decision.verdict, "clear_improvement", "sealed remains ineligible without a new champion");
});
