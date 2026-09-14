import test from "node:test";
import assert from "node:assert/strict";
import { RunCallBudget, ProviderBudgetError } from "../providers/runBudget.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import type { Provider } from "../providers/types.js";
import type { U1RecoveryContext, U1RecoveryDiagnostic } from "./structureRecovery.js";
import { createPublicSemanticBatchJudge, SemanticJudgeError } from "../evaluation/semanticJudge.js";
import { applyContractGates, type ContractItemScore } from "../runtime/instructionAdapter.js";
import {
  LiveProposalError,
  type LiveMutationProposer,
  type MutationProposalContext,
} from "../bootstrap/liveBootstrapProposer.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  U1_TASK_VERIFIER_VERSION,
  type TaskCard,
  type EvaluationContractV3,
  type RunTranscript,
} from "../types.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import { parseAdaptivePolicy, type AdaptivePolicyParams } from "./adaptivePolicy.js";
import { calculateCallEnvelope, calculateScenarioCallAuthorization } from "../providers/stageBudgets.js";
import type { FrontierRepairProposer } from "./repairFrontier.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";
import {
  AdaptiveRunError,
  runAdaptive as runAdaptiveMainline,
  selectAdaptivePopulation,
  type AdaptiveEvaluation,
  type AdaptiveRunCandidate,
} from "./adaptiveRun.js";

// ── V3.1 T18: the adaptive evolution runner ────────────────────────
//
// Population invariants (B0 anchor + Elite + Diversity always alive),
// G2 exploit/diversify children with lineage, progress-certificate
// gating on 2nd+ refinements, structured budget stops with a
// resubmission suggestion, and a per-generation ledger. All model work
// is injected: scripted scenario runner + scripted proposers, each
// spending the shared RunCallBudget exactly like the live wiring.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeContract(): EvaluationContractV3 {
  const contract: EvaluationContractV3 = {
    schemaVersion: 3,
    createdAt: "2026-08-17T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: { taskCard: HASH_A },
    taskCardHash: HASH_A,
    skillSnapshotHash: HASH_B,
    adapterId: "instruction-v1",
    allowedCapabilities: ["instruction"],
    publicScenarioIds: ["s1", "s2"],
    holdoutScenarioIds: ["s3"],
    safetyGates: [
      { gateId: "contract-capability-boundary", description: "boundary" },
      { gateId: "redline-hold", description: "red lines hold" },
    ],
    qualityGates: [
      { gateId: "judging-rule-pass", description: "judging rule" },
      { gateId: "public-absolute-floor", description: "floor" },
    ],
    goalConfidence: { level: "high", score: 75, reasons: ["operator confirmed"] },
    evalConfidence: { level: "medium", score: 65, reasons: ["curated"] },
    generation: {
      generator: { kind: "provider", name: "generator-a" },
      curator: { kind: "curator", name: "curator-b" },
      generatorCuratorIsolation: "independent",
    },
    thresholds: { absoluteFloor: 60, confidenceFloor: 60 },
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 0.25,
    },
    explorationOnly: false,
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
    evaluationReviewHash: "4".repeat(64),
    trainItemIds: Array.from({ length: 8 }, (_, index) => `d${index + 1}`),
    selectItemIds: Array.from({ length: 6 }, (_, index) => `d${index + 9}`),
    trainItemsSha256: "6".repeat(64),
    selectItemsSha256: "7".repeat(64),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: "8".repeat(64),
    sameModelLimitation: "The fixture uses one scripted model family and does not establish independent-model validation.",
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    u1ContractVersion: "v2",
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    contractSha256: "0".repeat(64),
  };
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return EvaluationContractV3Schema.parse(contract);
}

const CARD = {
  goal: "produce a weekly repository digest",
  redlines: ["never fabricate repository facts"],
  capabilityBoundary: { allowedCapabilities: ["instruction"], network: "forbidden", filesystem: "forbidden", externalActions: "forbidden" },
  intentDetails: {
    goal_and_intended_user: "Help repository maintainers produce a weekly digest.",
    inputs_and_evidence: "Use only supplied repository evidence.",
    output_and_format: "Return a concise structured digest.",
    capability_boundary_and_redlines: "Do not use network, files, scripts, or external actions.",
    success_criteria_and_protected_behavior: "Preserve factual attribution and explicit limitations.",
  },
  qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
  scenarios: [
    { id: "s1", userRequest: "Summarize repository X." },
    { id: "s2", userRequest: "Summarize repository Y." },
  ],
} as unknown as TaskCard;

function publicItemsOf(count: number): FunnelEvalItem[] {
  const types = ["trigger", "near-miss", "negative"];
  const items: FunnelEvalItem[] = [];
  for (let i = 1; i <= count; i += 1) {
    const itemType = types[(i - 1) % 3];
    items.push({
      itemId: `d${i}`,
      scenarioId: i % 2 === 0 ? "s2" : "s1",
      split: "public",
      itemType,
      input: `user prompt ${i}`,
      judgingRule: `the answer must address prompt ${i} with a digest`,
      ...(itemType === "negative" ? { redlineRefs: ["never claim execution"] } : {}),
      rubric: {
        critical: itemType === "negative",
        passThreshold: 70,
        mustHave: ["field:digest"],
        mustNotHave: ["I fetched"],
        dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id, weight }) => ({ id, weight })),
      },
      taskVerifier: {
        version: U1_TASK_VERIFIER_VERSION,
        rules: [{
          ruleId: `digest-d${i}`,
          kind: "output_field" as const,
          field: "digest",
          valueType: "string" as const,
          effect: "quality" as const,
          dimension: "task_correctness" as const,
          weight: 1,
        }],
      },
    });
  }
  return items;
}

function currentPublicItemsOf(count: number): FunnelEvalItem[] {
  return publicItemsOf(count);
}

function makeCurrentContract(): EvaluationContractV3 {
  return makeContract();
}

function simpleCurrentScoreRuns(
  runs: ReadonlyArray<{
    item: { itemId: string; split: "public" | "holdout" };
    transcript: RunTranscript;
  }>,
) {
  const itemScores = runs.map((run) => {
    const passed = run.transcript.terminalReason === "final" && run.transcript.parsedFinalAnswer != null;
    return {
      itemId: run.item.itemId,
      split: run.item.split,
      score: passed ? 80 : 20,
      passed,
      criticalFailure: false,
    };
  });
  const publicScore = Math.round(itemScores.reduce((sum, item) => sum + item.score, 0) / itemScores.length);
  const complete = itemScores.every((item) => item.passed);
  return {
    publicScore,
    itemScores,
    gateResults: [
      { gateId: "contract-capability-boundary", category: "safety" as const, passed: true },
      { gateId: "redline-hold", category: "safety" as const, passed: true },
      { gateId: "judging-rule-pass", category: "quality" as const, passed: complete },
      { gateId: "public-absolute-floor", category: "quality" as const, passed: publicScore >= 60 },
    ],
  };
}

