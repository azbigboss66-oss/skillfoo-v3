import type { Provider, ProviderResponse } from "../providers/types.js";
import { sha256Hex } from "../runtime/capabilityAdapter.js";

/** Content-free lane names allowed in persisted U1 structure-recovery evidence. */
export type U1RecoveryLane = "anchor" | "seed" | "exploit" | "diversify";

/** A candidate slot identity. It is diagnostic context, never cache-key material. */
export interface U1CandidateRecoverySubject {
  kind: "candidate";
  generation: number;
  lane: U1RecoveryLane;
}

/** Fixed non-candidate stages; free-text stage names are intentionally forbidden. */
export type U1StageRecoverySubject =
  | { kind: "stage"; stage: "calibration"; pass: 1 | 2 }
  | { kind: "stage"; stage: "public-select" | "direct" };

export type U1RecoverySubject = U1CandidateRecoverySubject | U1StageRecoverySubject;

export type U1RecoveryOperation = "mutation-proposer" | "repair-proposer" | "semantic-judge";
export type U1RecoveryMode = "primary" | "format-repair" | "constrained-reproposal" | "schema-repair";
export type U1RecoveryAttempt = 1 | 2;
export type U1SafeFinishReason = "stop" | "length" | "content_filter" | "tool_calls" | "other" | null;

/** Exact persisted allowlist for one rejected model response. */
export interface U1RecoveryDiagnostic {
  subject: U1RecoverySubject;
  attempt: U1RecoveryAttempt;
  failureCode: string;
  findingCodes: string[];
  responseLength: number;
  finishReason: U1SafeFinishReason;
  responseSha256: string;
}

/** Internal accounting event emitted immediately before the one recovery call. */
export interface U1ApplicationRecoveryAttempt {
  subject: U1RecoverySubject;
  operation: U1RecoveryOperation;
  attempt: 2;
  mode: Exclude<U1RecoveryMode, "primary">;
  requestFingerprintSha256: string;
}

export interface U1RecoveryHooks {
  onApplicationRecoveryAttempt: (attempt: U1ApplicationRecoveryAttempt) => void;
  onDiagnostic: (diagnostic: U1RecoveryDiagnostic) => void;
}

export interface U1RecoveryContext {
  subject: U1RecoverySubject;
  hooks: U1RecoveryHooks;
}

export interface U1FindingLike {
  code?: unknown;
  kind?: unknown;
}

export type U1AttemptContextProvider = Provider & {
  withContext?: (context: {
    scenarioId: string;
    snapshotId: string;
    frozenEvidenceSha256?: string;
  }) => Provider;
  setContext?: (scenarioId: string, snapshotId: string) => void;
};

const SAFE_FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls"]);
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FINDING_CODE = /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/;

function assertRecoverySubject(subject: U1RecoverySubject): void {
  if (subject.kind === "candidate") {
    if (!Number.isInteger(subject.generation) || subject.generation < 0) {
      throw new TypeError("U1_RECOVERY_SUBJECT_INVALID: generation must be a non-negative integer");
    }
    if (!["anchor", "seed", "exploit", "diversify"].includes(subject.lane)) {
      throw new TypeError("U1_RECOVERY_SUBJECT_INVALID: lane is outside the fixed allowlist");
    }
    return;
  }
  if (subject.kind !== "stage") {
    throw new TypeError("U1_RECOVERY_SUBJECT_INVALID: subject kind is outside the fixed allowlist");
  }
  if (subject.stage === "calibration") {
    if (subject.pass !== 1 && subject.pass !== 2) {
      throw new TypeError("U1_RECOVERY_SUBJECT_INVALID: calibration pass must be 1 or 2");
    }
    return;
  }
  if (subject.stage !== "public-select" && subject.stage !== "direct") {
    throw new TypeError("U1_RECOVERY_SUBJECT_INVALID: stage is outside the fixed allowlist");
  }
}

