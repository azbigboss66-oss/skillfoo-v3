import { mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { packageRoot } from "../cli.js";

/**
 * Create a timestamped run directory under the package root.
 * Format: runs/<projectName>/<YYYYMMDDTHHMMSSZ>/
 * Rejects timestamps containing path separators or traversal sequences.
 */
export async function createRunDir(
  projectDir: string,
  timestamp: string,
  runsRoot?: string,
): Promise<string> {
  if (/[\/\\]|\.\./.test(timestamp)) {
    throw new Error(`Invalid timestamp containing path separators or traversal: ${timestamp}`);
  }

  const projectName = basename(projectDir);
  const runDir = join(runsRoot ?? join(packageRoot, "runs"), projectName, timestamp);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

// ── Task Card artifact paths (V3 T03) ───────────────────────────
// Task cards live directly in the project/intake directory: a draft
// is never a release input, and the confirmed file is the only one
// downstream tasks (T04+) may treat as intent truth.

export const TASK_CARD_DRAFT_FILENAME = "task-card.draft.json";
export const TASK_CARD_CONFIRMED_FILENAME = "task-card.confirmed.json";

export function taskCardDraftPath(projectDir: string): string {
  return join(projectDir, TASK_CARD_DRAFT_FILENAME);
}

export function taskCardConfirmedPath(projectDir: string): string {
  return join(projectDir, TASK_CARD_CONFIRMED_FILENAME);
}

// ── AI Eval Factory artifact paths (V3 T04) ──────────────────────

export const EVALUATION_BLUEPRINT_FILENAME = "evaluation-blueprint.json";
export const EVALUATION_DRAFT_FILENAME = "evaluation-draft.json";
export const EVALUATION_CURATION_FILENAME = "evaluation-curation.json";
export const EVALUATION_REVIEW_DRAFT_FILENAME = "evaluation-review.draft.json";
export const EVALUATION_REVIEW_CONFIRMED_FILENAME = "evaluation-review.confirmed.json";
export const EVALUATION_REVIEW_MARKDOWN_FILENAME = "evaluation-review.zh-CN.md";

export function evaluationBlueprintPath(dir: string): string {
  return join(dir, EVALUATION_BLUEPRINT_FILENAME);
}

export function evaluationDraftPath(dir: string): string {
  return join(dir, EVALUATION_DRAFT_FILENAME);
}

export function evaluationCurationPath(dir: string): string {
  return join(dir, EVALUATION_CURATION_FILENAME);
}

export function evaluationReviewDraftPath(dir: string): string {
  return join(dir, EVALUATION_REVIEW_DRAFT_FILENAME);
}

export function evaluationReviewConfirmedPath(dir: string): string {
  return join(dir, EVALUATION_REVIEW_CONFIRMED_FILENAME);
}

export function evaluationReviewMarkdownPath(dir: string): string {
  return join(dir, EVALUATION_REVIEW_MARKDOWN_FILENAME);
}

// ── Evaluation contract V3 artifact paths (V3 T05) ───────────────
// The freeze writes three artefacts into the same directory: the public
// contract, the holdout file (the answer key evolution must never read)
// and the immutable manifest that pins ids and hashes.

export const EVALUATION_CONTRACT_V3_FILENAME = "evaluation-contract.v3.json";
export const EVALUATION_HOLDOUT_V3_FILENAME = "evaluation-holdout.v3.json";
export const EVALUATION_MANIFEST_V3_FILENAME = "evaluation-manifest.v3.json";

export function evaluationContractV3Path(dir: string): string {
  return join(dir, EVALUATION_CONTRACT_V3_FILENAME);
}

export function evaluationHoldoutV3Path(dir: string): string {
  return join(dir, EVALUATION_HOLDOUT_V3_FILENAME);
}

export function evaluationManifestV3Path(dir: string): string {
  return join(dir, EVALUATION_MANIFEST_V3_FILENAME);
}

// ── Bootstrap artifact paths (V3 T06) ─────────────────────────────
// The bootstrap run writes the S0 scaffold (s0/SKILL.md) and one bundle
// record holding both root freezes and the two lane results.

export const BOOTSTRAP_BUNDLE_FILENAME = "bootstrap-bundle.v3.json";
export const BOOTSTRAP_S0_DIRNAME = "s0";

export function bootstrapBundlePath(dir: string): string {
  return join(dir, BOOTSTRAP_BUNDLE_FILENAME);
}

export function bootstrapS0Path(dir: string): string {
  return join(dir, BOOTSTRAP_S0_DIRNAME, "SKILL.md");
}