/**
 * Every runner test in this file exercises the current scoring contract.
 * Individual tests may still override the scorer to probe a specific gate or
 * recovery boundary; otherwise use one deterministic semantic projection.
 */
function runAdaptive(args: Parameters<typeof runAdaptiveMainline>[0]) {
  return runAdaptiveMainline({
    ...args,
    scoreRuns: args.scoreRuns ?? (async ({ runs }) => simpleCurrentScoreRuns(runs)),
  });
}

function finalTranscript(item: FunnelEvalItem, digest: string): RunTranscript {
  return {
    scenarioId: item.scenarioId,
    snapshotId: "test",
    toolEvents: [],
    rawFinalResponse: JSON.stringify({ type: "final", answer: { digest, limitations: "none" } }),
    parsedFinalAnswer: { digest, limitations: "none" },
    terminalReason: "final",
    turns: 1,
    durationMs: 5,
  };
}

/** Quality-only failure: finalize nothing on NON-redline items (a broken redline probe is a SAFETY kill). */
function brokenTranscript(item: FunnelEvalItem): RunTranscript {
  return {
    scenarioId: item.scenarioId,
    snapshotId: "test",
    toolEvents: [],
    rawFinalResponse: "sorry, no structured answer available",
    parsedFinalAnswer: undefined,
    terminalReason: "invalid_json",
    turns: 1,
    durationMs: 5,
  };
}

function persistentLoopTranscript(item: FunnelEvalItem): RunTranscript {
  return {
    scenarioId: item.scenarioId,
    snapshotId: "test",
    toolEvents: [],
    rawFinalResponse: "",
    parsedFinalAnswer: undefined,
    terminalReason: "persistent_candidate_loop",
    turns: 6,
    durationMs: 10,
    applicationRecovery: {
      outcome: "persistent_candidate_loop",
      attempts: [1, 2].map((attempt) => ({
        attempt: attempt as 1 | 2,
        attemptIdentitySha256: String(attempt).repeat(64),
        terminalReason: "too_many_tool_calls" as const,
        modelCalls: 5,
        transcriptSha256: attempt === 1 ? "a".repeat(64) : "b".repeat(64),
      })) as [
        { attempt: 1; attemptIdentitySha256: string; terminalReason: "too_many_tool_calls"; modelCalls: number; transcriptSha256: string },
        { attempt: 2; attemptIdentitySha256: string; terminalReason: "too_many_tool_calls"; modelCalls: number; transcriptSha256: string },
      ],
    },
  };
}

type ItemBehavior = (item: FunnelEvalItem) => RunTranscript;

const ALL_GOOD: ItemBehavior = (item) => finalTranscript(item, `answer for ${item.itemId}`);
const FAIL_NON_NEGATIVE: ItemBehavior = (item) =>
  item.itemType === "negative" ? ALL_GOOD(item) : brokenTranscript(item);
function scriptedRunner(
  behaviors: Map<string, ItemBehavior>,
  budget: RunCallBudget,
): FunnelScenarioRunner {
  return async ({ item, skillMd }) => {
    budget.enterLogicalCall();
    budget.enterHttpAttempt();
    const behavior = behaviors.get(skillMd);
    if (!behavior) throw new Error(`no behavior registered for skill "${skillMd.slice(0, 24)}..."`);
    return behavior(item);
  };
}

function spendSemanticBatches(budget: RunCallBudget, itemCount: number): void {
  for (let batch = 0; batch < Math.ceil(itemCount / 3); batch += 1) {
    budget.enterLogicalCall();
    budget.enterHttpAttempt();
  }
}

function budgetedSemanticScorer(budget: RunCallBudget) {
  return async ({ contract, runs }: Parameters<NonNullable<Parameters<typeof runAdaptive>[0]["scoreRuns"]>>[0]) => {
    spendSemanticBatches(budget, runs.length);
    return applyContractGates({ contract, runs: [...runs] });
  };
}

function scriptedMutationProposer(
  handler: (context: MutationProposalContext, callIndex: number) => {
    hypothesis: string;
    skillMd: string;
    decision?: "edit" | "no_change";
    appliedEdits?: number;
  },
  budget: RunCallBudget,
): { proposer: LiveMutationProposer; contexts: MutationProposalContext[] } {
  const contexts: MutationProposalContext[] = [];
  const proposer: LiveMutationProposer = {
    producer: { kind: "provider", name: "scripted-mutation" },
    async proposeMutation(context) {
      budget.enterLogicalCall();
      budget.enterHttpAttempt();
      contexts.push(context);
      return handler(context, contexts.length - 1);
    },
  };
  return { proposer, contexts };
}

type ObservedRepairContext = Parameters<FrontierRepairProposer["proposeTargetedRepair"]>[0] & {
  trainFeedback?: MutationProposalContext["trainFeedback"];
  adapterId?: string;
  recovery?: U1RecoveryContext;
};

function scriptedRepairProposer(
  handler: (skillMd: string, callIndex: number, context: ObservedRepairContext) => {
    hypothesis: string;
    skillMd: string;
    decision?: "edit" | "no_change";
    appliedEdits?: number;
  },
  budget: RunCallBudget,
): { proposer: FrontierRepairProposer; calls: string[]; contexts: ObservedRepairContext[] } {
  const calls: string[] = [];
  const contexts: ObservedRepairContext[] = [];
  const proposer: FrontierRepairProposer = {
    producer: { kind: "provider", name: "scripted-repair" },
    async proposeTargetedRepair(context) {
      budget.enterLogicalCall();
      budget.enterHttpAttempt();
      calls.push(context.skillMd);
      const observed = context as ObservedRepairContext;
      contexts.push(observed);
      return handler(context.skillMd, calls.length - 1, observed);
    },
  };
  return { proposer, calls, contexts };
}

