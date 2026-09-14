import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { stableStringify } from "../intake/taskCard.js";
import { packageRoot } from "../cli.js";
import { ScriptedProvider } from "../providers/scriptedProvider.js";
import type { Provider, ProviderMessage, ProviderRequestOptions, ProviderResponse } from "../providers/types.js";
import type { EvaluationContractV3 } from "../types.js";
import { FrozenContextError, type FrozenRuntimeContextManifest } from "./frozenContext.js";
import {
  createU1ScenarioRunnerFactory,
  U1ScenarioEnvelopeError,
  withIsolatedCandidateWorkspace,
} from "./u1ScenarioRunner.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("candidate workspace contains only SKILL.md, stays outside dependencies and is always cleaned", async (t) => {
  const dependencyRoot = await mkdtemp(join(tmpdir(), "skillfoo-external-context-"));
  t.after(() => rm(dependencyRoot, { recursive: true, force: true }));
  const dependencyPath = join(dependencyRoot, "reference.txt");
  await writeFile(dependencyPath, "immutable dependency", "utf8");

  let completedWorkspace = "";
  const result = await withIsolatedCandidateWorkspace("# Candidate\n", async (workspace) => {
    completedWorkspace = workspace.workspaceDir;
    assert.deepEqual(await readdir(workspace.workspaceDir), ["SKILL.md"]);
    assert.equal(await readFile(workspace.skillMdPath, "utf8"), "# Candidate\n");
    await writeFile(workspace.skillMdPath, "# Candidate edited\n", "utf8");
    return "done";
  });
  assert.equal(result, "done");
  assert.equal(await pathExists(completedWorkspace), false);
  assert.equal(await readFile(dependencyPath, "utf8"), "immutable dependency");

  let failedWorkspace = "";
  await assert.rejects(
    () => withIsolatedCandidateWorkspace("# Candidate\n", async (workspace) => {
      failedWorkspace = workspace.workspaceDir;
      throw new Error("scripted failure");
    }),
    /scripted failure/,
  );
  assert.equal(await pathExists(failedWorkspace), false);
});

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function makeRuntimeContext(t: import("node:test").TestContext): Promise<{
  manifestPath: string;
  manifest: FrozenRuntimeContextManifest;
  referencePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-u1-context-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referencePath = join(root, "reference.md");
  await writeFile(referencePath, "# Frozen reference", "utf8");
  await writeFile(join(root, "attachment.json"), '{"value":7}', "utf8");
  await writeFile(join(root, "replay.json"), '{"answer":"fixed"}', "utf8");
  const content: Omit<FrozenRuntimeContextManifest, "manifestSha256"> = {
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [
      { id: "guide", kind: "reference", path: "reference.md", mediaType: "text/markdown", sha256: digest("# Frozen reference") },
      { id: "payload", kind: "attachment", path: "attachment.json", mediaType: "application/json", sha256: digest('{"value":7}') },
    ],
    replays: [{
      id: "fixed-query",
      tool: "catalog.lookup",
      request: { query: "frozen" },
      responsePath: "replay.json",
      responseSha256: digest('{"answer":"fixed"}'),
    }],
  };
  const manifest: FrozenRuntimeContextManifest = {
    ...content,
    manifestSha256: digest(stableStringify(content)),
  };
  const manifestPath = join(root, "runtime-context.v1.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, manifest, referencePath };
}

async function makeMultiReferenceRuntime(
  t: import("node:test").TestContext,
  count: number,
): Promise<{ manifestPath: string; manifest: FrozenRuntimeContextManifest }> {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-u1-multi-context-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries: FrozenRuntimeContextManifest["entries"] = [];
  for (let index = 1; index <= count; index += 1) {
    const content = `frozen reference ${index}`;
    const path = `reference-${index}.txt`;
    await writeFile(join(root, path), content, "utf8");
    entries.push({
      id: `guide-${index}`,
      kind: "reference",
      path,
      mediaType: "text/plain",
      sha256: digest(content),
    });
  }
  const content: Omit<FrozenRuntimeContextManifest, "manifestSha256"> = {
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries,
    replays: [],
  };
  const manifest: FrozenRuntimeContextManifest = {
    ...content,
    manifestSha256: digest(stableStringify(content)),
  };
  const manifestPath = join(root, "runtime-context.v1.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, manifest };
}

function contract(
  adapterId: "instruction-v1" | "reference-v1",
  manifestSha256?: string,
  currentU1 = false,
): EvaluationContractV3 {
  return {
    adapterId,
    sourceHashes: manifestSha256 ? { runtimeContextManifest: manifestSha256 } : {},
    ...(currentU1 ? { u1ContractVersion: "v2", confirmationMode: "human" } : {}),
  } as EvaluationContractV3;
}

class CaptureScriptedProvider extends ScriptedProvider {
  readonly calls: ProviderMessage[][] = [];

  override async chat(
    messages: ProviderMessage[],
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.calls.push(messages.map((message) => ({ ...message })));
    return super.chat(messages, options);
  }
}

const item = {
  itemId: "runtime-item",
  scenarioId: "runtime-scenario",
  split: "public" as const,
  itemType: "trigger",
  input: "Use the declared frozen context and answer.",
  judgingRule: "answer from the frozen context",
};

test("zero-network U1 runner serves frozen tools and reuses one binding across evaluation roles", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  const scripts = new Map<string, string[]>([
    [`runtime-item:starting`, [
      JSON.stringify({ type: "tool_call", tool: "reference.read", args: { id: "guide" } }),
      JSON.stringify({ type: "tool_call", tool: "attachment.read", args: { id: "payload" } }),
      JSON.stringify({ type: "tool_call", tool: "tool.replay", args: { id: "fixed-query", request: { query: "frozen" } } }),
      JSON.stringify({ type: "final", answer: { status: "used frozen context" } }),
    ]],
    ["runtime-item:adaptive", [JSON.stringify({ type: "final", answer: { role: "adaptive" } })]],
    ["runtime-item:direct", [JSON.stringify({ type: "final", answer: { role: "direct" } })]],
  ]);
  const provider = new CaptureScriptedProvider(scripts);

  const starting = await factory.runnerFor("starting-reference", provider)({
    item,
    skillMd: "# Runtime skill\nCall only declared logical ids.",
    snapshotId: "starting",
  });
  assert.equal(starting.terminalReason, "final");
  assert.deepEqual(starting.toolEvents.map((event) => event.toolName), [
    "reference.read",
    "attachment.read",
    "tool.replay",
  ]);
  assert.ok(starting.toolEvents.every((event) => event.success));
  assert.ok(starting.toolEvents.every((event) => !event.resultRef?.includes(runtime.manifestPath)));

  const firstSystem = provider.calls[0]?.find((message) => message.role === "system")?.content ?? "";
  assert.match(firstSystem, /reference\.read/);
  assert.match(firstSystem, /attachment\.read/);
  assert.match(firstSystem, /tool\.replay/);
  assert.match(firstSystem, /guide/);
  assert.doesNotMatch(firstSystem, /reference\.md|attachment\.json|replay\.json/);
  assert.doesNotMatch(firstSystem, /# Frozen reference|\"value\":7|\"answer\":\"fixed\"/);
  assert.ok(provider.calls.slice(1).some((messages) =>
    messages.some((message) => message.role === "user" && message.content.includes("# Frozen reference")),
  ));

  const adaptive = await factory.runnerFor("adaptive", provider)({
    item,
    skillMd: "# Adaptive candidate",
    snapshotId: "adaptive",
  });
  const direct = await factory.runnerFor("direct", provider)({
    item,
    skillMd: "# Direct candidate",
    snapshotId: "direct",
  });
  assert.equal(adaptive.terminalReason, "final");
  assert.equal(direct.terminalReason, "final");
  assert.equal(factory.binding.manifestSha256, runtime.manifest.manifestSha256);
  assert.equal(factory.binding.entryCount, 2);
  assert.equal(factory.binding.replayCount, 1);
  assert.deepEqual(factory.binding.allowedTools, ["reference.read", "attachment.read", "tool.replay"]);
  assert.equal(typeof factory.runnerFor("public-select", provider), "function");
  assert.equal(typeof factory.runnerFor("sealed", provider), "function");
  assert.equal(await readFile(runtime.referencePath, "utf8"), "# Frozen reference");
});

test("all U1 roles stop an undeclared candidate tool request as one sanitized tool_denied event", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  const roles = ["starting-reference", "adaptive", "public-select", "direct", "sealed"] as const;
  const provider = new CaptureScriptedProvider(new Map(roles.map((role) => [
    `runtime-item:${role}`,
    [JSON.stringify({ type: "tool_call", tool: "roi.calculate", args: { investment: 100 } })],
  ])));

  for (const role of roles) {
    const result = await factory.runnerFor(role, provider)({
      item,
      skillMd: `# ${role} candidate`,
      snapshotId: role,
    });
    assert.equal(result.terminalReason, "tool_denied");
    assert.equal(result.turns, 1);
    assert.equal(result.rawFinalResponse, "");
    assert.equal(result.parsedFinalAnswer, undefined);
    assert.deepEqual(result.toolEvents, [{
      turn: 1,
      sequence: 0,
      toolName: "roi.calculate",
      args: {},
      success: false,
      error: "FROZEN_CONTEXT_TOOL_UNDECLARED",
      durationMs: result.toolEvents[0]?.durationMs,
    }]);
  }
  assert.equal(provider.calls.length, roles.length, "a denied request must not trigger another model turn");
});

test("invalid frozen logical arguments and mismatched replay requests are candidate-level tool denials", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  const cases = [
    {
      snapshotId: "unknown-logical-id",
      tool: "reference.read",
      args: { id: "not-declared" },
      errorCode: "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
    },
    {
      snapshotId: "invalid-logical-arguments",
      tool: "attachment.read",
      args: { id: "payload", extra: true },
      errorCode: "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
    },
    {
      snapshotId: "replay-request-mismatch",
      tool: "tool.replay",
      args: { id: "fixed-query", request: { query: "changed" } },
      errorCode: "FROZEN_CONTEXT_REPLAY_MISMATCH",
    },
  ] as const;
  const provider = new CaptureScriptedProvider(new Map(cases.map((entry) => [
    `runtime-item:${entry.snapshotId}`,
    [JSON.stringify({ type: "tool_call", tool: entry.tool, args: entry.args })],
  ])));

  for (const entry of cases) {
    const result = await factory.runnerFor("adaptive", provider)({
      item,
      skillMd: "# Candidate with an invalid frozen request",
      snapshotId: entry.snapshotId,
    });
    assert.equal(result.terminalReason, "tool_denied");
    assert.equal(result.toolEvents.length, 1);
    assert.equal(result.toolEvents[0]?.success, false);
    assert.equal(result.toolEvents[0]?.error, entry.errorCode);
    assert.deepEqual(result.toolEvents[0]?.args, {});
  }
  assert.equal(provider.calls.length, cases.length, "candidate request errors stop before a follow-up model call");
});

