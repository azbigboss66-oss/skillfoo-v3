import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  assertFormalBootstrapBundleIsolation,
  runBootstrap,
  runFormalBootstrap,
  type BootstrapProposer,
} from "./runBootstrap.js";
import { assertRootUnchanged, materializeCandidate } from "./freezeRoots.js";
import { forbiddenToolViolations } from "./createScaffold.js";
import { getAdapterDeclaration } from "../runtime/adapterRegistry.js";
import {
  BootstrapBundleSchema,
  TaskCardSchema,
  type EvaluationContractV3,
  type TaskCard,
} from "../types.js";
import { taskCardContentSha256 } from "../intake/taskCard.js";
import { sampleTaskCard } from "../evalFactory/composeBlueprint.test.js";
import { composeBlueprint } from "../evalFactory/composeBlueprint.js";
import { createFixtureGenerator, generateDraft } from "../evalFactory/generateDraft.js";
import { createRuleCurator, curateDraft } from "../evalFactory/curateDraft.js";
import { freezeContract, type FreezeInput } from "../evalFactory/freezeContract.js";
import { createEvaluationReview, confirmEvaluationReview } from "../evalFactory/evaluationReview.js";
import { runCli } from "../cli.js";

const SAMPLE_DEVIATION_REASON =
  "low sample: 3 scenarios make the isolation-safe holdout floor 3 of 8 items (0.375 vs target 0.2)";

export const ROUGH_B0_MARKER = "fetch-data.ps1";

const B0_SKILL_MD = [
  "# Repo Digest Skill",
  "",
  "You are a helpful assistant that summarizes repository activity for maintainers.",
  "",
  "## Workflow",
  `1. Run scripts/${ROUGH_B0_MARKER} to pull the latest repository events.`,
  "2. Summarize whatever the script prints.",
].join("\n");

export async function frozenSampleContract(): Promise<{
  card: TaskCard;
  contract: EvaluationContractV3;
}> {
  const card = sampleTaskCard();
  const blueprint = composeBlueprint(card);
  const draft = await generateDraft(blueprint, card, createFixtureGenerator());
  const curation = await curateDraft(draft, card, blueprint, createRuleCurator());
  const evaluationReview = confirmEvaluationReview(
    createEvaluationReview({ taskCard: card, draft, curation }),
    "evaluation-review-fixture",
    { mode: "test-fixture" },
  );
  const bundle = await freezeContract({
    taskCard: card,
    blueprint,
    draft,
    curation,
    evaluationReview,
    evidenceMode: "test-fixture",
    adapterId: "instruction-v1",
    deviationReason: SAMPLE_DEVIATION_REASON,
  } as FreezeInput);
  return { card, contract: bundle.contract };
}

async function makeBootstrapEnv(): Promise<{ base: string; skillDir: string; outDir: string; s0Dir: string }> {
  const base = await mkdtemp(join(tmpdir(), "t06-run-"));
  const skillDir = join(base, "b0");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), B0_SKILL_MD, "utf-8");
  const outDir = join(base, "out");
  const s0Dir = join(outDir, "s0");
  return { base, skillDir, outDir, s0Dir };
}

async function makeFormalBootstrapEnv(skillBytes = Buffer.from("\uFEFF# 正式 B0\r\n\r\n只依据输入证据回答。\r\n", "utf8")) {
  const base = await mkdtemp(join(tmpdir(), "t06-formal-bootstrap-"));
  const sourceSkillDir = join(base, "b0-source");
  const formalDir = join(base, "formal-evidence");
  const outDir = join(formalDir, "bootstrap");
  await mkdir(sourceSkillDir);
  await mkdir(formalDir);
  await writeFile(join(sourceSkillDir, "SKILL.md"), skillBytes);
  const { card, contract } = await frozenSampleContract();
  return {
    base,
    sourceSkillDir,
    formalDir,
    outDir,
    skillBytes,
    card,
    contract,
    adapter: getAdapterDeclaration("instruction-v1")!,
  };
}

function formalStageNames(entries: string[]): string[] {
  return entries.filter((name) => name.startsWith(".formal-bootstrap-tmp-"));
}