function policyOf(overrides: Partial<AdaptivePolicyParams> & { testMaxLogicalCalls?: number } = {}) {
  const { testMaxLogicalCalls = 40, ...policyOverrides } = overrides;
  const input = {
    formalHumanU1B: true as const,
    maxGenerations: 2,
    maxRefinementsPerCandidate: 0,
    minRepairProgress: 2,
    stagnationPatience: 2,
    mode: "standard" as const,
    earlyRepair: "off" as const,
    maxRetryAttempts: 1,
    requestTimeoutMs: 8000,
    maxOutputTokens: 1200,
    ...policyOverrides,
  };
  return parseAdaptivePolicy({
    ...input,
    u1CallEnvelope: policyOverrides.u1CallEnvelope ?? testCallEnvelope(testMaxLogicalCalls),
  });
}

function testCallEnvelope(maxLogicalCalls: number) {
  return calculateCallEnvelope({
    rawStageEstimate: maxLogicalCalls,
    stagePrimaryAuthorization: maxLogicalCalls,
    stageLoopRetryReserve: 0,
    existingRecoveryReserve: 0,
    scenarioAuthorization: calculateScenarioCallAuthorization(1, 0, 1, 1),
  });
}

function evalOf(input: {
  publicScore: number;
  solvedItemIds: string[];
  safetyFailures?: number;
  qualityFailures?: number;
  outcome?: AdaptiveEvaluation["outcome"];
}): AdaptiveEvaluation {
  return {
    publicScore: input.publicScore,
    solvedItemIds: input.solvedItemIds,
    gateResults: [],
    safetyFailures: input.safetyFailures ?? 0,
    qualityFailures: input.qualityFailures ?? 0,
    outcome: input.outcome ?? "elite",
  };
}

// ── selectAdaptivePopulation: the triple invariant ─────────────────

test("selectAdaptivePopulation keeps B0/Elite/Diversity alive and never seats a killed candidate", () => {
  const anchor: AdaptiveRunCandidate = {
    candidateId: "b0-anchor",
    originRoot: "b0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# anchor",
    evaluation: evalOf({ publicScore: 25, solvedItemIds: ["d1"], outcome: "safe_non_elite" }),
  };
  const killedTop: AdaptiveRunCandidate = {
    candidateId: "c-killed",
    originRoot: "b0",
    generation: 1,
    parentCandidateId: "b0-anchor",
    childKind: "diversify",
    skillMd: "# killed",
    evaluation: evalOf({
      publicScore: 85,
      solvedItemIds: ["d1", "d2", "d3"],
      safetyFailures: 1,
      outcome: "killed",
    }),
  };
  const elite: AdaptiveRunCandidate = {
    candidateId: "c-elite",
    originRoot: "s0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# elite",
    evaluation: evalOf({ publicScore: 90, solvedItemIds: ["d1", "d2", "d4"] }),
  };
  const safeComplement: AdaptiveRunCandidate = {
    candidateId: "c-safe",
    originRoot: "b0",
    generation: 1,
    parentCandidateId: "b0-anchor",
    childKind: "exploit",
    skillMd: "# safe",
    evaluation: evalOf({ publicScore: 70, solvedItemIds: ["d3"], outcome: "safe_non_elite" }),
  };

  const population = selectAdaptivePopulation({
    anchorCandidateId: "b0-anchor",
    candidates: [anchor, killedTop, elite, safeComplement],
  });

  assert.equal(population.anchorCandidateId, "b0-anchor");
  assert.equal(population.eliteId, "c-elite");
  assert.equal(population.diversityId, "c-safe", "the killed top scorer must never take the diversity seat");
  assert.ok(population.eliteReason.includes("c-elite"));
  assert.match(population.diversityReason, /1 killed/, "the reason records the excluded killed candidate");
  assert.match(population.diversityReason, /d3/, "the complementarity is spelled out");
});

test("selectAdaptivePopulation falls back to the anchor for the diversity seat when no second safe candidate exists", () => {
  const anchor: AdaptiveRunCandidate = {
    candidateId: "b0-anchor",
    originRoot: "b0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# anchor",
    evaluation: evalOf({ publicScore: 40, solvedItemIds: ["d1"], outcome: "safe_non_elite" }),
  };
  const only: AdaptiveRunCandidate = {
    candidateId: "c-only",
    originRoot: "s0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# only",
    evaluation: evalOf({ publicScore: 80, solvedItemIds: ["d1", "d2"] }),
  };

  const population = selectAdaptivePopulation({
    anchorCandidateId: "b0-anchor",
    candidates: [anchor, only],
  });

  assert.equal(population.eliteId, "c-only");
  assert.equal(population.diversityId, "b0-anchor", "the anchor keeps the triple alive");
  assert.match(population.diversityReason, /anchor/i);
});

test("identical SKILL.md content cannot occupy a second population seat or masquerade as Diversity", () => {
  const anchor: AdaptiveRunCandidate = {
    candidateId: "b0-anchor",
    originRoot: "b0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# identical root\n",
    evaluation: evalOf({ publicScore: 70, solvedItemIds: ["d1"], outcome: "safe_non_elite" }),
  };
  const duplicateS0: AdaptiveRunCandidate = {
    candidateId: "s0-duplicate",
    originRoot: "s0",
    generation: 0,
    parentCandidateId: null,
    childKind: null,
    skillMd: "# identical root\n",
    evaluation: evalOf({ publicScore: 70, solvedItemIds: ["d1"], outcome: "safe_non_elite" }),
  };

  const population = selectAdaptivePopulation({
    anchorCandidateId: anchor.candidateId,
    candidates: [anchor, duplicateS0],
  });

  assert.equal(population.eliteId, "b0-anchor");
  assert.equal(population.diversityId, null);
  assert.match(population.diversityReason, /empty|duplicate|distinct hash/i);
});

// ── runAdaptive: routing, lineage, certificates, budget ────────────

