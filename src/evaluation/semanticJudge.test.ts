import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPublicSemanticBatchJudge,
  createSealedSemanticBatchJudge,
  SemanticJudgeError,
} from "./semanticJudge.js";
import type { Provider } from "../providers/types.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import type { InstructionGateInput } from "../runtime/instructionAdapter.js";
import type { U1ItemRubric } from "../types.js";
import type { U1RecoveryContext } from "../evolution/structureRecovery.js";

const u1Rubric: U1ItemRubric = {
  critical: true,
  passThreshold: 70,
  mustHave: ["states uncertainty"],
  mustNotHave: ["invented evidence"],
  dimensions: [
    { id: "task_correctness", weight: 0.35 },
    { id: "evidence_boundary", weight: 0.25 },
    { id: "capability_boundary", weight: 0.2 },
    { id: "output_structure", weight: 0.1 },
    { id: "actionability", weight: 0.1 },
  ],
};

const taskVerifier = {
  version: "u1-task-verifier-v3" as const,
  rules: [{
    ruleId: "summary-is-string",
    kind: "output_field" as const,
    field: "summary",
    valueType: "string" as const,
    effect: "quality" as const,
    dimension: "output_structure" as const,
    weight: 1,
  }],
};

const run: InstructionGateInput = {
  item: {
    itemId: "p1",
    scenarioId: "p1",
    split: "public",
    itemType: "trigger",
    input: "给客户做风险判断",
    judgingRule: "must identify uncertainty and ask for missing evidence",
    rubric: u1Rubric,
    taskVerifier,
  },
  transcript: { scenarioId: "p1", snapshotId: "s", toolEvents: [], rawFinalResponse: '{"type":"final","answer":{"summary":"可以"}}', parsedFinalAnswer: { summary: "可以" }, terminalReason: "final", turns: 1, durationMs: 1 },
};

const u1Run = run;

function rubricEntry(itemId = "p1") {
  return {
    itemId,
    dimensions: u1Rubric.dimensions.map((dimension) => ({
      id: dimension.id,
      score: 80,
      reason: `evidence for ${dimension.id}`,
    })),
    weightedScore: 80,
    overallReason: "meets the frozen rubric with bounded evidence",
  };
}

function adaptiveRecoveryContext(events?: {
  diagnostics?: unknown[];
  attempts?: unknown[];
}): U1RecoveryContext {
  return {
    subject: { kind: "candidate", generation: 1, lane: "exploit" },
    hooks: {
      onDiagnostic: (diagnostic) => events?.diagnostics?.push(diagnostic),
      onApplicationRecoveryAttempt: (attempt) => events?.attempts?.push(attempt),
    },
  };
}

function publicRuns(count: number): InstructionGateInput[] {
  return Array.from({ length: count }, (_, index): InstructionGateInput => ({
    ...u1Run,
    item: { ...u1Run.item, itemId: `p${index + 1}`, scenarioId: `p${index + 1}` },
    transcript: { ...u1Run.transcript, scenarioId: `p${index + 1}` },
  }));
}

function rubricResponseFor(messages: Parameters<Provider["chat"]>[0]): string {
  const userMessage = messages.find((message) => message.role === "user");
  const payload = JSON.parse(userMessage?.content ?? "{}") as { requiredItemIds?: string[] };
  return JSON.stringify({
    items: (payload.requiredItemIds ?? []).map((itemId) => rubricEntry(itemId)),
  });
}

function createTestPublicJudge(args: {
  provider: Provider;
  maxItemsPerRequest?: number;
}) {
  return createPublicSemanticBatchJudge({
    ...args,
    recovery: adaptiveRecoveryContext(),
  });
}

test("U1 semantic judge requires every frozen dimension and persists its request fingerprint", async () => {
  const provider: Provider = {
    chat: async () => ({ content: JSON.stringify({ items: [rubricEntry()] }) }),
  };
  const judged = await createTestPublicJudge({ provider })([u1Run]);
  assert.equal(judged[0].itemId, "p1");
  assert.equal(judged[0].weightedScore, 80);
  assert.equal(judged[0].dimensions?.length, 5);
  assert.match(judged[0].requestFingerprint ?? "", /^[0-9a-f]{64}$/);
});

