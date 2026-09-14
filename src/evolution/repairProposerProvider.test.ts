import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/types.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import type { FrontierTicket } from "../types.js";
import { FrontierTicketSchema } from "../types.js";
import type { MutationProposalContext } from "../bootstrap/liveBootstrapProposer.js";
import { planTargetedRepair } from "./repairFrontier.js";
import { createOpenAICompatibleRepairProposer } from "./repairProposerProvider.js";
import type { U1ApplicationRecoveryAttempt, U1RecoveryContext, U1RecoveryDiagnostic } from "./structureRecovery.js";

// ── P0 Task 3: live frontier repair proposer ──────────────────────
// The proposer gets bounded public-train evidence, the confirmed task intent,
// and the current SKILL.md, then must answer the strict U1 edit/no_change envelope. Every failure mode
// (bad JSON, invalid fields, no-op, provider error) throws a desensitized
// RepairFrontierError — the funnel then settles the candidate as
// safe_non_elite. Nothing is ever swapped for a fixture repair.

const BASE_SKILL = "# Skill\nAnswer briefly.\n";

function replaceEnvelope(newText: string, hypothesis = "tighten the digest rule"): string {
  return JSON.stringify({
    hypothesis,
    decision: "edit",
    edits: [{ op: "replace_exact", oldText: "Answer briefly.", newText }],
  });
}

function ticket(): FrontierTicket {
  return FrontierTicketSchema.parse({
    schemaVersion: 3,
    candidateId: "b0-repair",
    split: "public",
    minimalFailureReason: "one bounded quality finding requires repair on item d2",
    editableFiles: ["SKILL.md"],
    repairBudget: 1,
    repairsUsed: 0,
  });
}

/** Fake live provider: captures the prompt and returns queued content. */
function fakeProvider(
  content: string | Error | Array<string | Error>,
): Provider & {
  calls: ProviderMessage[][];
  contexts: Array<[string, string]>;
  setContext: (scenarioId: string, snapshotId: string) => void;
} {
  const calls: ProviderMessage[][] = [];
  const contexts: Array<[string, string]> = [];
  const queue = Array.isArray(content) ? [...content] : [content];
  return {
    calls,
    contexts,
    setContext(scenarioId: string, snapshotId: string) {
      contexts.push([scenarioId, snapshotId]);
    },
    async chat(messages: ProviderMessage[]): Promise<ProviderResponse> {
      calls.push(messages.map((message) => ({ ...message })));
      const next = queue.shift();
      if (next === undefined) throw new Error("fake provider response queue exhausted");
      if (next instanceof Error) throw next;
      return { content: next };
    },
  };
}

function recoveryHarness(): {
  recovery: U1RecoveryContext;
  attempts: U1ApplicationRecoveryAttempt[];
  diagnostics: U1RecoveryDiagnostic[];
} {
  const attempts: U1ApplicationRecoveryAttempt[] = [];
  const diagnostics: U1RecoveryDiagnostic[] = [];
  return {
    attempts,
    diagnostics,
    recovery: {
      subject: { kind: "candidate", generation: 1, lane: "exploit" },
      hooks: {
        onApplicationRecoveryAttempt: (attempt) => attempts.push(attempt),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    },
  };
}

test("a strict-JSON proposal passes planTargetedRepair and records the provider producer", async () => {
  const provider = fakeProvider(
    replaceEnvelope("Answer briefly and include the required digest."),
  );
  const proposer = createOpenAICompatibleRepairProposer({ provider });
  const { proposal, producer } = await planTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL, proposer });
  assert.equal(proposal.hypothesis, "tighten the digest rule");
  assert.ok(proposal.skillMd.startsWith("# Skill"));
  assert.notEqual(producer.kind, "fixture");
  assert.equal(producer.name, "openai-compatible-frontier-repair");
});

test("the prompt carries failure evidence, the edit contract, and only the authorized capability boundary", async () => {
  const provider = fakeProvider(
    replaceEnvelope("Answer briefly!", "h"),
  );
  const proposer = createOpenAICompatibleRepairProposer({
    provider,
    capabilityBoundary: {
      allowedCapabilities: ["reference"],
      network: "forbidden",
      filesystem: "forbidden",
      externalActions: "forbidden",
    },
    authorizedToolLogicalIds: ["reference.read:public-guide"],
  });
  await proposer.proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL });
  assert.equal(provider.calls.length, 1);
  const [system, user] = provider.calls[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /replace_exact/);
  assert.match(system.content, /insert_after/);
  assert.match(system.content, /delete_exact/);
  assert.doesNotMatch(system.content, /insert_before/);
  assert.match(system.content, /reference\.read:public-guide/);
  assert.doesNotMatch(system.content, /never add tool usage/i);
  assert.match(user.content, /bounded quality finding/);
  assert.doesNotMatch(user.content, /quality gate|public split|repair budget/i);
  assert.ok(user.content.includes(BASE_SKILL));
});

