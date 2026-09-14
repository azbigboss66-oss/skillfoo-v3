import test from "node:test";
import assert from "node:assert/strict";
import { RunCallBudget } from "../providers/runBudget.js";
import type { Provider, ProviderMessage, ProviderRequestOptions, ProviderResponse } from "../providers/types.js";
import { createLiveMutationProposer } from "../bootstrap/liveBootstrapProposer.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  U1_TASK_VERIFIER_VERSION,
  type TaskCard,
  type EvaluationContractV3,
  type RunTranscript,
} from "../types.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import type { InstructionBatchScorer } from "../runtime/instructionAdapter.js";
import { parseAdaptivePolicy, type AdaptivePolicyParams } from "./adaptivePolicy.js";
import { calculateCallEnvelope, calculateScenarioCallAuthorization } from "../providers/stageBudgets.js";
import { createOpenAICompatibleRepairProposer } from "./repairProposerProvider.js";
import {
  runDirectBaseline as runDirectBaselineWithRecovery,
  type DirectBaselineArgs,
} from "./directBaseline.js";
import { runAdaptive as runAdaptiveMainline } from "./adaptiveRun.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";

// ── Current U1 fake-provider end-to-end over the real proposer factories ──
//
// Nine scenarios driven through a fake chat provider that (a) bills the
// shared RunCallBudget exactly like the live wiring and (b) captures every
// outbound message, so the harness can prove the sealed audit split never
// reaches a generation or repair request. The proposers are the production
// factories (frontier-repair / targeted-mutation);
// only the transport is fake:
//   1 local repair      2 structural mutation  3 root rebuild
//   4 stagnation        5 budget exhaustion    6 bad JSON fail-closed
//   7 no fixture fallback                     8 audit isolation (+ suite assets)
//   9 direct baseline fairness
// Scenario 6 is the deliberate Red: RepairFrontierError must land as a
// structured proposer_failure, never rethrow out of the adaptive loop.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const AUDIT_SCENARIO_IDS = ["sealed-a1", "sealed-a2", "sealed-a3"];
const AUDIT_MARKERS = ["SEALED_AUDIT_MARKER_ONE", "SEALED_AUDIT_MARKER_TWO", "SEALED_AUDIT_MARKER_THREE"];

const currentScoreRuns: InstructionBatchScorer = async ({ runs }) => {
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
      { gateId: "contract-capability-boundary", category: "safety", passed: true },
      { gateId: "redline-hold", category: "safety", passed: true },
      { gateId: "judging-rule-pass", category: "quality", passed: complete },
      { gateId: "public-absolute-floor", category: "quality", passed: publicScore >= 60 },
    ],
  };
};

function runAdaptive(args: Parameters<typeof runAdaptiveMainline>[0]) {
  return runAdaptiveMainline({
    ...args,
    scoreRuns: args.scoreRuns ?? currentScoreRuns,
  });
}