test("U1 runner keeps Provider failures outside candidate tool-denial semantics", async () => {
  const factory = await createU1ScenarioRunnerFactory({ contract: contract("instruction-v1") });
  const providerFailure = new Error("scripted provider failure");
  const provider = {
    async chat(): Promise<ProviderResponse> {
      throw providerFailure;
    },
  };
  await assert.rejects(
    () => factory.runnerFor("public-select", provider)({
      item,
      skillMd: "# Candidate",
      snapshotId: "provider-failure",
    }),
    (error: unknown) => error === providerFailure,
  );
});

test("runtime dependency drift exits as an environment error instead of a score", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  await writeFile(runtime.referencePath, "tampered", "utf8");
  const provider = new ScriptedProvider(new Map([
    ["runtime-item:drift", [JSON.stringify({ type: "tool_call", tool: "reference.read", args: { id: "guide" } })]],
  ]));
  await assert.rejects(
    () => factory.runnerFor("adaptive", provider)({ item, skillMd: "# Candidate", snapshotId: "drift" }),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );
});

test("the U1 runner rejects an over-budget tool call before serving another dependency", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  const call = JSON.stringify({ type: "tool_call", tool: "reference.read", args: { id: "guide" } });
  const provider = new CaptureScriptedProvider(new Map([
    ["runtime-item:budget", [call, call, call, call, call, JSON.stringify({ type: "final", answer: "late" })]],
  ]));
  const result = await factory.runnerFor("sealed", provider)({
    item,
    skillMd: "# Candidate",
    snapshotId: "budget",
  });
  assert.equal(result.terminalReason, "too_many_tool_calls");
  assert.equal(result.toolEvents.length, 4);
  assert.ok(result.toolEvents.every((event) => event.success));
});

