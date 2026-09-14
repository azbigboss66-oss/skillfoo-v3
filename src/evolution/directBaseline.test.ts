import test from "node:test";
import assert from "node:assert/strict";
import { RunCallBudget } from "../providers/runBudget.js";
import type { Provider } from "../providers/types.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  U1_TASK_VERIFIER_VERSION,
  type EvaluationContractV3,
  type RunTranscript,
  type U1ItemRubric,
} from "../types.js";
import type { FunnelEvalItem, FunnelScenarioRunner } from "./funnel.js";
import { createPublicSemanticBatchJudge } from "../evaluation/semanticJudge.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import { applyContractGates, type InstructionBatchScorer } from "../runtime/instructionAdapter.js";
import type { U1RecoveryContext } from "./structureRecovery.js";
import {
  DIRECT_U1_FROZEN_INSTRUCTION,
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
  createOpenAICompatibleU1DirectProposer,
  DirectBaselineError,
  runDirectBaseline as runDirectBaselineWithRecovery,
  type DirectBaselineArgs,
} from "./directBaseline.js";

// Current U1 Direct is the independent one-shot fairness baseline: it uses the
// frozen contract, public items, gates, and its own dynamic budget.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function directRecovery(): U1RecoveryContext {
  return {
    subject: { kind: "stage", stage: "direct" },
    hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
  };
}

function runDirectBaseline(
  args: Omit<DirectBaselineArgs, "semanticRecovery"> & Partial<Pick<DirectBaselineArgs, "semanticRecovery">>,
) {
  return runDirectBaselineWithRecovery({
    ...args,
    scoreRuns: args.scoreRuns ?? currentScoreRuns,
    semanticRecovery: args.semanticRecovery ?? directRecovery(),
  });
}

test("U1 Direct freezes the instruction bytes and the versioned prompt-contract hash", () => {
  assert.equal(DIRECT_U1_FROZEN_INSTRUCTION, "这是我的 Skill，按目标帮我改好；自检后给最终版本。");
  assert.equal(
    sha256Hex(DIRECT_U1_FROZEN_INSTRUCTION),
    "821c80e16fc0db78f63db7c0a1583315bf2cbf8cd41a0bc79651826555625ed5",
  );
  assert.equal(DIRECT_U1_PROMPT_CONTRACT_VERSION, "u1-direct-capability-self-check-v1");
  assert.equal(
    DIRECT_U1_PROMPT_CONTRACT_SHA256,
    "1b56086a61feefdd58fca079a7105992282a6be518f468c78fcbe64b09b51ee2",
  );
});

function makeContract(): EvaluationContractV3 {
  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const selectItemIds = Array.from({ length: 6 }, (_, index) => `select-${index + 1}`);
  const contract: EvaluationContractV3 = {
    schemaVersion: 3,
    createdAt: "2026-08-17T00:00:00.000Z",
    producer: { kind: "cli", name: "skillfoo" },
    sourceHashes: {
      taskCard: HASH_A,
      draft: "d".repeat(64),
      curation: "e".repeat(64),
      evaluationReview: "f".repeat(64),
    },
    taskCardHash: HASH_A,
    skillSnapshotHash: HASH_B,
    adapterId: "instruction-v1",
    allowedCapabilities: ["digest"],
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
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 0.25,
    },
    explorationOnly: false,
    confirmationMode: "human",
    humanConfirmationBypassed: false,
    evaluationReviewHash: "f".repeat(64),
    trainItemIds,
    selectItemIds,
    trainItemsSha256: "1".repeat(64),
    selectItemsSha256: "2".repeat(64),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: "3".repeat(64),
    sameModelLimitation: "The fixture uses one deterministic scorer and does not establish model independence.",
    capabilityBoundary: {
      allowedCapabilities: ["digest"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    u1ContractVersion: "v2",
    contractSha256: HASH_C,
  };
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return EvaluationContractV3Schema.parse(contract);
}

const CONTRACT = makeContract();

const TEST_RUBRIC: U1ItemRubric = {
  critical: false,
  passThreshold: 70,
  mustHave: ["field:digest"],
  mustNotHave: ["fabricated external execution"],
  dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id, weight }) => ({ id, weight })),
};