test("fixture bootstrap produces two roots and one bounded candidate per lane, both bound to the contract", async () => {
  const { card, contract } = await frozenSampleContract();
  const env = await makeBootstrapEnv();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const { bundle } = await runBootstrap({
    skillDir: env.skillDir,
    taskCard: card,
    contract,
    adapter,
    s0Dir: env.s0Dir,
  });

  assert.ok(BootstrapBundleSchema.safeParse(bundle).success);
  assert.equal(bundle.b0.kind, "b0");
  assert.equal(bundle.s0.kind, "s0");
  assert.equal(bundle.provider, "fixture");
  assert.equal(bundle.dryRun, true);
  assert.equal(bundle.contractSha256, contract.contractSha256);

  const okLanes = bundle.lanes.filter((lane) => lane.status === "ok");
  assert.equal(okLanes.length, 2);
  assert.equal(bundle.lanes.find((l) => l.lane === "b0-repair")?.candidate?.originRoot, "b0");
  assert.equal(bundle.lanes.find((l) => l.lane === "s0-scaffold")?.candidate?.originRoot, "s0");
  for (const lane of okLanes) {
    assert.equal(lane.candidate?.contractSha256, contract.contractSha256);
    assert.equal(lane.candidate?.files.length, 1);
    assert.equal(lane.candidate?.files[0].path, "SKILL.md");
  }

  const s0Skill = await readFile(join(env.s0Dir, "SKILL.md"), "utf-8");
  assert.ok(s0Skill.includes(card.goal));
  assert.equal(s0Skill.includes(ROUGH_B0_MARKER), false);
});

test("B0 and S0 root hashes are reproducible across runs", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const envA = await makeBootstrapEnv();
  const envB = await makeBootstrapEnv();
  const a = (
    await runBootstrap({ skillDir: envA.skillDir, taskCard: card, contract, adapter, s0Dir: envA.s0Dir })
  ).bundle;
  const b = (
    await runBootstrap({ skillDir: envB.skillDir, taskCard: card, contract, adapter, s0Dir: envB.s0Dir })
  ).bundle;
  assert.equal(a.b0.rootHash, b.b0.rootHash);
  assert.equal(a.s0.rootHash, b.s0.rootHash);
});

