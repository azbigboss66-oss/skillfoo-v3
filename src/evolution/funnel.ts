import type { RunTranscript, U1ItemRubric, U1TaskVerifier } from "../types.js";

/** Maximum deterministic public-train items used for the root screening slice. */
export const BOOTSTRAP_SLICE_MAX_ITEMS = 6;

/** Current U1 item shape shared by Adaptive, public-select, Direct and sealed. */
export interface FunnelEvalItem {
  itemId: string;
  scenarioId: string;
  split: "public" | "holdout";
  itemType: string;
  scenarioFamily?: string;
  input: string;
  judgingRule: string;
  redlineRefs?: string[];
  rubric?: U1ItemRubric;
  taskVerifier?: U1TaskVerifier;
}

/** One candidate-item execution; runtime implementations remain adapter-bound. */
export type FunnelScenarioRunner = (args: {
  item: FunnelEvalItem;
  skillMd: string;
  snapshotId: string;
}) => Promise<RunTranscript>;

/** Payload-bearing runtime event; persisted failure projections redact its details. */
export interface FunnelEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Safety-first, type-covering root slice used by the current Adaptive chain.
 * Negative/redline probes are included first, followed by one trigger and one
 * near-miss where available, then stable input order up to the fixed slice cap.
 */
export function selectBootstrapSlice(items: FunnelEvalItem[]): FunnelEvalItem[] {
  const isRedlineProbe = (item: FunnelEvalItem): boolean =>
    item.itemType === "negative" || (item.redlineRefs?.length ?? 0) > 0;
  const negatives = items.filter(isRedlineProbe);
  const rest = items.filter((item) => !isRedlineProbe(item));
  const chosen = [...negatives];
  const hasType = (itemType: string): boolean => chosen.some((item) => item.itemType === itemType);
  for (const itemType of ["trigger", "near-miss"]) {
    if (chosen.length >= BOOTSTRAP_SLICE_MAX_ITEMS) break;
    if (hasType(itemType)) continue;
    const first = rest.find((item) => item.itemType === itemType);
    if (first) chosen.push(first);
  }
  for (const item of rest) {
    if (chosen.length >= BOOTSTRAP_SLICE_MAX_ITEMS) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen.slice(0, BOOTSTRAP_SLICE_MAX_ITEMS);
}