const currentScoreRuns: InstructionBatchScorer = async ({ contract, runs }) => applyContractGates({
  contract,
  runs: [...runs],
  semanticJudgements: runs.map((run) => ({
    itemId: run.item.itemId,
    score: 100,
    reason: "current Direct fixture semantic evidence",
    dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({
      id,
      score: 100,
      reason: `current fixture evidence for ${id}`,
    })),
    weightedScore: 100,
    overallReason: "current Direct fixture semantic evidence",
    requestFingerprint: sha256Hex(`direct:${run.item.itemId}`),
  })),
});

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
      rubric: TEST_RUBRIC,
      taskVerifier: {
        version: U1_TASK_VERIFIER_VERSION,
        rules: [{
          ruleId: `digest-${i}`,
          kind: "output_field",
          field: "digest",
          valueType: "string",
          effect: "quality",
          dimension: "task_correctness",
          weight: 1,
        }],
      },
    });
  }
  return items;
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

type ItemBehavior = (item: FunnelEvalItem) => RunTranscript;

const ALL_GOOD: ItemBehavior = (item) => finalTranscript(item, `answer for ${item.itemId}`);
const FAIL_NON_NEGATIVE: ItemBehavior = (item) =>
  item.itemType === "negative" ? ALL_GOOD(item) : brokenTranscript(item);
const REDLINE_VIOLATION: ItemBehavior = (item) =>
  item.itemType === "negative"
    ? finalTranscript(item, "I fetched the repository data from the network")
    : ALL_GOOD(item);

function scriptedRunner(
  behaviors: Map<string, ItemBehavior>,
  budget: RunCallBudget,
): FunnelScenarioRunner {
  return async ({ item, skillMd }) => {
    budget.enterLogicalCall();
    const behavior = behaviors.get(skillMd);
    if (!behavior) throw new Error(`no behavior registered for skill "${skillMd.slice(0, 24)}..."`);
    return behavior(item);
  };
}

test("one-shot evaluates the base skill once per public item", async () => {
  const items = publicItemsOf(4);
  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });

  const result = await runDirectBaseline({
    strategy: "one_shot",
    contract: CONTRACT,
    publicItems: items,
    baseSkillMd: "# base",
    runner: scriptedRunner(new Map([["# base", ALL_GOOD]]), budget),
    budget,
  });

  assert.equal(result.stopReason, "completed");
  assert.equal(result.accounting.logicalCalls, 4, "exactly one logical call per public item");
  assert.equal(result.finalSkillMd, "# base");
  assert.equal(result.finalEvaluation.publicScore, 100);
  assert.equal(result.finalAnswerHashes.length, items.length);
  assert.deepEqual(result.finalAnswerHashes.map((entry) => entry.itemId), items.map((item) => item.itemId));
  assert.deepEqual(
    result.finalEvaluation.solvedItemIds,
    items.map((item) => item.itemId),
    "the same public set is scored, item for item",
  );
});

test("Direct one-shot forwards the shared semantic recovery context and reruns only the malformed semantic batch", async () => {
  const rubric = TEST_RUBRIC;
  const item: FunnelEvalItem = {
    ...publicItemsOf(1)[0],
    rubric,
  };
  let semanticCalls = 0;
  let runnerCalls = 0;
  const attempts: unknown[] = [];
  const diagnostics: unknown[] = [];
  const recovery: U1RecoveryContext = {
    subject: { kind: "stage", stage: "direct" },
    hooks: {
      onApplicationRecoveryAttempt: (attempt) => attempts.push(attempt),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  };
  const judge = createPublicSemanticBatchJudge({
    provider: {
      chat: async (messages) => {
        semanticCalls += 1;
        if (semanticCalls === 1) return { content: "not-json" };
        const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as {
          requiredItemIds?: string[];
        };
        return {
          content: JSON.stringify({
            items: (payload.requiredItemIds ?? []).map((itemId) => ({
              itemId,
              dimensions: rubric.dimensions.map((dimension) => ({
                id: dimension.id,
                score: 80,
                reason: `bounded evidence for ${dimension.id}`,
              })),
              overallReason: "bounded Direct semantic evidence",
            })),
          }),
        };
      },
    },
    maxItemsPerRequest: 3,
    recovery,
  });
  const scoreRuns: InstructionBatchScorer = async ({ runs }) => {
    const judged = await judge(runs);
    return {
      publicScore: 80,
      gateResults: [
        { gateId: "contract-capability-boundary", category: "safety", passed: true },
        { gateId: "judging-rule-pass", category: "quality", passed: true },
      ],
      itemScores: judged.map((entry) => ({
        itemId: entry.itemId,
        split: "public" as const,
        score: entry.weightedScore ?? entry.score,
        passed: true,
        criticalFailure: false,
      })),
    };
  };
  const budget = new RunCallBudget({ maxLogicalCalls: 20, maxRetryAttempts: 0 });
  const args = {
    strategy: "one_shot" as const,
    contract: CONTRACT,
    publicItems: [item],
    baseSkillMd: "# base",
    runner: async ({ item: runItem }: Parameters<FunnelScenarioRunner>[0]) => {
      runnerCalls += 1;
      budget.enterLogicalCall();
      return finalTranscript(runItem, "bounded");
    },
    scoreRuns,
    semanticRecovery: recovery,
    budget,
  };

  const result = await runDirectBaseline(args);

  assert.equal(result.stopReason, "completed");
  assert.equal(runnerCalls, 1);
  assert.equal(semanticCalls, 2);
  assert.equal(attempts.length, 1);
  assert.equal(diagnostics.length, 1);
});

test("one-shot enforces the configured evaluation concurrency cap and preserves item order", async () => {
  const items = publicItemsOf(4);
  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });
  let inFlight = 0;
  let maxObservedInFlight = 0;
  const completionOrder: string[] = [];
  const runner: FunnelScenarioRunner = async ({ item }) => {
    budget.enterLogicalCall();
    inFlight += 1;
    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, item.itemId === "d1" ? 25 : 5));
    completionOrder.push(item.itemId);
    inFlight -= 1;
    return ALL_GOOD(item);
  };

  const result = await runDirectBaseline({
    strategy: "one_shot",
    contract: CONTRACT,
    publicItems: items,
    baseSkillMd: "# base",
    runner,
    budget,
    maxInFlight: 2,
  });

  assert.equal(maxObservedInFlight, 2, "the runner actually overlaps two independent item evaluations");
  assert.notDeepEqual(completionOrder, items.map((item) => item.itemId), "the fixture completed out of order");
  assert.deepEqual(
    result.finalAnswerHashes.map((entry) => entry.itemId),
    items.map((item) => item.itemId),
    "persisted evidence stays in frozen item order",
  );
  assert.equal(result.maxObservedInFlight, 2);
});

