import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableStringify } from "../intake/taskCard.js";
import { DEFAULT_MAX_RESPONSE_BYTES } from "./capabilityAdapter.js";
import {
  FrozenContextError,
  loadFrozenRuntimeContext,
  readFrozenContextEntry,
  type FrozenRuntimeContextManifest,
} from "./frozenContext.js";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function sealManifest(
  content: Omit<FrozenRuntimeContextManifest, "manifestSha256">,
): FrozenRuntimeContextManifest {
  return {
    ...content,
    manifestSha256: digest(stableStringify(content)),
  };
}

async function writeManifest(
  root: string,
  manifest: FrozenRuntimeContextManifest,
): Promise<string> {
  const path = join(root, "runtime-context.v1.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

test("frozen context rejects traversal, symlink and realpath escape", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "skillfoo-frozen-path-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "context");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside", "utf8");

  const traversal = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "outside",
      kind: "reference",
      path: "../outside/secret.txt",
      mediaType: "text/plain",
      sha256: digest("outside"),
    }],
    replays: [],
  });
  await assert.rejects(
    () => writeManifest(root, traversal).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_PATH_ESCAPE",
  );

  const linked = join(root, "linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const throughLink = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "linked",
      kind: "reference",
      path: "linked/secret.txt",
      mediaType: "text/plain",
      sha256: digest("outside"),
    }],
    replays: [],
  });
  await assert.rejects(
    () => writeManifest(root, throughLink).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_SYMLINK_REJECTED",
  );

  const linkedRoot = join(parent, "context-link");
  await symlink(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => loadFrozenRuntimeContext(join(linkedRoot, "runtime-context.v1.json")),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_SYMLINK_REJECTED",
  );
});

test("frozen context rejects duplicate ids and every non-portable path shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-frozen-portable-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "reference.txt"), "alpha", "utf8");
  await writeFile(join(root, "replay.json"), "{}", "utf8");

  const duplicate = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{ id: "same", kind: "reference", path: "reference.txt", mediaType: "text/plain", sha256: digest("alpha") }],
    replays: [{ id: "same", tool: "catalog.lookup", request: {}, responsePath: "replay.json", responseSha256: digest("{}") }],
  });
  await assert.rejects(
    () => writeManifest(root, duplicate).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_MANIFEST_INVALID",
  );

  for (const path of ["", "/absolute.txt", "C:/absolute.txt", "//server/share.txt", "nested\\file.txt", "nested//file.txt"]) {
    const invalidPath = sealManifest({
      schemaVersion: 1,
      adapterId: "reference-v1",
      entries: [{ id: "bad", kind: "reference", path, mediaType: "text/plain", sha256: digest("alpha") }],
      replays: [],
    });
    await assert.rejects(
      () => writeManifest(root, invalidPath).then(loadFrozenRuntimeContext),
      (error: unknown) =>
        error instanceof FrozenContextError &&
        (error.code === "FROZEN_CONTEXT_PATH_ESCAPE" || error.code === "FROZEN_CONTEXT_MANIFEST_INVALID"),
    );
  }
});

test("frozen context rejects manifest self-hash drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-frozen-self-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "reference.txt"), "alpha", "utf8");
  const manifest = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "reference",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: digest("alpha"),
    }],
    replays: [],
  });
  manifest.manifestSha256 = "0".repeat(64);

  await assert.rejects(
    () => writeManifest(root, manifest).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );
});

test("frozen context checks dependency hashes at load and every read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-frozen-file-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referencePath = join(root, "reference.txt");
  await writeFile(referencePath, "alpha", "utf8");
  const manifest = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "reference",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: digest("alpha"),
    }],
    replays: [],
  });
  const manifestPath = await writeManifest(root, manifest);
  const loaded = await loadFrozenRuntimeContext(manifestPath);
  assert.equal((await readFrozenContextEntry(loaded, "reference", "reference")).text, "alpha");

  await writeFile(referencePath, "changed", "utf8");
  await assert.rejects(
    () => readFrozenContextEntry(loaded, "reference", "reference"),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );

  const badRoot = await mkdtemp(join(tmpdir(), "skillfoo-frozen-load-hash-"));
  t.after(() => rm(badRoot, { recursive: true, force: true }));
  await writeFile(join(badRoot, "reference.txt"), "actual", "utf8");
  const badManifest = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "reference",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: digest("expected"),
    }],
    replays: [],
  });
  await assert.rejects(
    () => writeManifest(badRoot, badManifest).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError && error.code === "FROZEN_CONTEXT_HASH_MISMATCH",
  );
});

test("frozen context rejects canonical sealed paths before reading the body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-frozen-sealed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sealedBytes = Buffer.from([0xff]);
  await writeFile(join(root, "evaluation-holdout.v3.json"), sealedBytes);
  const manifest = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "forbidden",
      kind: "attachment",
      path: "evaluation-holdout.v3.json",
      mediaType: "application/json",
      sha256: createHash("sha256").update(sealedBytes).digest("hex"),
    }],
    replays: [],
  });

  await assert.rejects(
    () => writeManifest(root, manifest).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError &&
      error.code === "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN",
  );

  const sealedRoot = join(root, "sealed");
  await mkdir(sealedRoot);
  const sealedManifestPath = join(sealedRoot, "runtime-context.v1.json");
  await writeFile(sealedManifestPath, Buffer.from([0xff]));
  await assert.rejects(
    () => loadFrozenRuntimeContext(sealedManifestPath),
    (error: unknown) =>
      error instanceof FrozenContextError &&
      error.code === "FROZEN_CONTEXT_SEALED_PATH_FORBIDDEN",
  );
});

test("manifest loading rejects a dependency larger than the U1 default response limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skillfoo-frozen-load-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oversized = "x".repeat(DEFAULT_MAX_RESPONSE_BYTES + 1);
  await writeFile(join(root, "reference.txt"), oversized, "utf8");
  const manifest = sealManifest({
    schemaVersion: 1,
    adapterId: "reference-v1",
    entries: [{
      id: "oversized",
      kind: "reference",
      path: "reference.txt",
      mediaType: "text/plain",
      sha256: digest(oversized),
    }],
    replays: [],
  });

  await assert.rejects(
    () => writeManifest(root, manifest).then(loadFrozenRuntimeContext),
    (error: unknown) =>
      error instanceof FrozenContextError &&
      (error as { code?: string }).code === "FROZEN_CONTEXT_RESPONSE_TOO_LARGE",
  );
});