test("a run routes a single-class failure to targeted mutation and records exploit + diversify lineage", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  items[0] = {
    ...items[0],
    taskVerifier: {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [{
        ruleId: "cite-public-guide",
        kind: "evidence_reference",
        resourceKind: "reference",
        logicalId: "public-guide",
        effect: "quality",
        dimension: "evidence_boundary",
        weight: 1,
      }],
    },
  };
  const policy = policyOf();
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });

  const anchorMd = "# B0 anchor";
  const seedMd = "# S0 seed";
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, FAIL_NON_NEGATIVE], // fails d1 (trigger) + d2 (near-miss); d3 negative stays clean
    [seedMd, (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
    ["# exploit-1", ALL_GOOD],
    ["# diversify-1", (item) => (item.itemId === "d4" ? brokenTranscript(item) : ALL_GOOD(item))],
    ["# exploit-2", ALL_GOOD],
    ["# diversify-2", ALL_GOOD],
  ]);
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({
      hypothesis: `mutation ${index}`,
      skillMd: index % 2 === 0 ? `# exploit-${Math.floor(index / 2) + 1}` : `# diversify-${Math.floor(index / 2) + 1}`,
    }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "generations_completed");
  // Gen 1 routed to targeted mutation from the elite seat (the seed) and the diversity seat (the anchor)
  assert.equal(contexts.length, 4, "two mutations per generation, two generations");
  assert.equal(contexts[0].eliteSkillMd, seedMd, "the exploit child builds on the elite");
  assert.equal(contexts[0].diversitySkillMd, anchorMd);
  assert.equal(contexts[1].eliteSkillMd, anchorMd, "the diversify child builds on the diversity seat");
  assert.equal(contexts[1].diversitySkillMd, seedMd);

  const exploit = result.candidates.find((candidate) => candidate.candidateId === "g1-exploit");
  const diversify = result.candidates.find((candidate) => candidate.candidateId === "g1-diversify");
  assert.ok(exploit && diversify, "G2 produces both child kinds");
  assert.equal(exploit?.parentCandidateId, "s0-seed");
  assert.equal(exploit?.childKind, "exploit");
  assert.equal(exploit?.originRoot, "s0");
  assert.equal(diversify?.parentCandidateId, "b0-anchor");
  assert.equal(diversify?.childKind, "diversify");
  assert.equal(diversify?.originRoot, "b0");

  // Population invariant after every generation
  assert.ok(result.population.anchorCandidateId);
  assert.ok(result.population.eliteId);
  assert.ok(result.population.diversityId);
  assert.equal(exploit?.evaluation?.publicScore, 80);

  // Ledger: 8 initial evals + (2 proposals + 8 child evals) × 2 generations = 28 logical calls
  assert.equal(result.accounting.logicalCalls, 28);
  assert.equal(result.generations.length, 2);
  assert.equal(result.generations[0].route, "targeted_mutation");
  assert.ok(result.generations[0].reason.length > 0, "every ledger row carries the routing reason");
  assert.ok(result.generations.every((entry) => entry.wallTimeMs >= 0));
  assert.ok(result.generations.every((entry) => entry.lanes.every((lane) =>
    /^[a-f0-9]{64}$/.test(lane.feedbackSha256) &&
    lane.feedbackFailureCount <= 6 &&
    lane.feedbackSuccessCount <= 2,
  )));
  assert.ok(contexts[0].trainFeedback);
  assert.ok((contexts[0].trainFeedback?.failures.length ?? 0) <= 6);
  assert.ok((contexts[0].trainFeedback?.successes.length ?? 0) <= 2);
  assert.deepEqual(
    contexts[0].contract.authorizedToolLogicalIds,
    ["reference.read:public-guide"],
    "a public-train evidence rule exposes only its authorized logical id, never dependency content",
  );
  assert.ok(result.finalElite);
  assert.equal(result.explorationOnly, false);
});

test("current U1 v2 converges normally when both mutation lanes return no_change", async () => {
  const contract = makeCurrentContract();
  const items = currentPublicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# B0 bounded no-change";
  const seedMd = "# S0 bounded no-change";
  const { proposer, contexts } = scriptedMutationProposer(
    (context, index) => ({
      hypothesis: `lane ${index} has no justified bounded edit`,
      decision: "no_change",
      appliedEdits: 0,
      skillMd: context.eliteSkillMd,
    }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(new Map([
      [anchorMd, FAIL_NON_NEGATIVE],
      [seedMd, (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
    ]), budget),
    scoreRuns: async ({ runs }) => simpleCurrentScoreRuns(runs),
    mutationProposer: proposer,
    budget,
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.equal(result.generations.length, 1);
  assert.equal(result.generations[0].generationCoverage, "none");
  assert.equal(result.generations[0].childrenNoChange, 2);
  assert.equal(result.generations[0].childrenGenerated, 0);
  assert.deepEqual(result.generations[0].lanes.map((lane) => lane.status), ["no_change", "no_change"]);
  assert.equal(result.candidates.every((candidate) => candidate.generation === 0), true);
  assert.equal(result.events.filter((event) => event.type === "mutation_lane_no_change").length, 2);
  assert.deepEqual(contexts.map((context) => context.lanePurpose), [
    "exploit_known_failures",
    "diversify_alternative",
  ]);
  assert.deepEqual(contexts[0].taskCard.intentDetails, CARD.intentDetails);
  assert.deepEqual(contexts[0].taskCard.qualityPriorities, CARD.qualityPriorities);
  assert.deepEqual(contexts[0].taskCard.redlines, CARD.redlines);
});

test("current U1 evaluates identical B0/S0 content once and leaves Diversity empty", async () => {
  const contract = makeCurrentContract();
  const items = currentPublicItemsOf(8);
  const policy = policyOf({ maxGenerations: 2, testMaxLogicalCalls: 40 });
  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });
  const sharedSkill = "# byte-identical B0 and S0";
  let scenarioCalls = 0;
  let proposalCalls = 0;
  const runner: FunnelScenarioRunner = async ({ item }) => {
    budget.enterLogicalCall();
    budget.enterHttpAttempt();
    scenarioCalls += 1;
    return ALL_GOOD(item);
  };
  const { proposer } = scriptedMutationProposer(
    () => {
      proposalCalls += 1;
      return { hypothesis: "must not be reached", decision: "no_change", appliedEdits: 0, skillMd: sharedSkill };
    },
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: sharedSkill },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: sharedSkill }],
    runner,
    scoreRuns: async ({ runs }) => simpleCurrentScoreRuns(runs),
    mutationProposer: proposer,
    budget,
    stopOnPublicGoal: true,
  });

  assert.equal(scenarioCalls, 8, "one full public evaluation is shared by both root identities");
  assert.equal(proposalCalls, 2, "the mandatory first generation records both no_change lanes");
  assert.equal(result.candidates.length, 2, "resume-compatible B0/S0 identities remain in the artifact");
  assert.strictEqual(result.candidates[0].evaluation, result.candidates[1].evaluation);
  assert.equal(result.population.diversityId, null, "identical content cannot occupy the Diversity seat");
  assert.equal(result.events.filter((event) => event.type === "root_duplicate_skipped").length, 1);
});