test("current U1 expands raw r=5 to p=10 so a final on model call eight completes in attempt one", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256, true),
    runtimeContextPath: runtime.manifestPath,
  });
  let boundAttempts = 0;
  let totalModelCalls = 0;
  const provider = {
    withContext(): Provider {
      boundAttempts += 1;
      let modelCall = 0;
      return {
        async chat(): Promise<ProviderResponse> {
          modelCall += 1;
          totalModelCalls += 1;
          return modelCall === 8
            ? { content: JSON.stringify({ type: "final", answer: { completedAt: 8 } }) }
            : {
                content: JSON.stringify({
                  type: "tool_call",
                  tool: "reference.read",
                  args: { id: "guide" },
                }),
              };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  const result = await factory.runnerFor("adaptive", provider)({
    item,
    skillMd: "# Candidate requiring eight model calls",
    snapshotId: "expanded-primary-cap",
  });
  assert.equal(result.terminalReason, "final");
  assert.equal(totalModelCalls, 8);
  assert.equal(boundAttempts, 1, "calls six through ten belong to attempt one, not a retry");
  assert.equal(result.toolEvents.length, 7);
});

test("current U1 reserves two independent p=10 attempts and never sends model call twenty-one", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256, true),
    runtimeContextPath: runtime.manifestPath,
  });
  let boundAttempts = 0;
  let totalModelCalls = 0;
  const provider = {
    withContext(): Provider {
      boundAttempts += 1;
      return {
        async chat(): Promise<ProviderResponse> {
          totalModelCalls += 1;
          return {
            content: JSON.stringify({
              type: "tool_call",
              tool: "reference.read",
              args: { id: "guide" },
            }),
          };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  const result = await factory.runnerFor("public-select", provider)({
    item,
    skillMd: "# Candidate exhausting both attempts",
    snapshotId: "two-independent-attempts",
  });
  assert.equal(result.terminalReason, "persistent_candidate_loop");
  assert.equal(boundAttempts, 2);
  assert.equal(totalModelCalls, 20, "attempts one and two each own p=10; attempt three is forbidden");
  assert.deepEqual(result.applicationRecovery?.attempts.map((attempt) => attempt.modelCalls), [10, 10]);
});

test("two non-repeating authorized evidence walks that exhaust p are diagnosed as an underestimated scenario envelope", async (t) => {
  const runtime = await makeMultiReferenceRuntime(t, 9);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256, true),
    runtimeContextPath: runtime.manifestPath,
  });
  const provider = {
    withContext(): Provider {
      let modelCall = 0;
      return {
        async chat(): Promise<ProviderResponse> {
          modelCall += 1;
          return {
            content: JSON.stringify({
              type: "tool_call",
              tool: "reference.read",
              args: { id: `guide-${Math.min(modelCall, 9)}` },
            }),
          };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  await assert.rejects(
    () => factory.runnerFor("adaptive", provider)({
      item,
      skillMd: "# Candidate with a legitimate long evidence walk",
      snapshotId: "scenario-underestimated",
    }),
    (error: unknown) => {
      assert.ok(error instanceof U1ScenarioEnvelopeError);
      assert.equal(error.code, "SCENARIO_ENVELOPE_UNDERESTIMATED");
      assert.deepEqual(
        error.safeEvidence.attempts.map(
          (attempt) => (attempt as typeof attempt & { failedToolCalls?: number }).failedToolCalls,
        ),
        [0, 0],
        "persisted safe evidence must prove that every exhausted tool trajectory succeeded",
      );
      return true;
    },
  );
});

test("current U1 sealed expands its one-shot p=10 capacity but never opens an application retry", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256, true),
    runtimeContextPath: runtime.manifestPath,
  });
  let boundAttempts = 0;
  let totalModelCalls = 0;
  const provider = {
    withContext(): Provider {
      boundAttempts += 1;
      let modelCall = 0;
      return {
        async chat(): Promise<ProviderResponse> {
          modelCall += 1;
          totalModelCalls += 1;
          return modelCall === 8
            ? { content: JSON.stringify({ type: "final", answer: { sealed: true } }) }
            : {
                content: JSON.stringify({
                  type: "tool_call",
                  tool: "reference.read",
                  args: { id: "guide" },
                }),
              };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  const result = await factory.runnerFor("sealed", provider)({
    item: { ...item, split: "holdout" as const },
    skillMd: "# Sealed candidate requiring eight model calls",
    snapshotId: "sealed-expanded-one-shot",
  });
  assert.equal(result.terminalReason, "final");
  assert.equal(boundAttempts, 1);
  assert.equal(totalModelCalls, 8);
});

test("a U1 candidate loop gets exactly one clean application retry with a distinct attempt identity", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  const boundContexts: Array<{ scenarioId: string; snapshotId: string }> = [];
  let applicationAttempt = 0;
  const provider = {
    withContext(context: { scenarioId: string; snapshotId: string }): Provider {
      boundContexts.push(context);
      applicationAttempt += 1;
      let call = 0;
      return {
        async chat(): Promise<ProviderResponse> {
          call += 1;
          if (applicationAttempt === 1) {
            return {
              content: JSON.stringify({
                type: "tool_call",
                tool: "reference.read",
                args: { id: "guide" },
              }),
            };
          }
          assert.equal(call, 1, "the clean retry starts from a fresh conversation");
          return { content: JSON.stringify({ type: "final", answer: { recovered: true } }) };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  const result = await factory.runnerFor("adaptive", provider)({
    item,
    skillMd: "# Candidate that may loop",
    snapshotId: "single-retry",
  });
  const recovery = result as typeof result & {
    applicationRecovery?: {
      outcome: string;
      attempts: Array<{ attempt: number; terminalReason: string; modelCalls: number; attemptIdentitySha256: string }>;
    };
  };
  assert.equal(result.terminalReason, "final");
  assert.equal(recovery.applicationRecovery?.outcome, "recovered_after_single_retry");
  assert.equal(recovery.applicationRecovery?.attempts.length, 2);
  assert.deepEqual(recovery.applicationRecovery?.attempts.map((attempt) => attempt.terminalReason), [
    "too_many_tool_calls",
    "final",
  ]);
  assert.equal(boundContexts.length, 2);
  assert.notEqual(boundContexts[0]?.snapshotId, boundContexts[1]?.snapshotId);
  assert.notEqual(
    recovery.applicationRecovery?.attempts[0]?.attemptIdentitySha256,
    recovery.applicationRecovery?.attempts[1]?.attemptIdentitySha256,
  );
});

test("setContext-only providers receive each fresh application-attempt identity as the runner snapshot", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256, true),
    runtimeContextPath: runtime.manifestPath,
  });
  const boundSnapshots: string[] = [];
  let applicationAttempt = 0;
  const provider: Provider & { setContext(scenarioId: string, snapshotId: string): void } = {
    setContext(scenarioId, snapshotId) {
      assert.equal(scenarioId, item.itemId);
      boundSnapshots.push(snapshotId);
      applicationAttempt += 1;
    },
    async chat(): Promise<ProviderResponse> {
      if (applicationAttempt === 1) {
        return {
          content: JSON.stringify({
            type: "tool_call",
            tool: "reference.read",
            args: { id: "guide" },
          }),
        };
      }
      return { content: JSON.stringify({ type: "final", answer: { recovered: true } }) };
    },
  };

  const callerSnapshotId = "caller-snapshot-must-not-identify-attempts";
  const result = await factory.runnerFor("adaptive", provider)({
    item,
    skillMd: "# Candidate with a clean setContext retry",
    snapshotId: callerSnapshotId,
  });
  const attempts = result.applicationRecovery?.attempts;
  assert.equal(result.terminalReason, "final");
  assert.equal(attempts?.length, 2);
  assert.deepEqual(
    boundSnapshots,
    attempts?.map((attempt) => attempt.attemptIdentitySha256),
    "the mutable context fallback must bind the same fresh identities persisted in attempt evidence",
  );
  assert.notEqual(boundSnapshots[0], boundSnapshots[1]);
  assert.ok(boundSnapshots.every((snapshotId) => snapshotId !== callerSnapshotId));
});

test("a persistent U1 candidate loop stops after attempt two while sealed remains one-shot", async (t) => {
  const runtime = await makeRuntimeContext(t);
  const factory = await createU1ScenarioRunnerFactory({
    contract: contract("reference-v1", runtime.manifest.manifestSha256),
    runtimeContextPath: runtime.manifestPath,
  });
  let boundAttempts = 0;
  const loopingProvider = {
    withContext(): Provider {
      boundAttempts += 1;
      return {
        async chat(): Promise<ProviderResponse> {
          return {
            content: JSON.stringify({
              type: "tool_call",
              tool: "reference.read",
              args: { id: "guide" },
            }),
          };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("the U1 runner must bind an application-attempt context");
    },
  };

  const persistent = await factory.runnerFor("public-select", loopingProvider)({
    item,
    skillMd: "# Persistently looping candidate",
    snapshotId: "persistent-loop",
  });
  const recovery = persistent as typeof persistent & {
    applicationRecovery?: { outcome: string; attempts: Array<{ terminalReason: string }> };
  };
  assert.equal(persistent.terminalReason, "persistent_candidate_loop");
  assert.equal(recovery.applicationRecovery?.outcome, "persistent_candidate_loop");
  assert.equal(recovery.applicationRecovery?.attempts.length, 2);
  assert.equal(boundAttempts, 2, "there must never be a third application attempt");

  boundAttempts = 0;
  const sealed = await factory.runnerFor("sealed", loopingProvider)({
    item,
    skillMd: "# Sealed candidate",
    snapshotId: "sealed-one-shot",
  });
  assert.equal(sealed.terminalReason, "too_many_tool_calls");
  assert.equal(boundAttempts, 1, "sealed capacity does not authorize an application-level retry");
  assert.equal((sealed as typeof sealed & { applicationRecovery?: unknown }).applicationRecovery, undefined);
});

test("instruction-v1 legacy U1 runner remains zero-tool and needs no runtime context", async () => {
  const factory = await createU1ScenarioRunnerFactory({ contract: contract("instruction-v1") });
  const provider = new ScriptedProvider(new Map([
    ["runtime-item:legacy", [JSON.stringify({ type: "final", answer: { legacy: true } })]],
  ]));
  const result = await factory.runnerFor("starting-reference", provider)({
    item,
    skillMd: "# Legacy instruction skill",
    snapshotId: "legacy",
  });
  assert.equal(result.terminalReason, "final");
  assert.deepEqual(result.toolEvents, []);
  assert.deepEqual(factory.binding.allowedTools, []);
  assert.equal(factory.binding.manifestSha256, null);
});

test("existing U1 CLI commands expose one explicit runtime-context option and no new top-level command", async () => {
  const execFileAsync = promisify(execFile);
  for (const command of ["eval-freeze", "adaptive-run", "direct-run", "audit-compare"]) {
    const help = await execFileAsync(process.execPath, [join(packageRoot, "dist", "cli.js"), command, "--help"]);
    assert.match(help.stdout, /--runtime-context <path>/);
  }
  const rootHelp = await execFileAsync(process.execPath, [join(packageRoot, "dist", "cli.js"), "--help"]);
  assert.doesNotMatch(rootHelp.stdout, /frozen-context|runtime-context\s+command/i);
});
