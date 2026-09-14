import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderMessage, ProviderResponse } from "../providers/types.js";
import { createCachingProvider, createInMemoryResponseCache } from "../providers/cache.js";
import { ProviderBudgetError } from "../providers/runBudget.js";
import type {
  U1ApplicationRecoveryAttempt,
  U1RecoveryDiagnostic,
} from "../evolution/structureRecovery.js";
import {
  LIVE_MUTATION_PRODUCER_NAME,
  MUTATION_SYSTEM_PROMPT,
  LiveProposalError,
  createLiveMutationProposer,
  mutationUserPrompt,
  promptCardFactsOf,
  validateU1MutationProposal,
  type U1MutationFeedbackItem,
} from "./liveBootstrapProposer.js";
import { frozenSampleContract } from "./runBootstrap.test.js";

// ── V3.1 T17: the live (provider-backed) bootstrap/mutation proposers ──
//
// Legacy calls stay one-shot. Closure-v2 mutation calls may make one bounded
// application recovery, and every response still passes the same strict gate.
// A fixture proposal is NEVER substituted for a failed live one.

const PARENT = [
  "# Digest Skill",
  "",
  "Summarize the repository activity for maintainers using only the provided context.",
  "Answer in three bullet points.",
].join("\n");

const CHANGED = `${PARENT}

## Repair note

Restate the three bullet points as plain text before finishing.
`;

function editProposalJson(hypothesis: string, parentSkillMd: string, skillMd: string): string {
  if (parentSkillMd === skillMd) {
    const noopAnchor = parentSkillMd.split("\n").find(
      (line) => line.length > 0 && line !== parentSkillMd && parentSkillMd.indexOf(line) === parentSkillMd.lastIndexOf(line),
    ) ?? parentSkillMd.slice(0, 1);
    return JSON.stringify({
      hypothesis,
      decision: "edit",
      edits: [{ op: "replace_exact", oldText: noopAnchor, newText: noopAnchor }],
    });
  }
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
  const occurrenceCount = (needle: string): number => {
    let count = 0;
    let cursor = 0;
    while (cursor <= parentSkillMd.length - needle.length) {
      const found = parentSkillMd.indexOf(needle, cursor);
      if (found < 0) break;
      count += 1;
      cursor = found + 1;
    }
    return count;
  };
  let edit: Record<string, string>;
  if (prefix === parentSkillMd.length) {
    let anchorStart = Math.max(0, prefix - 1);
    while (anchorStart > 0 && occurrenceCount(parentSkillMd.slice(anchorStart, prefix)) !== 1) {
      anchorStart -= 1;
    }
    edit = {
      op: "insert_after",
      anchor: parentSkillMd.slice(anchorStart, prefix),
      text: skillMd.slice(prefix),
    };
  } else {
    let start = prefix;
    let end = parentSkillMd.length - suffix;
    let replacement = skillMd.slice(prefix, skillMd.length - suffix);
    while (occurrenceCount(parentSkillMd.slice(start, end)) !== 1 && (start > 0 || end < parentSkillMd.length)) {
      if (start > 0) {
        start -= 1;
        replacement = `${parentSkillMd[start]}${replacement}`;
      } else {
        replacement = `${replacement}${parentSkillMd[end]}`;
        end += 1;
      }
    }
    edit = replacement.length === 0
      ? { op: "delete_exact", oldText: parentSkillMd.slice(start, end) }
      : {
          op: "replace_exact",
          oldText: parentSkillMd.slice(start, end),
          newText: replacement,
        };
  }
  return JSON.stringify({
    hypothesis,
    decision: "edit",
    edits: [edit],
  });
}

function noChangeProposalJson(hypothesis: string): string {
  return JSON.stringify({ hypothesis, decision: "no_change" });
}

function trainFeedbackItem(itemId: string, itemType = "output_structure"): U1MutationFeedbackItem {
  return {
    itemId,
    itemType,
    family: "public-family",
    input: `public input for ${itemId}`,
    terminalReason: "final",
    parsedAnswer: { summary: itemId },
    score: 50,
    rules: [{
      ruleId: `rule-${itemId}`,
      kind: "output_field",
      passed: false,
      effect: "quality",
      failureCode: "TASK_VERIFIER_OUTPUT_FIELD_MISSING",
    }],
    dimensions: [{ id: "output_structure", score: 50, reason: `dimension reason for ${itemId}` }],
    toolTrace: [],
  };
}