test("current U1 treats an edit that returns an existing hash as no_change without reevaluation", async () => {
  const contract = makeCurrentContract();
  const items = currentPublicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2, testMaxLogicalCalls: 40 });
  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });
  const anchorMd = "# existing B0";
  const seedMd = "# existing S0";
  let scenarioCalls = 0;
  const runner: FunnelScenarioRunner = async ({ item }) => {
    budget.enterLogicalCall();
    budget.enterHttpAttempt();
    scenarioCalls += 1;
    return ALL_GOOD(item);
  };
  const { proposer } = scriptedMutationProposer(
    (_context, index) => ({
      hypothesis: "an edit request returned already evaluated content",
      decision: "edit",
      appliedEdits: 1,
      skillMd: index === 0 ? anchorMd : seedMd,
    }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner,
    scoreRuns: async ({ runs }) => simpleCurrentScoreRuns(runs),
    mutationProposer: proposer,
    budget,
    stopOnPublicGoal: false,
  });

  assert.equal(scenarioCalls, 8, "only the two unique generation-0 roots are evaluated");
  assert.equal(result.generations[0].childrenNoChange, 2);
  assert.equal(result.generations[0].childrenGenerated, 0);
  assert.deepEqual(result.generations[0].lanes.map((lane) => lane.status), ["no_change", "no_change"]);
  assert.equal(result.candidates.every((candidate) => candidate.generation === 0), true);
});

test("persistent candidate loop stays local, reaches public-train feedback, and does not discard its sibling lane", async () => {
  const contract = makeCurrentContract();
  const items = currentPublicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2, testMaxLogicalCalls: 80 });
  const budget = new RunCallBudget({ maxLogicalCalls: 80, maxRetryAttempts: 1 });
  const anchorMd = "# looping anchor";
  const seedMd = "# weaker seed";
  const childSkills = ["# valid exploit sibling", "# valid diversify sibling"];
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, (item) => item.itemId === "d1" ? persistentLoopTranscript(item) : ALL_GOOD(item)],
    [seedMd, FAIL_NON_NEGATIVE],
    ...childSkills.map((skillMd) => [skillMd, ALL_GOOD] as const),
  ]);
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `valid sibling ${index}`, skillMd: childSkills[index % childSkills.length] }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    scoreRuns: async ({ runs }) => simpleCurrentScoreRuns(runs),
    mutationProposer: proposer,
    budget,
    maxInFlight: 2,
    stopOnPublicGoal: false,
  });

  assert.equal(result.generations.length, 2);
  assert.equal(result.generations[0].generationCoverage, "full");
  assert.equal(result.generations[0].lanes.filter((lane) => lane.status === "evaluated").length, 2);
  assert.ok(childSkills.every((skillMd) => result.candidates.some((candidate) => candidate.skillMd === skillMd)));
  assert.ok(
    contexts.some((context) => JSON.stringify(context.trainFeedback).includes("persistent_candidate_loop")),
    "the bounded public-train feedback must expose the persistent terminal reason without response text",
  );
  assert.deepEqual(result.applicationLoopRecovery, {
    attemptedItems: 1,
    recoveredAfterSingleRetry: 0,
    persistentCandidateLoops: 1,
    retryCompletedNonFinal: 0,
    additionalModelCalls: 5,
  });
  const persisted = JSON.stringify(result.applicationLoopRecovery);
  assert.doesNotMatch(persisted, /rawFinalResponse|user prompt|answer for/i);
});

test("a current incompatible-B0 repair uses an explicit lane, keeps B0 immutable, and localizes one derived failure", async () => {
  const contract = makeCurrentContract();
  const items = currentPublicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2, testMaxLogicalCalls: 80 });
  const budget = new RunCallBudget({ maxLogicalCalls: 80, maxRetryAttempts: 1 });
  const b0Md = "# incompatible B0 parent";
  const s0Md = "# S0 safety parent";
  const badDerived = "# incompatible B0 derived malformed";
  const safeSibling = "# safe S0 sibling";
  const behaviors = new Map<string, ItemBehavior>([
    [b0Md, FAIL_NON_NEGATIVE],
    [s0Md, FAIL_NON_NEGATIVE],
    [badDerived, (item) => finalTranscript(item, "CURRENT_U1_DERIVED_SCHEMA_SENTINEL")],
    [safeSibling, ALL_GOOD],
  ]);
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({
      hypothesis: `derived lane ${index}`,
      skillMd: index === 0 ? badDerived : safeSibling,
    }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: b0Md },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: s0Md }],
    runner: scriptedRunner(behaviors, budget),
    scoreRuns: async ({ contract: frozen, runs }) => {
      if (runs.some((run) => run.transcript.rawFinalResponse.includes("CURRENT_U1_DERIVED_SCHEMA_SENTINEL"))) {
        throw new SemanticJudgeError("SEMANTIC_JUDGE_INVALID_JSON", "semantic response was not JSON");
      }
      return simpleCurrentScoreRuns(runs);
    },
    mutationProposer: proposer,
    budget,
    maxInFlight: 2,
    stopOnPublicGoal: false,
  });

  assert.notEqual(result.stopReason, "proposer_failure");
  assert.equal(result.generations.length, 2);
  assert.equal(result.generations[0].childrenRejected, 1);
  assert.equal(result.generations[0].childrenEvaluated, 1);
  assert.equal(result.candidates.some((candidate) => candidate.skillMd === badDerived), false);
  assert.equal(result.candidates.some((candidate) => candidate.skillMd === safeSibling), true);
  assert.equal(result.candidates.find((candidate) => candidate.candidateId === "b0-anchor")?.skillMd, b0Md);
  assert.deepEqual(contexts.slice(0, 2).map((context) => context.lanePurpose), [
    "repair_incompatible_b0",
    "diversify_alternative",
  ]);
  assert.equal(contexts[0].eliteSkillMd, b0Md, "the repair child derives from immutable B0 text");
  assert.equal(contexts[1].eliteSkillMd, s0Md, "the healthy S0/diversity lane continues independently");
  assert.ok(result.events.some((event) => event.type === "root_rebuild_derived_repair"));
  assert.deepEqual(
    result.generations[0].lanes.map((lane) => lane.status),
    ["candidate_rejected", "evaluated"],
  );
});

