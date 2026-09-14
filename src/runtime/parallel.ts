export interface ParallelTiming {
  index: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

export interface ParallelMapResult<T> {
  values: T[];
  timings: ParallelTiming[];
  maxObservedInFlight: number;
}

export type SettledValue<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * Settled counterpart for independent candidate lanes. It preserves input
 * order and concurrency accounting, but records each worker failure instead
 * of cancelling queued siblings or throwing from the map itself.
 */
export async function mapBoundedSettled<T, R>(
  items: readonly T[],
  maxInFlight: number,
  worker: (item: T, index: number) => Promise<R>,
  now: () => number = () => Date.now(),
): Promise<ParallelMapResult<SettledValue<R>>> {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`PARALLEL_INVALID_MAX_IN_FLIGHT: maxInFlight must be a positive integer, got ${maxInFlight}`);
  }

  const values = new Array<SettledValue<R>>(items.length);
  const timings = new Array<ParallelTiming>(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let maxObservedInFlight = 0;

  const takeOne = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const startedAtMs = now();
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      try {
        values[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        values[index] = { status: "rejected", reason };
      } finally {
        const endedAtMs = now();
        timings[index] = {
          index,
          startedAtMs,
          endedAtMs,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
        };
        inFlight -= 1;
      }
    }
  };

  const workerCount = Math.min(maxInFlight, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => takeOne()));
  return { values, timings, maxObservedInFlight };
}

/**
 * Run independent work with a fixed local concurrency cap. This module knows
 * nothing about providers or retries: callers own their budgets and failures.
 * Results remain in input order even when the work completes out of order.
 */
export async function mapBoundedStable<T, R>(
  items: readonly T[],
  maxInFlight: number,
  worker: (item: T, index: number) => Promise<R>,
  now: () => number = () => Date.now(),
): Promise<ParallelMapResult<R>> {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`PARALLEL_INVALID_MAX_IN_FLIGHT: maxInFlight must be a positive integer, got ${maxInFlight}`);
  }

  const values = new Array<R>(items.length);
  const timings = new Array<ParallelTiming>(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let maxObservedInFlight = 0;
  let failure: unknown = null;

  const takeOne = async (): Promise<void> => {
    while (failure === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const startedAtMs = now();
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      try {
        values[index] = await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      } finally {
        const endedAtMs = now();
        timings[index] = { index, startedAtMs, endedAtMs, durationMs: Math.max(0, endedAtMs - startedAtMs) };
        inFlight -= 1;
      }
    }
  };

  const workerCount = Math.min(maxInFlight, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => takeOne()));
  if (failure !== null) throw failure;

  return { values, timings, maxObservedInFlight };
}