function recordingProvider(
  handler: (messages: ProviderMessage[]) => string,
  opts?: { error?: Error },
): { provider: Provider; calls: ProviderMessage[][] } {
  const calls: ProviderMessage[][] = [];
  const provider: Provider = {
    async chat(messages) {
      calls.push(messages);
      if (opts?.error) {
        throw opts.error;
      }
      return { content: handler(messages), promptTokens: 10, completionTokens: 10 };
    },
  };
  return { provider, calls };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoHoldoutIds(promptText: string, holdoutIds: readonly string[]): void {
  for (const id of holdoutIds) {
    const asToken = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(id)}($|[^A-Za-z0-9_-])`);
    assert.ok(
      !asToken.test(promptText),
      `holdout scenario id "${id}" must never reach a generation prompt`,
    );
  }
}

function proposerCard(
  card: Parameters<typeof promptCardFactsOf>[0],
  contract: { publicScenarioIds: readonly string[] },
) {
  return promptCardFactsOf(card, { allowedScenarioIds: contract.publicScenarioIds });
}

// ── createLiveMutationProposer ──

test("mutation proposer: one provider call combining elite + diversity around the failure classes", async () => {
  const { card, contract } = await frozenSampleContract();
  const { provider, calls } = recordingProvider(() => editProposalJson("merge the two approaches", PARENT, CHANGED));
  const proposer = createLiveMutationProposer({ provider });
  assert.equal(proposer.producer.kind, "provider");
  assert.equal(proposer.producer.name, LIVE_MUTATION_PRODUCER_NAME);

  const diversity = `${PARENT}\n\n## Alternative\nAnswer as a short paragraph instead of bullets.\n`;
  const proposal = await proposer.proposeMutation({
    eliteSkillMd: PARENT,
    diversitySkillMd: diversity,
    failureClasses: ["trigger", "output_structure"],
    lanePurpose: "exploit_known_failures" as const,
    trainFeedback: {
      failures: [trainFeedbackItem("train-trigger", "trigger"), trainFeedbackItem("train-structure")],
      successes: [],
    },
    taskCard: proposerCard(card, contract),
    contract,
  });

  assert.equal(proposal.skillMd, CHANGED);
  assert.equal(calls.length, 1, "exactly one chat call per mutation");
  const promptText = calls[0].map((message) => message.content).join("\n");
  assert.ok(promptText.includes(PARENT), "the elite is the mutation base");
  assert.ok(promptText.includes("Alternative"), "the diversity candidate is provided");
  assert.ok(promptText.includes("train-trigger") && promptText.includes("train-structure"), "structured train failures steer the mutation");
});

test("mutation prompt carries the frozen task card and boundary, and never leaks holdout", async () => {
  const { card, contract } = await frozenSampleContract();
  const { provider, calls } = recordingProvider(() => editProposalJson("merge the two approaches", PARENT, CHANGED));
  const proposer = createLiveMutationProposer({ provider });

  await proposer.proposeMutation({
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\n\n## Alternative\nAnswer as a short paragraph instead of bullets.\n`,
    failureClasses: ["trigger"],
    lanePurpose: "exploit_known_failures",
    taskCard: proposerCard(card, contract),
    contract,
  });

  assert.equal(calls.length, 1, "exactly one chat call per mutation");
  const promptText = calls[0].map((message) => message.content).join("\n");
  assert.ok(promptText.includes(card.goal), "the frozen goal steers every mutation");
  assert.ok(promptText.includes(card.redlines[0]), "the frozen redlines are injected");
  assert.ok(promptText.includes(JSON.stringify(card.capabilityBoundary)), "the capability boundary is injected verbatim");
  assert.ok(!promptText.includes(contract.contractSha256), "contract hashes are not mutation feedback");
  assertNoHoldoutIds(promptText, contract.holdoutScenarioIds);
  for (const scenario of card.scenarios.filter((entry) => contract.holdoutScenarioIds.includes(entry.id))) {
    assert.ok(!promptText.includes(scenario.userRequest), "holdout Task Card request body must stay out of mutation prompts");
    if (scenario.expectedOutcome) {
      assert.ok(!promptText.includes(scenario.expectedOutcome), "holdout Task Card expected outcome must stay out of mutation prompts");
    }
  }
  assert.ok(!promptText.includes("holdoutScenarioIds"), "the field name itself must not appear");
});

