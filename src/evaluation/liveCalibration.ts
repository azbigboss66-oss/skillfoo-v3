import { createHash } from "node:crypto";
import { stableStringify } from "../intake/taskCard.js";
import type { Provider } from "../providers/types.js";
import type { InstructionGateInput } from "../runtime/instructionAdapter.js";
import {
  projectApplicationRecoveryAttempt,
  projectRecoveryDiagnostic,
  type U1ApplicationRecoveryAttempt,
  type U1RecoveryDiagnostic,
  type U1RecoveryHooks,
} from "../evolution/structureRecovery.js";
import {
  LiveCalibrationEvidenceSchema,
  type CalibrationScores,
  type EvaluationContractV3,
  type EvaluationDraft,
  type LiveCalibrationEvidence,
  type LiveCalibrationPassEvidence,
  type OpenAICompatibleProviderIdentity,
} from "../types.js";
import { createPublicSemanticBatchJudge, semanticResponseBindingVersion } from "./semanticJudge.js";
import {
  calibrationSourceSha256,
  evaluateCalibrationPass,
  evaluateTwoPassCalibration,
} from "./calibration.js";

export type CalibrationEvidenceErrorCode =
  | "CALIBRATION_TRIPLET_MISSING"
  | "CALIBRATION_TRIPLET_DRIFT"
  | "CALIBRATION_EVIDENCE_INVALID"
  | "CALIBRATION_NOT_PASSED"
  | "CALIBRATION_CONTRACT_DRIFT"
  | "CALIBRATION_PROVIDER_DRIFT"
  | "CALIBRATION_CONFIRMATION_MODE_DRIFT"
  | "CALIBRATION_SEMANTIC_BINDING_DRIFT";

export class CalibrationEvidenceError extends Error {
  constructor(readonly code: CalibrationEvidenceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CalibrationEvidenceError";
  }
}

export interface LiveCalibrationRecoveryEvidence {
  applicationRecoveryAttempts: U1ApplicationRecoveryAttempt[];
  structureRecoveryDiagnostics: U1RecoveryDiagnostic[];
}

