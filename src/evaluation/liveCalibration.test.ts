import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { composeBlueprint } from "../evalFactory/composeBlueprint.js";
import { sampleTaskCard } from "../evalFactory/composeBlueprint.test.js";
import { createFixtureGenerator, generateDraft } from "../evalFactory/generateDraft.js";
import type { Provider } from "../providers/types.js";
import { LiveCalibrationEvidenceSchema, type EvaluationContractV3, type LiveCalibrationEvidence } from "../types.js";
import { stableStringify } from "../intake/taskCard.js";
import {
  CalibrationEvidenceError,
  assertCalibrationEvidenceForAdaptive,
  createLiveCalibrationRecoveryEvidence,
  runTwoPassEvaluatorCalibration,
} from "./liveCalibration.js";

const DIMENSIONS = [
  "task_correctness",
  "evidence_boundary",
  "capability_boundary",
  "output_structure",
  "actionability",
] as const;

const CALIBRATION_PROVIDER_IDENTITY = {
  adapterVersion: "openai-chat-completions-v1",
  name: "openai-compatible",
  endpointIdentity: "9".repeat(24),
  model: "deepseek-v4-flash",
  authMode: "bearer",
  requestProfile: {
    preset: "deepseek",
    jsonMode: "json_object",
    reasoningMode: "thinking-disabled",
    maxTokensField: "max_tokens",
  },
  roles: {
    semanticJudge: {
      requestTimeoutMs: 120_000,
      maxOutputTokensBehavior: "provider-default",
      configFingerprint: "c".repeat(24),
    },
  },
} as const;

function responseFor(scores: { good: number; borderline: number; unsafe: number }) {
  return {
    content: JSON.stringify({
      items: (["good", "borderline", "unsafe"] as const).map((level) => ({
        itemId: `cal-${level}`,
        dimensions: DIMENSIONS.map((id) => ({ id, score: scores[level], reason: `${level} ${id}` })),
        weightedScore: scores[level],
        overallReason: `${level} calibration answer`,
      })),
    }),
  };
}

async function calibrationFixture() {
  const card = sampleTaskCard();
  const draft = await generateDraft(composeBlueprint(card), card, createFixtureGenerator());
  const contract = {
    contractSha256: "a".repeat(64),
    calibrationTripletSha256: createHash("sha256")
      .update(stableStringify(draft.calibration), "utf8")
      .digest("hex"),
    calibrationMinAdjacentGap: 10,
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
  } as EvaluationContractV3;
  return { draft, contract };
}

test("live evaluator calibration makes exactly two uncached passes and returns only score fingerprints", async () => {
  const { draft, contract } = await calibrationFixture();
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      return responseFor(calls === 1
        ? { good: 92, borderline: 72, unsafe: 42 }
        : { good: 90, borderline: 70, unsafe: 40 });
    },
  };

  const run = await runTwoPassEvaluatorCalibration({ contract, draft, provider, recoveryEvidence: createLiveCalibrationRecoveryEvidence() });

  assert.equal(calls, 2, "independent calibration passes must never collapse through cache reuse");
  assert.equal(
    (run as { semanticResponseBindingVersion?: string }).semanticResponseBindingVersion,
    "identity-set-v2",
  );
  assert.equal(run.result.pass, true);
  assert.deepEqual(run.result.medianScores, { good: 91, borderline: 71, unsafe: 41 });
  assert.equal(run.passes.length, 2);
  for (const pass of run.passes) {
    assert.match(pass.requestFingerprint, /^[0-9a-f]{64}$/);
    assert.match(pass.resultFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(pass).sort(), ["requestFingerprint", "resultFingerprint", "scores"]);
  }
  assert.doesNotMatch(JSON.stringify(run.passes), /candidateAnswer|judgingRule|api[_-]?key|authorization/i);
});

test("live evaluator calibration repairs one malformed semantic pass exactly once", async () => {
  const { draft, contract } = await calibrationFixture();
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      if (calls === 1) return { content: "not-json" };
      return responseFor(calls === 2
        ? { good: 92, borderline: 72, unsafe: 42 }
        : { good: 90, borderline: 70, unsafe: 40 });
    },
  };

  const run = await runTwoPassEvaluatorCalibration({ contract, draft, provider, recoveryEvidence: createLiveCalibrationRecoveryEvidence() });

  assert.equal(calls, 3);
  assert.equal(run.result.pass, true);
  assert.deepEqual(run.result.medianScores, { good: 91, borderline: 71, unsafe: 41 });
  assert.equal(run.applicationRecoveryAttempts.length, 1);
  assert.deepEqual(run.applicationRecoveryAttempts[0]?.subject, { kind: "stage", stage: "calibration", pass: 1 });
  assert.equal(run.structureRecoveryDiagnostics.length, 1);
  assert.deepEqual(run.structureRecoveryDiagnostics[0]?.subject, { kind: "stage", stage: "calibration", pass: 1 });
});

test("live evaluator calibration gives each primary pass one independent schema repair and never a fifth call", async () => {
  const { draft, contract } = await calibrationFixture();
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      if (calls === 1 || calls === 3) return { content: "not-json" };
      return responseFor(calls === 2
        ? { good: 92, borderline: 72, unsafe: 42 }
        : { good: 90, borderline: 70, unsafe: 40 });
    },
  };

  const run = await runTwoPassEvaluatorCalibration({ contract, draft, provider, recoveryEvidence: createLiveCalibrationRecoveryEvidence() });

  assert.equal(calls, 4);
  assert.equal(run.result.pass, true);
  assert.deepEqual(run.applicationRecoveryAttempts.map(({ subject }) => subject), [
    { kind: "stage", stage: "calibration", pass: 1 },
    { kind: "stage", stage: "calibration", pass: 2 },
  ]);
});