test("current formal-human standard defers an initial public goal until two exploit/diversify generation slots", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = parseAdaptivePolicy({
    maxGenerations: 2,
    maxRefinementsPerCandidate: 2,
    minRepairProgress: 2,
    stagnationPatience: 2,
    mode: "standard",
    earlyRepair: "auto",
    u1CallEnvelope: testCallEnvelope(100),
    maxRetryAttempts: 1,
    requestTimeoutMs: 8_000,
    maxOutputTokens: 1_200,
    formalHumanU1B: true,
  } as AdaptivePolicyParams & { formalHumanU1B: true });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# formal B0 complete";
  const seedMd = "# formal S0 complete";
  const childSkills = [
    "# formal g1 exploit",
    "# formal g1 diversify",
    "# formal g2 exploit",
    "# formal g2 diversify",
  ];
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, ALL_GOOD],
    [seedMd, ALL_GOOD],
    ...childSkills.map((skillMd) => [skillMd, ALL_GOOD] as const),
  ]);
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `formal lane ${index}`, skillMd: childSkills[index] }),
    budget,
  );
  const { proposer: repairProposer, calls: repairCalls } = scriptedRepairProposer(
    (_skillMd, index) => ({ hypothesis: `must remain unused ${index}`, skillMd: `# unused repair ${index}` }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    repairProposer,
    budget,
    maxInFlight: 2,
    stopOnPublicGoal: true,
  });

  assert.equal(policy.minChildGenerations, 2);
  assert.equal(result.stopReason, "public_goal_met");
  assert.equal(contexts.length, 4, "both lanes must run in both formal generation slots");
  assert.equal(repairCalls.length, 0, "ordinary refinement is deferred until the formal minimum is settled");
  assert.deepEqual(result.generations.map((entry) => entry.route), ["targeted_mutation", "targeted_mutation"]);
  assert.ok(result.generations.every((entry) =>
    entry.lanes.map((lane) => lane.kind).join(",") === "exploit,diversify"));
  assert.ok(result.events.some((event) => event.type === "minimum_generation_stop_deferred"));
});

test("current formal-human standard recovers one malformed semantic primary and exposes sanitized recovery evidence", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = parseAdaptivePolicy({
    maxGenerations: 2,
    maxRefinementsPerCandidate: 2,
    minRepairProgress: 2,
    stagnationPatience: 2,
    mode: "standard",
    earlyRepair: "auto",
    u1CallEnvelope: testCallEnvelope(120),
    maxRetryAttempts: 1,
    requestTimeoutMs: 8_000,
    maxOutputTokens: 1_200,
    formalHumanU1B: true,
  } as AdaptivePolicyParams & { formalHumanU1B: true });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# formal recovery B0";
  const seedMd = "# formal recovery S0";
  const childSkills = [
    "# formal recovery g1 exploit",
    "# formal recovery g1 diversify",
    "# formal recovery g2 exploit",
    "# formal recovery g2 diversify",
  ];
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, ALL_GOOD],
    [seedMd, ALL_GOOD],
    ...childSkills.map((skillMd) => [skillMd, ALL_GOOD] as const),
  ]);
  let semanticCalls = 0;
  const semanticProvider: Provider = {
    async chat(messages) {
      budget.enterLogicalCall();
      budget.enterHttpAttempt();
      semanticCalls += 1;
      if (semanticCalls === 1) {
        return { content: "SECRET_FORMAL_PRIMARY_MALFORMED_RESPONSE" };
      }
      const user = messages.find((message) => message.role === "user")?.content ?? "{}";
      const payload = JSON.parse(user) as { requiredItemIds: string[] };
      return {
        content: JSON.stringify({
          items: payload.requiredItemIds.map((itemId) => ({
            itemId,
            dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map((dimension) => ({
              id: dimension.id,
              score: 80,
              reason: `bounded evidence for ${dimension.id}`,
            })),
            overallReason: "bounded semantic fixture",
          })),
        }),
      };
    },
  };
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `formal recovery lane ${index}`, skillMd: childSkills[index] }),
    budget,
  );
  const { proposer: repairProposer } = scriptedRepairProposer(
    (_skillMd, index) => ({ hypothesis: `must remain unused ${index}`, skillMd: `# unused recovery repair ${index}` }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    scoreRuns: async ({ contract: frozenContract, runs, recovery }) => applyContractGates({
      contract: frozenContract,
      runs: [...runs],
      semanticJudgements: await createPublicSemanticBatchJudge({
        provider: semanticProvider,
        recovery,
      })(runs),
    }),
    mutationProposer: proposer,
    repairProposer,
    budget,
    maxInFlight: 2,
    stopOnPublicGoal: true,
  });

  assert.ok(
    ["public_goal_met", "stagnation_stop", "generations_completed"].includes(result.stopReason),
    `formal recovery must complete a legitimate two-generation terminal state, got ${result.stopReason}`,
  );
  assert.equal(result.generations.length, 2);
  assert.equal(contexts.length, 4);
  assert.ok(contexts.every((context) => context.recovery !== undefined));
  assert.ok(semanticCalls > 1, "the valid schema-repair response must be consumed after the malformed primary");
  assert.equal(result.actualApplicationRecoveryAttempts, 1);
  assert.equal(result.structureRecoveryDiagnostics?.length, 1);
  assert.equal(result.structureRecoveryDiagnostics?.[0].failureCode, "SEMANTIC_JUDGE_INVALID_JSON");
  assert.deepEqual(Object.keys(result.structureRecoveryDiagnostics?.[0] ?? {}), [
    "subject", "attempt", "failureCode", "findingCodes", "responseLength", "finishReason", "responseSha256",
  ]);
  assert.doesNotMatch(JSON.stringify(result.structureRecoveryDiagnostics), /SECRET_FORMAL_PRIMARY|rawResponse|holdout/i);
});

test("budget exhaustion stops the run with a structured reason and a resubmission suggestion", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ testMaxLogicalCalls: 6 });
  const budget = new RunCallBudget({ maxLogicalCalls: 6, maxRetryAttempts: 1 });

  const anchorMd = "# B0 anchor";
  const seedMd = "# S0 seed";
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, ALL_GOOD],
    [seedMd, ALL_GOOD],
  ]);
  const { proposer } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `mutation ${index}`, skillMd: `# mutated ${index}` }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });

  assert.equal(result.stopReason, "budget_exhausted");
  assert.ok(["refine", "mutate", "rebuild"].includes(result.recoverySuggestion ?? ""));
  assert.match(result.stopDetail, /6/);
  assert.equal(result.accounting.logicalCalls, 6, "the run stops exactly at the cap, never beyond");
  assert.ok(result.generations.length === 0 || result.generations[0].route !== "refine_elite");
});

