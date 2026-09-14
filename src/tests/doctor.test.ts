import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableStringify } from "../intake/taskCard.js";
import {
  diagnoseSkill,
  DoctorError,
  doctorExitCode,
} from "../runtime/doctor.js";
import {
  FrozenContextError,
  type FrozenRuntimeContextManifest,
} from "../runtime/frozenContext.js";
import {
  findAdaptersForCapability,
  getAdapterDeclaration,
  listAdapterContracts,
  listAdapterDeclarations,
} from "../runtime/adapterRegistry.js";

// Current skill-level doctor + declarative U1 registry.
// Doctor only reads files and hashes them: no provider, no tool, no
// network. Every rejection path carries a stable machine code.

async function makeSkillDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-doctor-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function makeRuntimeContext(t: TestContext): Promise<{
  manifestPath: string;
  referencePath: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-doctor-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referencePath = join(root, "reference.txt");
  await writeFile(referencePath, "alpha", "utf8");
  const content: Omit<FrozenRuntimeContextManifest, "manifestSha256"> = {
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "guide",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: digest("alpha"),
    }],
    replays: [],
  };
  const manifest: FrozenRuntimeContextManifest = {
    ...content,
    manifestSha256: digest(stableStringify(content)),
  };
  const manifestPath = join(root, "runtime-context.v1.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, referencePath, root };
}

// ── Registry declarations ────────────────────────────────────────

test("the declaration registry contains only current executable U1 adapters", () => {
  const declarations = listAdapterDeclarations();
  const byId = new Map(declarations.map((d) => [d.id, d]));

  assert.equal(byId.get("instruction-v1")?.executionTier, "U1");
  assert.equal(byId.get("instruction-v1")?.networkPolicy, "denied");

  assert.equal(byId.get("reference-v1")?.implementation, "implemented");
  assert.equal(byId.get("reference-v1")?.networkPolicy, "denied");

  assert.deepEqual([...byId.keys()], ["instruction-v1", "reference-v1"]);

  for (const contract of listAdapterContracts()) {
    const declaration = byId.get(contract.adapterId);
    assert.ok(declaration, `${contract.adapterId} must have a V3 declaration`);
    assert.equal(
      declaration.implementation === "implemented",
      contract.implemented,
      `${contract.adapterId}: declaration and executable contract must agree`,
    );
  }
});

test("capabilities resolve through the declaration registry", () => {
  assert.deepEqual(findAdaptersForCapability("instruction").map((d) => d.id), ["instruction-v1"]);
  assert.deepEqual(findAdaptersForCapability("reference").map((d) => d.id), ["reference-v1"]);
  assert.deepEqual(findAdaptersForCapability("web"), []);
  assert.equal(getAdapterDeclaration("unknown-v1"), undefined);
  assert.equal(getAdapterDeclaration("web-fetch-v1"), undefined);
});

// ── Diagnosis tiers ──────────────────────────────────────────────

test("any minimal SKILL.md yields a U0 diagnosis", async () => {
  const dir = await makeSkillDir({ "SKILL.md": "# Digest\nWrite a weekly digest." });
  const report = await diagnoseSkill(dir);

  assert.equal(report.schemaVersion, 3);
  assert.equal(report.maxTier, "U0");
  assert.equal(report.needsAdapter, false);
  assert.equal(report.readyToRun, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.skillMd.bytes, "# Digest\nWrite a weekly digest.".length);
  assert.match(report.skillMd.sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.humanSummary.length > 0);
  assert.ok(report.suggestedTaskCard.goal.length > 0);
  assert.equal(report.suggestedTaskCard.suggestionsOnly, true);
  assert.equal(report.suggestedTaskCard.capabilityBoundary.network, "forbidden");
});

test("an instruction declaration reaches U1 and is runnable since T08", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "# Helper",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["instruction"] }),
  });
  const report = await diagnoseSkill(dir);

  assert.equal(report.maxTier, "U1");
  assert.equal(report.needsAdapter, true);
  const adapter = report.adapters.find((a) => a.capability === "instruction");
  assert.ok(adapter);
  assert.equal(adapter.adapterId, "instruction-v1");
  assert.equal(adapter.executionTier, "U1");
  assert.equal(adapter.implementation, "implemented");
  assert.equal(adapter.satisfied, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.readyToRun, true);
  assert.equal(doctorExitCode(report), 0);
});

test("a reference declaration without a runtime context is diagnosed as not ready", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["reference"] }),
  });
  const report = await diagnoseSkill(dir);

  const adapter = report.adapters.find((entry) => entry.capability === "reference");
  assert.ok(adapter);
  assert.equal(adapter.adapterId, "reference-v1");
  assert.equal(adapter.implementation, "implemented");
  assert.equal(adapter.satisfied, false);
  assert.equal(report.maxTier, "U1");
  assert.ok(report.blockers.some(
    (blocker) => (blocker as { code: string }).code === "MISSING_RUNTIME_CONTEXT",
  ));
  assert.equal(report.readyToRun, false);
  assert.equal(doctorExitCode(report), 3);
});

