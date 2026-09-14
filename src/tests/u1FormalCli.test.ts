import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot, runCli } from "../cli.js";
import * as cliModule from "../cli.js";
import { sampleTaskCard } from "../evalFactory/composeBlueprint.test.js";
import { DEFAULT_U1_SCORING_PROFILE, TaskCardSchema } from "../types.js";
import { calculateAdaptiveClosureBudget } from "../evolution/adaptiveClosureProtocol.js";
import type { AdaptiveRunResult } from "../evolution/adaptiveRun.js";
import { AdaptiveFailureArtifactSchema } from "../evolution/publicSelectionResume.js";
import { RunCallBudget } from "../providers/runBudget.js";
import { archiveSupersededStageAttempt } from "../evidence/stageAttemptArchive.js";
import { SEMANTIC_RESPONSE_BINDING_VERSION } from "../types.js";

const LIVE_AUTH = [
  "--provider", "deepseek",
  "--allow-network",
  "--confirm-real-provider", "I_UNDERSTAND_REAL_PROVIDER_COSTS",
  "--no-release",
] as const;

const CURRENT_COMMANDS = [
  "doctor",
  "intake",
  "eval-draft",
  "eval-review",
  "eval-freeze",
  "bootstrap",
  "preflight",
  "provider-check",
  "calibration-run",
  "adaptive-run",
  "direct-run",
  "audit-compare",
  "suite-report",
] as const;

const RETIRED_COMMANDS = [
  "inspect",
  "evaluate",
  "evolve",
  "instruction-run",
  "funnel-run",
  "freeze-contract",
] as const;

function cliHelp(...args: string[]): string {
  return execFileSync(
    process.execPath,
    [join(packageRoot, "dist", "cli.js"), ...args, "--help"],
    { cwd: packageRoot, encoding: "utf8" },
  );
}

test("public CLI help exposes only the current U1 commands and omits retired flags", () => {
  const rootHelp = cliHelp();
  for (const command of CURRENT_COMMANDS) {
    assert.match(rootHelp, new RegExp(`^\\s{2}${command}\\b`, "m"), command);
  }
  for (const command of RETIRED_COMMANDS) {
    assert.doesNotMatch(rootHelp, new RegExp(`^\\s{2}${command}\\b`, "m"), command);
  }

  const directHelp = cliHelp("direct-run");
  assert.match(directHelp, /--strategy <mode>[^\n]*one_shot/);
  assert.doesNotMatch(
    directHelp,
    /self_refine|development-bypass|execution-protocol|public-select-max-logical-calls|direct-max-logical-calls|sealed-max-logical-calls/,
  );

  const auditHelp = cliHelp("audit-compare");
  assert.doesNotMatch(
    auditHelp,
    /legacy V3\.1|direct-result|public-select-max-logical-calls|direct-max-logical-calls|sealed-max-logical-calls/,
  );
});