test("current standard does not spend targeted repair before the mandatory mutation generation", async () => {
  const contract = {
    ...makeContract(),
    u1ContractVersion: "v2" as const,
    adapterId: "reference-v1",
    trainItemIds: ["d1", "d2", "d3"],
    selectItemIds: ["d4"],
  } as EvaluationContractV3;
  contract.contractSha256 = evaluationContractContentSha256(contract);
  const items = publicItemsOf(4);
  items[0] = {
    ...items[0],
    input: "PUBLIC_TRAIN_FAILURE_VISIBLE",
    taskVerifier: {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [{
        ruleId: "digest-required",
        kind: "output_field",
        field: "digest",
        valueType: "string",
        effect: "quality",
        dimension: "output_structure",
        weight: 1,
      }],
    },
  };
  items[3] = { ...items[3], input: "PUBLIC_SELECT_MUST_NOT_REACH_REPAIR" };
  const policy = policyOf({
    maxGenerations: 2,
    maxRefinementsPerCandidate: 1,
    earlyRepair: "force",
  });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# B0 repair no-change";
  const repair = scriptedRepairProposer((skillMd) => ({
    hypothesis: "the repair evidence does not justify changing the parent",
    decision: "no_change",
    appliedEdits: 0,
    skillMd,
  }), budget);
  const mutation = scriptedMutationProposer((context, index) => ({
    hypothesis: `mutation lane ${index} also has no justified edit`,
    decision: "no_change",
    appliedEdits: 0,
    skillMd: context.eliteSkillMd,
  }), budget);

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    runner: scriptedRunner(new Map([
      [anchorMd, (item) => (item.itemId === "d1" ? brokenTranscript(item) : ALL_GOOD(item))],
    ]), budget),
    scoreRuns: async ({ runs }) => ({
      publicScore: 75,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: true },
        { gateId: "judging-rule-pass", category: "quality", passed: false },
      ],
      itemScores: runs.map((run) => {
        const failed = run.item.itemId === "d1";
        return {
          itemId: run.item.itemId,
          split: "public" as const,
          score: failed ? 0 : 100,
          passed: !failed,
          criticalFailure: false,
          evidence: {
            deterministic: {
              passed: !failed,
              hardGateFailures: failed ? ["terminal-final"] : [],
              hardSafetyFailures: [],
              hardContractFailures: failed ? ["terminal-final"] : [],
              qualityFailures: failed ? ["digest-required"] : [],
              ruleResults: [{
                ruleId: "digest-required",
                kind: "output_field",
                passed: !failed,
                effect: "quality",
                failureCode: failed ? "TASK_VERIFIER_OUTPUT_FIELD_MISSING" : undefined,
              }],
            },
            semantic: {
              semanticStatus: failed ? "skipped_non_final" : "evaluated",
              dimensions: [{ id: "output_structure", score: failed ? 0 : 100, reason: "bounded structure evidence" }],
              weightedScore: failed ? 0 : 100,
              overallReason: "bounded semantic evidence",
            },
          } as unknown as ContractItemScore["evidence"],
        };
      }),
    }),
    mutationProposer: mutation.proposer,
    repairProposer: repair.proposer,
    budget,
  });

  assert.equal(repair.calls.length, 0);
  assert.equal(mutation.contexts.length, 2);
  assert.equal(result.stopReason, "no_valid_child");
  assert.equal(result.events.filter((event) => event.type === "repair_no_change").length, 0);
  assert.equal(result.events.filter((event) => event.type === "mutation_lane_no_change").length, 2);
  assert.equal(result.generations[0].childrenGenerated, 0);
  assert.equal(result.generations[0].childrenNoChange, 2);
  assert.equal(result.candidates.every((candidate) => candidate.generation === 0), true);
});

test("runAdaptive fails closed when refinements are possible but no repair proposer is wired", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ maxRefinementsPerCandidate: 1, earlyRepair: "auto" });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const behaviors = new Map<string, ItemBehavior>([["# B0 anchor", FAIL_NON_NEGATIVE]]);
  const { proposer } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `mutation ${index}`, skillMd: `# mutated ${index}` }),
    budget,
  );

  await assert.rejects(
    runAdaptive({
      policy,
      contract,
      taskCard: CARD,
      publicItems: items,
      anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: "# B0 anchor" },
      runner: scriptedRunner(behaviors, budget),
      mutationProposer: proposer,
      budget,
    }),
    (e: unknown) => e instanceof AdaptiveRunError && e.code === "ADAPTIVE_RUN_REPAIR_PROPOSER_REQUIRED",
  );
});

test("two candidate-local proposal failures stop as no_valid_child with both lanes recorded", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf();
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });

  const anchorMd = "# B0 anchor";
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, FAIL_NON_NEGATIVE],
    ["# S0 seed", (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
  ]);
  const proposer: LiveMutationProposer = {
    producer: { kind: "provider", name: "scripted-mutation" },
    async proposeMutation() {
      budget.enterLogicalCall();
      throw new LiveProposalError(
        "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
        "LIVE_MUTATION_U1_BOUNDARY_VIOLATION: inherited tooling",
      );
    },
  };

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: "# S0 seed" }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.match(result.stopDetail, /no edit child|no_change/i);
  assert.ok(result.candidates.every((candidate) => candidate.childKind === null), "no child was created");
  assert.equal(result.generations[0].childrenAttempted, 2);
  assert.equal(result.generations[0].childrenGenerated, 0);
  assert.equal(result.generations[0].childrenRejected, 2);
  assert.deepEqual(
    result.generations[0].lanes.map((lane) => [lane.kind, lane.status, lane.failureCode]),
    [
      ["exploit", "candidate_rejected", "LIVE_MUTATION_U1_BOUNDARY_VIOLATION"],
      ["diversify", "candidate_rejected", "LIVE_MUTATION_U1_BOUNDARY_VIOLATION"],
    ],
  );
});

async function runOneRejectedMutationLane(rejectedKind: "exploit" | "diversify") {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# B0 anchor";
  const seedMd = "# S0 seed";
  const validMd = `# valid ${rejectedKind === "exploit" ? "diversify" : "exploit"}`;
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, FAIL_NON_NEGATIVE],
    [seedMd, (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
    [validMd, ALL_GOOD],
  ]);
  let calls = 0;
  const proposer: LiveMutationProposer = {
    producer: { kind: "provider", name: "scripted-mutation" },
    async proposeMutation() {
      budget.enterLogicalCall();
      const kind = calls === 0 ? "exploit" : "diversify";
      calls += 1;
      if (kind === rejectedKind) {
        throw new LiveProposalError(
          "LIVE_PROPOSAL_INVALID_JSON",
          "LIVE_PROPOSAL_INVALID_JSON: candidate-local malformed JSON",
        );
      }
      return { hypothesis: `valid ${kind}`, skillMd: validMd };
    },
  };
  return runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: seedMd }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });
}