test("a reference declaration is ready only with a valid frozen runtime context", async (t) => {
  const dir = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["reference"] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = await makeRuntimeContext(t);
  const report = await diagnoseSkill(dir, { runtimeContextPath: runtime.manifestPath });

  assert.equal(report.maxTier, "U1");
  assert.equal(report.readyToRun, true);
  assert.equal(doctorExitCode(report), 0);
  assert.equal(report.runtimeContextPresent, true);
  assert.deepEqual(report.runtimeContext, {
    adapterId: "reference-v1",
    manifestSha256: report.runtimeContext?.manifestSha256,
    entryCount: 1,
    replayCount: 0,
    allowedTools: ["reference.read", "attachment.read", "tool.replay"],
  });
  assert.match(report.runtimeContext?.manifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(report.adapters.find((entry) => entry.capability === "reference")?.satisfied, true);
  const summary = JSON.stringify(report.runtimeContext);
  assert.equal(summary.includes(runtime.root), false);
  assert.equal(summary.includes("alpha"), false);
  assert.equal(summary.includes("reference.txt"), false);
});

test("reference Doctor preserves invalid, drift, sealed and linked manifest failures", async (t) => {
  const dir = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["reference"] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const invalidRoot = await mkdtemp(join(tmpdir(), "skillfoo-doctor-invalid-"));
  t.after(() => rm(invalidRoot, { recursive: true, force: true }));
  const invalidManifest = join(invalidRoot, "runtime-context.v1.json");
  await writeFile(invalidManifest, "{}", "utf8");
  await assert.rejects(
    () => diagnoseSkill(dir, { runtimeContextPath: invalidManifest }),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_MANIFEST_INVALID",
  );

  const drift = await makeRuntimeContext(t);
  await writeFile(drift.referencePath, "changed", "utf8");
  await assert.rejects(
    () => diagnoseSkill(dir, { runtimeContextPath: drift.manifestPath }),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );

  const sealedRoot = await mkdtemp(join(tmpdir(), "skillfoo-doctor-sealed-parent-"));
  t.after(() => rm(sealedRoot, { recursive: true, force: true }));
  const sealedDir = join(sealedRoot, "sealed");
  await mkdir(sealedDir);
  const sealedManifest = join(sealedDir, "runtime-context.v1.json");
  await writeFile(sealedManifest, "not-read", "utf8");
  await assert.rejects(
    () => diagnoseSkill(dir, { runtimeContextPath: sealedManifest }),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN",
  );

  const linked = await makeRuntimeContext(t);
  const linkParent = await mkdtemp(join(tmpdir(), "skillfoo-doctor-link-parent-"));
  t.after(() => rm(linkParent, { recursive: true, force: true }));
  const linkedRoot = join(linkParent, "linked-context");
  await symlink(linked.root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const linkedManifest = join(linkedRoot, "runtime-context.v1.json");
  await assert.rejects(
    () => diagnoseSkill(dir, { runtimeContextPath: linkedManifest }),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_SYMLINK_REJECTED",
  );
});

test("a non-reference skill rejects a surplus runtime-context argument", async (t) => {
  const dir = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["instruction"] }),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => diagnoseSkill(dir, { runtimeContextPath: "unused-runtime-context.v1.json" }),
    (error: unknown) =>
      error instanceof DoctorError && error.code === "RUNTIME_CONTEXT_NOT_APPLICABLE",
  );
});

test("unregistered capabilities return a structured UNSUPPORTED_ADAPTER blocker", async () => {
  const dir = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["web", "sql"] }),
  });
  const report = await diagnoseSkill(dir);

  assert.equal(report.maxTier, "U0");
  for (const capability of ["web", "sql"]) {
    const entry = report.adapters.find((a) => a.capability === capability);
    assert.ok(entry);
    assert.equal(entry.adapterId, null);
    assert.equal(entry.implementation, "unsupported");
    assert.equal(entry.satisfied, false);
    const blocker = report.blockers.find(
      (b) => b.code === "UNSUPPORTED_ADAPTER" && b.capability === capability,
    );
    assert.ok(blocker, `expected UNSUPPORTED_ADAPTER blocker for ${capability}`);
  }
});

// ── Deterministic rejections ─────────────────────────────────────

test("structural failures throw deterministic DoctorError codes", async () => {
  const missing = await mkdtemp(join(tmpdir(), "skillfoo-doctor-"));
  await assert.rejects(
    () => diagnoseSkill(missing),
    (err: unknown) => err instanceof DoctorError && err.code === "SKILL_NOT_FOUND",
  );

  const empty = await makeSkillDir({ "SKILL.md": "   \n" });
  await assert.rejects(
    () => diagnoseSkill(empty),
    (err: unknown) => err instanceof DoctorError && err.code === "SKILL_EMPTY",
  );

  const badJson = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": "{not json",
  });
  await assert.rejects(
    () => diagnoseSkill(badJson),
    (err: unknown) => err instanceof DoctorError && err.code === "INVALID_DECLARATION",
  );

  const badAllowlist = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({
      capabilities: ["instruction"],
      networkAllowlist: ["not-a-url"],
    }),
  });
  await assert.rejects(
    () => diagnoseSkill(badAllowlist),
    (err: unknown) => err instanceof DoctorError && err.code === "INVALID_DECLARATION",
  );
});

test("exit codes are deterministic per diagnosis outcome", async () => {
  const clean = await makeSkillDir({ "SKILL.md": "# x" });
  assert.equal(doctorExitCode(await diagnoseSkill(clean)), 0);

  const blocked = await makeSkillDir({
    "SKILL.md": "# x",
    "skillfoo.declaration.json": JSON.stringify({ capabilities: ["web"] }),
  });
  assert.equal(doctorExitCode(await diagnoseSkill(blocked)), 3);
});