test("U1-C non-final transcripts skip semantic Provider calls and preserve the terminal reason", async () => {
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      return { content: JSON.stringify({ items: [rubricEntry()] }) };
    },
  };
  const nonFinal: InstructionGateInput = {
    ...u1Run,
    transcript: {
      ...u1Run.transcript,
      parsedFinalAnswer: undefined,
      rawFinalResponse: "not-json",
      terminalReason: "invalid_json",
    },
  };

  const judged = await createTestPublicJudge({ provider })([nonFinal]);
  assert.equal(calls, 0);
  assert.equal((judged[0] as typeof judged[number] & { semanticStatus?: string }).semanticStatus, "skipped_non_final");
  assert.equal(judged[0].score, 0);
  assert.match(judged[0].reason, /invalid_json/);
});

test("U1-C mixed semantic batches judge only final parsed answers and restore original order", async () => {
  const runs = publicRuns(4);
  runs[0] = {
    ...runs[0],
    transcript: { ...runs[0].transcript, terminalReason: "invalid_json", parsedFinalAnswer: undefined },
  };
  runs[2] = {
    ...runs[2],
    transcript: { ...runs[2].transcript, terminalReason: "final", parsedFinalAnswer: undefined },
  };
  const requestedIds: string[][] = [];
  const provider: Provider = {
    chat: async (messages) => {
      const payload = JSON.parse(messages[1]?.content ?? "{}") as { requiredItemIds: string[] };
      requestedIds.push(payload.requiredItemIds);
      return { content: rubricResponseFor(messages) };
    },
  };

  const judged = await createTestPublicJudge({ provider })(runs);

  assert.deepEqual(requestedIds, [["p2", "p4"]]);
  assert.deepEqual(judged.map((entry) => entry.itemId), ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(
    judged.map((entry) => entry.semanticStatus ?? "evaluated"),
    ["skipped_non_final", "evaluated", "skipped_non_final", "evaluated"],
  );
  for (const index of [0, 2]) {
    assert.equal(judged[index].score, 0);
    assert.equal(judged[index].weightedScore, 0);
    assert.ok(judged[index].dimensions?.every((dimension) => dimension.score === 0));
    assert.equal(judged[index].requestFingerprint, undefined);
  }
});

test("U1 semantic judge computes the weighted score locally instead of trusting model arithmetic", async () => {
  const { weightedScore: _modelArithmetic, ...modelEvidence } = rubricEntry();
  let systemPrompt = "";
  const provider: Provider = {
    chat: async (messages) => {
      systemPrompt = messages[0]?.content ?? "";
      return { content: JSON.stringify({ items: [modelEvidence] }) };
    },
  };
  const judged = await createTestPublicJudge({ provider })([u1Run]);
  assert.equal(judged[0].weightedScore, 80);
  assert.doesNotMatch(systemPrompt, /weightedScore/);
});

test("U1 semantic judge rejects missing, duplicate, extra, or unknown dimension identities", async () => {
  const valid = rubricEntry();
  const cases = [
    { name: "missing", dimensions: valid.dimensions.slice(0, -1) },
    { name: "duplicate", dimensions: [...valid.dimensions.slice(0, -1), { ...valid.dimensions[4], id: "task_correctness" }] },
    { name: "extra", dimensions: [...valid.dimensions, { id: "invented_dimension", score: 80, reason: "invented" }] },
    { name: "case-changed", dimensions: valid.dimensions.map((entry, index) => index === 4 ? { ...entry, id: "Actionability" } : entry) },
    { name: "whitespace-changed", dimensions: valid.dimensions.map((entry, index) => index === 4 ? { ...entry, id: "actionability " } : entry) },
    { name: "invalid-id", dimensions: valid.dimensions.map((entry, index) => index === 4 ? { ...entry, id: 42 } : entry) },
  ];
  for (const entry of cases) {
    await assert.rejects(
      () => createTestPublicJudge({
        provider: {
          chat: async () => ({
            content: JSON.stringify({ items: [{ ...valid, dimensions: entry.dimensions }] }),
          }),
        },
      })([u1Run]),
      (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
      entry.name,
    );
  }
});

test("current semantic judge accepts an exact item identity set in any response order and restores frozen order", async () => {
  const second = {
    ...run,
    item: { ...run.item, itemId: "p2", scenarioId: "p2" },
    transcript: { ...run.transcript, scenarioId: "p2" },
  };
  const judged = await createTestPublicJudge({
    provider: {
      chat: async () => ({
        content: JSON.stringify({
          items: [
            rubricEntry("p2"),
            rubricEntry("p1"),
          ],
        }),
      }),
    },
  })([run, second]);

  assert.deepEqual(judged.map((entry) => entry.itemId), ["p1", "p2"]);
  assert.deepEqual(judged.map((entry) => entry.score), [80, 80]);
});

test("semantic judge rejects missing, duplicate, extra, case-changed, or whitespace-changed item identities", async () => {
  const second = {
    ...run,
    item: { ...run.item, itemId: "p2", scenarioId: "p2" },
    transcript: { ...run.transcript, scenarioId: "p2" },
  };
  const valid = {
    p1: rubricEntry("p1"),
    p2: rubricEntry("p2"),
  };
  const cases = [
    { name: "missing", items: [valid.p1] },
    { name: "duplicate", items: [valid.p1, valid.p1] },
    { name: "extra", items: [valid.p1, valid.p2, { itemId: "p3", score: 50, reason: "extra" }] },
    { name: "case-changed", items: [valid.p1, { ...valid.p2, itemId: "P2" }] },
    { name: "whitespace-changed", items: [valid.p1, { ...valid.p2, itemId: "p2 " }] },
    { name: "invalid-id", items: [valid.p1, { ...valid.p2, itemId: 42 }] },
  ];

  for (const entry of cases) {
    await assert.rejects(
      () => createTestPublicJudge({
        provider: { chat: async () => ({ content: JSON.stringify({ items: entry.items }) }) },
      })([run, second]),
      (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_ITEM_MISMATCH",
      entry.name,
    );
  }
});

test("semantic judge validates item identities against each frozen request chunk, not the whole run", async () => {
  const runs = publicRuns(4);
  let calls = 0;
  await assert.rejects(
    () => createTestPublicJudge({
      provider: {
        chat: async (messages) => {
          calls += 1;
          const payload = JSON.parse(messages[1]?.content ?? "{}") as { requiredItemIds: string[] };
          return {
            content: JSON.stringify({
              items: payload.requiredItemIds.map((itemId) => rubricEntry(calls >= 2 ? "p1" : itemId)),
            }),
          };
        },
      },
    })(runs),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_ITEM_MISMATCH",
  );
  assert.equal(calls, 3, "the malformed chunk receives exactly one schema-repair call");
});

test("U1 semantic judge binds item and dimension evidence by exact identity before applying frozen non-equal weights", async () => {
  const secondRubric: U1ItemRubric = {
    ...u1Rubric,
    dimensions: [
      { id: "actionability", weight: 0.5 },
      { id: "output_structure", weight: 0.2 },
      { id: "capability_boundary", weight: 0.1 },
      { id: "evidence_boundary", weight: 0.1 },
      { id: "task_correctness", weight: 0.1 },
    ],
  };
  const second: InstructionGateInput = {
    ...u1Run,
    item: { ...u1Run.item, itemId: "p2", scenarioId: "p2", rubric: secondRubric },
    transcript: { ...u1Run.transcript, scenarioId: "p2" },
  };
  const scoreById = {
    task_correctness: 10,
    evidence_boundary: 20,
    capability_boundary: 30,
    output_structure: 40,
    actionability: 50,
  } as const;
  const responseEntry = (itemId: string, dimensionOrder: readonly (keyof typeof scoreById)[]) => ({
    itemId,
    dimensions: dimensionOrder.map((id) => ({ id, score: scoreById[id], reason: `reason for ${id}` })),
    overallReason: `overall for ${itemId}`,
  });
  const judged = await createTestPublicJudge({
    provider: {
      chat: async () => ({
        content: JSON.stringify({
          items: [
            responseEntry("p2", ["task_correctness", "evidence_boundary", "capability_boundary", "output_structure", "actionability"]),
            responseEntry("p1", ["actionability", "output_structure", "capability_boundary", "evidence_boundary", "task_correctness"]),
          ],
        }),
      }),
    },
  })([u1Run, second]);

  assert.deepEqual(judged.map((entry) => entry.itemId), ["p1", "p2"]);
  assert.deepEqual(judged[0].dimensions?.map((entry) => entry.id), u1Rubric.dimensions.map((entry) => entry.id));
  assert.deepEqual(judged[1].dimensions?.map((entry) => entry.id), secondRubric.dimensions.map((entry) => entry.id));
  assert.equal(judged[0].weightedScore, 23.5);
  assert.equal(judged[1].weightedScore, 39);
});

test("U1 semantic request fingerprint binds the identity-set-v2 response semantics", async () => {
  let capturedMessages: Parameters<Provider["chat"]>[0] = [];
  const provider: Provider = {
    chat: async (messages) => {
      capturedMessages = messages;
      return { content: JSON.stringify({ items: [rubricEntry()] }) };
    },
  };
  const judged = await createTestPublicJudge({ provider })([u1Run]);
  const unboundFingerprint = createHash("sha256")
    .update(JSON.stringify({ messages: capturedMessages, responseFormat: "json_object" }), "utf8")
    .digest("hex");
  const expectedV2Fingerprint = createHash("sha256")
    .update(JSON.stringify({ semanticResponseBindingVersion: "identity-set-v2", messages: capturedMessages, responseFormat: "json_object" }), "utf8")
    .digest("hex");

  assert.notEqual(judged[0].requestFingerprint, unboundFingerprint);
  assert.equal(judged[0].requestFingerprint, expectedV2Fingerprint);
});

test("semantic provider failure remains a classified failure, never a low score", async () => {
  await assert.rejects(
    () => createTestPublicJudge({
      provider: { chat: async () => { throw new Error("transport unavailable"); } },
    })([u1Run]),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_PROVIDER_FAILED",
  );
});

test("semantic judge preserves run-fatal budget errors instead of relabelling them as provider failures", async () => {
  const runBudgetError = new ProviderBudgetError(
    "logical_calls",
    { maxLogicalCalls: 10, maxRetryAttempts: 2 },
    "semantic",
  );
  await assert.rejects(
    () => createTestPublicJudge({
      provider: { chat: async () => { throw runBudgetError; } },
    })([u1Run]),
    (error: unknown) => error === runBudgetError,
  );
});

test("semantic judge receives judging rules and the current rubric in its evaluation-only request", async () => {
  let prompt = "";
  const provider: Provider = { chat: async (messages) => { prompt = messages.map((m) => m.content).join("\n"); return { content: JSON.stringify({ items: [rubricEntry("p1")] }) }; } };
  const judge = createTestPublicJudge({ provider });
  const judged = await judge([run]);
  assert.equal(judged[0].score, 80);
  assert.equal(judged[0].semanticStatus, "evaluated");
  assert.match(prompt, /identify uncertainty/);
  assert.match(prompt, /task_correctness/);
});

test("semantic judge receives the exact required item-id order and count for a batch", async () => {
  let systemPrompt = "";
  let userPayload: unknown;
  const secondRun: InstructionGateInput = {
    ...run,
    item: { ...run.item, itemId: "p2", scenarioId: "p2", input: "请判断证据是否充分" },
    transcript: { ...run.transcript, scenarioId: "p2" },
  };
  const provider: Provider = {
    chat: async (messages) => {
      systemPrompt = messages[0]?.content ?? "";
      userPayload = JSON.parse(messages[1]?.content ?? "{}");
      return {
        content: JSON.stringify({
          items: [
            rubricEntry("p1"),
            rubricEntry("p2"),
          ],
        }),
      };
    },
  };

  await createTestPublicJudge({ provider })([run, secondRun]);
  const payload = userPayload as { requiredItemIds: string[]; requiredItemCount: number; items: Array<{ rubric?: unknown }> };
  assert.deepEqual(payload.requiredItemIds, ["p1", "p2"]);
  assert.equal(payload.requiredItemCount, 2);
  assert.equal(payload.items.length, 2);
  assert.ok(payload.items.every((item) => item.rubric !== undefined));
  assert.match(systemPrompt, /Copy each required itemId verbatim and preserve the required order/);
  assert.match(systemPrompt, /Do not omit, duplicate, translate, normalize, or invent an itemId/);
});

test("semantic judge splits seven public items into ordered 3/3/1 requests and restores one ordered score list", async () => {
  const runs = publicRuns(7).map((entry, index) => ({
    ...entry,
    item: { ...entry.item, input: `用户问题 ${index + 1}` },
  }));
  const requestedIds: string[][] = [];
  const provider: Provider = {
    chat: async (messages) => {
      const payload = JSON.parse(messages[1]?.content ?? "{}") as { requiredItemIds: string[] };
      requestedIds.push(payload.requiredItemIds);
      return {
        content: JSON.stringify({
          items: payload.requiredItemIds.map((itemId) => rubricEntry(itemId)),
        }),
      };
    },
  };

  const judged = await createTestPublicJudge({ provider })(runs);

  assert.deepEqual(requestedIds, [["p1", "p2", "p3"], ["p4", "p5", "p6"], ["p7"]]);
  assert.deepEqual(judged.map((entry) => entry.itemId), ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
});

test("semantic judge rejects a malformed later chunk and never returns a partial score set", async () => {
  const runs = publicRuns(4);
  let calls = 0;
  const provider: Provider = {
    chat: async (messages) => {
      calls += 1;
      const payload = JSON.parse(messages[1]?.content ?? "{}") as { requiredItemIds: string[] };
      const ids = calls === 1 ? payload.requiredItemIds : [];
      return {
        content: JSON.stringify({
          items: ids.map((itemId) => rubricEntry(itemId)),
        }),
      };
    },
  };

  await assert.rejects(
    () => createTestPublicJudge({ provider })(runs),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_ITEM_MISMATCH",
  );
  assert.equal(calls, 3, "the failed later chunk is retried once without rerunning the valid first chunk");
});

test("semantic judge fails closed when its JSON omits a requested item", async () => {
  const provider: Provider = { chat: async () => ({ content: JSON.stringify({ items: [] }) }) };
  await assert.rejects(() => createTestPublicJudge({ provider })([run]), (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_ITEM_MISMATCH");
});

test("the public semantic judge refuses sealed holdout input before contacting the provider", async () => {
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      return { content: JSON.stringify({ items: [{ itemId: "sealed-1", score: 100, reason: "should not run" }] }) };
    },
  };
  const sealedRun: InstructionGateInput = {
    ...run,
    item: { ...run.item, itemId: "sealed-1", split: "holdout" },
  };
  await assert.rejects(
    () => createTestPublicJudge({ provider })([sealedRun]),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_SPLIT_VIOLATION",
  );
  assert.equal(calls, 0, "a public-phase judge must not receive sealed input");
});

test("adaptive semantic judging performs exactly one schema recovery and keeps the original request binding", async () => {
  const diagnostics: unknown[] = [];
  const attempts: unknown[] = [];
  const messagesByCall: Parameters<Provider["chat"]>[0][] = [];
  const boundContexts: Array<{ scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }> = [];
  let calls = 0;
  const chat: Provider["chat"] = async (messages) => {
    calls += 1;
    messagesByCall.push(messages);
    return calls === 1
      ? { content: "RAW_RESPONSE_SENTINEL_HOLDOUT_SCORE_987654321" }
      : { content: rubricResponseFor(messages) };
  };
  const provider = {
    chat,
    withContext(context: { scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }): Provider {
      boundContexts.push(context);
      return { chat };
    },
  } as Provider;

  const judged = await createPublicSemanticBatchJudge({
    provider,
    recovery: adaptiveRecoveryContext({ diagnostics, attempts }),
  })([u1Run]);

  assert.equal(calls, 2);
  assert.equal(judged[0].weightedScore, 80);
  assert.equal(diagnostics.length, 1);
  assert.equal(attempts.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0] as object).sort(), [
    "attempt",
    "failureCode",
    "findingCodes",
    "finishReason",
    "responseLength",
    "responseSha256",
    "subject",
  ]);
  assert.equal((diagnostics[0] as { failureCode: string }).failureCode, "SEMANTIC_JUDGE_INVALID_JSON");
  const expectedPrimaryFingerprint = createHash("sha256")
    .update(JSON.stringify({
      semanticResponseBindingVersion: "identity-set-v2",
      messages: messagesByCall[0],
      responseFormat: "json_object",
    }), "utf8")
    .digest("hex");
  assert.deepEqual(attempts, [{
    subject: { kind: "candidate", generation: 1, lane: "exploit" },
    operation: "semantic-judge",
    attempt: 2,
    mode: "schema-repair",
    requestFingerprintSha256: expectedPrimaryFingerprint,
  }]);
  assert.equal(boundContexts.length, 2);
  assert.notDeepEqual(boundContexts[0], boundContexts[1], "primary and recovery must have distinct cache identities");

  const recoveryPrompt = messagesByCall[1].map((message) => message.content).join("\n");
  assert.match(recoveryPrompt, /SEMANTIC_JUDGE_INVALID_JSON/);
  assert.match(recoveryPrompt, /Return JSON only/);
  assert.doesNotMatch(recoveryPrompt, /RAW_RESPONSE_SENTINEL|HOLDOUT_SCORE|987654321/);
  assert.doesNotMatch(JSON.stringify(diagnostics), /RAW_RESPONSE_SENTINEL|HOLDOUT_SCORE|987654321/);

  assert.equal(judged[0].requestFingerprint, expectedPrimaryFingerprint);
});

test("each three-item semantic chunk owns one independent recovery allowance", async () => {
  const diagnostics: unknown[] = [];
  const attempts: unknown[] = [];
  let calls = 0;
  const provider: Provider = {
    chat: async (messages) => {
      calls += 1;
      return calls % 2 === 1
        ? { content: "malformed chunk response" }
        : { content: rubricResponseFor(messages) };
    },
  };

  const judged = await createPublicSemanticBatchJudge({
    provider,
    recovery: adaptiveRecoveryContext({ diagnostics, attempts }),
  })(publicRuns(6));

  assert.equal(calls, 4, "two chunks each consume primary plus one recovery");
  assert.equal(judged.length, 6);
  assert.equal(diagnostics.length, 2);
  assert.equal(attempts.length, 2);
});

test("a second malformed semantic response fails with the same class and never makes a third call", async () => {
  const diagnostics: unknown[] = [];
  const attempts: unknown[] = [];
  let calls = 0;
  const provider: Provider = {
    chat: async () => ({ content: calls++ === 0 ? "first malformed" : "second malformed" }),
  };

  await assert.rejects(
    () => createPublicSemanticBatchJudge({
      provider,
      recovery: adaptiveRecoveryContext({ diagnostics, attempts }),
    })([u1Run]),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_INVALID_JSON",
  );
  assert.equal(calls, 2);
  assert.equal(diagnostics.length, 2);
  assert.equal(attempts.length, 1);
});

test("the semantic recovery allowlist covers only strict response-contract failures", async () => {
  const invalidResponses: Array<{ code: string; content: string }> = [
    { code: "SEMANTIC_JUDGE_INVALID_JSON", content: "not-json" },
    { code: "SEMANTIC_JUDGE_INVALID", content: JSON.stringify({ wrong: [] }) },
    { code: "SEMANTIC_JUDGE_ITEM_MISMATCH", content: JSON.stringify({ items: [] }) },
    {
      code: "SEMANTIC_JUDGE_DIMENSION_MISMATCH",
      content: JSON.stringify({ items: [{ ...rubricEntry(), dimensions: [] }] }),
    },
    {
      code: "SEMANTIC_JUDGE_OVERALL_REASON_INVALID",
      content: JSON.stringify({ items: [{ ...rubricEntry(), overallReason: " " }] }),
    },
  ];

  for (const invalid of invalidResponses) {
    let calls = 0;
    const provider: Provider = {
      chat: async (messages) => ({
        content: calls++ === 0 ? invalid.content : rubricResponseFor(messages),
      }),
    };
    const judged = await createPublicSemanticBatchJudge({
      provider,
      recovery: adaptiveRecoveryContext(),
    })([u1Run]);
    assert.equal(calls, 2, invalid.code);
    assert.equal(judged.length, 1, invalid.code);
  }
});

test("split, context, mixed-contract, batch-size, provider, and budget failures never recover", async () => {
  const cases: Array<{
    name: string;
    judge: (recovery: U1RecoveryContext) => ReturnType<typeof createPublicSemanticBatchJudge>;
    runs: readonly InstructionGateInput[];
    expected: (error: unknown) => boolean;
    calls: () => number;
  }> = [];
  const makeProvider = (error?: unknown) => {
    let calls = 0;
    return {
      provider: {
        chat: async () => {
          calls += 1;
          if (error !== undefined) throw error;
          return { content: JSON.stringify({ items: [] }) };
        },
      } satisfies Provider,
      calls: () => calls,
    };
  };
  const split = makeProvider();
  cases.push({
    name: "split",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: split.provider, recovery }),
    runs: [{ ...u1Run, item: { ...u1Run.item, split: "holdout" } }],
    expected: (error) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_SPLIT_VIOLATION",
    calls: split.calls,
  });
  const context = makeProvider();
  cases.push({
    name: "context",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: context.provider, recovery }),
    runs: [{ ...u1Run, item: { ...u1Run.item, input: "" } }],
    expected: (error) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_CONTEXT_MISSING",
    calls: context.calls,
  });
  const mixed = makeProvider();
  const { rubric: _omittedRubric, ...itemWithoutRubric } = run.item;
  cases.push({
    name: "mixed",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: mixed.provider, recovery }),
    runs: [{ ...run, item: itemWithoutRubric }, { ...u1Run, item: { ...u1Run.item, itemId: "p2", scenarioId: "p2" } }],
    expected: (error) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_CONTEXT_MISSING",
    calls: mixed.calls,
  });
  const batch = makeProvider();
  cases.push({
    name: "batch-size",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: batch.provider, maxItemsPerRequest: 0, recovery }),
    runs: [u1Run],
    expected: (error) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_BATCH_SIZE_INVALID",
    calls: batch.calls,
  });
  const providerFailure = makeProvider(new Error("transport unavailable"));
  cases.push({
    name: "provider",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: providerFailure.provider, recovery }),
    runs: [u1Run],
    expected: (error) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_PROVIDER_FAILED",
    calls: providerFailure.calls,
  });
  const budgetError = new ProviderBudgetError("logical_calls", { maxLogicalCalls: 1, maxRetryAttempts: 0 }, "semantic");
  const budget = makeProvider(budgetError);
  cases.push({
    name: "budget",
    judge: (recovery) => createPublicSemanticBatchJudge({ provider: budget.provider, recovery }),
    runs: [u1Run],
    expected: (error) => error === budgetError,
    calls: budget.calls,
  });

  for (const entry of cases) {
    const diagnostics: unknown[] = [];
    const attempts: unknown[] = [];
    await assert.rejects(
      () => entry.judge(adaptiveRecoveryContext({ diagnostics, attempts }))(entry.runs),
      entry.expected,
      entry.name,
    );
    assert.equal(attempts.length, 0, entry.name);
    assert.equal(diagnostics.length, 0, entry.name);
    assert.ok(entry.calls() <= 1, entry.name);
  }
});