test("U1-C public-train feedback excludes terminal-select and sealed identities from mutation prompts", async () => {
  const { card, contract } = await frozenSampleContract();
  const prompt = mutationUserPrompt({
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a concise table.\n`,
    failureClasses: [],
    lanePurpose: "exploit_known_failures",
    trainFeedback: {
      failures: ["train-visible", "failure-2", "failure-3", "failure-4", "failure-5", "failure-6", "failure-7"].map((id) => trainFeedbackItem(id)),
      successes: ["success-1", "success-2", "success-3"].map((id) => trainFeedbackItem(id, "trigger")),
    },
    taskCard: proposerCard(card, contract),
    contract,
  });

  assert.match(prompt, /train-visible/);
  assert.match(prompt, /failure-6/);
  assert.doesNotMatch(prompt, /failure-7/);
  assert.match(prompt, /success-2/);
  assert.doesNotMatch(prompt, /success-3/);
  assert.doesNotMatch(prompt, /select-secret-sentinel/);
  assert.doesNotMatch(prompt, /holdout|sealed|contract|sha-?256|governance/i);
});

test("mutation prompt preserves contract-authorized tool logical IDs but redacts reference answer bodies", async () => {
  const { card, contract } = await frozenSampleContract();
  const feedback = trainFeedbackItem("reference-train", "trigger");
  feedback.parsedAnswer = { excerpt: "REFERENCE_BODY_SENTINEL" };
  feedback.rules = [{
    ruleId: "trace",
    kind: "successful_tool_trace",
    passed: true,
    effect: "hard_contract",
  }];
  const prompt = mutationUserPrompt({
    eliteSkillMd: PARENT,
    diversitySkillMd: PARENT,
    failureClasses: [],
    lanePurpose: "exploit_known_failures",
    trainFeedback: { failures: [feedback], successes: [] },
    taskCard: {
      ...proposerCard(card, contract),
      capabilityBoundary: {
        ...card.capabilityBoundary,
        allowedCapabilities: ["reference"],
      },
    },
    contract: {
      ...contract,
      adapterId: "reference-v1",
      allowedCapabilities: ["reference"],
      authorizedToolLogicalIds: ["reference.read:public-guide"],
    },
  });

  assert.match(prompt, /reference\.read:public-guide/);
  assert.doesNotMatch(prompt, /REFERENCE_BODY_SENTINEL/);
  assert.doesNotMatch(MUTATION_SYSTEM_PROMPT, /never add tool usage|NO tools/i);
});

test("U1 mutation validation rejects inherited tooling even when the parent already carries it", async () => {
  const { card, contract } = await frozenSampleContract();
  for (const legacy of [
    `${PARENT}\n\nLegacy step: run legacy.ps1 through powershell to gather events.\n`,
    `${PARENT}\n\nLegacy: fetch https://events.example.com before answering.\n`,
    `${PARENT}\n\nLegacy: install the DSH plugin for extra reach.\n`,
    `${PARENT}\n\nLegacy: read the repository filesystem directly.\n`,
  ]) {
    const mutated = `${legacy}\n\n## Mutation\nReorder the summary sections.\n`;
    const { provider } = recordingProvider(() => editProposalJson("reorder the sections", legacy, mutated));
    const proposer = createLiveMutationProposer({ provider });
    await assert.rejects(
      proposer.proposeMutation({
        eliteSkillMd: legacy,
        diversitySkillMd: `${PARENT}\n\n## Alternative\nAnswer as a short paragraph instead of bullets.\n`,
        failureClasses: ["output_structure"],
        lanePurpose: "exploit_known_failures",
        taskCard: proposerCard(card, contract),
        contract,
      }),
      (e: unknown) =>
        e instanceof LiveProposalError && e.code === "LIVE_MUTATION_U1_BOUNDARY_VIOLATION",
      `a mutation inheriting "${legacy.split("\n").at(-2)?.slice(0, 40)}..." must be rejected`,
    );
  }
});

