import test from "node:test";
import assert from "node:assert/strict";
import {
  assertConfirmationContentHash,
  authorizeEvidenceMode,
  EvidenceModeError,
} from "./evidenceMode.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("formal evidence requires two human confirmations", () => {
  const authorization = authorizeEvidenceMode({
    executionMode: "formal",
    taskConfirmationMode: "human",
    evaluationConfirmationMode: "human",
    liveProvider: true,
  });

  assert.deepEqual(authorization, {
    executionMode: "formal",
    explorationOnly: false,
    humanConfirmationBypassed: false,
    sealedAllowed: false,
    releaseAllowed: false,
  });
});

test("formal evidence rejects a missing confirmation", () => {
  assert.throws(
    () => authorizeEvidenceMode({
      executionMode: "formal",
      taskConfirmationMode: "human",
      liveProvider: true,
    }),
    (error: unknown) => error instanceof EvidenceModeError && error.code === "FORMAL_CONFIRMATION_REQUIRED",
  );
});

test("formal live evidence rejects fixture confirmations", () => {
  assert.throws(
    () => authorizeEvidenceMode({
      executionMode: "formal",
      taskConfirmationMode: "test-fixture",
      evaluationConfirmationMode: "test-fixture",
      liveProvider: true,
    }),
    (error: unknown) => error instanceof EvidenceModeError && error.code === "FORMAL_CONFIRMATION_REQUIRED",
  );
});

test("test-fixture evidence accepts two fixture confirmations offline", () => {
  const authorization = authorizeEvidenceMode({
    executionMode: "test-fixture",
    taskConfirmationMode: "test-fixture",
    evaluationConfirmationMode: "test-fixture",
    liveProvider: false,
  });

  assert.equal(authorization.explorationOnly, true);
  assert.equal(authorization.humanConfirmationBypassed, false);
  assert.equal(authorization.sealedAllowed, false);
  assert.equal(authorization.releaseAllowed, false);
});

test("test-fixture evidence rejects a live provider", () => {
  assert.throws(
    () => authorizeEvidenceMode({
      executionMode: "test-fixture",
      taskConfirmationMode: "test-fixture",
      evaluationConfirmationMode: "test-fixture",
      liveProvider: true,
    }),
    (error: unknown) => error instanceof EvidenceModeError && error.code === "FIXTURE_LIVE_PROVIDER_FORBIDDEN",
  );
});

test("test-fixture evidence rejects a human and fixture mixture", () => {
  assert.throws(
    () => authorizeEvidenceMode({
      executionMode: "test-fixture",
      taskConfirmationMode: "human",
      evaluationConfirmationMode: "test-fixture",
      liveProvider: false,
    }),
    (error: unknown) => error instanceof EvidenceModeError && error.code === "FIXTURE_CONFIRMATION_REQUIRED",
  );
});

test("confirmation content hash drift is rejected", () => {
  assert.doesNotThrow(() => assertConfirmationContentHash(HASH_A, HASH_A, "task card"));
  assert.throws(
    () => assertConfirmationContentHash(HASH_A, HASH_B, "task card"),
    (error: unknown) => error instanceof EvidenceModeError && error.code === "CONFIRMATION_HASH_DRIFT",
  );
});
