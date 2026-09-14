import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The current manifest, bin link, and root lockfile must agree on the
// published package identity.

const repoRoot = new URL("../../", import.meta.url);

const readJson = async (relative: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(relative, repoRoot), "utf8")) as Record<string, unknown>;

test("the root package is skillfoo-v3@1.0.0 with a matching bin link", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.name, "skillfoo-v3");
  assert.equal(pkg.version, "1.0.0");
  assert.deepEqual(pkg.bin, { "skillfoo-v3": "dist/cli.js" });
  assert.deepEqual(pkg.scripts, {
    build: "tsc",
    test: "node --test dist/**/*.test.js",
    prepack: "npm run build",
  });
});

test("the root lockfile mirrors the root manifest at both name sites", async () => {
  const lock = await readJson("package-lock.json");
  assert.equal(lock.name, "skillfoo-v3");
  assert.equal(lock.version, "1.0.0");
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  assert.equal(packages[""]?.name, "skillfoo-v3");
  assert.equal(packages[""]?.version, "1.0.0");
  assert.deepEqual(packages[""]?.bin, { "skillfoo-v3": "dist/cli.js" });
});

test("the current manifest and lockfile carry no superseded package identity", async () => {
  for (const relative of ["package.json", "package-lock.json"]) {
    const text = await readFile(new URL(relative, repoRoot), "utf8");
    assert.ok(!text.includes("skillfoo-v1"), `${relative} still carries a skillfoo-v1 residue`);
    assert.ok(!text.includes("skillfoo-v2"), `${relative} still carries a skillfoo-v2 residue`);
  }
});