test("formal bootstrap commits a self-contained byte-identical B0, S0 and sealed-free bundle", async (t) => {
  const env = await makeFormalBootstrapEnv();
  t.after(async () => rm(env.base, { recursive: true, force: true }));
  const result = await runFormalBootstrap({
    skillDir: env.sourceSkillDir,
    formalDir: env.formalDir,
    outDir: env.outDir,
    taskCard: env.card,
    contract: env.contract,
    adapter: env.adapter,
  });

  assert.deepEqual(await readFile(join(env.formalDir, "b0-source", "SKILL.md")), env.skillBytes);
  assert.deepEqual(await readdir(join(env.formalDir, "b0-source")), ["SKILL.md"]);
  assert.deepEqual(await readdir(join(env.outDir, "s0")), ["SKILL.md"]);
  const bundleText = await readFile(join(env.outDir, "bootstrap-bundle.v3.json"), "utf8");
  const bundle = BootstrapBundleSchema.parse(JSON.parse(bundleText));
  assert.equal(bundle.b0.rootDir, join(env.formalDir, "b0-source"));
  assert.equal(bundle.s0.rootDir, join(env.outDir, "s0"));
  assert.equal(bundle.b0.rootHash, result.bundle.b0.rootHash);
  assert.equal(bundle.b0.files[0]?.sha256, createHash("sha256").update(env.skillBytes).digest("hex"));
  for (const forbidden of [
    "evaluation-holdout.v3.json",
    "evaluation-holdout",
    "judgingRule",
    "expectedOutcome",
    "holdoutInput",
  ]) {
    assert.equal(bundleText.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.deepEqual(formalStageNames(await readdir(env.formalDir)), []);
});

test("formal bootstrap does not mistake ordinary SKILL prose for a sealed JSON property", async (t) => {
  const skillBytes = Buffer.from(
    "# Contract-writing Skill\n\nExplain what an expectedOutcome field means without reading any evaluation file.\n",
    "utf8",
  );
  const env = await makeFormalBootstrapEnv(skillBytes);
  t.after(async () => rm(env.base, { recursive: true, force: true }));
  const result = await runFormalBootstrap({
    skillDir: env.sourceSkillDir,
    formalDir: env.formalDir,
    outDir: env.outDir,
    taskCard: env.card,
    contract: env.contract,
    adapter: env.adapter,
  });
  assert.equal(result.bundle.b0.files.length, 1);
  assert.deepEqual(await readFile(join(env.formalDir, "b0-source", "SKILL.md")), skillBytes);
  assert.throws(
    () => assertFormalBootstrapBundleIsolation({
      ...result.bundle,
      injectedSealedPayload: { expectedOutcome: "must not enter bootstrap metadata" },
    }),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "FORMAL_BOOTSTRAP_SEALED_STRUCTURE_FORBIDDEN",
  );
});

test("formal bootstrap isolation rejects explicit sealed container structures", () => {
  for (const leaked of [
    { holdout: { input: "sealed" } },
    { evaluationHoldout: { items: [1] } },
    { sealed: { items: [1] } },
  ]) {
    assert.throws(
      () => assertFormalBootstrapBundleIsolation(leaked),
      (error: unknown) =>
        error instanceof BootstrapError && error.code === "FORMAL_BOOTSTRAP_SEALED_STRUCTURE_FORBIDDEN",
    );
  }
});

test("formal bootstrap rejects an extra source file before creating any target or staging output", async (t) => {
  const env = await makeFormalBootstrapEnv();
  t.after(async () => rm(env.base, { recursive: true, force: true }));
  await writeFile(
    join(env.sourceSkillDir, "evaluation-holdout.v3.json"),
    "this body must never be an input to bootstrap",
    "utf8",
  );
  await assert.rejects(
    () => runFormalBootstrap({
      skillDir: env.sourceSkillDir,
      formalDir: env.formalDir,
      outDir: env.outDir,
      taskCard: env.card,
      contract: env.contract,
      adapter: env.adapter,
    }),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "FORMAL_BOOTSTRAP_SOURCE_SCOPE_INVALID",
  );
  assert.deepEqual(await readdir(env.formalDir), []);
});

test("formal bootstrap refuses an existing drifted B0 before writes and preserves its bytes", async (t) => {
  const env = await makeFormalBootstrapEnv();
  t.after(async () => rm(env.base, { recursive: true, force: true }));
  const existingB0Dir = join(env.formalDir, "b0-source");
  const existingBytes = Buffer.from("# drifted formal B0\n", "utf8");
  await mkdir(existingB0Dir);
  await writeFile(join(existingB0Dir, "SKILL.md"), existingBytes);
  await assert.rejects(
    () => runFormalBootstrap({
      skillDir: env.sourceSkillDir,
      formalDir: env.formalDir,
      outDir: env.outDir,
      taskCard: env.card,
      contract: env.contract,
      adapter: env.adapter,
    }),
    (error: unknown) =>
      error instanceof BootstrapError && error.code === "FORMAL_BOOTSTRAP_EXISTING_B0_HASH_DRIFT",
  );
  assert.deepEqual(await readFile(join(existingB0Dir, "SKILL.md")), existingBytes);
  assert.deepEqual(await readdir(env.formalDir), ["b0-source"]);
});

test("formal bootstrap rolls back a new B0 on second rename failure and never deletes an equal pre-existing B0", async (t) => {
  for (const preExisting of [false, true]) {
    const env = await makeFormalBootstrapEnv();
    t.after(async () => rm(env.base, { recursive: true, force: true }));
    const finalB0Dir = join(env.formalDir, "b0-source");
    if (preExisting) {
      await mkdir(finalB0Dir);
      await writeFile(join(finalB0Dir, "SKILL.md"), env.skillBytes);
    }
    const injectedRename = async (source: string, target: string): Promise<void> => {
      if (target === env.outDir) throw new Error("injected bootstrap commit failure");
      await fsRename(source, target);
    };
    await assert.rejects(
      () => runFormalBootstrap({
        skillDir: env.sourceSkillDir,
        formalDir: env.formalDir,
        outDir: env.outDir,
        taskCard: env.card,
        contract: env.contract,
        adapter: env.adapter,
        commitRename: injectedRename,
      }),
      /injected bootstrap commit failure/,
    );
    await assert.rejects(readFile(join(env.outDir, "bootstrap-bundle.v3.json"), "utf8"));
    assert.deepEqual(formalStageNames(await readdir(env.formalDir)), []);
    if (preExisting) {
      assert.deepEqual(await readFile(join(finalB0Dir, "SKILL.md")), env.skillBytes);
    } else {
      await assert.rejects(readFile(join(finalB0Dir, "SKILL.md")));
    }
  }
});

test("the b0 candidate stays within B0's existing tool surface and differs from B0", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const { bundle } = await runBootstrap({
    skillDir: env.skillDir,
    taskCard: card,
    contract,
    adapter,
    s0Dir: env.s0Dir,
  });
  const candidate = bundle.lanes.find((l) => l.lane === "b0-repair")!.candidate!;
  const b0SkillMd = await readFile(join(env.skillDir, "SKILL.md"), "utf-8");
  assert.notEqual(candidate.files[0].content, b0SkillMd);
  const before = new Set(forbiddenToolViolations(b0SkillMd, card.capabilityBoundary));
  const newViolations = forbiddenToolViolations(
    candidate.files[0].content,
    card.capabilityBoundary,
  ).filter((v) => !before.has(v));
  assert.deepEqual(newViolations, []);
});

test("a failing b0 lane does not delete the s0 lane", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const failing: BootstrapProposer = {
    producer: { kind: "fixture", name: "failing-proposer" },
    async proposeB0Repair() {
      throw new Error("generator exploded");
    },
  };
  const { bundle } = await runBootstrap({
    skillDir: env.skillDir,
    taskCard: card,
    contract,
    adapter,
    s0Dir: env.s0Dir,
    proposer: failing,
  });
  const b0 = bundle.lanes.find((l) => l.lane === "b0-repair")!;
  const s0 = bundle.lanes.find((l) => l.lane === "s0-scaffold")!;
  assert.equal(b0.status, "failed");
  assert.ok(b0.error?.code);
  assert.ok(b0.error?.message);
  assert.equal(s0.status, "ok");
  assert.ok(s0.candidate);
  assert.ok(BootstrapBundleSchema.safeParse(bundle).success);
});

