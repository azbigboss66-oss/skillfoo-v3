import type { ConfirmationMode, ExecutionEvidenceMode } from "../types.js";

export type EvidenceModeErrorCode =
  | "FORMAL_CONFIRMATION_REQUIRED"
  | "FIXTURE_CONFIRMATION_REQUIRED"
  | "FIXTURE_LIVE_PROVIDER_FORBIDDEN"
  | "UNSUPPORTED_EVIDENCE_MODE"
  | "CONFIRMATION_HASH_DRIFT";

export class EvidenceModeError extends Error {
  constructor(
    readonly code: EvidenceModeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EvidenceModeError";
  }
}

export interface EvidenceAuthorization {
  executionMode: ExecutionEvidenceMode;
  explorationOnly: boolean;
  humanConfirmationBypassed: boolean;
  sealedAllowed: boolean;
  releaseAllowed: boolean;
}

export interface EvidenceModeInput {
  executionMode: ExecutionEvidenceMode;
  taskConfirmationMode?: ConfirmationMode;
  evaluationConfirmationMode?: ConfirmationMode;
  liveProvider: boolean;
}

/**
 * Convert explicit confirmation/run modes into immutable evidence limits.
 * This gate grants no sealed or release authority: those remain B5-only.
 */
export function authorizeEvidenceMode(input: EvidenceModeInput): EvidenceAuthorization {
  if (input.executionMode === "formal") {
    if (
      input.taskConfirmationMode !== "human" ||
      input.evaluationConfirmationMode !== "human"
    ) {
      throw new EvidenceModeError(
        "FORMAL_CONFIRMATION_REQUIRED",
        "formal evidence requires separate human Task Card and evaluation-review confirmations",
      );
    }
    return {
      executionMode: "formal",
      explorationOnly: false,
      humanConfirmationBypassed: false,
      sealedAllowed: false,
      releaseAllowed: false,
    };
  }

  if (input.executionMode === "test-fixture") {
    if (input.liveProvider) {
      throw new EvidenceModeError(
        "FIXTURE_LIVE_PROVIDER_FORBIDDEN",
        "test-fixture confirmations are valid only for zero-network automated tests",
      );
    }
    if (
      input.taskConfirmationMode !== "test-fixture" ||
      input.evaluationConfirmationMode !== "test-fixture"
    ) {
      throw new EvidenceModeError(
        "FIXTURE_CONFIRMATION_REQUIRED",
        "test-fixture evidence requires two explicit test-fixture confirmations",
      );
    }
    return {
      executionMode: "test-fixture",
      explorationOnly: true,
      humanConfirmationBypassed: false,
      sealedAllowed: false,
      releaseAllowed: false,
    };
  }

  throw new EvidenceModeError(
    "UNSUPPORTED_EVIDENCE_MODE",
    "current U1 evidence supports only formal human confirmation or zero-network test fixtures",
  );
}

export function assertConfirmationContentHash(
  confirmedContentSha256: string,
  currentContentSha256: string,
  label: string,
): void {
  if (confirmedContentSha256 !== currentContentSha256) {
    throw new EvidenceModeError(
      "CONFIRMATION_HASH_DRIFT",
      `${label} content differs from the content that was confirmed`,
    );
  }
}
