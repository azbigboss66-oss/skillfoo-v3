import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderResponse } from "../providers/types.js";
import {
  applicationAttemptIdentitySha256,
  bindApplicationAttemptProvider,
  projectApplicationRecoveryAttempt,
  projectRecoveryDiagnostic,
  recoveryDiagnosticOf,
  safeFindingCodesOf,
  safeFinishReasonOf,
} from "./structureRecovery.js";

test("safe response diagnostics retain only fixed metadata and a body hash", () => {
  const rawSentinel = "RAW_RESPONSE_SENTINEL sk-secret https://private.example/path";
  const response: ProviderResponse = {
    content: rawSentinel,
    diagnostics: {
      httpStatus: 200,
      choiceCount: 1,
      contentLength: 999,
      finishReason: "provider-controlled-sentinel",
      usagePresent: true,
      usage: { promptTokens: 123, completionTokens: 456 },
      reasoningContentPresent: true,
    },
  };

  const diagnostic = recoveryDiagnosticOf({
    subject: { kind: "candidate", generation: 2, lane: "diversify" },
    attempt: 1,
    failureCode: "LIVE_PROPOSAL_INVALID_JSON",
    findings: [
      { code: "network", kind: "execution_instruction", excerpt: rawSentinel },
      { code: "network", kind: "execution_instruction" },
      { code: "../private/path", kind: "execution_instruction" },
    ] as Array<{ code: string; kind: string; excerpt?: string }>,
    response,
  });

  assert.deepEqual(Object.keys(diagnostic), [
    "subject",
    "attempt",
    "failureCode",
    "findingCodes",
    "responseLength",
    "finishReason",
    "responseSha256",
  ]);
  assert.deepEqual(diagnostic.findingCodes, ["network:execution_instruction"]);
  assert.equal(diagnostic.responseLength, rawSentinel.length, "length is computed from the actual response body");
  assert.equal(diagnostic.finishReason, "other", "provider-controlled finish text is normalized");
  assert.equal(
    diagnostic.responseSha256,
    createHash("sha256").update(rawSentinel, "utf8").digest("hex"),
  );
  const persisted = JSON.stringify(diagnostic);
  assert.ok(!persisted.includes(rawSentinel));
  assert.ok(!persisted.includes("sk-secret"));
  assert.ok(!persisted.includes("private.example"));
  assert.ok(!persisted.includes("promptTokens"));
});

test("finish-reason and finding projections are fixed, deduplicated, and content-free", () => {
  assert.equal(safeFinishReasonOf("stop"), "stop");
  assert.equal(safeFinishReasonOf("length"), "length");
  assert.equal(safeFinishReasonOf("content_filter"), "content_filter");
  assert.equal(safeFinishReasonOf("tool_calls"), "tool_calls");
  assert.equal(safeFinishReasonOf("unexpected-private-text"), "other");
  assert.equal(safeFinishReasonOf(undefined), null);
  assert.deepEqual(
    safeFindingCodesOf([
      { code: "network", kind: "execution_instruction" },
      { code: "filesystem", kind: "execution_instruction" },
      { code: "network", kind: "execution_instruction" },
      { code: "bad/path", kind: "https://private.example" },
    ]),
    ["filesystem:execution_instruction", "network:execution_instruction"],
  );
});

test("central diagnostic projection strips extra runtime fields and rejects invalid allowlist values", () => {
  const projected = projectRecoveryDiagnostic({
    subject: { kind: "candidate", generation: 1, lane: "exploit" },
    attempt: 2,
    failureCode: "LIVE_PROPOSAL_INVALID_JSON",
    findingCodes: ["network:execution_instruction", "network:execution_instruction"],
    responseLength: 12,
    finishReason: "stop",
    responseSha256: "a".repeat(64),
    rawResponse: "SECRET_RUNTIME_INJECTION",
    score: 100,
    holdout: "SEALED_RUNTIME_INJECTION",
  } as unknown as Parameters<typeof projectRecoveryDiagnostic>[0]);
  assert.deepEqual(Object.keys(projected), [
    "subject", "attempt", "failureCode", "findingCodes", "responseLength", "finishReason", "responseSha256",
  ]);
  assert.deepEqual(projected.findingCodes, ["network:execution_instruction"]);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|score|holdout|rawResponse/i);

  for (const invalid of [
    { ...projected, subject: { kind: "candidate", generation: -1, lane: "exploit" } },
    { ...projected, attempt: 3 },
    { ...projected, failureCode: "bad/code" },
    { ...projected, findingCodes: ["bad/path"] },
    { ...projected, responseLength: -1 },
    { ...projected, finishReason: "provider-private" },
    { ...projected, responseSha256: "not-a-hash" },
  ]) {
    assert.throws(
      () => projectRecoveryDiagnostic(invalid as Parameters<typeof projectRecoveryDiagnostic>[0]),
      /U1_RECOVERY_(?:SUBJECT|DIAGNOSTIC)_INVALID/,
    );
  }
});

