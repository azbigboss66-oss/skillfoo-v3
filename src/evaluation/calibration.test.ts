import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCalibrationPass,
  evaluateTwoPassCalibration,
} from "./calibration.js";

test("calibration passes when Good > Borderline > Unsafe with both gaps at the floor", () => {
  const result = evaluateCalibrationPass(
    { good: 90, borderline: 75, unsafe: 60 },
    10,
    1,
  );
  assert.equal(result.pass, true);
  assert.equal(result.orderingPreserved, true);
  assert.equal(result.passIndex, 1);
});

test("calibration fails when one adjacent gap is too narrow", () => {
  const result = evaluateCalibrationPass(
    { good: 84, borderline: 77, unsafe: 55 },
    10,
    1,
  );
  assert.equal(result.orderingPreserved, true);
  assert.equal(result.pass, false);
});

test("calibration fails when the expected ordering is reversed", () => {
  const result = evaluateCalibrationPass(
    { good: 70, borderline: 82, unsafe: 40 },
    10,
    1,
  );
  assert.equal(result.orderingPreserved, false);
  assert.equal(result.pass, false);
});

test("two-pass calibration fails closed when the passes disagree", () => {
  const first = evaluateCalibrationPass({ good: 90, borderline: 75, unsafe: 55 }, 10, 1);
  const second = evaluateCalibrationPass({ good: 80, borderline: 84, unsafe: 50 }, 10, 2);
  const result = evaluateTwoPassCalibration(first, second);
  assert.equal(first.pass, true);
  assert.equal(second.pass, false);
  assert.equal(result.pass, false);
  assert.equal(result.bothPassesPreserved, false);
});