function runDirectBaseline(args: Omit<DirectBaselineArgs, "semanticRecovery" | "scoreRuns">) {
  return runDirectBaselineWithRecovery({
    ...args,
    scoreRuns: currentScoreRuns,
    semanticRecovery: {
      subject: { kind: "stage", stage: "direct" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
}

type FakeTurn = string | Error;

/** Fake transport: bills the budget, records every request, replays queued turns. */
class FakeChatProvider implements Provider {
  readonly calls: Array<{ messages: ProviderMessage[]; options?: ProviderRequestOptions }> = [];
  private readonly turns: FakeTurn[];

  constructor(turns: FakeTurn[], private readonly budget: RunCallBudget) {
    this.turns = [...turns];
  }

  setContext(_scenarioId: string, _snapshotId: string): void {}

  async chat(messages: ProviderMessage[], options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.budget.enterLogicalCall();
    this.calls.push({ messages, options });
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("FAKE_PROVIDER_QUEUE_EXHAUSTED: scripted turns ran out");
    }
    if (turn instanceof Error) {
      throw turn;
    }
    return { content: turn, promptTokens: 12, completionTokens: 34 };
  }
}

function assertNoAuditLeak(provider: FakeChatProvider, extraMarkers: string[] = []): void {
  assert.ok(provider.calls.length > 0, "the leak assertion needs at least one captured provider call");
  const markers = [...AUDIT_SCENARIO_IDS, ...AUDIT_MARKERS, ...extraMarkers];
  for (const call of provider.calls) {
    const wire = JSON.stringify(call.messages);
    for (const marker of markers) {
      assert.ok(!wire.includes(marker), `audit content "${marker}" leaked into a provider request`);
    }
  }
}

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
    holdoutScenarioIds: AUDIT_SCENARIO_IDS,
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
      targetHoldoutRatio: 0.4,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 0.43,
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
    contractSha256: HASH_C,
  };
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return EvaluationContractV3Schema.parse(contract);
}

const CARD = {
  goal: "produce a weekly repository digest from user-provided context",
  redlines: ["never fabricate repository facts", "never claim execution"],
  capabilityBoundary: {
    allowedCapabilities: ["instruction"],
    network: "forbidden",
    filesystem: "forbidden",
    externalActions: "forbidden",
  },
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

function publicItemsOf(): FunnelEvalItem[] {
  const rows = [
    { itemId: "d1", scenarioId: "s1", itemType: "trigger" },
    { itemId: "d2", scenarioId: "s2", itemType: "near-miss" },
    { itemId: "d3", scenarioId: "s1", itemType: "negative" },
    { itemId: "d4", scenarioId: "s2", itemType: "trigger" },
  ];
  return rows.map((row, index) => ({
    itemId: row.itemId,
    scenarioId: row.scenarioId,
    split: "public" as const,
    itemType: row.itemType,
    input: `user prompt ${index + 1}`,
    judgingRule: `the answer must address prompt ${index + 1} with a digest`,
    ...(row.itemType === "negative" ? { redlineRefs: ["never claim execution"] } : {}),
    rubric: {
      critical: row.itemType === "negative",
      passThreshold: 70,
      mustHave: ["field:digest"],
      mustNotHave: ["I fetched"],
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id, weight }) => ({ id, weight })),
    },
    taskVerifier: {
      version: U1_TASK_VERIFIER_VERSION,
      rules: [{
        ruleId: `digest-${row.itemId}`,
        kind: "output_field" as const,
        field: "digest",
        valueType: "string" as const,
        effect: "quality" as const,
        dimension: "task_correctness" as const,
        weight: 1,
      }],
    },
  }));
}

const ANCHOR_MD = [
  "# repository digest skill",
  "Produce a weekly digest strictly from the repository context the user provides.",
  "- summarize the merged pull requests",
  "- list the release notes",
  "Output a markdown digest with a limitations line.",
].join("\n");

const REPAIRED_MD = [
  "# repository digest skill (repaired)",
  "Produce a weekly digest strictly from the repository context the user provides.",
  "- summarize the merged pull requests",
  "- list the release notes",
  "- always close with an explicit limitations paragraph",
  "Output a markdown digest with a limitations line.",
].join("\n");

const STALL_MD = `${ANCHOR_MD}\n(stalled variant: identical behavior, no measurable progress)`;

const MUTATION_A_MD = [
  "# repository digest skill (exploit mutation)",
  "Keep the digest core and tighten the pull-request summary into a table.",
  "- summarize the merged pull requests in a table",
  "- list the release notes",
  "Output a markdown digest with a limitations line.",
].join("\n");

const MUTATION_B_MD = [
  "# repository digest skill (diversify mutation)",
  "An alternative structure: lead with release notes, then pull requests.",
  "- list the release notes first",
  "- summarize the merged pull requests second",
  "Output a markdown digest with a limitations line.",
].join("\n");