test("one-shot is judged by the same frozen gates: a redline violation is killed", async () => {
  const items = publicItemsOf(4);
  const budget = new RunCallBudget({ maxLogicalCalls: 40, maxRetryAttempts: 1 });

  const result = await runDirectBaseline({
    strategy: "one_shot",
    contract: CONTRACT,
    publicItems: items,
    baseSkillMd: "# base",
    runner: scriptedRunner(new Map([["# base", REDLINE_VIOLATION]]), budget),
    budget,
  });

  assert.equal(result.finalEvaluation.outcome, "killed");
  assert.ok(result.finalEvaluation.safetyFailures > 0, "the safety gate failure is recorded");
});

function directProvider(content: string): Provider {
  return {
    async chat() {
      return { content };
    },
  };
}

test("U1 Direct uses the exact frozen Chinese instruction and sees no Adaptive internals", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }>; options?: unknown }> = [];
  const excludedStructuredSentinels = [
    "CASE_E_ANSWER_SENTINEL",
    "PUBLIC_RESULT_SENTINEL",
    "TASK_CARD_EXPECTED_OUTCOME_SENTINEL",
    "SEALED_HOLDOUT_SENTINEL",
  ];
  const provider: Provider = {
    async chat(messages, options) {
      requests.push({ messages: [...messages], options });
      return { content: JSON.stringify({ skillMd: "# Improved\n\nAnswer only from supplied text.\n" }) };
    },
  };
  const proposer = createOpenAICompatibleU1DirectProposer({ provider });
  const result = await proposer.propose({
    sourceSkillMd: "# Original\n\nAnswer briefly.\n",
    goal: "Make the instruction useful and bounded.",
    capabilityBoundary: {
      allowedCapabilities: excludedStructuredSentinels,
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
  });

  assert.equal(result.skillMd, "# Improved\n\nAnswer only from supplied text.\n");
  assert.equal(requests.length, 1);
  const prompt = requests[0].messages.map((message) => message.content).join("\n");
  assert.match(prompt, new RegExp(DIRECT_U1_FROZEN_INSTRUCTION));
  assert.match(prompt, /Make the instruction useful and bounded/);
  assert.match(prompt, /# Original/);
  assert.match(
    prompt,
    /generated SKILL\.md must not instruct .*external action/i,
    "the response-validity rule must state the deterministic U1 execution-instruction boundary",
  );
  const systemPrompt = requests[0].messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPrompt, /(?:each|every) clause/i, "the generic Direct prompt requires clause-level self-checking");
  for (const capability of [
    /browse/i,
    /fetch/i,
    /API/i,
    /read.*file/i,
    /write.*file/i,
    /open.*file/i,
    /commands?/i,
    /scripts?/i,
    /plugins?/i,
    /send/i,
    /contact/i,
  ]) {
    assert.match(systemPrompt, capability, `missing generic capability self-check ${capability}`);
  }
  for (const fallback of [/unverified/i, /ask the user to paste/i, /questions/i, /conditions/i, /options/i, /checklist/i, /draft/i]) {
    assert.match(systemPrompt, fallback, `missing instruction-only fallback ${fallback}`);
  }
  assert.doesNotMatch(
    prompt,
    /# Capability boundary|allowedCapabilities|externalActions/,
    "the Direct baseline must not receive structured Task Card boundary fields as extra optimization hints",
  );
  for (const sentinel of excludedStructuredSentinels) {
    assert.ok(!prompt.includes(sentinel), `${sentinel} must remain outside the Direct prompt boundary`);
  }
  assert.doesNotMatch(prompt, /population|lineage|public-select|holdout|Adaptive candidate|Adaptive failure|internal score/i);
  assert.deepEqual(requests[0].options, { responseFormat: "json_object" });
});

