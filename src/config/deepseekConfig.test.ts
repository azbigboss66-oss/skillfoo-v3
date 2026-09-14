import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getDeepSeekConfig, DeepSeekConfigError } from "./deepseekConfig.js";
import { loadRuntimeEnv } from "./runtimeEnv.js";
import { packageRoot } from "../cli.js";

// ── Helper: snapshot and restore process.env ───────────────────

let envBackup: Record<string, string | undefined>;

test.beforeEach(() => {
  envBackup = { ...process.env };
});

test.afterEach(() => {
  // Remove keys that didn't exist before
  for (const key of Object.keys(process.env)) {
    if (!(key in envBackup)) {
      delete process.env[key];
    }
  }
  // Restore original values
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ── Test 1: All three env vars present ─────────────────────────

test("getDeepSeekConfig returns exact values when all env vars are set", () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-key-123";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

  const config = getDeepSeekConfig();
  assert.equal(config.apiKey, "sk-test-key-123");
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(config.model, "deepseek-v4-flash");
});

// ── Test 2: Only Key present → defaults ────────────────────────

test("getDeepSeekConfig uses defaults for base URL and model when only key is set", () => {
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
  process.env.DEEPSEEK_API_KEY = "sk-only-key";

  const config = getDeepSeekConfig();
  assert.equal(config.apiKey, "sk-only-key");
  assert.equal(config.baseUrl, "https://api.deepseek.com");
  assert.equal(config.model, "deepseek-v4-flash");
});

// ── Test 3: Key missing/empty/whitespace → error ───────────────

test("getDeepSeekConfig throws DEEPSEEK_API_KEY_MISSING when key is empty", () => {
  delete process.env.DEEPSEEK_API_KEY;
  assert.throws(
    () => getDeepSeekConfig(),
    (err: unknown) => err instanceof DeepSeekConfigError && err.message === "DEEPSEEK_API_KEY_MISSING",
  );
});

test("getDeepSeekConfig throws DEEPSEEK_API_KEY_MISSING when key is whitespace only", () => {
  process.env.DEEPSEEK_API_KEY = "   ";
  assert.throws(
    () => getDeepSeekConfig(),
    (err: unknown) => err instanceof DeepSeekConfigError && err.message === "DEEPSEEK_API_KEY_MISSING",
  );
});

test("getDeepSeekConfig error message does not contain the key value", () => {
  process.env.DEEPSEEK_API_KEY = "sk-super-secret-key";
  try {
    getDeepSeekConfig({ DEEPSEEK_API_KEY: "" });
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes("sk-super-secret-key"));
    assert.ok(!err.message.includes("secret"));
  }
});

// ── Test 4: loadRuntimeEnv loads .env with override: false ────

test("loadRuntimeEnv loads .env from projectRoot without overriding existing env", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "skillfoo-env-"));

  await writeFile(
    join(tempDir, ".env"),
    "DEEPSEEK_API_KEY=from-file-key\nDEEPSEEK_BASE_URL=https://from-file.example.com\nDEEPSEEK_MODEL=from-file-model\n",
  );

  // Pre-set an env var that should NOT be overridden
  process.env.DEEPSEEK_API_KEY = "from-process-key";

  loadRuntimeEnv(tempDir);

  assert.equal(process.env.DEEPSEEK_API_KEY, "from-process-key", "process env should take priority");
  assert.equal(process.env.DEEPSEEK_BASE_URL, "https://from-file.example.com");
  assert.equal(process.env.DEEPSEEK_MODEL, "from-file-model");
});

test("loadRuntimeEnv does not throw when .env file does not exist", () => {
  const tempDir = "/nonexistent/path/that/should/not/exist";
  // Should not throw
  loadRuntimeEnv(tempDir);
});

// ── Test 5: .env.example has empty key, .gitignore ignores .env ─

test(".env.example exists with empty key and standard defaults", async () => {
  const content = await readFile(join(packageRoot, ".env.example"), "utf-8");
  const lines = content.split("\n");
  const keyLine = lines.find((l) => l.startsWith("DEEPSEEK_API_KEY="));
  assert.ok(keyLine, "DEEPSEEK_API_KEY line must exist");
  assert.equal(keyLine, "DEEPSEEK_API_KEY=", "Key must be empty in .env.example");

  const baseUrlLine = lines.find((l) => l.startsWith("DEEPSEEK_BASE_URL="));
  assert.ok(baseUrlLine, "DEEPSEEK_BASE_URL line must exist");
  assert.equal(baseUrlLine, "DEEPSEEK_BASE_URL=https://api.deepseek.com");

  const modelLine = lines.find((l) => l.startsWith("DEEPSEEK_MODEL="));
  assert.ok(modelLine, "DEEPSEEK_MODEL line must exist");
  assert.equal(modelLine, "DEEPSEEK_MODEL=deepseek-v4-flash");
});

test(".gitignore ignores .env but not .env.example", async () => {
  const gitignore = await readFile(join(packageRoot, ".gitignore"), "utf-8");
  assert.ok(gitignore.includes(".env"), ".gitignore must ignore .env");
  assert.ok(gitignore.includes("!.env.example"), ".gitignore must NOT ignore .env.example");
});

// ── Test: baseUrl trailing slash removal ───────────────────────

test("getDeepSeekConfig strips trailing slashes from baseUrl", () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

  const config = getDeepSeekConfig();
  assert.equal(config.baseUrl, "https://api.deepseek.com", "trailing slash must be removed");
});

test("getDeepSeekConfig strips multiple trailing slashes from baseUrl", () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com///";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";

  const config = getDeepSeekConfig();
  assert.equal(config.baseUrl, "https://api.deepseek.com");
});

// ── Test: accepts explicit env parameter ───────────────────────

test("getDeepSeekConfig accepts explicit env parameter", () => {
  const config = getDeepSeekConfig({
    DEEPSEEK_API_KEY: "explicit-key",
    DEEPSEEK_BASE_URL: "https://custom.example.com",
    DEEPSEEK_MODEL: "custom-model",
  });
  assert.equal(config.apiKey, "explicit-key");
  assert.equal(config.baseUrl, "https://custom.example.com");
  assert.equal(config.model, "custom-model");
});