const SEED_MD = [
  "# repository digest skill (seed alternative)",
  "A second root: digest via per-author sections instead of chronology.",
  "- group merged pull requests by author",
  "- list the release notes",
  "Output a markdown digest with a limitations line.",
].join("\n");

type ItemBehavior = (item: FunnelEvalItem) => RunTranscript;

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

const ALL_GOOD: ItemBehavior = (item) => finalTranscript(item, `answer for ${item.itemId}`);
const FAIL_D1_ONLY: ItemBehavior = (item) => (item.itemId === "d1" ? brokenTranscript(item) : ALL_GOOD(item));
const FAIL_D1_D2: ItemBehavior = (item) =>
  item.itemId === "d1" || item.itemId === "d2" ? brokenTranscript(item) : ALL_GOOD(item);
// The negative redline probe (d3) must stay GOOD: a broken redline probe is a
// SAFETY kill, and the root-rebuild scenario needs both roots safe_non_elite
// sharing the same unsolved core {d2, d4}.
const SOLVE_D1_D3_ONLY: ItemBehavior = (item) =>
  item.itemId === "d1" || item.itemId === "d3" ? ALL_GOOD(item) : brokenTranscript(item);
const MUTATION_B_BEHAVIOR: ItemBehavior = (item) => (item.itemId === "d4" ? brokenTranscript(item) : ALL_GOOD(item));

function runnerWith(behaviors: Map<string, ItemBehavior>, budget: RunCallBudget): FunnelScenarioRunner {
  return async ({ item, skillMd }) => {
    budget.enterLogicalCall();
    const behavior = behaviors.get(skillMd);
    if (!behavior) {
      throw new Error(`no behavior registered for skill "${skillMd.slice(0, 24)}..."`);
    }
    return behavior(item);
  };
}