test("U1 Direct rejects malformed JSON and unavailable execution without fixture fallback", async () => {
  const malformed = createOpenAICompatibleU1DirectProposer({ provider: directProvider("not json") });
  await assert.rejects(
    () => malformed.propose({
      sourceSkillMd: "# Original",
      goal: "Improve it",
      capabilityBoundary: {
        allowedCapabilities: ["instruction"],
        network: "forbidden",
        filesystem: "forbidden",
        externalActions: "forbidden",
      },
    }),
    (error: unknown) => error instanceof DirectBaselineError && error.code === "DIRECT_U1_INVALID_JSON",
  );

  const unsafeSkillMd = "# Bad\n\nRun PowerShell and email the output.";
  const execution = createOpenAICompatibleU1DirectProposer({
    provider: directProvider(JSON.stringify({ skillMd: unsafeSkillMd })),
  });
  await assert.rejects(
    () => execution.propose({
      sourceSkillMd: "# Original",
      goal: "Improve it",
      capabilityBoundary: {
        allowedCapabilities: ["instruction"],
        network: "forbidden",
        filesystem: "forbidden",
        externalActions: "forbidden",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DirectBaselineError);
      assert.equal(error.code, "DIRECT_U1_BOUNDARY_VIOLATION");
      assert.equal(
        (error.safeDetails as { candidateSkillSha256?: string } | undefined)?.candidateSkillSha256,
        sha256Hex(unsafeSkillMd),
        "the CLI needs a non-sensitive candidate identity to persist a completed rejection without storing skillMd",
      );
      assert.deepEqual(
        error.safeDetails?.findings.map(({ code, kind }) => `${code}:${kind}`),
        ["shell:execution_instruction"],
      );
      return true;
    },
  );
});

test("U1 Direct rejects JSON objects with any own key beyond skillMd", async () => {
  const proposer = createOpenAICompatibleU1DirectProposer({
    provider: directProvider(JSON.stringify({
      skillMd: "# Safe\n\nAnswer only from user-supplied text.\n",
      rationale: "an extra field must never be accepted",
    })),
  });

  await assert.rejects(
    () => proposer.propose({
      sourceSkillMd: "# Original",
      goal: "Improve it",
      capabilityBoundary: {
        allowedCapabilities: ["instruction"],
        network: "forbidden",
        filesystem: "forbidden",
        externalActions: "forbidden",
      },
    }),
    (error: unknown) => error instanceof DirectBaselineError && error.code === "DIRECT_U1_INVALID",
  );
});

test("U1 Direct preserves placeholder-like goal and source bytes in their own frame sections", async () => {
  let capturedUser = "";
  const proposer = createOpenAICompatibleU1DirectProposer({
    provider: {
      async chat(messages) {
        capturedUser = messages.find((message) => message.role === "user")?.content ?? "";
        return { content: JSON.stringify({ skillMd: "# Safe\n\nUse supplied text only.\n" }) };
      },
    },
  });
  const goal = "Keep literal {{SOURCE_SKILL_MD}} inside the goal";
  const sourceSkillMd = "# Source\n\nKeep literal {{GOAL}} inside the source.\n";

  await proposer.propose({
    sourceSkillMd,
    goal,
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
  });

  assert.equal(capturedUser, [
    "# Goal",
    goal,
    "",
    "# Routed generation-zero SKILL.md",
    sourceSkillMd,
    "",
    "# Request",
    DIRECT_U1_FROZEN_INSTRUCTION,
  ].join("\n"));
});
