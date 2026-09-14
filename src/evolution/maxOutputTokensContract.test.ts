import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "../providers/openaiCompatible.js";
import { RunCallBudget, createBudgetedProvider } from "../providers/runBudget.js";
import { createOpenAICompatibleRepairProposer } from "./repairProposerProvider.js";
import { createOpenAICompatibleU1DirectProposer } from "./directBaseline.js";
import {
  createLiveMutationProposer,
  LiveProposalError,
  promptCardFactsOf,
} from "../bootstrap/liveBootstrapProposer.js";
import { RepairFrontierError } from "./repairFrontier.js";
import { sampleTaskCard } from "../evalFactory/composeBlueprint.test.js";
import { frozenSampleContract } from "../bootstrap/runBootstrap.test.js";
import type { FrontierTicket } from "../types.js";
import type { LlmConfig } from "../config/llmConfig.js";

// ── P1 任务 3：显式输出上限的可验证契约 ─────────────────────────
//
// T22 根因 3 的修复证据：maxOutputTokens 是一条从显式授权直达每个
// proposer 请求体 max_tokens 字段的链路（不许偷偷硬编码升高）；当前 one-shot Direct
// 生成独立完整候选，而 U1 mutation/repair 只接收 bounded edit；length 截断确定性失败
// （一次 HTTP、不重试、结构化错误码、带角色标签）。全部用 mock fetch，
// 零真实请求。

const EXPLICIT_MAX_OUTPUT_TOKENS = 3000;

const FAKE_CONFIG: LlmConfig = {
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
};

interface CapturedRequest {
  body: Record<string, unknown>;
}

/** Capture request bodies; queue one JSON response per attempt. */
function mockFetchBodies(responses: Array<{ status?: number; body: unknown } | { body: unknown }>): {
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const queue: Array<{ status?: number; body: unknown }> = responses.map((entry) => entry);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse((init?.body as string) ?? "null") as Record<string, unknown> });
    const next = queue.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
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

function providerOf(role: string): ReturnType<typeof createBudgetedProvider> {
  const budget = new RunCallBudget({
    maxLogicalCalls: 10,
    maxRetryAttempts: 1,
    roleRetryReserves: { [role]: 1 },
  });
  return createBudgetedProvider(
    new OpenAICompatibleProvider(FAKE_CONFIG, 8000, {
      budget,
      role,
      maxRetries: 1,
      maxOutputTokens: EXPLICIT_MAX_OUTPUT_TOKENS,
      sleep: async () => {},
    }),
    budget,
    role,
  );
}

function okCompletion(content: string): { choices: Array<{ message: { content: string }; finish_reason: string }> } {
  return { choices: [{ message: { content }, finish_reason: "stop" }] };
}

const PLAIN_PARENT = ["# Parent skill", "", "Read the task card. Answer with one JSON object."].join("\n");

/** A long (~8 KB) plain replacement SKILL.md with no boundary keywords. */
function longPlainSkill(): string {
  const section = (n: number) =>
    [
      `## Section ${n}`,
      "",
      "Restate the goal in one line. List the answer keys the card expects.",
      "Then produce exactly one JSON object with those keys and nothing else.",
      "Keep every sentence plain text; add no tool, no link, no command.",
      "",
    ].join("\n");
  return ["# Refined skill", "", ...Array.from({ length: 60 }, (_, i) => section(i + 1))].join("\n");
}

const TICKET: FrontierTicket = {
  schemaVersion: 3,
  candidateId: "b0-anchor",
  split: "public",
  minimalFailureReason: "two items missed the required key names",
  editableFiles: ["SKILL.md"],
  repairBudget: 1,
  repairsUsed: 0,
};

// ── 1. max_tokens 恰为显式授权值：三条可达 proposer 车道逐一验证 ──

test("repair proposer sends max_tokens exactly as the explicit authorized value", async () => {
  const appended = "\n\nState missing evidence before returning the final JSON object.";
  const { requests } = mockFetchBodies([
    { body: okCompletion(JSON.stringify({
      hypothesis: "spell out missing evidence",
      decision: "edit",
      edits: [{ op: "insert_after", anchor: "# Parent skill", text: appended }],
    })) },
  ]);
  const proposer = createOpenAICompatibleRepairProposer({ provider: providerOf("repair") });
  const proposal = await proposer.proposeTargetedRepair({ ticket: TICKET, skillMd: PLAIN_PARENT });

  assert.equal(proposal.skillMd, PLAIN_PARENT.replace("# Parent skill", `# Parent skill${appended}`));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_tokens, EXPLICIT_MAX_OUTPUT_TOKENS);
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
});