function policyOf(overrides: Partial<AdaptivePolicyParams> & { testMaxLogicalCalls?: number } = {}) {
  const { testMaxLogicalCalls = 60, ...policyOverrides } = overrides;
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

function boundedEditJson(hypothesis: string, parentSkillMd: string, skillMd: string): string {
  let prefix = 0;
  while (
    prefix < parentSkillMd.length &&
    prefix < skillMd.length &&
    parentSkillMd[prefix] === skillMd[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < parentSkillMd.length - prefix &&
    suffix < skillMd.length - prefix &&
    parentSkillMd[parentSkillMd.length - 1 - suffix] === skillMd[skillMd.length - 1 - suffix]
  ) suffix += 1;

  const oldText = parentSkillMd.slice(prefix, parentSkillMd.length - suffix);
  const newText = skillMd.slice(prefix, skillMd.length - suffix);
  const edit = oldText.length === 0
    ? { op: "insert_after", anchor: parentSkillMd.slice(0, prefix), text: newText }
    : newText.length === 0
      ? { op: "delete_exact", oldText }
      : { op: "replace_exact", oldText, newText };
  return JSON.stringify({ hypothesis, decision: "edit", edits: [edit] });
}

const repairJson = (parentSkillMd: string, skillMd: string): string =>
  boundedEditJson("repair the single failing item via explicit instructions", parentSkillMd, skillMd);
const mutationJson = (parentSkillMd: string, skillMd: string): string =>
  boundedEditJson("combine the working core with the alternative structure", parentSkillMd, skillMd);
const noChangeJson = JSON.stringify({
  hypothesis: "the current parent already expresses the bounded instruction",
  decision: "no_change",
});
// ── Scenario 1: local repair through the real frontier-repair factory ──

test("e2e 1 bounded exploit: the formal generation floor preserves a successful edit end to end", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([
    repairJson(ANCHOR_MD, REPAIRED_MD),
    ...Array<string>(6).fill(noChangeJson),
  ], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_ONLY],
    [REPAIRED_MD, ALL_GOOD],
  ]);

  const result = await runAdaptive({
    policy: policyOf({ maxRefinementsPerCandidate: 2, earlyRepair: "force" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    repairProposer: createOpenAICompatibleRepairProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.ok(result.finalElite);
  assert.equal(result.finalElite!.skillMd, REPAIRED_MD, "the repaired child must take the elite seat");
  const route = result.events.find((event) => event.type === "route_decision");
  assert.equal(route?.route, "targeted_mutation", "the formal two-generation floor continues after repair");

  assert.ok(provider.calls.length >= 3, "the repair call is followed by the required bounded generation slots");
  const repairRequest = provider.calls[0].messages.map((m) => m.content).join("\n");
  assert.match(repairRequest, /# Train failures \(maximum 6\)/, "the proposer receives bounded current train evidence");
  assert.ok(repairRequest.includes('"itemId":"d1"'), "the proposer receives the failing current item identity");
  assert.ok(repairRequest.includes(ANCHOR_MD), "the proposer carries the current SKILL.md");
  assert.ok(
    result.accounting.logicalCalls >= 6,
    "root evaluation (4) + repair call (1) + repaired-child evaluation (1) are all billed",
  );
  assertNoAuditLeak(provider);
});

// ── Scenario 2: structural mutation through the real mutation factory ──

test("e2e 2 structural mutation: two failure classes route to targeted mutation with lineage", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([
    mutationJson(ANCHOR_MD, MUTATION_A_MD),
    mutationJson(ANCHOR_MD, MUTATION_B_MD),
    noChangeJson,
    noChangeJson,
  ], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_D2],
    [MUTATION_A_MD, ALL_GOOD],
    [MUTATION_B_MD, MUTATION_B_BEHAVIOR],
  ]);

  const result = await runAdaptive({
    policy: policyOf({ earlyRepair: "off" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  const route = result.events.find((event) => event.type === "route_decision");
  assert.equal(route?.route, "targeted_mutation", "two distinct failure classes force the mutation lane");

  const exploit = result.candidates.find((c) => c.candidateId === "g1-exploit");
  const diversify = result.candidates.find((c) => c.candidateId === "g1-diversify");
  assert.ok(exploit && exploit.evaluation, "the exploit child was proposed and evaluated");
  assert.ok(diversify && diversify.evaluation, "the diversify child was proposed and evaluated");
  assert.equal(exploit!.parentCandidateId, "b0");
  assert.equal(diversify!.parentCandidateId, "b0");
  assert.equal(exploit!.skillMd, MUTATION_A_MD);
  assert.equal(diversify!.skillMd, MUTATION_B_MD);
  assert.equal(result.population.eliteId, "g1-exploit");

  assert.equal(provider.calls.length, 4);
  for (const call of provider.calls.slice(0, 2)) {
    const prompt = call.messages.map((m) => m.content).join("\n");
    assert.ok(prompt.includes(CARD.goal as string), "the frozen card goal binds every mutation");
    assert.ok(prompt.includes("never fabricate repository facts"), "the frozen redlines are injected");
    assert.match(prompt, /# Train failures \(maximum 6\)/, "the bounded public-train section is present");
    assert.ok(
      prompt.includes('"itemId":"d1"') && prompt.includes('"input":"user prompt 1"'),
      "the structured public-train item identity and public input are present",
    );
    assert.doesNotMatch(prompt, /public-select|sealed|holdout|publicScenarioIds|holdoutScenarioIds/i);
  }
  assertNoAuditLeak(provider);
});

// ── Scenario 3: root rebuild on a shared core failure ──

test("e2e 3 incompatible roots: B0 remains immutable while both current lanes settle locally", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([noChangeJson, noChangeJson], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, SOLVE_D1_D3_ONLY],
    [SEED_MD, SOLVE_D1_D3_ONLY],
  ]);

  const result = await runAdaptive({
    policy: policyOf(),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    seeds: [{ candidateId: "s0", originRoot: "s0", skillMd: SEED_MD }],
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.ok(result.events.some((event) => event.type === "root_rebuild_derived_repair"));
  assert.equal(result.candidates.find((candidate) => candidate.candidateId === "b0")?.skillMd, ANCHOR_MD);
  assert.equal(provider.calls.length, 2, "the current repair/diversify lanes each settle once");
});

// ── Scenario 4: stagnation stop after a no-progress refinement ──

test("e2e 4 no progress: a stalled repair converges through a bounded no-change generation", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([
    repairJson(ANCHOR_MD, STALL_MD),
    ...Array<string>(6).fill(noChangeJson),
  ], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_ONLY],
    [STALL_MD, FAIL_D1_ONLY],
  ]);

  const result = await runAdaptive({
    policy: policyOf({
      maxGenerations: 2,
      maxRefinementsPerCandidate: 2,
      stagnationPatience: 1,
      earlyRepair: "force",
    }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    repairProposer: createOpenAICompatibleRepairProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.match(result.stopDetail, /no_change/);
  assert.equal(result.generations.length, 2);
  assert.equal(result.generations[0].route, "targeted_mutation");
  assertNoAuditLeak(provider);
});

// ── Scenario 5: mid-refinement budget exhaustion ──

test("e2e 5 budget: exhausting the shared budget mid-refinement stops with a resubmission suggestion", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([repairJson(ANCHOR_MD, REPAIRED_MD)], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_ONLY],
    [REPAIRED_MD, ALL_GOOD],
  ]);

  const result = await runAdaptive({
    policy: policyOf({ maxRefinementsPerCandidate: 2, earlyRepair: "force" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    repairProposer: createOpenAICompatibleRepairProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "budget_exhausted");
  assert.match(result.stopDetail, /run cap/);
  assert.ok(result.recoverySuggestion, "a budget stop carries a resubmission suggestion");
  assert.equal(result.accounting.logicalCalls, 5, "4 root evaluations + 1 repair call exactly exhaust the cap");
  assert.ok(result.events.some((event) => event.type === "budget_exhausted"));
});

// ── Scenario 6: bad JSON fails closed (Red→Green: RepairFrontierError must not rethrow) ──

test("e2e 6 bad JSON: a malformed repair is localized and never admits a guessed child", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([
    "<not-json>{ definitely not json",
    "<still-not-json>{ definitely not json",
    noChangeJson,
    noChangeJson,
  ], budget);
  const behaviors = new Map<string, ItemBehavior>([[ANCHOR_MD, FAIL_D1_ONLY]]);

  const result = await runAdaptive({
    policy: policyOf({ maxRefinementsPerCandidate: 2, earlyRepair: "force" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    repairProposer: createOpenAICompatibleRepairProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.ok(
    result.candidates.every((candidate) => candidate.parentCandidateId === null),
    "no repair child may enter the pool after a malformed response",
  );
  assert.equal(provider.calls.length, 3, "one bounded repair recovery plus the surviving mutation lane");
  assertNoAuditLeak(provider);
});

// ── Scenario 7: no fixture fallback after a transport failure ──

test("e2e 7 no fallback: a transport failure in the mutation lane never substitutes a fixture candidate", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([new Error("HTTP 503 upstream unavailable")], budget);
  const behaviors = new Map<string, ItemBehavior>([[ANCHOR_MD, FAIL_D1_ONLY]]);

  const result = await runAdaptive({
    policy: policyOf({ earlyRepair: "off" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "proposer_failure");
  assert.match(result.stopDetail, /LIVE_MUTATION_PROVIDER_FAILED/);
  assert.equal(result.candidates.length, 1, "only the anchor root exists — no fixture child appeared");
  assert.equal(result.candidates[0].candidateId, "b0");
  assert.equal(provider.calls.length, 2, "both concurrent lanes may already be in flight before the fatal transport result settles");
  assert.equal(result.generations[0].childrenAttempted, 2);
  assert.ok(result.generations[0].lanes.some((lane) => lane.status === "provider_failed"));
});

// ── Scenario 8: audit isolation over a dual-proposer chain ──

test("e2e 8 audit isolation: no sealed audit content reaches any repair or mutation request", async () => {
  const budget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider(
    [
      repairJson(ANCHOR_MD, REPAIRED_MD),
      mutationJson(REPAIRED_MD, MUTATION_A_MD),
      mutationJson(ANCHOR_MD, MUTATION_B_MD),
    ],
    budget,
  );
  const behaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_ONLY],
    [REPAIRED_MD, ALL_GOOD],
    [MUTATION_A_MD, ALL_GOOD],
    [MUTATION_B_MD, MUTATION_B_BEHAVIOR],
  ]);

  const result = await runAdaptive({
    policy: policyOf({ maxGenerations: 2, maxRefinementsPerCandidate: 2, stagnationPatience: 3, earlyRepair: "force" }),
    contract: makeContract(),
    taskCard: CARD,
    publicItems: publicItemsOf(),
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: ANCHOR_MD },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    repairProposer: createOpenAICompatibleRepairProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.ok(result.candidates.length >= 2, "the chain actually ran multiple proposer turns");
  assert.ok(provider.calls.length >= 3, "repair + exploit + diversify turns were all issued");
  assertNoAuditLeak(provider);
});

// ── Scenario 9: current one-shot Direct baseline fairness ──

test("e2e 9 direct baseline: one_shot evaluates the independent candidate once on the frozen contract", async () => {
  const contract = makeContract();
  const items = publicItemsOf();
  const baseBehaviors = new Map<string, ItemBehavior>([
    [ANCHOR_MD, FAIL_D1_ONLY],
  ]);

  const oneShotBudget = new RunCallBudget({ maxLogicalCalls: 60, maxRetryAttempts: 1 });
  const oneShot = await runDirectBaseline({
    strategy: "one_shot",
    contract,
    publicItems: items,
    baseSkillMd: ANCHOR_MD,
    runner: runnerWith(baseBehaviors, oneShotBudget),
    budget: oneShotBudget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(oneShot.stopReason, "completed");
  assert.equal(oneShot.strategy, "one_shot");
  assert.equal(oneShot.finalSkillMd, ANCHOR_MD);
  assert.equal(oneShot.finalEvaluation.itemScores?.length, items.length);
  assert.equal(oneShot.finalEvaluation.gateResults.length, 4);
  assert.equal(oneShotBudget.accounting.logicalCalls, 4, "one_shot spends exactly the base evaluation");
});

// ── Scenario 8b: current in-file assets drive a real mutation round ──

test("e2e 8b current fixture: an instruction-only contract drives a mutation round with zero sealed leakage", async () => {
  const card = CARD;
  const contract = makeContract();
  const publicItems = publicItemsOf();
  const suiteMd = ANCHOR_MD;
  const mutatedA = MUTATION_A_MD;
  const mutatedB = MUTATION_B_MD;

  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });
  const provider = new FakeChatProvider([
    mutationJson(suiteMd, mutatedA),
    mutationJson(suiteMd, mutatedB),
    noChangeJson,
    noChangeJson,
  ], budget);
  const behaviors = new Map<string, ItemBehavior>([
    [suiteMd, ALL_GOOD],
    [mutatedA, ALL_GOOD],
    [mutatedB, ALL_GOOD],
  ]);

  const result = await runAdaptive({
    policy: policyOf({ earlyRepair: "off" }),
    contract,
    taskCard: card,
    publicItems,
    anchor: { candidateId: "b0", originRoot: "b0", skillMd: suiteMd },
    runner: runnerWith(behaviors, budget),
    mutationProposer: createLiveMutationProposer({ provider }),
    budget,
    now: () => "2026-08-17T00:00:00.000Z",
  });

  assert.equal(result.stopReason, "no_valid_child");
  assert.equal(provider.calls.length, 4);
  assertNoAuditLeak(provider);
  assert.ok(
    result.candidates.some((candidate) => candidate.skillMd === mutatedA),
    "the mutated child entered the pool from the current in-file root",
  );
});