test("current human-formal preflight and execute share the same 0/2 waiting gate with zero Provider calls or writes", async (t) => {
  const projectDir = await mkdtemp(join(tmpdir(), "skillfoo-current-formal-waiting-"));
  t.after(async () => rm(projectDir, { recursive: true, force: true }));
  const draftCard = TaskCardSchema.parse({
    ...sampleTaskCard(),
    confirmation: { status: "draft" },
  });
  await writeFile(join(projectDir, "task-card.draft.json"), JSON.stringify(draftCard), "utf8");

  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("the human-confirmation gate must prevent Provider access");
  };
  try {
    for (const command of ["calibration-run", "adaptive-run", "direct-run", "audit-compare"] as const) {
      for (const execute of [false, true]) {
        const outDir = join(projectDir, `${command}-${execute ? "execute" : "preflight"}`);
        const result = await runCli([
          command,
          "--dir", projectDir,
          "--out", outDir,
          ...LIVE_AUTH,
          ...(execute ? ["--execute"] : []),
        ]);
        assert.equal(result.exitCode, 0, `${command}/${execute ? "execute" : "preflight"}: ${result.stderr}`);
        assert.match(result.stdout, /WAITING_FOR_HUMAN_CONFIRMATION/);
        assert.match(result.stdout, /"fetches":0/);
        assert.match(result.stdout, /"providerCalls":0/);
        assert.match(result.stdout, /"writes":0/);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetches, 0);
  assert.deepEqual((await readdir(projectDir)).sort(), ["task-card.draft.json"]);
});

test("a structured proposer_failure writes one redacted Adaptive failure and cannot enter later stages", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "skillfoo-adaptive-terminal-failure-"));
  t.after(async () => rm(outDir, { recursive: true, force: true }));

  const persistFailure = (
    cliModule as unknown as {
      persistAdaptiveFailureStop?: (args: Record<string, unknown>) => Promise<boolean>;
    }
  ).persistAdaptiveFailureStop;
  assert.equal(
    typeof persistFailure,
    "function",
    "the CLI must classify a returned failure stop before the success artifact parser",
  );
  if (!persistFailure) return;

  const adaptiveBudget = calculateAdaptiveClosureBudget({
    rootCandidates: 2,
    publicTrainItems: 1,
    pinnedItems: 1,
    semanticBatchSize: 3,
    minChildGenerations: 1,
    maxModelTurns: 2,
    maxToolCalls: 1,
    maxRefinements: 0,
    budgetMultiplier: 2,
  });
  const budget = new RunCallBudget(
    { maxLogicalCalls: adaptiveBudget.envelope.authorizedLogicalCalls, maxRetryAttempts: 2 },
    { logicalCalls: 3, httpAttempts: 3, retryAttempts: 0 },
  );
  const sensitiveDetail = "SENSITIVE_PROVIDER_BODY_MUST_NOT_BE_PERSISTED";
  const result = {
    stopReason: "proposer_failure",
    stopDetail: sensitiveDetail,
    events: [
      { at: "2026-08-30T00:00:00.000Z", type: "run_start", cacheHits: 2, cacheMisses: 5, secret: sensitiveDetail },
      { at: "2026-08-30T00:00:01.000Z", type: "proposer_failure", cacheHits: 3, cacheMisses: 8, detail: sensitiveDetail },
    ],
    actualApplicationRecoveryAttempts: 0,
    structureRecoveryDiagnostics: [],
    totalWallTimeMs: 1234,
  } as unknown as AdaptiveRunResult;
  const providerTokenTelemetry = {
    promptTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    completionTokens: 0,
    responses: 0,
    responsesWithUsage: 0,
    responsesMissingUsage: 0,
    byStageRoleModel: [],
  };
  const wroteFailure = await persistFailure({
    outDir,
    result,
    liveRun: {
      provider: { name: "deepseek", model: "deepseek-v4-flash", configFingerprint: "f".repeat(24) },
      authorizedBudget: { maxLogicalCalls: adaptiveBudget.envelope.authorizedLogicalCalls, maxRetryAttempts: 2 },
      callEnvelope: adaptiveBudget.envelope,
      providerTokenTelemetry,
    },
    budget,
    evidence: {
      track: "u1-b-formal",
      confirmationMode: "human",
      explorationOnly: false,
      humanConfirmationBypassed: false,
    },
    adaptiveBudget,
    callEnvelope: adaptiveBudget.envelope,
    scoringIdentity: {
      contractSha256: "a".repeat(64),
      profileVersion: DEFAULT_U1_SCORING_PROFILE.version,
      taskVerifierVersion: DEFAULT_U1_SCORING_PROFILE.taskVerifierVersion,
      rubricVersion: DEFAULT_U1_SCORING_PROFILE.rubricVersion,
    },
  });

  assert.equal(wroteFailure, true);
  assert.deepEqual((await readdir(outDir)).sort(), ["adaptive-failure.json"]);
  const raw = await readFile(join(outDir, "adaptive-failure.json"), "utf8");
  assert.doesNotMatch(raw, /SENSITIVE_PROVIDER_BODY_MUST_NOT_BE_PERSISTED/);
  const artifact = AdaptiveFailureArtifactSchema.parse(JSON.parse(raw));
  assert.equal((artifact as { stopReason?: string }).stopReason, "proposer_failure");
  assert.equal(artifact.safeError.code, "ADAPTIVE_PROPOSER_FAILURE");
  assert.equal((artifact as { totalWallTimeMs?: number }).totalWallTimeMs, 1234);
  assert.equal(artifact.contractSha256, "a".repeat(64));
  assert.deepEqual(artifact.cache, { hits: 3, misses: 8 });

  const archived = await archiveSupersededStageAttempt({
    evidenceDir: outDir,
    trigger: "adaptive",
    expectedBinding: {
      contractSha256: "a".repeat(64),
      semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
      confirmationMode: "human",
    },
    now: () => "2026-08-30T00:01:00.000Z",
  });
  assert.equal(archived.kind, "archived", "a classified failure must remain safely rerunnable through the existing archive path");
  assert.deepEqual((await readdir(outDir)).sort(), ["attempts"]);
});