test("U1-C edit protocol rejects non-SKILL targets and net growth beyond the frozen bound", () => {
  const outsideSkill = JSON.stringify({
    hypothesis: "change a frozen dependency",
    decision: "edit",
    edits: [{
      op: "replace_exact",
      path: "references/private.md",
      oldText: "old",
      newText: "new",
    }],
  });
  assert.throws(
    () => validateU1MutationProposal({ proposalText: outsideSkill, parentSkillMd: PARENT }),
    (error: unknown) => error instanceof LiveProposalError && error.code === "U1_EDIT_SCOPE_VIOLATION",
  );

  const oversized = JSON.stringify({
    hypothesis: "append an unbounded replacement",
    decision: "edit",
    edits: [{
      op: "insert_after",
      anchor: "Answer in three bullet points.",
      text: "x".repeat(1300),
    }],
  });
  assert.throws(
    () => validateU1MutationProposal({ proposalText: oversized, parentSkillMd: PARENT }),
    (error: unknown) => error instanceof LiveProposalError && error.code === "U1_EDIT_GROWTH_LIMIT_EXCEEDED",
  );
});

test("U1 mutation accepts Case A-style refusal text that names forbidden channels", () => {
  const safeBoundary = [
    "# Revised skill",
    "Network access is forbidden — must not fetch, browse, or call HTTP APIs.",
    "Filesystem access is forbidden — must not read, write, or delete files.",
    "External actions are forbidden — do not execute shell commands or scripts.",
    "Never claim to have searched the web, files, or any external system.",
  ].join("\n");
  const result = validateU1MutationProposal({
    proposalText: editProposalJson("state bounded fallback", PARENT, safeBoundary),
    parentSkillMd: PARENT,
  });
  assert.equal(result.skillMd, safeBoundary);
});

test("U1 mutation exposes the shared finding codes for an execution instruction", () => {
  const unsafe = [PARENT, "Fetch the latest website, then write it to output.md."].join("\n");
  assert.throws(
    () => validateU1MutationProposal({
      proposalText: editProposalJson("add forbidden execution", PARENT, unsafe),
      parentSkillMd: PARENT,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LiveProposalError);
      const findings = (error as LiveProposalError & {
        findings?: Array<{ code: string; kind: string }>;
      }).findings;
      assert.deepEqual(
        findings?.map((finding) => `${finding.code}:${finding.kind}`).sort(),
        ["filesystem:execution_instruction", "network:execution_instruction"],
      );
      return true;
    },
  );
});

test("mutation proposer: a no-op mutation is rejected with LIVE_PROPOSAL_NOOP", async () => {
  const { card, contract } = await frozenSampleContract();
  const { provider } = recordingProvider(() => editProposalJson("identical elite", PARENT, PARENT));
  const proposer = createLiveMutationProposer({ provider });
  const diversity = `${PARENT}\n\n## Alternative\nA paragraph form.\n`;
  await assert.rejects(
    proposer.proposeMutation({
      eliteSkillMd: PARENT,
      diversitySkillMd: diversity,
      failureClasses: ["trigger"],
      lanePurpose: "exploit_known_failures",
      taskCard: proposerCard(card, contract),
      contract,
    }),
    (e: unknown) => e instanceof LiveProposalError && e.code === "LIVE_PROPOSAL_NOOP",
  );
});

