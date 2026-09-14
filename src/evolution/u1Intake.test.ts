import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { RunCallBudget, createBudgetedProvider } from "../providers/runBudget.js";
import type { Provider } from "../providers/types.js";
import {
  createLiveMutationProposer,
  promptCardFactsOf,
} from "../bootstrap/liveBootstrapProposer.js";
import { getAdapterDeclaration } from "../runtime/adapterRegistry.js";
import {
  applyContractGates,
  createInstructionAdapter,
  INSTRUCTION_ADAPTER_ID,
  runInstructionScenario,
} from "../runtime/instructionAdapter.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type AdapterContext,
} from "../runtime/capabilityAdapter.js";
import {
  DEFAULT_U1_SCORING_PROFILE,
  EvaluationContractV3Schema,
  TaskCardSchema,
  U1_TASK_VERIFIER_VERSION,
  type EvaluationContractV3,
  type TaskCard,
  type U1ItemRubric,
} from "../types.js";
import { taskCardContentSha256 } from "../intake/taskCard.js";
import { evaluationContractContentSha256 } from "../evalFactory/freezeContract.js";
import {
  diagnoseU1BoundaryCommitments,
  U1IntakeError,
  decideU1Intake,
  materializeS0RebuildTrack,
  sanitizedCategoryLines,
  stripCardQuotes,
} from "./u1Intake.js";

// ── P1 任务 4 Red→Green：U1 intake 先分车道，坏 B0 不直接喂给 live proposer ──
//
// T22 根因 4 的修复证据：intake 决策是纯静态的（零 Provider、零网络、
// 零工具执行），good 源走 eligible_b0_repair，medium/poor 源因为有 legacy
// U1 违规承诺被冻结为证据、只走 requires_s0_rebuild——live prompt 只看到
// Task Card 生成的 S0 脚手架 + 冻结卡片 + 去敏失败类别，绝看不到带工具/
// 网络/脚本承诺的原文；S0 车道仍能形成严格 JSON 候选并被 public evaluator
// 打分。全部 mock，零真实请求。

type SuiteCaseId = "good" | "medium" | "poor";

const FIXTURE_SKILLS: Record<SuiteCaseId, string> = {
  good: [
    "# Source-grounded bulletin briefing",
    "Use only bulletin text supplied by the user.",
    "Return a concise summary, relevance, evidence gaps, and next steps.",
  ].join("\n"),
  medium: [
    "# Ranked bulletin briefing",
    "Run scripts/fixture_rank.py and scripts/fixture_compare.py before writing the briefing.",
    "Return a concise summary and ranking.",
  ].join("\n"),
  poor: [
    "# Automated bulletin monitor",
    "自动扫描 https://bulletins.example.test 和 https://archive.example.test。",
    "每天推送至样例收件箱。",
  ].join("\n"),
};

function currentTaskCard(): TaskCard {
  const draft = TaskCardSchema.parse({
    schemaVersion: 3,
    createdAt: "2026-08-30T00:00:00.000Z",
    producer: { kind: "fixture", name: "u1-intake-current" },
    sourceHashes: { intakeInput: "a".repeat(64) },
    goal: "Create a trustworthy briefing from bulletin text supplied by the user.",
    goalSha256: "b".repeat(64),
    intentStatus: "complete",
    answeredDimensions: [
      "goal_and_intended_user",
      "inputs_and_evidence",
      "output_and_format",
      "capability_boundary_and_redlines",
      "success_criteria_and_protected_behavior",
    ],
    unresolvedDimensions: [],
    clarifications: [],
    intentDetails: {
      goal_and_intended_user: "Help an analyst create a source-grounded bulletin briefing.",
      inputs_and_evidence: "Use only bulletin text supplied in the request.",
      output_and_format: "Return summary, relevance, evidence gaps, and next steps.",
      capability_boundary_and_redlines: "Do not browse, execute scripts, or send messages.",
      success_criteria_and_protected_behavior: "Preserve source attribution and explicit unknowns.",
    },
    scenarios: [
      { id: "s1", userRequest: "Summarize the supplied bulletin.", expectedOutcome: "A sourced briefing with unknowns." },
      { id: "s2", userRequest: "Rank two supplied bulletin excerpts.", expectedOutcome: "A justified source-bound ranking." },
    ],
    redlines: ["Never fabricate bulletin facts.", "Never claim external execution."],
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
    confirmation: { status: "draft" },
  });
  return TaskCardSchema.parse({
    ...draft,
    confirmation: {
      status: "confirmed",
      confirmedBy: "u1-intake-current-fixture",
      confirmedAt: "2026-08-30T00:01:00.000Z",
      confirmationMode: "test-fixture",
      confirmedContentSha256: taskCardContentSha256(draft),
    },
  });
}