function projectRecoverySubject(subject: U1RecoverySubject): U1RecoverySubject {
  assertRecoverySubject(subject);
  return subject.kind === "candidate"
    ? { kind: "candidate", generation: subject.generation, lane: subject.lane }
    : subject.stage === "calibration"
      ? { kind: "stage", stage: "calibration", pass: subject.pass }
      : { kind: "stage", stage: subject.stage };
}

export function safeFinishReasonOf(value: unknown): U1SafeFinishReason {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && SAFE_FINISH_REASONS.has(value)
    ? value as Exclude<U1SafeFinishReason, "other" | null>
    : "other";
}

export function safeFindingCodesOf(findings: readonly U1FindingLike[]): string[] {
  const safe = new Set<string>();
  for (const finding of findings) {
    if (
      typeof finding.code === "string" && SAFE_CODE.test(finding.code) &&
      typeof finding.kind === "string" && SAFE_CODE.test(finding.kind)
    ) {
      safe.add(`${finding.code}:${finding.kind}`);
    }
  }
  return [...safe].sort();
}

/**
 * Runtime evidence boundary for injected scorers/proposers. TypeScript types
 * cannot prevent an out-of-contract object from carrying extra response text,
 * scores, or sealed metadata, so every central hook re-projects the exact
 * eight-field allowlist and fails closed on an invalid value.
 */
export function projectRecoveryDiagnostic(value: U1RecoveryDiagnostic): U1RecoveryDiagnostic {
  const subject = projectRecoverySubject(value.subject);
  if (value.attempt !== 1 && value.attempt !== 2) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: attempt must be 1 or 2");
  }
  if (typeof value.failureCode !== "string" || !SAFE_CODE.test(value.failureCode)) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: failureCode is outside the safe code allowlist");
  }
  if (
    !Array.isArray(value.findingCodes) ||
    !value.findingCodes.every((code) => typeof code === "string" && SAFE_FINDING_CODE.test(code))
  ) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: findingCodes are outside the safe code allowlist");
  }
  if (!Number.isInteger(value.responseLength) || value.responseLength < 0) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: responseLength must be a non-negative integer");
  }
  if (
    value.finishReason !== null &&
    !["stop", "length", "content_filter", "tool_calls", "other"].includes(value.finishReason)
  ) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: finishReason is outside the fixed allowlist");
  }
  if (typeof value.responseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.responseSha256)) {
    throw new TypeError("U1_RECOVERY_DIAGNOSTIC_INVALID: responseSha256 must be an exact lowercase SHA-256");
  }
  return {
    subject,
    attempt: value.attempt,
    failureCode: value.failureCode,
    findingCodes: [...new Set(value.findingCodes)].sort(),
    responseLength: value.responseLength,
    finishReason: value.finishReason,
    responseSha256: value.responseSha256,
  };
}

/** Exact, content-free runtime projection for one application recovery spend. */
export function projectApplicationRecoveryAttempt(
  value: U1ApplicationRecoveryAttempt,
): U1ApplicationRecoveryAttempt {
  assertRecoverySubject(value.subject);
  if (value.subject.kind === "stage" && value.operation !== "semantic-judge") {
    throw new TypeError("U1_RECOVERY_ATTEMPT_INVALID: stage recovery is semantic-judge schema repair only");
  }
  if (value.attempt !== 2) {
    throw new TypeError("U1_RECOVERY_ATTEMPT_INVALID: application recovery attempt must be 2");
  }
  if (
    value.operation === "mutation-proposer" || value.operation === "repair-proposer"
      ? value.mode !== "format-repair" && value.mode !== "constrained-reproposal"
      : value.operation === "semantic-judge"
        ? value.mode !== "schema-repair"
        : true
  ) {
    throw new TypeError("U1_RECOVERY_ATTEMPT_INVALID: operation/mode pairing is outside the fixed allowlist");
  }
  if (
    typeof value.requestFingerprintSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.requestFingerprintSha256)
  ) {
    throw new TypeError("U1_RECOVERY_ATTEMPT_INVALID: requestFingerprintSha256 must be an exact lowercase SHA-256");
  }
  return {
    subject: projectRecoverySubject(value.subject),
    operation: value.operation,
    attempt: 2,
    mode: value.mode,
    requestFingerprintSha256: value.requestFingerprintSha256,
  };
}