test("targeted repair reuses the bounded public-train feedback and reference-body sanitizer", async () => {
  const provider = fakeProvider(replaceEnvelope("Answer briefly!", "h"));
  const proposer = createOpenAICompatibleRepairProposer({ provider });
  const trainFeedback: NonNullable<MutationProposalContext["trainFeedback"]> = {
    failures: Array.from({ length: 7 }, (_, index) => ({
      itemId: `train-failure-${index + 1}`,
      itemType: "output_structure",
      family: "bounded-family",
      input: `PUBLIC_TRAIN_INPUT_${index + 1}`,
      terminalReason: "final",
      parsedAnswer: `REFERENCE_BODY_MUST_NOT_LEAK_${index + 1}`,
      score: 40 + index,
      rules: [{
        ruleId: `rule-${index + 1}`,
        kind: "output_field",
        passed: false,
        effect: "quality",
        failureCode: "TASK_VERIFIER_OUTPUT_FIELD_MISSING",
      }],
      dimensions: [{ id: "output_structure", score: 40, reason: "missing required structured field" }],
      toolTrace: [{ toolName: "reference.read", logicalId: "public-guide", success: true }],
    })),
    successes: Array.from({ length: 3 }, (_, index) => ({
      itemId: `train-success-${index + 1}`,
      itemType: "trigger",
      input: `PUBLIC_SUCCESS_${index + 1}`,
      terminalReason: "final",
      parsedAnswer: `REFERENCE_SUCCESS_BODY_${index + 1}`,
      score: 90,
    })),
  };
  const context: Parameters<typeof proposer.proposeTargetedRepair>[0] = {
    ticket: ticket(),
    skillMd: BASE_SKILL,
    adapterId: "reference-v1",
    trainFeedback,
    taskCard: {
      goal: "Prepare a trustworthy public-train digest.",
      intentDetails: {
        goal_and_intended_user: "Help maintainers review repository changes.",
        inputs_and_evidence: "Use only supplied evidence and identify unknowns.",
        output_and_format: "Return a concise structured digest.",
        capability_boundary_and_redlines: "No network, scripts, writes, or invented facts.",
        success_criteria_and_protected_behavior: "Preserve attribution and explicit limitations.",
      },
      qualityPriorities: ["correctness", "evidence", "format", "speed", "cost"],
      scenarios: [{ id: "public-train-1", userRequest: "Summarize the supplied change.", expectedOutcome: "A grounded digest." }],
      redlines: ["never fabricate repository evidence"],
      capabilityBoundary: {
        allowedCapabilities: ["reference"],
        network: "forbidden",
        filesystem: "controlled",
        externalActions: "controlled",
      },
    },
    lanePurpose: "exploit_known_failures" as const,
    failureClasses: ["output_structure"],
    authorizedToolLogicalIds: ["reference.read:public-guide"],
  };
  await proposer.proposeTargetedRepair(context);

  const prompt = provider.calls[0].map(({ content }) => content).join("\n");
  assert.match(prompt, /PUBLIC_TRAIN_INPUT_1/);
  assert.match(prompt, /TASK_VERIFIER_OUTPUT_FIELD_MISSING/);
  assert.match(prompt, /output_structure/);
  assert.match(prompt, /reference\.read/);
  assert.match(prompt, /Help maintainers review repository changes/);
  assert.match(prompt, /Preserve attribution and explicit limitations/);
  assert.match(prompt, /Lane purpose: exploit_known_failures/);
  assert.match(prompt, /Failure classes: output_structure/);
  assert.doesNotMatch(prompt, /PUBLIC_TRAIN_INPUT_7/);
  assert.match(prompt, /PUBLIC_SUCCESS_2/);
  assert.doesNotMatch(prompt, /PUBLIC_SUCCESS_3/);
  assert.doesNotMatch(prompt, /REFERENCE_(?:BODY|SUCCESS_BODY)_MUST_NOT_LEAK|REFERENCE_SUCCESS_BODY/);
  assert.doesNotMatch(prompt, /repair budget|quality gate|public split|holdout|sealed|contract sha|split identity/i);
});

