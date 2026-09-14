import test from "node:test";
import assert from "node:assert/strict";
import { ScriptedProvider } from "./scriptedProvider.js";

test("ScriptedProvider keys by scenarioId:snapshotId — same scenario, different snapshot hits different scripts", async () => {
  const scripts = new Map<string, string[]>();

  // Same scenario, two different snapshots
  scripts.set("scenario-a:snap-1", [
    JSON.stringify({ type: "final", answer: { projects: [], limitations: "response for snap-1" } }),
  ]);
  scripts.set("scenario-a:snap-2", [
    JSON.stringify({ type: "final", answer: { projects: [], limitations: "response for snap-2" } }),
  ]);

  const provider = new ScriptedProvider(scripts);

  // First run: scenario-a with snap-1
  provider.setContext("scenario-a", "snap-1");
  const resp1 = await provider.chat([
    { role: "system", content: "test system" },
    { role: "user", content: "test user" },
  ]);
  const parsed1 = JSON.parse(resp1.content);
  assert.equal(parsed1.answer.limitations, "response for snap-1");

  // Second run: same scenario but different snapshot
  provider.setContext("scenario-a", "snap-2");
  const resp2 = await provider.chat([
    { role: "system", content: "test system" },
    { role: "user", content: "test user" },
  ]);
  const parsed2 = JSON.parse(resp2.content);
  assert.equal(parsed2.answer.limitations, "response for snap-2");

  // Verify the responses are different
  assert.notEqual(parsed1.answer.limitations, parsed2.answer.limitations);
});

test("ScriptedProvider throws when no script exists for the composite key", async () => {
  const scripts = new Map<string, string[]>();
  scripts.set("scenario-a:snap-1", [
    JSON.stringify({ type: "final", answer: { projects: [], limitations: "ok" } }),
  ]);

  const provider = new ScriptedProvider(scripts);
  provider.setContext("scenario-a", "snap-unknown");

  await assert.rejects(
    () => provider.chat([{ role: "user", content: "test" }]),
    /no script found for key "scenario-a:snap-unknown"/,
  );
});

test("ScriptedProvider resets playback cursor on setContext", async () => {
  const scripts = new Map<string, string[]>();
  scripts.set("scenario-a:snap-1", [
    JSON.stringify({ type: "tool_call", tool: "github.search_repositories", args: {} }),
    JSON.stringify({ type: "final", answer: { projects: [], limitations: "done" } }),
  ]);

  const provider = new ScriptedProvider(scripts);

  // Consume first envelope
  provider.setContext("scenario-a", "snap-1");
  const resp1 = await provider.chat([{ role: "user", content: "test" }]);
  assert.ok(JSON.parse(resp1.content).type === "tool_call");

  // Reset and consume from the beginning again
  provider.setContext("scenario-a", "snap-1");
  const resp2 = await provider.chat([{ role: "user", content: "test" }]);
  assert.ok(JSON.parse(resp2.content).type === "tool_call");
});