test("live evaluator calibration stops after one failed schema repair for a pass", async () => {
  const { draft, contract } = await calibrationFixture();
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      return { content: "not-json" };
    },
  };

  await assert.rejects(
    () => runTwoPassEvaluatorCalibration({ contract, draft, provider, recoveryEvidence: createLiveCalibrationRecoveryEvidence() }),
    /SEMANTIC_JUDGE_INVALID_JSON/,
  );
  assert.equal(calls, 2, "one primary plus one repair is the complete allowance for the failed pass");
});

test("two-pass live calibration fails closed when either pass misses the frozen adjacent gap", async () => {
  const { draft, contract } = await calibrationFixture();
  let calls = 0;
  const provider: Provider = {
    chat: async () => {
      calls += 1;
      return responseFor(calls === 1
        ? { good: 90, borderline: 70, unsafe: 40 }
        : { good: 82, borderline: 78, unsafe: 40 });
    },
  };

  const run = await runTwoPassEvaluatorCalibration({ contract, draft, provider, recoveryEvidence: createLiveCalibrationRecoveryEvidence() });
  assert.equal(calls, 2);
  assert.equal(run.result.pass, false);
  assert.equal(run.result.bothPassesPreserved, false);
});

function passedEvidence(overrides: Partial<LiveCalibrationEvidence> = {}): LiveCalibrationEvidence {
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: "identity-set-v2",
    createdAt: "2026-08-26T00:00:00.000Z",
    status: "passed",
    contractSha256: "a".repeat(64),
    calibrationTripletSha256: "b".repeat(64),
    provider: CALIBRATION_PROVIDER_IDENTITY,
    confirmationMode: "human",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    formalEvidence: true,
    releaseAllowed: false,
    sealedAllowed: false,
    result: {
      pass: true,
      minAdjacentGap: 10,
      passes: [
        { pass: true, minAdjacentGap: 10, passIndex: 1, scores: { good: 90, borderline: 70, unsafe: 40 }, orderingPreserved: true },
        { pass: true, minAdjacentGap: 10, passIndex: 2, scores: { good: 88, borderline: 68, unsafe: 38 }, orderingPreserved: true },
      ],
      medianScores: { good: 89, borderline: 69, unsafe: 39 },
      bothPassesPreserved: true,
      medianGapPreserved: true,
    },
    passes: [
      { scores: { good: 90, borderline: 70, unsafe: 40 }, requestFingerprint: "d".repeat(64), resultFingerprint: "e".repeat(64) },
      { scores: { good: 88, borderline: 68, unsafe: 38 }, requestFingerprint: "d".repeat(64), resultFingerprint: "f".repeat(64) },
    ],
    actualApplicationRecoveryAttempts: 0,
    applicationRecoveryAttempts: [],
    structureRecoveryDiagnostics: [],
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    tokenTelemetry: { promptTokens: 10, completionTokens: 10, responses: 2 },
    providerTokenTelemetry: {
      promptTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      completionTokens: null,
      responses: 2,
      responsesWithUsage: 0,
      responsesMissingUsage: 2,
    },
    ...overrides,
  } as LiveCalibrationEvidence;
}

test("calibration evidence schema and Adaptive gate reject missing or mismatched current semantic response bindings", () => {
  const current = passedEvidence() as unknown as Record<string, unknown>;
  assert.equal(LiveCalibrationEvidenceSchema.safeParse(current).success, true);
  const missing = { ...current };
  delete missing.semanticResponseBindingVersion;
  const mismatched = { ...current, semanticResponseBindingVersion: "unexpected-binding" };
  const expected = {
    contractSha256: "a".repeat(64),
    calibrationTripletSha256: "b".repeat(64),
    providerIdentity: CALIBRATION_PROVIDER_IDENTITY,
    confirmationMode: "human" as const,
  };

  for (const evidence of [missing, mismatched]) {
    assert.equal(LiveCalibrationEvidenceSchema.safeParse(evidence).success, false);
    assert.throws(
      () => assertCalibrationEvidenceForAdaptive(evidence, expected),
      (error: unknown) =>
        error instanceof CalibrationEvidenceError &&
        String(error.code) === "CALIBRATION_SEMANTIC_BINDING_DRIFT",
    );
  }
});

test("Adaptive calibration gate rejects missing success, contract drift, and provider configuration drift", () => {
  const expected = {
    contractSha256: "a".repeat(64),
    calibrationTripletSha256: "b".repeat(64),
    providerIdentity: CALIBRATION_PROVIDER_IDENTITY,
    confirmationMode: "human" as const,
  };
  assert.doesNotThrow(() => assertCalibrationEvidenceForAdaptive(passedEvidence(), expected));
  for (const evidence of [
    passedEvidence({ status: "failed" as "passed" }),
    passedEvidence({ contractSha256: "0".repeat(64) }),
    passedEvidence({ calibrationTripletSha256: "1".repeat(64) }),
    passedEvidence({
      provider: {
        ...CALIBRATION_PROVIDER_IDENTITY,
        roles: {
          semanticJudge: {
            ...CALIBRATION_PROVIDER_IDENTITY.roles.semanticJudge,
            configFingerprint: "2".repeat(24),
          },
        },
      },
    }),
  ]) {
    assert.throws(
      () => assertCalibrationEvidenceForAdaptive(evidence, expected),
      (error: unknown) => error instanceof CalibrationEvidenceError,
    );
  }
});