test("targeted repair never serializes parsed answer bodies, including instruction-v1", async () => {
  const feedback: NonNullable<MutationProposalContext["trainFeedback"]> = {
    failures: [{
      itemId: "train-unknown-adapter",
      itemType: "quality",
      input: "public input",
      terminalReason: "final",
      parsedAnswer: "DEPENDENCY_BODY_MUST_NOT_LEAK",
    }],
    successes: [],
  };
  const unknownProvider = fakeProvider(replaceEnvelope("Answer briefly!", "h"));
  await createOpenAICompatibleRepairProposer({ provider: unknownProvider }).proposeTargetedRepair({
    ticket: ticket(),
    skillMd: BASE_SKILL,
    trainFeedback: feedback,
  });
  assert.doesNotMatch(
    unknownProvider.calls[0].map(({ content }) => content).join("\n"),
    /DEPENDENCY_BODY_MUST_NOT_LEAK/,
  );

  const instructionProvider = fakeProvider(replaceEnvelope("Answer briefly!", "h"));
  await createOpenAICompatibleRepairProposer({ provider: instructionProvider }).proposeTargetedRepair({
    ticket: ticket(),
    skillMd: BASE_SKILL,
    adapterId: "instruction-v1",
    trainFeedback: feedback,
  });
  assert.doesNotMatch(
    instructionProvider.calls[0].map(({ content }) => content).join("\n"),
    /DEPENDENCY_BODY_MUST_NOT_LEAK/,
  );
});

test("targeted repair performs one content-free structure recovery and never a third attempt", async () => {
  const successful = fakeProvider([
    "malformed primary secret payload",
    replaceEnvelope("Answer briefly and include a digest.", "repair the schema once"),
  ]);
  const successfulHarness = recoveryHarness();
  const successfulContext = {
    ticket: ticket(),
    skillMd: BASE_SKILL,
    recovery: successfulHarness.recovery,
  };
  const recovered = await createOpenAICompatibleRepairProposer({ provider: successful })
    .proposeTargetedRepair(successfulContext);
  assert.match(recovered.skillMd, /include a digest/);
  assert.equal(successful.calls.length, 2);
  assert.equal(successfulHarness.attempts.length, 1);
  assert.equal(
    successfulHarness.attempts[0]?.operation,
    "repair-proposer",
    "targeted repair must retain its own auditable application identity",
  );
  assert.equal(successfulHarness.diagnostics.length, 1);
  const recoveryPrompt = successful.calls[1].map(({ content }) => content).join("\n");
  assert.match(recoveryPrompt, /REPAIR_PROPOSAL_INVALID_JSON/);
  assert.doesNotMatch(recoveryPrompt, /malformed primary secret payload/);

  const twiceInvalid = fakeProvider(["first rejected secret", "second rejected secret"]);
  const twiceHarness = recoveryHarness();
  const twiceContext = { ticket: ticket(), skillMd: BASE_SKILL, recovery: twiceHarness.recovery };
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider: twiceInvalid }).proposeTargetedRepair(twiceContext),
    /REPAIR_PROPOSAL_INVALID_JSON/,
  );
  assert.equal(twiceInvalid.calls.length, 2, "the second contract failure must not trigger a third call");
  assert.equal(twiceHarness.attempts.length, 1);
  assert.deepEqual(twiceHarness.diagnostics.map(({ attempt }) => attempt), [1, 2]);
});

test("repair recovery never catches provider, network, or budget failures", async () => {
  for (const failure of [
    new Error("network unavailable"),
    new ProviderBudgetError("logical_calls", { maxLogicalCalls: 1, maxRetryAttempts: 0 }, "repair"),
    new ProviderBudgetError("retry_attempts", { maxLogicalCalls: 2, maxRetryAttempts: 0 }, "repair"),
  ]) {
    const provider = fakeProvider([failure, replaceEnvelope("must remain unused")]);
    const harness = recoveryHarness();
    const context = { ticket: ticket(), skillMd: BASE_SKILL, recovery: harness.recovery };
    if (
      failure instanceof ProviderBudgetError && failure.kind === "logical_calls"
    ) {
      await assert.rejects(
        () => createOpenAICompatibleRepairProposer({ provider }).proposeTargetedRepair(context),
        (error: unknown) => error === failure,
      );
    } else {
      await assert.rejects(
        () => createOpenAICompatibleRepairProposer({ provider }).proposeTargetedRepair(context),
        /REPAIR_PROPOSER_PROVIDER_FAILED/,
      );
    }
    assert.equal(provider.calls.length, 1);
    assert.equal(harness.attempts.length, 0);
    assert.equal(harness.diagnostics.length, 0);
  }
});