function suiteCase(caseId: SuiteCaseId): {
  skillMd: string;
  taskCard: TaskCard;
  contract: EvaluationContractV3;
} {
  const taskCard = currentTaskCard();
  const taskCardHash = taskCardContentSha256(taskCard);
  const trainItemIds = Array.from({ length: 8 }, (_, index) => `train-${index + 1}`);
  const selectItemIds = Array.from({ length: 6 }, (_, index) => `select-${index + 1}`);
  const contract: EvaluationContractV3 = {
    schemaVersion: 3,
    createdAt: "2026-08-30T00:02:00.000Z",
    producer: { kind: "fixture", name: "u1-intake-current" },
    sourceHashes: {
      taskCard: taskCardHash,
      draft: "d".repeat(64),
      curation: "e".repeat(64),
      evaluationReview: "f".repeat(64),
    },
    taskCardHash,
    skillSnapshotHash: "c".repeat(64),
    adapterId: "instruction-v1",
    allowedCapabilities: ["instruction"],
    publicScenarioIds: ["s1", "s2"],
    holdoutScenarioIds: ["h1", "h2", "h3"],
    safetyGates: [
      { gateId: "contract-capability-boundary", description: "Keep the frozen capability boundary." },
      { gateId: "redline-hold", description: "Keep the confirmed red lines." },
    ],
    qualityGates: [
      { gateId: "judging-rule-pass", description: "Satisfy the public judging rule." },
      { gateId: "public-absolute-floor", description: "Meet the frozen public score floor." },
    ],
    goalConfidence: { level: "high", score: 80, reasons: ["confirmed fixture goal"] },
    evalConfidence: { level: "medium", score: 65, reasons: ["offline contract fixture"] },
    generation: {
      generator: { kind: "fixture", name: "u1-intake-current" },
      curator: { kind: "fixture", name: "u1-intake-current-curator" },
      generatorCuratorIsolation: "independent",
    },
    thresholds: { absoluteFloor: 60, confidenceFloor: 60 },
    scoringProfile: DEFAULT_U1_SCORING_PROFILE,
    splitPolicy: {
      targetHoldoutRatio: 0.2,
      minHoldoutItems: 3,
      maxRatioDeviation: 0.15,
      actualHoldoutRatio: 3 / 17,
    },
    explorationOnly: false,
    confirmationMode: "test-fixture",
    humanConfirmationBypassed: false,
    evaluationReviewHash: "f".repeat(64),
    trainItemIds,
    selectItemIds,
    trainItemsSha256: "1".repeat(64),
    selectItemsSha256: "2".repeat(64),
    calibrationMinAdjacentGap: 10,
    calibrationTripletSha256: "3".repeat(64),
    sameModelLimitation: "The fixture is deterministic zero-network evidence and does not establish model independence.",
    capabilityBoundary: {
      allowedCapabilities: ["instruction"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    u1ContractVersion: "v2",
    contractSha256: "d".repeat(64),
  };
  contract.contractSha256 = evaluationContractContentSha256(contract);
  return {
    skillMd: FIXTURE_SKILLS[caseId],
    taskCard,
    contract: EvaluationContractV3Schema.parse(contract),
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── 1. 纯静态分车道决策 ────────────────────────────────────────────

test("good source (no legacy commitments) routes to eligible_b0_repair", async () => {
  const { skillMd, taskCard } = await suiteCase("good");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  assert.equal(decision.lane, "eligible_b0_repair");
  assert.equal(decision.violationCategories.length, 0);
  assert.equal(decision.b0EvidenceSha256, sha256Hex(skillMd));
  assert.ok(decision.reasons.length > 0);
});

test("medium source (script_exec commitments) routes to requires_s0_rebuild with sanitized reasons", async () => {
  const { skillMd, taskCard } = await suiteCase("medium");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  assert.equal(decision.lane, "requires_s0_rebuild");
  assert.ok(decision.violationCategories.some((entry) => entry.kind === "script_exec"));
  const joined = [...decision.reasons, ...decision.violationCategories.map((c) => c.label)].join(" ");
  assert.ok(joined.includes("script_exec"), "the reason cites the discovered boundary category");
  assert.ok(!joined.includes("fixture_rank.py"), "no original violation text leaks into the decision");
  assert.ok(!joined.includes("fixture_compare.py"));
});

test("poor source (network + external_push commitments) routes to requires_s0_rebuild", async () => {
  const { skillMd, taskCard } = await suiteCase("poor");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  assert.equal(decision.lane, "requires_s0_rebuild");
  const kinds = decision.violationCategories.map((entry) => entry.kind);
  assert.ok(kinds.includes("network"));
  assert.ok(kinds.includes("external_push"));
  const joined = [...decision.reasons, ...decision.violationCategories.map((c) => c.label)].join(" ");
  assert.ok(!joined.includes("bulletins.example.test"));
  assert.ok(!joined.includes("推送至样例收件箱"));
});

test("an empty B0 and a non-U1 task card are both blocked with explicit reasons", async () => {
  const { taskCard } = await suiteCase("good");
  const empty = decideU1Intake({ b0SkillMd: "   \n  ", taskCard });
  assert.equal(empty.lane, "blocked");
  assert.ok(empty.reasons.length > 0);

  const widened = {
    ...JSON.parse(JSON.stringify(taskCard)),
    capabilityBoundary: { ...taskCard.capabilityBoundary, network: "allowed" as const },
  };
  const blocked = decideU1Intake({ b0SkillMd: "# plain skill", taskCard: widened });
  assert.equal(blocked.lane, "blocked");
  assert.match(blocked.reasons.join("; "), /network/);
});

test("reference-v1 accepts forbidden or controlled external actions while wider boundaries stay blocked", async () => {
  const { taskCard } = await suiteCase("good");
  const referenceCard = TaskCardSchema.parse({
    ...JSON.parse(JSON.stringify(taskCard)),
    capabilityBoundary: {
      allowedCapabilities: ["reference"],
      network: "forbidden",
      filesystem: "controlled",
      externalActions: "controlled",
    },
  });
  const decide = (adapterId: string, card = referenceCard) => decideU1Intake({
    b0SkillMd: "# Reference-only ROI analyst\n\nRead only declared logical ids and never execute commands.",
    taskCard: card,
    adapterId,
  } as Parameters<typeof decideU1Intake>[0] & { adapterId: string });

  assert.equal(decide("reference-v1").lane, "eligible_b0_repair");
  assert.equal(decide("reference-v1", TaskCardSchema.parse({
    ...JSON.parse(JSON.stringify(referenceCard)),
    capabilityBoundary: { ...referenceCard.capabilityBoundary, externalActions: "forbidden" },
  })).lane, "eligible_b0_repair");
  assert.equal(decide("instruction-v1").lane, "blocked");
  assert.equal(decide("unknown-v1").lane, "blocked");
  assert.equal(decide("reference-v1", TaskCardSchema.parse({
    ...JSON.parse(JSON.stringify(referenceCard)),
    capabilityBoundary: { ...referenceCard.capabilityBoundary, externalActions: "allowed" },
  })).lane, "blocked");
  assert.equal(decide("reference-v1", TaskCardSchema.parse({
    ...JSON.parse(JSON.stringify(referenceCard)),
    capabilityBoundary: { ...referenceCard.capabilityBoundary, network: "allowed" },
  })).lane, "blocked");
  assert.equal(decide("reference-v1", TaskCardSchema.parse({
    ...JSON.parse(JSON.stringify(referenceCard)),
    capabilityBoundary: {
      ...referenceCard.capabilityBoundary,
      allowedCapabilities: ["reference", "instruction"],
    },
  })).lane, "blocked");
  assert.equal(decideU1Intake({
    b0SkillMd: "# Instruction-only analyst\n\nAnswer from supplied evidence.",
    taskCard,
    adapterId: "instruction-v1",
  }).lane, "eligible_b0_repair");
});

// ── 2. S0 重构车道的物化（复用 createScaffold，冻结 B0 仅作证据）─────

test("the poor case materializes a clean deterministic S0 rebuild track with sanitized categories", async () => {
  const { skillMd, taskCard, contract } = await suiteCase("poor");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  const adapter = getAdapterDeclaration(INSTRUCTION_ADAPTER_ID)!;
  const track = materializeS0RebuildTrack({ decision, taskCard, contract, adapter });

  assert.equal(track.track, "s0-rebuild");
  assert.ok(track.s0SkillMd.length > 0);
  assert.equal(track.s0SkillSha256, sha256Hex(track.s0SkillMd));
  assert.equal(track.b0EvidenceSha256, sha256Hex(skillMd), "the original B0 stays frozen as evidence");
  assert.equal(
    diagnoseU1BoundaryCommitments(stripCardQuotes(track.s0SkillMd, taskCard)).hasU1Violations,
    false,
    "the scaffold's own voice (frozen-card quotes stripped) carries no legacy U1 commitment",
  );
  assert.ok(!track.s0SkillMd.includes("bulletins.example.test"));
  assert.ok(!track.s0SkillMd.includes("archive.example.test"));
  assert.ok(!track.s0SkillMd.includes("scripts/"));

  const lines = sanitizedCategoryLines(track.violationCategories);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(!line.includes("bulletins.example.test") && !line.includes("推送至样例收件箱") && !line.includes("scripts/"));
  }

  const again = materializeS0RebuildTrack({ decision, taskCard, contract, adapter });
  assert.equal(again.s0SkillMd, track.s0SkillMd, "scaffolding is deterministic");
});

test("materializeS0RebuildTrack refuses a non-rebuild lane decision", async () => {
  const { skillMd, taskCard, contract } = await suiteCase("good");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  assert.throws(
    () =>
      materializeS0RebuildTrack({
        decision,
        taskCard,
        contract,
        adapter: getAdapterDeclaration(INSTRUCTION_ADAPTER_ID)!,
      }),
    (err: unknown) => {
      assert.ok(err instanceof U1IntakeError);
      assert.match(err.code, /U1_INTAKE_NOT_REBUILD_LANE/);
      return true;
    },
  );
});

// ── 3. live 消息干净 + 严格 JSON 子代 + public evaluator 打分（mock）──

interface CapturedRequest {
  body: Record<string, unknown>;
}

function mockFetchBodies(responses: Array<{ body: unknown }>): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse((init?.body as string) ?? "null") as Record<string, unknown> });
    const next = queue.shift() ?? { body: {} };
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: 200 }));
  }) as typeof fetch;
  (mockFetchBodies as unknown as { _restore?: () => void })._restore = () => {
    globalThis.fetch = originalFetch;
  };
  return { requests };
}

