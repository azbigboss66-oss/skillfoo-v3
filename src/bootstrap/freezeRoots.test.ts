import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRootUnchanged,
  freezeRoot,
  materializeCandidate,
  RootFreezeError,
  ROOT_EDITABLE_FILES,
} from "./freezeRoots.js";
import { RootFreezeSchema } from "../types.js";

export const B0_SKILL_MD = [
  "# Repo Digest Skill",
  "",
  "You are a helpful assistant that summarizes repository activity for maintainers.",
  "",
  "## Workflow",
  "1. Run scripts/fetch-data.ps1 to pull the latest repository events.",
  "2. Summarize whatever the script prints.",
].join("\n");

export async function makeRoughSkillDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t06-b0-"));
  await writeFile(join(dir, "SKILL.md"), B0_SKILL_MD, "utf-8");
  await writeFile(join(dir, "notes.txt"), "operator notes\n", "utf-8");
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(
    join(dir, "scripts", "fetch-data.ps1"),
    "Invoke-WebRequest http://example.invalid\n",
    "utf-8",
  );
  await writeFile(join(dir, "data.bin"), Buffer.from([0, 1, 2, 3]));
  return dir;
}

test("freezeRoot is read-only, reproducible, and quarantines unknown or dangerous files", async () => {
  const dir = await makeRoughSkillDir();
  const before = (await readdir(dir, { recursive: true })).sort();

  const first = await freezeRoot({
    skillDir: dir,
    kind: "b0",
    source: "operator-supplied rough skill directory",
  });
  const second = await freezeRoot({
    skillDir: dir,
    kind: "b0",
    source: "operator-supplied rough skill directory",
  });

  assert.ok(RootFreezeSchema.safeParse(first).success);
  assert.equal(first.rootHash, second.rootHash);
  assert.equal(first.kind, "b0");

  const statusOf = (path: string) => first.files.find((f) => f.path === path)?.status;
  assert.equal(statusOf("SKILL.md"), "recorded");
  assert.equal(statusOf("notes.txt"), "recorded");
  assert.equal(statusOf("scripts/fetch-data.ps1"), "skipped-dangerous");
  assert.equal(statusOf("data.bin"), "skipped-unknown");

  const after = (await readdir(dir, { recursive: true })).sort();
  assert.deepEqual(after, before);
});

test("the root hash changes when root content changes", async () => {
  const dir = await makeRoughSkillDir();
  const first = await freezeRoot({ skillDir: dir, kind: "b0", source: "s" });
  await writeFile(join(dir, "notes.txt"), "changed notes\n", "utf-8");
  const second = await freezeRoot({ skillDir: dir, kind: "b0", source: "s" });
  assert.notEqual(first.rootHash, second.rootHash);
});

test("a root without SKILL.md is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t06-empty-"));
  await writeFile(join(dir, "notes.txt"), "no skill here\n", "utf-8");
  await assert.rejects(
    () => freezeRoot({ skillDir: dir, kind: "b0", source: "s" }),
    (e: unknown) => e instanceof RootFreezeError && e.code === "ROOT_SKILL_MD_MISSING",
  );
});

test("a frozen root rejects symlinks instead of following them", async (t) => {
  const dir = await makeRoughSkillDir();
  try {
    await symlink(
      join(dir, "scripts"),
      join(dir, "scripts-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("the host does not permit creating a test symlink");
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => freezeRoot({ skillDir: dir, kind: "b0", source: "s" }),
    (error: unknown) => error instanceof RootFreezeError && error.code === "ROOT_SYMLINK_REJECTED",
  );
});

test("the schema refuses a frozen root whose SKILL.md is not recorded", () => {
  const candidate = {
    schemaVersion: 3,
    createdAt: "2026-08-16T00:00:00.000Z",
    producer: { kind: "cli", name: "test" },
    kind: "b0",
    rootDir: "/tmp/nowhere",
    source: "s",
    rootHash: "b".repeat(64),
    files: [{ path: "SKILL.md", sha256: "a".repeat(64), bytes: 10, status: "skipped-dangerous" }],
  };
  assert.equal(RootFreezeSchema.safeParse(candidate).success, false);
});

test("bootstrap patches may only target SKILL.md", () => {
  assert.deepEqual(ROOT_EDITABLE_FILES, ["SKILL.md"]);
});

test("materializeCandidate copies recorded files only and leaves the frozen root untouched", async () => {
  const dir = await makeRoughSkillDir();
  const freeze = await freezeRoot({ skillDir: dir, kind: "b0", source: "s" });
  const target = await mkdtemp(join(tmpdir(), "t06-cand-"));

  await materializeCandidate({
    root: freeze,
    files: [{ path: "SKILL.md", content: `${B0_SKILL_MD}\n## Boundary reinforcement\n` }],
    targetDir: target,
  });

  const copied = (await readdir(target, { recursive: true })).sort();
  assert.deepEqual(copied, ["SKILL.md", "notes.txt"]);
  const patched = await readFile(join(target, "SKILL.md"), "utf-8");
  assert.ok(patched.endsWith("## Boundary reinforcement\n"));
  await assertRootUnchanged(freeze);
  const originalSkill = await readFile(join(dir, "SKILL.md"), "utf-8");
  assert.equal(originalSkill, B0_SKILL_MD);
});

test("a patch touching a locked path is refused and the root stays intact", async () => {
  const dir = await makeRoughSkillDir();
  const freeze = await freezeRoot({ skillDir: dir, kind: "b0", source: "s" });
  const target = await mkdtemp(join(tmpdir(), "t06-cand-"));

  await assert.rejects(
    () =>
      materializeCandidate({
        root: freeze,
        files: [{ path: "notes.txt", content: "hijacked" }],
        targetDir: target,
      }),
    (e: unknown) => e instanceof RootFreezeError && e.code === "ROOT_PATCH_PATH_LOCKED",
  );
  await assert.rejects(
    () =>
      materializeCandidate({
        root: freeze,
        files: [{ path: "scripts/fetch-data.ps1", content: "evil" }],
        targetDir: target,
      }),
    (e: unknown) => e instanceof RootFreezeError && e.code === "ROOT_PATCH_PATH_LOCKED",
  );
  await assertRootUnchanged(freeze);
});

test("materializing into a directory inside the root is refused", async () => {
  const dir = await makeRoughSkillDir();
  const freeze = await freezeRoot({ skillDir: dir, kind: "b0", source: "s" });
  await assert.rejects(
    () =>
      materializeCandidate({
        root: freeze,
        files: [{ path: "SKILL.md", content: "x" }],
        targetDir: join(dir, "inside"),
      }),
    (e: unknown) => e instanceof RootFreezeError && e.code === "ROOT_TARGET_INSIDE_ROOT",
  );
});