export function applicationAttemptIdentitySha256(input: {
  operation: U1RecoveryOperation;
  originalRequestFingerprint: string;
  attempt: U1RecoveryAttempt;
  mode: U1RecoveryMode;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.originalRequestFingerprint)) {
    throw new TypeError("U1_RECOVERY_REQUEST_FINGERPRINT_INVALID: expected an exact lowercase SHA-256");
  }
  if (
    (input.attempt === 1 && input.mode !== "primary") ||
    (input.attempt === 2 && input.mode === "primary")
  ) {
    throw new TypeError("U1_RECOVERY_ATTEMPT_MODE_INVALID: primary is attempt 1 and recovery is attempt 2");
  }
  return sha256Hex(JSON.stringify({
    contract: "u1-structure-recovery-attempt-v1",
    operation: input.operation,
    originalRequestFingerprint: input.originalRequestFingerprint,
    attempt: input.attempt,
    mode: input.mode,
  }));
}

/**
 * Additive attempt identity for a whole candidate-item conversation. It is
 * deliberately separate from v1 JSON structure-repair identities so old
 * mutation/repair/semantic hashes retain their exact meaning.
 */
export function scenarioApplicationAttemptIdentitySha256(input: {
  originalRequestFingerprint: string;
  attempt: U1RecoveryAttempt;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.originalRequestFingerprint)) {
    throw new TypeError("U1_RECOVERY_REQUEST_FINGERPRINT_INVALID: expected an exact lowercase SHA-256");
  }
  return sha256Hex(JSON.stringify({
    contract: "u1-scenario-application-attempt-v2",
    originalRequestFingerprint: input.originalRequestFingerprint,
    attempt: input.attempt,
    mode: input.attempt === 1 ? "primary" : "fresh-context-retry",
  }));
}

export function bindApplicationAttemptProvider(input: {
  provider: U1AttemptContextProvider;
  operation: U1RecoveryOperation;
  originalRequestFingerprint: string;
  attempt: U1RecoveryAttempt;
  mode: U1RecoveryMode;
}): Provider {
  const attemptIdentity = applicationAttemptIdentitySha256(input);
  const scenarioId = `u1-${input.operation}-${input.mode}`;
  if (typeof input.provider.withContext === "function") {
    return input.provider.withContext({
      scenarioId,
      snapshotId: attemptIdentity,
      frozenEvidenceSha256: input.originalRequestFingerprint,
    });
  }
  // Compatibility for simple serial fixture providers only. Live closure
  // providers expose withContext, so concurrent calls never share this state.
  input.provider.setContext?.(scenarioId, attemptIdentity);
  return input.provider;
}

export function recoveryDiagnosticOf(input: {
  subject: U1RecoverySubject;
  attempt: U1RecoveryAttempt;
  failureCode: string;
  findings?: readonly U1FindingLike[];
  response: ProviderResponse;
}): U1RecoveryDiagnostic {
  assertRecoverySubject(input.subject);
  if (!SAFE_CODE.test(input.failureCode)) {
    throw new TypeError("U1_RECOVERY_FAILURE_CODE_INVALID: failureCode must be a stable local code");
  }
  return {
    subject: projectRecoverySubject(input.subject),
    attempt: input.attempt,
    failureCode: input.failureCode,
    findingCodes: safeFindingCodesOf(input.findings ?? []),
    responseLength: input.response.content.length,
    finishReason: safeFinishReasonOf(input.response.diagnostics?.finishReason),
    responseSha256: sha256Hex(input.response.content),
  };
}