test.afterEach(() => {
  const restore = (mockFetchBodies as unknown as { _restore?: () => void })._restore;
  if (restore) restore();
});

function mutationProvider(): Provider {
  const budget = new RunCallBudget({ maxLogicalCalls: 5, maxRetryAttempts: 0 });
  return createBudgetedProvider(
    new OpenAICompatibleProvider(
      {
        apiKey: "test-key",
        authMode: "bearer",
        baseUrl: "https://api.deepseek.com",
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-v4-flash",
        requestProfile: {
          preset: "deepseek",
          jsonMode: "json_object",
          reasoningMode: "thinking-disabled",
          maxTokensField: "max_tokens",
        },
      },
      8000,
      { budget, role: "mutation", maxRetries: 0, maxOutputTokens: 3000 },
    ),
    budget,
    "mutation",
  );
}

function okCompletion(content: string): { choices: Array<{ message: { content: string }; finish_reason: string }> } {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

const CURRENT_PUBLIC_RUBRIC: U1ItemRubric = {
  critical: false,
  passThreshold: 60,
  mustHave: ["field:summary", "field:relevance"],
  mustNotHave: ["fabricated external execution"],
  dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id, weight }) => ({ id, weight })),
};

test("the rebuild lane feeds live proposers S0 + sanitized categories only, and the strict-JSON child scores under the public evaluator", async () => {
  const { skillMd, taskCard, contract } = await suiteCase("poor");
  const decision = decideU1Intake({ b0SkillMd: skillMd, taskCard });
  const track = materializeS0RebuildTrack({
    decision,
    taskCard,
    contract,
    adapter: getAdapterDeclaration(INSTRUCTION_ADAPTER_ID)!,
  });

  const editAnchor = "## Workflow and output";
  const boundedAddition = [
    "",
    "### Bulletin briefing specialization",
    "",
    "- Use only bulletin text pasted by the user.",
    "- Return summary, relevance, and reasons in one structured response.",
    "- State that automatic scanning and external push remain out of scope.",
  ].join("\n");
  const childSkillMd = track.s0SkillMd.replace(editAnchor, `${editAnchor}${boundedAddition}`);
  const { requests } = mockFetchBodies([
    { body: okCompletion(JSON.stringify({
      hypothesis: "specialize the card-derived S0 for pasted bulletin text",
      decision: "edit",
      edits: [{
        op: "insert_after",
        path: "SKILL.md",
        anchor: editAnchor,
        text: boundedAddition,
      }],
    })) },
  ]);
  const proposer = createLiveMutationProposer({ provider: mutationProvider() });
  const proposal = await proposer.proposeMutation({
    eliteSkillMd: track.s0SkillMd,
    diversitySkillMd: `${track.s0SkillMd}\n## Alternative phrasing\nAnswer tersely, one key per line.`,
    failureClasses: sanitizedCategoryLines(track.violationCategories),
    lanePurpose: "repair_incompatible_b0",
    taskCard: promptCardFactsOf(taskCard, { requireComplete: false }),
    contract,
  });

  assert.equal(proposal.decision, "edit");
  assert.equal(proposal.appliedEdits, 1);
  assert.equal(proposal.skillMd, childSkillMd, "the strict-JSON bounded edit applies to the frozen S0 parent");
  assert.notEqual(proposal.skillMd, track.s0SkillMd);

  const messages = requests
    .flatMap((request) => (Array.isArray(request.body.messages) ? (request.body.messages as Array<{ content: string }>) : []))
    .map((message) => message.content)
    .join("\n");
  for (const forbidden of ["bulletins.example.test", "archive.example.test", "自动扫描样例公告站", "推送至样例收件箱", "fixture_rank.py", "fixture_compare.py"]) {
    assert.ok(!messages.includes(forbidden), `the live prompt must not carry the original violation text (${forbidden})`);
  }
  assert.ok(messages.includes("network") || messages.includes("external_push"), "sanitized categories do reach the prompt");
  assert.ok(messages.includes("# Skill:"), "the S0 scaffold (card-derived) is the parent text");

  const adapter = createInstructionAdapter({
    policy: { adapterId: INSTRUCTION_ADAPTER_ID, allowedTools: [], maxToolCalls: 2, networkMode: "fixture", lockedPaths: [] },
  });
  const adapterContext: AdapterContext = {
    mode: "record",
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowNetwork: false,
  };
  // One attempted tool call first: U1 must answer it with a controlled refusal,
  // never an execution — even on the rebuild lane.
  const scripted: Provider = {
    chat: (() => {
      let call = 0;
      return async () => {
        call += 1;
        if (call === 1) {
          return {
            content: JSON.stringify({ type: "tool_call", tool: "fetch", args: { url: "http://example.invalid" } }),
          };
        }
        return { content: JSON.stringify({ type: "final", answer: { summary: "briefing", relevance: "high" } }) };
      };
    })(),
  };

  const runs = [];
  for (const scenario of taskCard.scenarios) {
    const transcript = await runInstructionScenario({
      provider: scripted,
      skillMarkdown: proposal.skillMd,
      outputContract: `Answer with a JSON object satisfying the frozen judging rule: the answer must satisfy the scenario outcome: ${scenario.expectedOutcome}`,
      scenario: { id: scenario.id, userPrompt: scenario.userRequest, maxToolCalls: 2 },
      snapshotId: "u1-intake-test",
      adapter,
      adapterContext,
    });
    assert.ok(
      transcript.toolEvents.every((event) => !event.success),
      "U1 still forbids tool execution: every attempted call is a controlled refusal",
    );
    runs.push({
      item: {
        itemId: `${scenario.id}-public`,
        split: "public" as const,
        itemType: "trigger",
        rubric: CURRENT_PUBLIC_RUBRIC,
        taskVerifier: {
          version: U1_TASK_VERIFIER_VERSION,
          rules: [
            {
              ruleId: `${scenario.id}-summary`,
              kind: "output_field" as const,
              field: "summary",
              valueType: "string" as const,
              effect: "quality" as const,
              dimension: "output_structure" as const,
              weight: 1,
            },
            {
              ruleId: `${scenario.id}-relevance`,
              kind: "output_field" as const,
              field: "relevance",
              valueType: "string" as const,
              effect: "quality" as const,
              dimension: "task_correctness" as const,
              weight: 1,
            },
          ],
        },
      },
      transcript,
    });
  }

  const scored = applyContractGates({
    contract,
    runs,
    semanticJudgements: runs.map((run) => ({
      itemId: run.item.itemId,
      score: 100,
      reason: "current fixture semantic evidence",
      dimensions: DEFAULT_U1_SCORING_PROFILE.dimensions.map(({ id }) => ({
        id,
        score: 100,
        reason: `current fixture evidence for ${id}`,
      })),
      weightedScore: 100,
      overallReason: "current fixture semantic evidence",
      requestFingerprint: sha256Hex(`u1-intake:${run.item.itemId}`),
    })),
  });
  assert.equal(typeof scored.publicScore, "number");
  assert.equal(scored.publicScore, 100, "the S0-lane child finalizes on every public item");
  assert.ok(scored.gateResults.every((gate) => gate.passed), "all frozen contract gates pass");
});