test("non-JSON output fails desensitized — the raw content is never echoed", async () => {
  const provider = fakeProvider("here is my repair idea: <not json>");
  const proposer = createOpenAICompatibleRepairProposer({ provider });
  try {
    await proposer.proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL });
    assert.fail("expected the non-JSON proposal to be rejected");
  } catch (e) {
    assert.ok(e instanceof Error, `expected an Error, got ${typeof e}`);
    assert.match(e.message, /REPAIR_PROPOSAL_INVALID_JSON/);
    assert.ok(!e.message.includes("<not json>"), "raw model output must not leak into the error");
  }
});

test("invalid fields or a no-op edit are refused without a fixture fallback", async () => {
  const empty = fakeProvider(JSON.stringify({ hypothesis: "  ", decision: "no_change" }));
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider: empty }).proposeTargetedRepair({
      ticket: ticket(),
      skillMd: BASE_SKILL,
    }),
    /U1_EDIT_INVALID/,
  );

  const noop = fakeProvider(JSON.stringify({
    hypothesis: "h",
    decision: "edit",
    edits: [{ op: "replace_exact", oldText: "Answer briefly.", newText: "Answer briefly." }],
  }));
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider: noop }).proposeTargetedRepair({
      ticket: ticket(),
      skillMd: BASE_SKILL,
    }),
    /REPAIR_PROPOSAL_NOOP/,
  );
});

test("a provider failure (429/network) surfaces as a desensitized repair error", async () => {
  const provider = fakeProvider(new Error("HTTP 429 from provider (deepseek) at https://unit.test.invalid: rate limited"));
  const proposer = createOpenAICompatibleRepairProposer({ provider });
  await assert.rejects(
    () => proposer.proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /REPAIR_PROPOSER_PROVIDER_FAILED/);
      assert.ok(!e.message.includes(BASE_SKILL), "the prompt must not leak into the error");
      assert.doesNotMatch(e.message, /deepseek|unit\.test|rate limited/i, "provider diagnostics stay redacted");
      return true;
    },
  );
});

test("the repair call is billed through the shared provider chain context", async () => {
  const provider = fakeProvider(replaceEnvelope("Answer briefly!", "h"));
  const proposer = createOpenAICompatibleRepairProposer({ provider });
  await proposer.proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL });
  assert.deepEqual(provider.contexts.at(-1)?.[0], "frontier-repair");
  assert.match(provider.contexts.at(-1)?.[1] ?? "", /^[0-9a-f]{12}$/);
});

test("repair accepts explicit no-tool fallback language", async () => {
  const safe = [
    "Answer briefly.",
    "Network access is forbidden; do not fetch or browse.",
    "无法读取文件或执行脚本，请用户粘贴必要信息。",
  ].join("\n");
  const provider = fakeProvider(replaceEnvelope(safe, "add a bounded fallback"));
  const proposal = await createOpenAICompatibleRepairProposer({ provider })
    .proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL });
  assert.equal(proposal.skillMd, `# Skill\n${safe}\n`);
});

test("repair rejects unavailable execution with shared finding evidence", async () => {
  const unsafe = "Answer briefly. Fetch the latest website and write output.md.";
  const provider = fakeProvider(replaceEnvelope(unsafe, "execute outside U1"));
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider })
      .proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL }),
    /REPAIR_PROPOSAL_U1_BOUNDARY_VIOLATION.*network:execution_instruction.*filesystem:execution_instruction/,
  );
});

test("no_change is a normal targeted-repair result and does not trigger a fallback call", async () => {
  const provider = fakeProvider(JSON.stringify({
    hypothesis: "the bounded evidence does not justify a safe edit",
    decision: "no_change",
  }));
  const result = await createOpenAICompatibleRepairProposer({ provider })
    .proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL });
  assert.equal(result.decision, "no_change");
  assert.equal(result.skillMd, BASE_SKILL);
  assert.equal(provider.calls.length, 1);
});

test("repair shares the four-edit, exact-anchor, parent-only, and growth bounds", async () => {
  const scoped = fakeProvider(JSON.stringify({
    hypothesis: "edit another file",
    decision: "edit",
    edits: [{ op: "delete_exact", path: "references/private.md", oldText: "Answer briefly." }],
  }));
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider: scoped })
      .proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL }),
    /U1_EDIT_SCOPE_VIOLATION/,
  );

  const growth = fakeProvider(JSON.stringify({
    hypothesis: "unbounded growth",
    decision: "edit",
    edits: [{ op: "insert_after", anchor: "Answer briefly.", text: "x".repeat(1201) }],
  }));
  await assert.rejects(
    () => createOpenAICompatibleRepairProposer({ provider: growth })
      .proposeTargetedRepair({ ticket: ticket(), skillMd: BASE_SKILL }),
    /U1_EDIT_GROWTH_LIMIT_EXCEEDED/,
  );
});