test("sealed-audit has no application-recovery surface and fails after one malformed response", async () => {
  const sealedEvents = { diagnostics: [] as unknown[], attempts: [] as unknown[] };
  let sealedCalls = 0;
  const sealedRun: InstructionGateInput = {
    ...u1Run,
    item: { ...u1Run.item, itemId: "synthetic-sealed-1", scenarioId: "synthetic-sealed-1", split: "holdout" },
    transcript: { ...u1Run.transcript, scenarioId: "synthetic-sealed-1" },
  };
  await assert.rejects(
    () => createSealedSemanticBatchJudge({
      provider: { chat: async () => ({ content: sealedCalls++ === 0 ? "malformed" : rubricResponseFor([]) }) },
    })([sealedRun]),
    (error: unknown) => error instanceof SemanticJudgeError && error.code === "SEMANTIC_JUDGE_INVALID_JSON",
  );
  assert.equal(sealedCalls, 1);
  assert.equal(sealedEvents.diagnostics.length, 0);
  assert.equal(sealedEvents.attempts.length, 0);
});

test("schema recovery never reflects observed identities, scores, raw text, or excerpts into its prompt or diagnostics", async () => {
  const observedIdentity = "OBSERVED_ITEM_SENTINEL_DO_NOT_COPY";
  const observedExcerpt = "HOLDOUT_EXCERPT_SENTINEL_DO_NOT_COPY";
  const diagnostics: unknown[] = [];
  const prompts: string[] = [];
  let calls = 0;
  const provider: Provider = {
    chat: async (messages) => {
      calls += 1;
      prompts.push(messages.map((message) => message.content).join("\n"));
      return calls === 1
        ? {
            content: JSON.stringify({
              items: [{
                ...rubricEntry(observedIdentity),
                weightedScore: 987654321,
                overallReason: observedExcerpt,
              }],
            }),
          }
        : { content: rubricResponseFor(messages) };
    },
  };

  await createPublicSemanticBatchJudge({
    provider,
    recovery: adaptiveRecoveryContext({ diagnostics }),
  })([u1Run]);

  assert.equal(calls, 2);
  assert.match(prompts[1], /SEMANTIC_JUDGE_ITEM_MISMATCH/);
  assert.doesNotMatch(prompts[1], new RegExp(`${observedIdentity}|${observedExcerpt}|987654321`));
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(`${observedIdentity}|${observedExcerpt}|987654321`));
});

test("semantic attempt identities vary by attempt but not by candidate generation or lane", async () => {
  const contexts: Array<{ scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }> = [];
  let calls = 0;
  const chat: Provider["chat"] = async (messages) => ({
    content: calls++ % 2 === 0 ? "malformed" : rubricResponseFor(messages),
  });
  const provider = {
    chat,
    withContext(context: { scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }): Provider {
      contexts.push(context);
      return { chat };
    },
  } as Provider;
  await createPublicSemanticBatchJudge({
    provider,
    recovery: adaptiveRecoveryContext(),
  })([u1Run]);
  await createPublicSemanticBatchJudge({
    provider,
    recovery: {
      subject: { kind: "candidate", generation: 99, lane: "diversify" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  })([u1Run]);

  assert.equal(contexts.length, 4);
  assert.deepEqual(contexts[0], contexts[2], "primary identity must be shareable across candidate subjects");
  assert.deepEqual(contexts[1], contexts[3], "recovery identity must be shareable across candidate subjects");
  assert.notDeepEqual(contexts[0], contexts[1], "attempt two must not hit the primary bad-response cache entry");
});