test("a b0 candidate that escalates privileges fails its lane only", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const escalating: BootstrapProposer = {
    producer: { kind: "fixture", name: "escalating-proposer" },
    async proposeB0Repair(ctx) {
      return {
        hypothesis: "add network",
        skillMd: `${ctx.b0SkillMd}\nAlso fetch http://example.invalid every run.\n`,
      };
    },
  };
  const { bundle } = await runBootstrap({
    skillDir: env.skillDir,
    taskCard: card,
    contract,
    adapter,
    s0Dir: env.s0Dir,
    proposer: escalating,
  });
  const b0 = bundle.lanes.find((l) => l.lane === "b0-repair")!;
  assert.equal(b0.status, "failed");
  assert.equal(b0.error?.code, "BOOTSTRAP_PRIVILEGE_ESCALATION");
  assert.equal(bundle.lanes.find((l) => l.lane === "s0-scaffold")!.status, "ok");
});

test("release and non-fixture providers are refused outright", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const base = { skillDir: env.skillDir, taskCard: card, contract, adapter, s0Dir: env.s0Dir };
  await assert.rejects(
    () => runBootstrap({ ...base, release: true }),
    (e: unknown) => e instanceof BootstrapError && e.code === "BOOTSTRAP_RELEASE_FORBIDDEN",
  );
  await assert.rejects(
    () => runBootstrap({ ...base, provider: "deepseek" }),
    (e: unknown) => e instanceof BootstrapError && e.code === "BOOTSTRAP_PROVIDER_UNAUTHORIZED",
  );
});

