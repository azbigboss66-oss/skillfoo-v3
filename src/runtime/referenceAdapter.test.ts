import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableStringify } from "../intake/taskCard.js";
import type { AdapterContext } from "./capabilityAdapter.js";
import type { Provider, ProviderMessage } from "../providers/types.js";
import {
  FrozenContextError,
  loadFrozenRuntimeContext,
  type FrozenRuntimeContextManifest,
} from "./frozenContext.js";
import { runInstructionScenario } from "./instructionAdapter.js";
import { createReferenceAdapter } from "./referenceAdapter.js";

const digest = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-reference-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "reference.md"), "# Frozen reference", "utf8");
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
  return loadFrozenRuntimeContext(manifestPath);
}

const context: AdapterContext = {
  mode: "fixture",
  maxResponseBytes: 1_048_576,
  timeoutMs: 8_000,
  allowNetwork: false,
};

test("reference-v1 rejects undeclared tools and path, URL or command-shaped arguments", async (t) => {
  const runtimeContext = await fixture(t);
  const adapter = createReferenceAdapter({
    runtimeContext,
    policy: {
      adapterId: "reference-v1",
      allowedTools: ["reference.read", "attachment.read", "tool.replay"],
      maxToolCalls: 4,
      networkMode: "fixture",
      lockedPaths: [],
    },
  });

  await assert.rejects(
    () => adapter.execute({ tool: "script.run", args: { command: "whoami" } }, context),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_TOOL_UNDECLARED",
  );
  for (const args of [
    { id: "guide", path: "../outside" },
    { id: "guide", url: "https://example.com" },
    { id: "guide", command: "type secret" },
    { id: "guide", cwd: "C:/" },
    { id: "guide", executable: "cmd.exe" },
  ]) {
    await assert.rejects(
      () => adapter.execute({ tool: "reference.read", args }, context),
      (error: unknown) =>
        error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
    );
  }
  await assert.rejects(
    () => adapter.execute(
      { tool: "reference.read", args: { id: "guide" } },
      { ...context, mode: "record", allowNetwork: true },
    ),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_RECORD_MODE_FORBIDDEN",
  );
});

test("tool.replay requires the exact canonical frozen request", async (t) => {
  const runtimeContext = await fixture(t);
  const adapter = createReferenceAdapter({
    runtimeContext,
    policy: {
      adapterId: "reference-v1",
      allowedTools: ["reference.read", "attachment.read", "tool.replay"],
      maxToolCalls: 4,
      networkMode: "fixture",
      lockedPaths: [],
    },
  });

  const exact = await adapter.execute({
    tool: "tool.replay",
    args: { id: "fixed-query", request: { query: "frozen" } },
  }, context);
  assert.deepEqual(exact.result, { answer: "fixed" });

  await assert.rejects(
    () => adapter.execute({
      tool: "tool.replay",
      args: { id: "fixed-query", request: { query: "different" } },
    }, context),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_REPLAY_MISMATCH",
  );
});

test("reference-v1 enforces maxResponseBytes for reference, attachment and replay", async (t) => {
  const runtimeContext = await fixture(t);
  const adapter = createReferenceAdapter({
    runtimeContext,
    policy: {
      adapterId: "reference-v1",
      allowedTools: ["reference.read", "attachment.read", "tool.replay"],
      maxToolCalls: 4,
      networkMode: "fixture",
      lockedPaths: [],
    },
  });
  const calls = [
    { tool: "reference.read", args: { id: "guide" }, bytes: Buffer.byteLength("# Frozen reference", "utf8") },
    { tool: "attachment.read", args: { id: "payload" }, bytes: Buffer.byteLength('{"value":7}', "utf8") },
    {
      tool: "tool.replay",
      args: { id: "fixed-query", request: { query: "frozen" } },
      bytes: Buffer.byteLength('{"answer":"fixed"}', "utf8"),
    },
  ];

  for (const call of calls) {
    await assert.rejects(
      () => adapter.execute(call, { ...context, maxResponseBytes: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof FrozenContextError);
        assert.equal((error as { code?: string }).code, "FROZEN_CONTEXT_RESPONSE_TOO_LARGE");
        assert.doesNotMatch(error.message, /Frozen reference|value|answer|skillfoo-reference-adapter/i);
        return true;
      },
    );
    await assert.doesNotReject(
      () => adapter.execute(call, { ...context, maxResponseBytes: call.bytes }),
    );
  }
});

test("an oversized frozen result fails before it enters a scenario message", async (t) => {
  const runtimeContext = await fixture(t);
  const adapter = createReferenceAdapter({
    runtimeContext,
    policy: {
      adapterId: "reference-v1",
      allowedTools: ["reference.read", "attachment.read", "tool.replay"],
      maxToolCalls: 4,
      networkMode: "fixture",
      lockedPaths: [],
    },
  });
  const providerMessages: ProviderMessage[][] = [];
  const provider: Provider = {
    async chat(messages) {
      providerMessages.push(messages.map((message) => ({ ...message })));
      return {
        content: JSON.stringify({ type: "tool_call", tool: "reference.read", args: { id: "guide" } }),
      };
    },
  };

  await assert.rejects(
    () => runInstructionScenario({
      provider,
      skillMarkdown: "# Candidate",
      outputContract: "Return JSON.",
      scenario: { id: "response-size", userPrompt: "Read the guide.", maxToolCalls: 1 },
      snapshotId: "candidate",
      adapter,
      adapterContext: { ...context, maxResponseBytes: 1 },
    }),
    (error: unknown) =>
      error instanceof FrozenContextError &&
      (error as { code?: string }).code === "FROZEN_CONTEXT_RESPONSE_TOO_LARGE",
  );
  assert.equal(providerMessages.length, 1);
  assert.ok(providerMessages.every((messages) =>
    messages.every((message) => !message.content.includes("# Frozen reference")),
  ));
});