test("mutation proposer treats no_change as a normal result without recovery", async () => {
  const { card, contract } = await frozenSampleContract();
  const { provider, calls } = sequentialProvider([
    noChangeProposalJson("the train evidence does not justify a safe edit"),
    editProposalJson("must never be requested", PARENT, CHANGED),
  ]);
  const recoveryAttempts: U1ApplicationRecoveryAttempt[] = [];
  const proposer = createLiveMutationProposer({ provider });

  const result = await proposer.proposeMutation({
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\nAlternative`,
    failureClasses: ["output_structure"],
    lanePurpose: "exploit_known_failures",
    taskCard: proposerCard(card, contract),
    contract,
    recovery: {
      subject: { kind: "candidate", generation: 1, lane: "exploit" },
      hooks: {
        onApplicationRecoveryAttempt: (entry: U1ApplicationRecoveryAttempt) => recoveryAttempts.push(entry),
        onDiagnostic: () => undefined,
      },
    },
  });

  assert.equal(result.decision, "no_change");
  assert.equal(result.skillMd, PARENT);
  assert.equal(calls.length, 1);
  assert.deepEqual(recoveryAttempts, []);
});

function sequentialProvider(
  sequence: Array<string | Error>,
): { provider: Provider; calls: ProviderMessage[][] } {
  const calls: ProviderMessage[][] = [];
  let index = 0;
  return {
    calls,
    provider: {
      async chat(messages): Promise<ProviderResponse> {
        calls.push(messages.map((message) => ({ ...message })));
        const next = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return {
          content: next,
          diagnostics: {
            httpStatus: 200,
            choiceCount: 1,
            contentLength: next.length,
            finishReason: "stop",
            usagePresent: false,
            usage: null,
            reasoningContentPresent: false,
          },
        };
      },
    },
  };
}

test("mutation recovery: malformed primary gets one content-free format repair and then succeeds", async () => {
  const { card, contract } = await frozenSampleContract();
  const rawSentinel = "RAW_BAD_RESPONSE_SENTINEL sk-private https://private.example";
  const { provider, calls } = sequentialProvider([
    rawSentinel,
    editProposalJson("valid edit after format repair", PARENT, CHANGED),
  ]);
  const recoveryAttempts: U1ApplicationRecoveryAttempt[] = [];
  const diagnostics: U1RecoveryDiagnostic[] = [];
  const proposer = createLiveMutationProposer({ provider });
  const context = {
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a short paragraph.\n`,
    failureClasses: ["output_structure"],
    lanePurpose: "exploit_known_failures" as const,
    taskCard: proposerCard(card, contract),
    contract,
    recovery: {
    subject: { kind: "candidate" as const, generation: 1, lane: "exploit" as const },
      hooks: {
        onApplicationRecoveryAttempt: (entry: U1ApplicationRecoveryAttempt) => recoveryAttempts.push(entry),
        onDiagnostic: (entry: U1RecoveryDiagnostic) => diagnostics.push(entry),
      },
    },
  };

  const result = await proposer.proposeMutation(context);

  assert.equal(result.skillMd, CHANGED);
  assert.equal(calls.length, 2, "one primary plus one format repair; never a third call");
  assert.equal(recoveryAttempts.length, 1);
  assert.equal(recoveryAttempts[0].mode, "format-repair");
  assert.equal(diagnostics.length, 1, "only the rejected primary has a failure diagnostic");
  assert.equal(diagnostics[0].attempt, 1);
  assert.equal(diagnostics[0].failureCode, "LIVE_PROPOSAL_INVALID_JSON");
  const repairPrompt = calls[1].map((message) => message.content).join("\n");
  assert.match(repairPrompt, /LIVE_PROPOSAL_INVALID_JSON/);
  assert.match(repairPrompt, /hypothesis/);
  assert.match(repairPrompt, /no_change/);
  assert.ok(!repairPrompt.includes('"skillMd"'), "recovery must not request a full-document field");
  assert.ok(!repairPrompt.includes(rawSentinel), "the malformed body must never be fed back to the model");
  assert.ok(!JSON.stringify(diagnostics).includes(rawSentinel), "diagnostics retain only hash/length metadata");
  assertNoHoldoutIds(repairPrompt, contract.holdoutScenarioIds);
  for (const scenario of card.scenarios.filter((entry) => contract.holdoutScenarioIds.includes(entry.id))) {
    assert.ok(!repairPrompt.includes(scenario.userRequest));
    if (scenario.expectedOutcome) assert.ok(!repairPrompt.includes(scenario.expectedOutcome));
  }
});

test("mutation recovery: NOOP gets one constrained re-proposal without echoing the rejected response", async () => {
  const { card, contract } = await frozenSampleContract();
  const rawNoopSentinel = "RAW_NOOP_SENTINEL";
  const { provider, calls } = sequentialProvider([
    editProposalJson(rawNoopSentinel, PARENT, PARENT),
    editProposalJson("different bounded edit", PARENT, CHANGED),
  ]);
  const recoveryAttempts: U1ApplicationRecoveryAttempt[] = [];
  const proposer = createLiveMutationProposer({ provider });
  const result = await proposer.proposeMutation({
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a short paragraph.\n`,
    failureClasses: ["stagnation"],
    lanePurpose: "diversify_alternative",
    taskCard: proposerCard(card, contract),
    contract,
    recovery: {
      subject: { kind: "candidate", generation: 1, lane: "diversify" },
      hooks: {
        onApplicationRecoveryAttempt: (entry: U1ApplicationRecoveryAttempt) => recoveryAttempts.push(entry),
        onDiagnostic: () => undefined,
      },
    },
  });

  assert.equal(result.skillMd, CHANGED);
  assert.equal(calls.length, 2);
  assert.equal(recoveryAttempts.length, 1);
  assert.equal(recoveryAttempts[0].mode, "constrained-reproposal");
  const repairPrompt = calls[1].map((message) => message.content).join("\n");
  assert.match(repairPrompt, /LIVE_PROPOSAL_NOOP/);
  assert.match(repairPrompt, /bounded exact edit|no_change/i);
  assert.ok(!repairPrompt.includes(rawNoopSentinel));
});

test("mutation recovery: a second candidate-contract failure is returned unchanged with no third call", async () => {
  const { card, contract } = await frozenSampleContract();
  const { provider, calls } = sequentialProvider([
    "not-json-primary",
    editProposalJson("still identical", PARENT, PARENT),
    editProposalJson("must never be requested", PARENT, CHANGED),
  ]);
  const diagnostics: U1RecoveryDiagnostic[] = [];
  const proposer = createLiveMutationProposer({ provider });

  await assert.rejects(
    proposer.proposeMutation({
      eliteSkillMd: PARENT,
      diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a short paragraph.\n`,
      failureClasses: ["stagnation"],
      lanePurpose: "exploit_known_failures",
      taskCard: proposerCard(card, contract),
      contract,
      recovery: {
        subject: { kind: "candidate", generation: 2, lane: "exploit" },
        hooks: {
          onApplicationRecoveryAttempt: () => undefined,
          onDiagnostic: (entry: U1RecoveryDiagnostic) => diagnostics.push(entry),
        },
      },
    }),
    (error: unknown) => error instanceof LiveProposalError && error.code === "LIVE_PROPOSAL_NOOP",
  );

  assert.equal(calls.length, 2, "the bounded application recovery is never repeated");
  assert.deepEqual(diagnostics.map((entry) => [entry.attempt, entry.failureCode]), [
    [1, "LIVE_PROPOSAL_INVALID_JSON"],
    [2, "LIVE_PROPOSAL_NOOP"],
  ]);
});

