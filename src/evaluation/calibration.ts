import { createHash } from "node:crypto";
import { stableStringify } from "../intake/taskCard.js";
import {
  CalibrationResultSchema,
  CalibrationScoresSchema,
  TwoPassCalibrationResultSchema,
  type CalibrationResult,
  type CalibrationScores,
  type TwoPassCalibrationResult,
  type DraftItem,
} from "../types.js";

/** Bind the calibration to immutable scoring semantics, not to mutable review workflow metadata. */
export function calibrationSourceSha256(item: DraftItem): string {
  return createHash("sha256").update(stableStringify({
    itemId: item.itemId,
    split: item.split,
    selectionRole: item.selectionRole ?? null,
    itemType: item.itemType,
    input: item.input,
    judgingRule: item.judgingRule,
    rubric: item.rubric ?? null,
  }), "utf8").digest("hex");
}

function gapsMeetFloor(scores: CalibrationScores, floor: number): boolean {
  return scores.good - scores.borderline >= floor &&
    scores.borderline - scores.unsafe >= floor;
}

/** Pure, deterministic validation of one scorer calibration pass. */
export function evaluateCalibrationPass(
  rawScores: CalibrationScores,
  minAdjacentGap: number,
  passIndex: 1 | 2,
): CalibrationResult {
  const scores = CalibrationScoresSchema.parse(rawScores);
  if (!Number.isFinite(minAdjacentGap) || minAdjacentGap <= 0) {
    throw new Error("CALIBRATION_GAP_INVALID: minAdjacentGap must be positive");
  }
  const orderingPreserved = scores.good > scores.borderline && scores.borderline > scores.unsafe;
  return CalibrationResultSchema.parse({
    pass: orderingPreserved && gapsMeetFloor(scores, minAdjacentGap),
    minAdjacentGap,
    passIndex,
    scores,
    orderingPreserved,
  });
}

function middleOfTwo(a: number, b: number): number {
  return (a + b) / 2;
}

/**
 * Fail-closed aggregation for the two required independent evaluator passes.
 * Both individual passes and the component-wise median must preserve the
 * frozen gap. Provider orchestration intentionally stays outside this module.
 */
export function evaluateTwoPassCalibration(
  first: CalibrationResult,
  second: CalibrationResult,
): TwoPassCalibrationResult {
  const pass1 = CalibrationResultSchema.parse(first);
  const pass2 = CalibrationResultSchema.parse(second);
  if (pass1.passIndex !== 1 || pass2.passIndex !== 2) {
    throw new Error("CALIBRATION_PASS_ORDER_INVALID: expected pass indexes 1 then 2");
  }
  if (pass1.minAdjacentGap !== pass2.minAdjacentGap) {
    throw new Error("CALIBRATION_GAP_DRIFT: both passes must use the same frozen gap");
  }
  const medianScores = {
    good: middleOfTwo(pass1.scores.good, pass2.scores.good),
    borderline: middleOfTwo(pass1.scores.borderline, pass2.scores.borderline),
    unsafe: middleOfTwo(pass1.scores.unsafe, pass2.scores.unsafe),
  };
  const medianOrdering = medianScores.good > medianScores.borderline &&
    medianScores.borderline > medianScores.unsafe;
  const medianGapPreserved = medianOrdering && gapsMeetFloor(medianScores, pass1.minAdjacentGap);
  const bothPassesPreserved = pass1.pass && pass2.pass;

  return TwoPassCalibrationResultSchema.parse({
    pass: bothPassesPreserved && medianGapPreserved,
    minAdjacentGap: pass1.minAdjacentGap,
    passes: [pass1, pass2],
    medianScores,
    bothPassesPreserved,
    medianGapPreserved,
  });
}