test("one-shot Direct proposer sends max_tokens exactly as the explicit authorized value", async () => {
  const longSkill = longPlainSkill();
  const { requests } = mockFetchBodies([
    { body: okCompletion(JSON.stringify({ skillMd: longSkill })) },
  ]);
  const proposer = createOpenAICompatibleU1DirectProposer({ provider: providerOf("direct-refine") });
  const proposal = await proposer.propose({
    sourceSkillMd: PLAIN_PARENT,
    goal: "Return one complete instruction-only SKILL.md.",
    capabilityBoundary: sampleTaskCard().capabilityBoundary,
  });

  assert.equal(proposal.skillMd, longSkill);
  assert.equal(requests[0].body.max_tokens, EXPLICIT_MAX_OUTPUT_TOKENS);
});

test("mutation proposer sends max_tokens exactly as the explicit authorized value", async () => {
  const { card, contract } = await frozenSampleContract();
  const appended = "\n\nState missing evidence before returning the final JSON object.";
  const { requests } = mockFetchBodies([
    { body: okCompletion(JSON.stringify({
      hypothesis: "make missing evidence explicit",
      decision: "edit",
      edits: [{ op: "insert_after", anchor: "# Parent skill", text: appended }],
    })) },
  ]);
  const proposer = createLiveMutationProposer({ provider: providerOf("mutation") });
  const proposal = await proposer.proposeMutation({
    eliteSkillMd: PLAIN_PARENT,
    diversitySkillMd: ["# Alt skill", "", "Answer tersely."].join("\n"),
    failureClasses: ["wrong_key_names"],
    lanePurpose: "exploit_known_failures",
    taskCard: promptCardFactsOf(card),
    contract,
  });

  assert.equal(proposal.skillMd, PLAIN_PARENT.replace("# Parent skill", `# Parent skill${appended}`));
  assert.equal(requests[0].body.max_tokens, EXPLICIT_MAX_OUTPUT_TOKENS);
});

// ── 2. length 截断：确定性失败，一次 HTTP，不重试，错误码可诊断 ────

test("a length-truncated repair proposal fails once with the structured code and the role tag", async () => {
  const { requests } = mockFetchBodies([
    {
      body: {
        choices: [{ message: { content: '{"hypothesis":"x","skillMd":"# partial' }, finish_reason: "length" }],
        usage: { prompt_tokens: 800, completion_tokens: EXPLICIT_MAX_OUTPUT_TOKENS },
      },
    },
    { status: 200, body: okCompletion("{}") }, // must never be fetched
  ]);
  const proposer = createOpenAICompatibleRepairProposer({ provider: providerOf("repair") });

  await assert.rejects(
    () => proposer.proposeTargetedRepair({ ticket: TICKET, skillMd: PLAIN_PARENT }),
    (err: unknown) => {
      assert.ok(err instanceof RepairFrontierError);
      assert.match(err.message, /PROVIDER_TRUNCATED_OUTPUT/);
      assert.match(err.message, /\[role=repair\]/);
      assert.match(err.message, /finishReason=length/);
      return true;
    },
  );
  assert.equal(requests.length, 1, "truncation is deterministic — no retry may be spent");
});

test("a length-truncated mutation proposal fails once as a structured LiveProposalError", async () => {
  const { card, contract } = await frozenSampleContract();
  const { requests } = mockFetchBodies([
    {
      body: {
        choices: [{ message: { content: '{"hypothesis":"y","skillMd' }, finish_reason: "length" }],
      },
    },
  ]);
  const proposer = createLiveMutationProposer({ provider: providerOf("mutation") });

  await assert.rejects(
    () =>
      proposer.proposeMutation({
        eliteSkillMd: PLAIN_PARENT,
        diversitySkillMd: PLAIN_PARENT,
        failureClasses: ["wrong_key_names"],
        lanePurpose: "exploit_known_failures",
        taskCard: promptCardFactsOf(card),
        contract,
      }),
    (err: unknown) => {
      assert.ok(err instanceof LiveProposalError);
      assert.match(err.message, /PROVIDER_TRUNCATED_OUTPUT/);
      assert.match(err.message, /\[role=mutation\]/);
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test("a provider without maxOutputTokens omits max_tokens entirely (no hidden default)", async () => {
  const { requests } = mockFetchBodies([{ body: okCompletion('{"type":"final"}') }]);
  const provider = new OpenAICompatibleProvider(FAKE_CONFIG, 8000, { maxRetries: 0 });
  await provider.chat([{ role: "user", content: "q" }]);
  assert.equal("max_tokens" in requests[0].body, false);
});

test("sample task card from the shared fixture stays U1-clean for these proposers", () => {
  const card = sampleTaskCard();
  assert.ok(card.goal.length > 0);
  assert.ok(Array.isArray(card.redlines));
});