test("an unconfirmed task card is refused", async () => {
  const { contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const draftCard = TaskCardSchema.parse({
    ...sampleTaskCard(),
    confirmation: { status: "draft" },
  });
  await assert.rejects(
    () => runBootstrap({ skillDir: env.skillDir, taskCard: draftCard, contract, adapter, s0Dir: env.s0Dir }),
    (e: unknown) => e instanceof BootstrapError && e.code === "BOOTSTRAP_TASK_CARD_NOT_CONFIRMED",
  );
});

test("bootstrap rejects a Task Card whose content hash differs from the frozen contract", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const drifted = TaskCardSchema.parse({
    ...card,
    goal: `${card.goal} silently changed`,
  });
  assert.notEqual(taskCardContentSha256(drifted), contract.taskCardHash);
  await assert.rejects(
    () => runBootstrap({ skillDir: env.skillDir, taskCard: drifted, contract, adapter, s0Dir: env.s0Dir }),
    (error: unknown) => error instanceof BootstrapError && error.code === "BOOTSTRAP_TASK_CARD_HASH_MISMATCH",
  );
});

test("materializing the b0 candidate leaves the frozen root untouched", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const env = await makeBootstrapEnv();
  const { bundle } = await runBootstrap({
    skillDir: env.skillDir,
    taskCard: card,
    contract,
    adapter,
    s0Dir: env.s0Dir,
  });
  const candidate = bundle.lanes.find((l) => l.lane === "b0-repair")!.candidate!;
  const target = join(env.outDir, "cand-b0");
  await materializeCandidate({ root: bundle.b0, files: candidate.files, targetDir: target });
  await assertRootUnchanged(bundle.b0);
  const materialized = await readFile(join(target, "SKILL.md"), "utf-8");
  assert.equal(materialized, candidate.files[0].content);
});

// ── CLI channel ───────────────────────────────────────────────────

async function makeProjectDir(): Promise<string> {
  const { card, contract } = await frozenSampleContract();
  const dir = await mkdtemp(join(tmpdir(), "t06-cli-"));
  await writeFile(join(dir, "task-card.confirmed.json"), JSON.stringify(card, null, 2), "utf-8");
  await writeFile(
    join(dir, "evaluation-contract.v3.json"),
    JSON.stringify(contract, null, 2),
    "utf-8",
  );
  const skillDir = join(dir, "b0-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), B0_SKILL_MD, "utf-8");
  return dir;
}

test("CLI bootstrap writes the s0 scaffold and the bundle with exit 0", async () => {
  const dir = await makeProjectDir();
  try {
    const result = await runCli([
      "bootstrap",
      "--dir", dir,
      "--skill-dir", join(dir, "b0-skill"),
      "--adapter", "instruction-v1",
    ]);
    assert.equal(result.exitCode, 0);

    const outDir = join(dir, "bootstrap");
    const bundleRaw = JSON.parse(
      await readFile(join(outDir, "bootstrap-bundle.v3.json"), "utf-8"),
    );
    assert.ok(BootstrapBundleSchema.safeParse(bundleRaw).success);
    const s0Skill = await readFile(join(outDir, "s0", "SKILL.md"), "utf-8");
    assert.ok(s0Skill.length > 0);
    assert.match(result.stdout, /b0-repair/);
    assert.match(result.stdout, /s0-scaffold/);
    assert.match(result.stdout, /DRY-RUN/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI bootstrap refuses --release and undeclared adapters with exit 2", async () => {
  const dir = await makeProjectDir();
  try {
    const release = await runCli([
      "bootstrap",
      "--dir", dir,
      "--skill-dir", join(dir, "b0-skill"),
      "--adapter", "instruction-v1",
      "--release",
    ]);
    assert.equal(release.exitCode, 2);
    assert.match(release.stderr, /BOOTSTRAP_RELEASE_FORBIDDEN/);

    const ghost = await runCli([
      "bootstrap",
      "--dir", dir,
      "--skill-dir", join(dir, "b0-skill"),
      "--adapter", "ghost-adapter",
    ]);
    assert.equal(ghost.exitCode, 2);
    assert.match(ghost.stderr, /BOOTSTRAP_ADAPTER_UNDECLARED/);
    const leftovers = await readdir(join(dir, "bootstrap"), { recursive: true }).catch(() => []);
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