test("mutation recovery: provider and budget failures never become application recovery", async () => {
  const { card, contract } = await frozenSampleContract();
  const cases = [
    new Error("transport failed before a response existed"),
    new ProviderBudgetError("logical_calls", { maxLogicalCalls: 1, maxRetryAttempts: 0 }, "mutation"),
  ];

  for (const failure of cases) {
    const { provider, calls } = sequentialProvider([failure, editProposalJson("must not run", PARENT, CHANGED)]);
    const attempts: U1ApplicationRecoveryAttempt[] = [];
    const proposer = createLiveMutationProposer({ provider });
    await assert.rejects(proposer.proposeMutation({
      eliteSkillMd: PARENT,
      diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a short paragraph.\n`,
      failureClasses: ["transport"],
      lanePurpose: "exploit_known_failures",
      taskCard: proposerCard(card, contract),
      contract,
      recovery: {
        subject: { kind: "candidate", generation: 1, lane: "exploit" },
        hooks: {
          onApplicationRecoveryAttempt: (entry: U1ApplicationRecoveryAttempt) => attempts.push(entry),
          onDiagnostic: () => undefined,
        },
      },
    }));
    assert.equal(calls.length, 1);
    assert.equal(attempts.length, 0);
  }
});

test("mutation recovery: bad primary and valid recovery use different cache identities while an identical rerun still hits both", async () => {
  const { card, contract } = await frozenSampleContract();
  const inner = sequentialProvider([
    "malformed-and-cacheable",
    editProposalJson("valid cached recovery", PARENT, CHANGED),
  ]);
  const cache = createInMemoryResponseCache();
  const provider = createCachingProvider(inner.provider, {
    cache,
    role: "mutation",
    baseMaterial: {
      model: "deepseek-v4-flash",
      providerConfigFingerprint: "fixture-fingerprint",
      baseUrlIdentity: "fixture-endpoint",
      skillSnapshotSha256: "-",
      mode: "live",
      maxOutputTokensBehavior: 16384,
      reasoningMode: "thinking-disabled",
      temperatureBehavior: "provider-default",
      frozenEvidenceSha256: "-",
      stage: "adaptive",
    },
  });
  const proposer = createLiveMutationProposer({ provider });
  const base = {
    eliteSkillMd: PARENT,
    diversitySkillMd: `${PARENT}\n\n## Alternative\nUse a short paragraph.\n`,
    failureClasses: ["output_structure"],
    lanePurpose: "exploit_known_failures" as const,
    taskCard: proposerCard(card, contract),
    contract,
  };

  const first = await proposer.proposeMutation({
    ...base,
    recovery: {
      subject: { kind: "candidate", generation: 1, lane: "exploit" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });
  const second = await proposer.proposeMutation({
    ...base,
    recovery: {
      subject: { kind: "candidate", generation: 2, lane: "diversify" },
      hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
    },
  });

  assert.equal(first.skillMd, CHANGED);
  assert.equal(second.skillMd, CHANGED);
  assert.equal(inner.calls.length, 2, "only primary+recovery reach the inner provider once each");
  assert.deepEqual(cache.stats(), { hits: 2, misses: 2, stores: 2 });
});

test("mutation proposer uses immutable attempt-bound providers for concurrent lanes", async () => {
  const { card, contract } = await frozenSampleContract();
  const parentA = `${PARENT}\n\nMarker A.`;
  const parentB = `${PARENT}\n\nMarker B.`;
  const changedA = `${parentA}\n\nChanged A.`;
  const changedB = `${parentB}\n\nChanged B.`;
  const boundContexts: Array<{ scenarioId: string; snapshotId: string }> = [];
  const provider: Provider & {
    withContext(context: { scenarioId: string; snapshotId: string }): Provider;
    setContext(scenarioId: string, snapshotId: string): void;
  } = {
    setContext() {
      throw new Error("mutable context path must not run");
    },
    withContext(context) {
      const captured = { ...context };
      boundContexts.push(captured);
      return {
        async chat(messages): Promise<ProviderResponse> {
          await new Promise((resolve) => setTimeout(resolve, messages.some((m) => m.content.includes("Marker A")) ? 5 : 0));
          const joined = messages.map((message) => message.content).join("\n");
          return {
            content: joined.includes("Marker A")
              ? editProposalJson("bound concurrent mutation", parentA, changedA)
              : editProposalJson("bound concurrent mutation", parentB, changedB),
          };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("unbound provider path must not run");
    },
  };
  const proposer = createLiveMutationProposer({ provider });

  const [a, b] = await Promise.all([
    proposer.proposeMutation({
      eliteSkillMd: parentA,
      diversitySkillMd: `${PARENT}\nAlternative A`,
      failureClasses: ["a"],
      lanePurpose: "exploit_known_failures",
      taskCard: proposerCard(card, contract),
      contract,
      recovery: {
        subject: { kind: "candidate", generation: 1, lane: "exploit" },
        hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
      },
    }),
    proposer.proposeMutation({
      eliteSkillMd: parentB,
      diversitySkillMd: `${PARENT}\nAlternative B`,
      failureClasses: ["b"],
      lanePurpose: "diversify_alternative",
      taskCard: proposerCard(card, contract),
      contract,
      recovery: {
        subject: { kind: "candidate", generation: 1, lane: "diversify" },
        hooks: { onApplicationRecoveryAttempt: () => undefined, onDiagnostic: () => undefined },
      },
    }),
  ]);

  assert.equal(a.skillMd, changedA);
  assert.equal(b.skillMd, changedB);
  assert.equal(boundContexts.length, 2);
  assert.notEqual(boundContexts[0].snapshotId, boundContexts[1].snapshotId, "different primary requests stay isolated");
});
