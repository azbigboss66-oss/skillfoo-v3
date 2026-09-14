import test from "node:test";
import assert from "node:assert/strict";
import { mapBoundedSettled, mapBoundedStable } from "./parallel.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("mapBoundedStable never starts more than two tasks at once", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapBoundedStable([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(15);
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result.values, [10, 20, 30, 40]);
  assert.equal(peak, 2);
  assert.equal(result.maxObservedInFlight, 2);
  assert.equal(result.timings.length, 4);
});

test("mapBoundedStable preserves input order even when later work finishes first", async () => {
  const result = await mapBoundedStable([30, 10], 2, async (delayMs) => {
    await delay(delayMs);
    return delayMs;
  });
  assert.deepEqual(result.values, [30, 10]);
});

test("mapBoundedStable rejects with the worker error and starts no queued work after it", async () => {
  const started: number[] = [];
  await assert.rejects(
    () =>
      mapBoundedStable([0, 1, 2], 1, async (value) => {
        started.push(value);
        if (value === 0) throw new Error("PARALLEL_TEST_FAILURE");
        return value;
      }),
    /PARALLEL_TEST_FAILURE/,
  );
  assert.deepEqual(started, [0]);
});

test("mapBoundedStable refuses an invalid concurrency cap", async () => {
  await assert.rejects(() => mapBoundedStable([1], 0, async (value) => value), /maxInFlight/);
  await assert.rejects(() => mapBoundedStable([1], 1.5, async (value) => value), /maxInFlight/);
});

test("mapBoundedSettled preserves order and lets a valid sibling finish", async () => {
  const started: number[] = [];
  const result = await mapBoundedSettled([20, 5, 10], 2, async (delayMs, index) => {
    started.push(index);
    await delay(delayMs);
    if (index === 0) throw new Error("candidate-local invalid JSON");
    return delayMs * 10;
  });

  assert.equal(result.values[0].status, "rejected");
  assert.deepEqual(result.values[1], { status: "fulfilled", value: 50 });
  assert.deepEqual(result.values[2], { status: "fulfilled", value: 100 });
  assert.deepEqual(started.sort(), [0, 1, 2]);
  assert.equal(result.maxObservedInFlight, 2);
  assert.equal(result.timings.length, 3);
});

test("mapBoundedSettled records every rejection without throwing", async () => {
  const result = await mapBoundedSettled(["a", "b"], 2, async (value) => {
    throw new Error(`bad-${value}`);
  });
  assert.equal(result.values.every((value) => value.status === "rejected"), true);
  assert.match(
    String(result.values[1].status === "rejected" ? result.values[1].reason : ""),
    /bad-b/,
  );
});
