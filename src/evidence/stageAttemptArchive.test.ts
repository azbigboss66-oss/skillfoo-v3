import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEMANTIC_RESPONSE_BINDING_VERSION } from "../types.js";
import {
  StageAttemptArchiveError,
  archiveSupersededStageAttempt,
  readVerifiedStageAttemptSummary,
} from "./stageAttemptArchive.js";
import {
  DIRECT_U1_PROMPT_CONTRACT_SHA256,
  DIRECT_U1_PROMPT_CONTRACT_VERSION,
} from "../evolution/directBaseline.js";

const CONTRACT_SHA256 = "c".repeat(64);
const CURRENT_BINDING = {
  contractSha256: CONTRACT_SHA256,
  semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
  confirmationMode: "human" as const,
};
const HUMAN_FLAGS = {
  confirmationMode: "human",
  explorationOnly: false,
  humanConfirmationBypassed: false,
  formalEvidence: true,
  sealedAllowed: false,
  releaseAllowed: false,
};

function diagnostic(stage: "public-select" | "direct", attempt: 1 | 2 = 1) {
  return {
    subject: { kind: "stage", stage },
    attempt,
    failureCode: "SEMANTIC_JUDGE_INVALID_JSON",
    findingCodes: [],
    responseLength: 7,
    finishReason: "stop",
    responseSha256: (attempt === 1 ? "d" : "e").repeat(64),
  };
}

function publicFailure() {
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    status: "failed",
    phase: "public-select",
    contractSha256: CONTRACT_SHA256,
    selectItemsSha256: "b".repeat(64),
    adaptiveResultSha256: "a".repeat(64),
    safeError: { code: "PUBLIC_SELECTION_FAILED", message: "sanitized" },
    budget: { envelope: { existingRecoveryReserve: 1 } },
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    providerTokenTelemetry: {
      promptTokens: 10,
      completionTokens: 5,
      responses: 2,
    },
    actualApplicationRecoveryAttempts: 1,
    structureRecoveryDiagnostics: [diagnostic("public-select")],
    ...HUMAN_FLAGS,
  };
}

function directFailure() {
  return {
    schemaVersion: 1,
    semanticResponseBindingVersion: SEMANTIC_RESPONSE_BINDING_VERSION,
    createdAt: new Date().toISOString(),
    status: "failed",
    phase: "direct-public-select",
    contractSha256: CONTRACT_SHA256,
    directPromptContractVersion: DIRECT_U1_PROMPT_CONTRACT_VERSION,
    directPromptContractSha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
    safeError: { code: "DIRECT_RUN_FAILED", message: "sanitized" },
    budget: { envelope: { existingRecoveryReserve: 1 } },
    accounting: { logicalCalls: 2, httpAttempts: 2, retryAttempts: 0 },
    tokenTelemetry: { promptTokens: 10, completionTokens: 5, responses: 2 },
    actualApplicationRecoveryAttempts: 1,
    structureRecoveryDiagnostics: [diagnostic("direct")],
    ...HUMAN_FLAGS,
  };
}

test("archives current human public-select evidence and verifies the exact recovery binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-current-public-archive-"));
  try {
    const source = `${JSON.stringify(publicFailure(), null, 2)}\n`;
    await writeFile(join(dir, "public-selection-failure.json"), source, "utf8");
    const archived = await archiveSupersededStageAttempt({
      evidenceDir: dir,
      trigger: "public-select",
      expectedBinding: CURRENT_BINDING,
      now: () => "2026-08-30T00:00:00.000Z",
    });
    assert.deepEqual(archived, {
      kind: "archived",
      attemptName: "public-select-attempt-1",
      attemptSequence: 1,
      recoveredCommittedArchive: false,
    });
    const attemptDir = join(dir, "attempts", "public-select-attempt-1");
    assert.equal(await readFile(join(attemptDir, "public-selection-failure.json"), "utf8"), source);
    const summary = await readVerifiedStageAttemptSummary(attemptDir);
    assert.equal(summary.sourceBinding.compatibility, "verified");
    assert.equal(summary.expectedBinding.confirmationMode, "human");
    assert.deepEqual(summary.measurements[0].safeErrorCodes, ["PUBLIC_SELECTION_FAILED"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive rejects wrong-stage or duplicate recovery evidence without changing canonical bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-current-recovery-reject-"));
  try {
    const wrongStage = {
      ...publicFailure(),
      structureRecoveryDiagnostics: [diagnostic("direct")],
    };
    const source = `${JSON.stringify(wrongStage)}\n`;
    const path = join(dir, "public-selection-failure.json");
    await writeFile(path, source, "utf8");
    await assert.rejects(
      archiveSupersededStageAttempt({
        evidenceDir: dir,
        trigger: "public-select",
        expectedBinding: CURRENT_BINDING,
      }),
      (error: unknown) => error instanceof StageAttemptArchiveError &&
        error.code === "STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID",
    );
    assert.equal(await readFile(path, "utf8"), source);

    const duplicate = publicFailure();
    duplicate.actualApplicationRecoveryAttempts = 2;
    duplicate.structureRecoveryDiagnostics = [
      diagnostic("public-select"),
      { ...diagnostic("public-select"), responseSha256: "9".repeat(64) },
    ];
    await writeFile(path, `${JSON.stringify(duplicate)}\n`, "utf8");
    await assert.rejects(
      archiveSupersededStageAttempt({
        evidenceDir: dir,
        trigger: "public-select",
        expectedBinding: CURRENT_BINDING,
      }),
      (error: unknown) => error instanceof StageAttemptArchiveError &&
        error.code === "STAGE_ATTEMPT_ARCHIVE_ARTIFACT_INVALID",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Direct archive requires exact current semantic and prompt bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-current-direct-archive-"));
  try {
    const path = join(dir, "direct-failure.json");
    await writeFile(path, `${JSON.stringify(directFailure())}\n`, "utf8");
    await assert.rejects(
      archiveSupersededStageAttempt({
        evidenceDir: dir,
        trigger: "direct",
        expectedBinding: CURRENT_BINDING,
      }),
      (error: unknown) => error instanceof StageAttemptArchiveError &&
        error.code === "STAGE_ATTEMPT_ARCHIVE_INPUT_INVALID",
    );

    const missingIdentity = { ...directFailure() } as Record<string, unknown>;
    delete missingIdentity.semanticResponseBindingVersion;
    const missingRaw = `${JSON.stringify(missingIdentity)}\n`;
    await writeFile(path, missingRaw, "utf8");
    await assert.rejects(
      archiveSupersededStageAttempt({
        evidenceDir: dir,
        trigger: "direct",
        expectedBinding: {
          ...CURRENT_BINDING,
          directPromptContractVersion: DIRECT_U1_PROMPT_CONTRACT_VERSION,
          directPromptContractSha256: DIRECT_U1_PROMPT_CONTRACT_SHA256,
        },
      }),
      (error: unknown) => error instanceof StageAttemptArchiveError &&
        error.code === "STAGE_ATTEMPT_ARCHIVE_BINDING_INVALID",
    );
    assert.equal(await readFile(path, "utf8"), missingRaw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