test("application attempt identity separates recovery from primary but preserves identical primary cache identity", () => {
  const requestFingerprint = "ab".repeat(32);
  const primary = applicationAttemptIdentitySha256({
    operation: "mutation-proposer",
    originalRequestFingerprint: requestFingerprint,
    attempt: 1,
    mode: "primary",
  });
  const samePrimaryInAnotherGeneration = applicationAttemptIdentitySha256({
    operation: "mutation-proposer",
    originalRequestFingerprint: requestFingerprint,
    attempt: 1,
    mode: "primary",
  });
  const recovery = applicationAttemptIdentitySha256({
    operation: "mutation-proposer",
    originalRequestFingerprint: requestFingerprint,
    attempt: 2,
    mode: "format-repair",
  });

  assert.match(primary, /^[0-9a-f]{64}$/);
  assert.equal(samePrimaryInAnotherGeneration, primary, "generation/lane are deliberately absent from cache identity");
  assert.notEqual(recovery, primary, "a recovery may never hit the malformed primary cache entry");
});

test("central application-attempt projection binds one safe request fingerprint and strips extras", () => {
  const projected = projectApplicationRecoveryAttempt({
    subject: { kind: "candidate", generation: 2, lane: "diversify" },
    operation: "semantic-judge",
    attempt: 2,
    mode: "schema-repair",
    requestFingerprintSha256: "b".repeat(64),
    rawResponse: "SECRET_ATTEMPT_INJECTION",
  } as unknown as Parameters<typeof projectApplicationRecoveryAttempt>[0]);
  assert.deepEqual(projected, {
    subject: { kind: "candidate", generation: 2, lane: "diversify" },
    operation: "semantic-judge",
    attempt: 2,
    mode: "schema-repair",
    requestFingerprintSha256: "b".repeat(64),
  });
  assert.throws(
    () => projectApplicationRecoveryAttempt({
      ...projected,
      requestFingerprintSha256: "not-a-hash",
    }),
    /U1_RECOVERY_ATTEMPT_INVALID/,
  );
});

test("attempt-bound provider prefers immutable withContext and keeps concurrent contexts isolated", async () => {
  const seen: string[] = [];
  const base: Provider & {
    withContext(context: { scenarioId: string; snapshotId: string; frozenEvidenceSha256?: string }): Provider;
    setContext(scenarioId: string, snapshotId: string): void;
  } = {
    setContext() {
      throw new Error("mutable setContext must not be used when withContext exists");
    },
    withContext(context) {
      const captured = { ...context };
      return {
        async chat(): Promise<ProviderResponse> {
          await new Promise((resolve) => setTimeout(resolve, captured.scenarioId.endsWith("primary") ? 5 : 0));
          seen.push(`${captured.scenarioId}:${captured.snapshotId}`);
          return { content: "ok" };
        },
      };
    },
    async chat(): Promise<ProviderResponse> {
      throw new Error("unbound provider must not be used");
    },
  };

  const requestFingerprint = "cd".repeat(32);
  const primary = bindApplicationAttemptProvider({
    provider: base,
    operation: "mutation-proposer",
    originalRequestFingerprint: requestFingerprint,
    attempt: 1,
    mode: "primary",
  });
  const recovery = bindApplicationAttemptProvider({
    provider: base,
    operation: "mutation-proposer",
    originalRequestFingerprint: requestFingerprint,
    attempt: 2,
    mode: "format-repair",
  });

  await Promise.all([primary.chat([]), recovery.chat([])]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen.some((entry) => entry.startsWith("u1-mutation-proposer-primary:")));
  assert.ok(seen.some((entry) => entry.startsWith("u1-mutation-proposer-format-repair:")));
});

test("attempt-bound provider keeps a serial setContext fallback for simple providers", async () => {
  const seen: Array<[string, string]> = [];
  const provider: Provider & { setContext(scenarioId: string, snapshotId: string): void } = {
    setContext(scenarioId, snapshotId) {
      seen.push([scenarioId, snapshotId]);
    },
    async chat(): Promise<ProviderResponse> {
      return { content: "ok" };
    },
  };
  const bound = bindApplicationAttemptProvider({
    provider,
    operation: "semantic-judge",
    originalRequestFingerprint: "ef".repeat(32),
    attempt: 2,
    mode: "schema-repair",
  });
  await bound.chat([]);
  assert.equal(bound, provider);
  assert.equal(seen.length, 1);
  assert.match(seen[0][1], /^[0-9a-f]{64}$/);
});