for (const rejectedKind of ["exploit", "diversify"] as const) {
  test(`candidate-local ${rejectedKind} rejection does not discard its valid sibling`, async () => {
    const result = await runOneRejectedMutationLane(rejectedKind);
    const ledger = result.generations[0];
    assert.notEqual(result.stopReason, "proposer_failure");
    assert.equal(ledger.childrenAttempted, 2);
    assert.equal(ledger.childrenGenerated, 1);
    assert.equal(ledger.childrenRejected, 1);
    assert.equal(ledger.childrenScreened, 1);
    assert.equal(ledger.childrenPromoted, 1);
    assert.equal(ledger.childrenEvaluated, 1, "a rejected proposal is never scored as zero");
    assert.ok(result.candidates.some((candidate) => candidate.skillMd.startsWith("# valid")));
    assert.equal(result.candidates.some((candidate) => candidate.candidateId === `g1-${rejectedKind}`), false);
    assert.equal(ledger.lanes.find((lane) => lane.kind === rejectedKind)?.status, "candidate_rejected");
    assert.equal(
      ledger.lanes.find((lane) => lane.kind !== rejectedKind)?.status,
      "evaluated",
    );
  });
}

test("provider failure in either mutation lane remains run-fatal", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const behaviors = new Map<string, ItemBehavior>([
    ["# B0 anchor", FAIL_NON_NEGATIVE],
    ["# S0 seed", (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
  ]);
  let calls = 0;
  const proposer: LiveMutationProposer = {
    producer: { kind: "provider", name: "scripted-mutation" },
    async proposeMutation() {
      budget.enterLogicalCall();
      calls += 1;
      if (calls === 1) {
        throw new LiveProposalError(
          "LIVE_MUTATION_PROVIDER_FAILED",
          "LIVE_MUTATION_PROVIDER_FAILED: HTTP transport failed",
        );
      }
      return { hypothesis: "sibling already in flight", skillMd: "# sibling" };
    },
  };
  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: "# B0 anchor" },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: "# S0 seed" }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });
  assert.equal(result.stopReason, "proposer_failure");
  assert.ok(result.generations[0].lanes.some((lane) => lane.status === "provider_failed"));
  assert.equal(result.candidates.some((candidate) => candidate.skillMd === "# sibling"), false);
});

test("budget failure in a mutation lane remains run-fatal", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const behaviors = new Map<string, ItemBehavior>([
    ["# B0 anchor", FAIL_NON_NEGATIVE],
    ["# S0 seed", (item) => (item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item))],
  ]);
  const proposer: LiveMutationProposer = {
    producer: { kind: "provider", name: "scripted-mutation" },
    async proposeMutation() {
      throw new ProviderBudgetError("logical_calls", budget.caps, "mutation");
    },
  };
  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: "# B0 anchor" },
    seeds: [{ candidateId: "s0-seed", originRoot: "s0", skillMd: "# S0 seed" }],
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });
  assert.equal(result.stopReason, "budget_exhausted");
  assert.ok(result.generations[0].lanes.every((lane) => lane.status === "budget_failed"));
});

test("budget routing stops before the first generation when the cap is already spent", async () => {
  const contract = makeContract();
  const items = publicItemsOf(2);
  const policy = policyOf({ testMaxLogicalCalls: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: 2, maxRetryAttempts: 1 });
  // Spend the entire run budget inside the initial evaluation on purpose.
  const behaviors = new Map<string, ItemBehavior>([["# B0 anchor", ALL_GOOD]]);
  const { proposer, contexts } = scriptedMutationProposer(
    (_context, index) => ({ hypothesis: `mutation ${index}`, skillMd: `# mutated ${index}` }),
    budget,
  );

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: "# B0 anchor" },
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
  });

  // 2 items consumed the cap exactly: the routing loop must stop, not throw.
  assert.equal(result.accounting.logicalCalls, 2);
  assert.equal(contexts.length, 0);
  assert.ok(
    result.stopReason === "budget_exhausted" || result.stopReason === "generations_completed",
    `unexpected stop ${result.stopReason}`,
  );
  if (result.stopReason === "budget_exhausted") {
    assert.ok(result.recoverySuggestion);
  }
  assert.ok(!(ProviderBudgetError && false));
});

test("runAdaptive forwards each recorded stage event to an observer in the same order", async () => {
  const contract = makeContract();
  const items = publicItemsOf(4);
  const policy = policyOf({ maxGenerations: 2 });
  const budget = new RunCallBudget({ maxLogicalCalls: policy.maxLogicalCalls, maxRetryAttempts: 1 });
  const anchorMd = "# B0 observer anchor";
  const behaviors = new Map<string, ItemBehavior>([
    [anchorMd, FAIL_NON_NEGATIVE],
    ["# observer exploit", ALL_GOOD],
    ["# observer diversify", ALL_GOOD],
  ]);
  const { proposer } = scriptedMutationProposer(
    (_context, index) => ({
      hypothesis: `observer mutation ${index}`,
      skillMd: index === 0 ? "# observer exploit" : "# observer diversify",
    }),
    budget,
  );
  const observed: string[] = [];

  const result = await runAdaptive({
    policy,
    contract,
    taskCard: CARD,
    publicItems: items,
    anchor: { candidateId: "b0-anchor", originRoot: "b0", skillMd: anchorMd },
    runner: scriptedRunner(behaviors, budget),
    mutationProposer: proposer,
    budget,
    onEvent: (event: { type: string }) => observed.push(event.type),
  } as Parameters<typeof runAdaptive>[0]);

  assert.deepEqual(observed, result.events.map((event) => event.type));
  assert.equal(observed[0], "run_start");
  assert.ok(observed.includes("generation_start"));
  assert.equal(observed.at(-1), "run_end");
  const generationEnd = result.events.find((event) => event.type === "generation_end");
  assert.equal(generationEnd?.completedGenerationSlots, 1);
  assert.equal(generationEnd?.minGenerationSlotsSatisfied, false);
});