export function createLiveCalibrationRecoveryEvidence(): LiveCalibrationRecoveryEvidence {
  return {
    applicationRecoveryAttempts: [],
    structureRecoveryDiagnostics: [],
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function calibrationTripletSha256(draft: EvaluationDraft): string {
  if (!draft.calibration) {
    throw new CalibrationEvidenceError("CALIBRATION_TRIPLET_MISSING", "the frozen evaluation draft has no calibration triplet");
  }
  return sha256(draft.calibration);
}

function calibrationRuns(draft: EvaluationDraft): InstructionGateInput[] {
  const calibration = draft.calibration;
  if (!calibration) {
    throw new CalibrationEvidenceError("CALIBRATION_TRIPLET_MISSING", "the frozen evaluation draft has no calibration triplet");
  }
  const source = draft.items.find((item) => item.itemId === calibration.sourceItemId);
  if (
    !source ||
    source.selectionRole !== "train" ||
    source.split !== "public" ||
    !source.rubric ||
    calibrationSourceSha256(source) !== calibration.sourceItemSha256
  ) {
    throw new CalibrationEvidenceError(
      "CALIBRATION_TRIPLET_DRIFT",
      "the calibration source is missing, non-train, or no longer matches its frozen semantic hash",
    );
  }
  return (["good", "borderline", "unsafe"] as const).map((level) => ({
    item: {
      itemId: `cal-${level}`,
      scenarioId: source.scenarioId,
      split: "public" as const,
      itemType: source.itemType,
      input: source.input,
      judgingRule: source.judgingRule,
      ...(source.redlineRefs ? { redlineRefs: source.redlineRefs } : {}),
      rubric: source.rubric,
    },
    transcript: {
      scenarioId: source.scenarioId,
      snapshotId: `calibration-${level}`,
      toolEvents: [],
      rawFinalResponse: "",
      parsedFinalAnswer: calibration.answers[level],
      terminalReason: "final" as const,
      turns: 1,
      durationMs: 0,
    },
  }));
}

function scoresOf(judgements: Awaited<ReturnType<ReturnType<typeof createPublicSemanticBatchJudge>>>): CalibrationScores {
  const byId = new Map(judgements.map((entry) => [entry.itemId, entry.score]));
  const scores = {
    good: byId.get("cal-good"),
    borderline: byId.get("cal-borderline"),
    unsafe: byId.get("cal-unsafe"),
  };
  if (Object.values(scores).some((score) => typeof score !== "number")) {
    throw new CalibrationEvidenceError("CALIBRATION_EVIDENCE_INVALID", "semantic judge omitted a calibration level score");
  }
  return scores as CalibrationScores;
}

export async function runTwoPassEvaluatorCalibration(args: {
  contract: EvaluationContractV3;
  draft: EvaluationDraft;
  provider: Provider;
  recoveryEvidence: LiveCalibrationRecoveryEvidence;
}): Promise<{
  semanticResponseBindingVersion: typeof semanticResponseBindingVersion;
  result: ReturnType<typeof evaluateTwoPassCalibration>;
  passes: [LiveCalibrationPassEvidence, LiveCalibrationPassEvidence];
  applicationRecoveryAttempts: U1ApplicationRecoveryAttempt[];
  structureRecoveryDiagnostics: U1RecoveryDiagnostic[];
}> {
  const minGap = args.contract.calibrationMinAdjacentGap;
  const expectedTripletHash = args.contract.calibrationTripletSha256;
  if (!minGap || !expectedTripletHash) {
    throw new CalibrationEvidenceError(
      "CALIBRATION_TRIPLET_MISSING",
      "the frozen contract does not bind a calibration triplet and adjacent-gap threshold",
    );
  }
  if (calibrationTripletSha256(args.draft) !== expectedTripletHash) {
    throw new CalibrationEvidenceError("CALIBRATION_TRIPLET_DRIFT", "the draft calibration triplet differs from the frozen contract hash");
  }
  const runs = calibrationRuns(args.draft);
  const recoveryHooks: U1RecoveryHooks = {
    onApplicationRecoveryAttempt: (attempt) => {
      args.recoveryEvidence.applicationRecoveryAttempts.push(projectApplicationRecoveryAttempt(attempt));
    },
    onDiagnostic: (diagnostic) => {
      args.recoveryEvidence.structureRecoveryDiagnostics.push(projectRecoveryDiagnostic(diagnostic));
    },
  };
  const passEvidence: LiveCalibrationPassEvidence[] = [];
  const results = [];
  for (const passIndex of [1, 2] as const) {
    const judge = createPublicSemanticBatchJudge({
      provider: args.provider,
      maxItemsPerRequest: 3,
      recovery: {
        subject: { kind: "stage", stage: "calibration", pass: passIndex },
        hooks: recoveryHooks,
      },
    });
    const judgements = await judge(runs);
    const scores = scoresOf(judgements);
    const requestFingerprints = [...new Set(judgements.map((entry) => entry.requestFingerprint).filter((value): value is string => Boolean(value)))];
    if (requestFingerprints.length !== 1) {
      throw new CalibrationEvidenceError("CALIBRATION_EVIDENCE_INVALID", "one calibration pass must have one request fingerprint");
    }
    passEvidence.push({
      scores,
      requestFingerprint: requestFingerprints[0],
      resultFingerprint: sha256(judgements.map((entry) => ({ itemId: entry.itemId, score: entry.score, dimensions: entry.dimensions }))),
    });
    results.push(evaluateCalibrationPass(scores, minGap, passIndex));
  }
  return {
    semanticResponseBindingVersion,
    result: evaluateTwoPassCalibration(results[0], results[1]),
    passes: passEvidence as [LiveCalibrationPassEvidence, LiveCalibrationPassEvidence],
    applicationRecoveryAttempts: [...args.recoveryEvidence.applicationRecoveryAttempts],
    structureRecoveryDiagnostics: [...args.recoveryEvidence.structureRecoveryDiagnostics],
  };
}

export function assertCalibrationEvidenceForAdaptive(
  rawEvidence: unknown,
  expected: {
    contractSha256: string;
    calibrationTripletSha256: string;
    providerIdentity: OpenAICompatibleProviderIdentity;
    confirmationMode: "human";
  },
): LiveCalibrationEvidence {
  const rawRecord = rawEvidence && typeof rawEvidence === "object"
    ? rawEvidence as Record<string, unknown>
    : null;
  if (rawRecord?.semanticResponseBindingVersion !== semanticResponseBindingVersion) {
    throw new CalibrationEvidenceError(
      "CALIBRATION_SEMANTIC_BINDING_DRIFT",
      `calibration evidence must use ${semanticResponseBindingVersion}`,
    );
  }
  const parsed = LiveCalibrationEvidenceSchema.safeParse(rawEvidence);
  if (!parsed.success) {
    throw new CalibrationEvidenceError("CALIBRATION_EVIDENCE_INVALID", "the calibration evidence is malformed or not passed");
  }
  const evidence = parsed.data;
  if (!evidence.result.pass) {
    throw new CalibrationEvidenceError("CALIBRATION_NOT_PASSED", "the two-pass evaluator calibration did not pass");
  }
  if (
    evidence.contractSha256 !== expected.contractSha256 ||
    evidence.calibrationTripletSha256 !== expected.calibrationTripletSha256
  ) {
    throw new CalibrationEvidenceError("CALIBRATION_CONTRACT_DRIFT", "the calibration evidence is bound to different frozen inputs");
  }
  if (
    JSON.stringify(evidence.provider) !== JSON.stringify(expected.providerIdentity)
  ) {
    throw new CalibrationEvidenceError("CALIBRATION_PROVIDER_DRIFT", "the evaluator model configuration differs from the calibration evidence");
  }
  if (evidence.confirmationMode !== expected.confirmationMode) {
    throw new CalibrationEvidenceError("CALIBRATION_CONFIRMATION_MODE_DRIFT", "the calibration evidence uses a different confirmation mode");
  }
  return evidence;
}
