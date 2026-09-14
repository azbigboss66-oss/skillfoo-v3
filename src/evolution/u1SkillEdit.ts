/**
 * Authoritative U1 mutation/repair protocol. It accepts a small set of exact
 * edits against the supplied parent SKILL.md, or an explicit no_change
 * decision. The current U1 path has no whole-file replacement protocol.
 */

export const U1_EDIT_MAX_EDITS = 4;
export const U1_EDIT_MIN_GROWTH_ALLOWANCE = 1_200;
export const U1_EDIT_GROWTH_RATIO = 0.25;

export type U1SkillEditErrorCode =
  | "U1_EDIT_INVALID_JSON"
  | "U1_EDIT_INVALID"
  | "U1_EDIT_SCOPE_VIOLATION"
  | "U1_EDIT_LIMIT_EXCEEDED"
  | "U1_EDIT_ANCHOR_NOT_UNIQUE"
  | "U1_EDIT_OVERLAP"
  | "U1_EDIT_NOOP"
  | "U1_EDIT_RESULT_EMPTY"
  | "U1_EDIT_GOVERNANCE_METADATA_FORBIDDEN"
  | "U1_EDIT_GROWTH_LIMIT_EXCEEDED";

export class U1SkillEditError extends Error {
  constructor(
    readonly code: U1SkillEditErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "U1SkillEditError";
  }
}

export interface AppliedU1SkillChange {
  hypothesis: string;
  decision: "edit" | "no_change";
  skillMd: string;
  appliedEdits: number;
}

type JsonObject = Record<string, unknown>;

interface ResolvedEdit {
  anchor: string;
  start: number;
  end: number;
  replacement: string;
}

const INTERNAL_GOVERNANCE_MARKERS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "contract-binding", pattern: /\b(?:contractSha256|contract[-_ ]?hash)\b/giu },
  { id: "evaluation-split", pattern: /\b(?:public[-_ ]?train|public[-_ ]?select|terminal[-_ ]?public[-_ ]?select|sealed[-_ ]?holdout|evaluation[-_ ]?holdout)\b/giu },
  { id: "gate-identity", pattern: /\b(?:gateId|gate[-_ ]id|gate\s+identifier)\b/giu },
  { id: "budget-identity", pattern: /\b(?:adaptiveMaxLogicalCalls|publicSelectMaxLogicalCalls|directMaxLogicalCalls|sealedMaxLogicalCalls|maxLogicalCalls)\b/gu },
  { id: "hidden-evaluation", pattern: /\b(?:hidden|unseen)\s+(?:tests?|examples?)\b|隐藏(?:测试|样例)|未见过的?(?:测试|样例)/giu },
  { id: "provenance-section", pattern: /^\s*(?:#{1,6}\s*)?(?:internal\s+)?provenance\s*:?\s*$/gimu },
];

function markerCount(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function assertNoIntroducedGovernanceMetadata(parentSkillMd: string, skillMd: string): void {
  const introduced = INTERNAL_GOVERNANCE_MARKERS
    .filter(({ pattern }) => markerCount(skillMd, pattern) > markerCount(parentSkillMd, pattern))
    .map(({ id }) => id);
  if (introduced.length > 0) {
    throw new U1SkillEditError(
      "U1_EDIT_GOVERNANCE_METADATA_FORBIDDEN",
      `candidate text may not introduce internal evaluation governance (${introduced.join(", ")})`,
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: JsonObject, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new U1SkillEditError(
      "U1_EDIT_INVALID",
      `${context} contains unsupported field(s): ${unexpected.sort().join(", ")}`,
    );
  }
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new U1SkillEditError("U1_EDIT_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

function assertSkillPath(edit: JsonObject): void {
  if (edit.path !== undefined && edit.path !== "SKILL.md") {
    throw new U1SkillEditError(
      "U1_EDIT_SCOPE_VIOLATION",
      "an U1 edit may target only the parent SKILL.md",
    );
  }
}

function uniqueOccurrence(parentSkillMd: string, anchor: string): number {
  let first = -1;
  let occurrences = 0;
  let cursor = 0;
  while (cursor <= parentSkillMd.length - anchor.length) {
    const found = parentSkillMd.indexOf(anchor, cursor);
    if (found === -1) break;
    if (first === -1) first = found;
    occurrences += 1;
    if (occurrences > 1) break;
    cursor = found + 1;
  }
  if (occurrences !== 1) {
    throw new U1SkillEditError(
      "U1_EDIT_ANCHOR_NOT_UNIQUE",
      `each exact anchor must occur once in the parent SKILL.md; observed ${occurrences}`,
    );
  }
  return first;
}

function resolveEdit(parentSkillMd: string, raw: unknown): ResolvedEdit {
  if (!isObject(raw)) {
    throw new U1SkillEditError("U1_EDIT_INVALID", "each edit must be a JSON object");
  }
  assertSkillPath(raw);
  if (typeof raw.op !== "string") {
    throw new U1SkillEditError("U1_EDIT_INVALID", "each edit requires an op string");
  }

  if (raw.op === "replace_exact") {
    assertExactKeys(raw, ["op", "path", "oldText", "newText"], "replace_exact edit");
    const anchor = requiredNonEmptyString(raw.oldText, "replace_exact.oldText");
    if (anchor === parentSkillMd) {
      throw new U1SkillEditError(
        "U1_EDIT_SCOPE_VIOLATION",
        "replace_exact may not use the complete parent document as its anchor",
      );
    }
    if (typeof raw.newText !== "string") {
      throw new U1SkillEditError("U1_EDIT_INVALID", "replace_exact.newText must be a string");
    }
    const start = uniqueOccurrence(parentSkillMd, anchor);
    return { anchor, start, end: start + anchor.length, replacement: raw.newText };
  }

  if (raw.op === "delete_exact") {
    assertExactKeys(raw, ["op", "path", "oldText"], "delete_exact edit");
    const anchor = requiredNonEmptyString(raw.oldText, "delete_exact.oldText");
    const start = uniqueOccurrence(parentSkillMd, anchor);
    return { anchor, start, end: start + anchor.length, replacement: "" };
  }

  if (raw.op === "insert_after") {
    assertExactKeys(raw, ["op", "path", "anchor", "text"], `${raw.op} edit`);
    const anchor = requiredNonEmptyString(raw.anchor, `${raw.op}.anchor`);
    const text = requiredNonEmptyString(raw.text, `${raw.op}.text`);
    const anchorStart = uniqueOccurrence(parentSkillMd, anchor);
    const start = anchorStart + anchor.length;
    return { anchor, start, end: start, replacement: text };
  }

  throw new U1SkillEditError("U1_EDIT_INVALID", `unsupported edit op: ${raw.op}`);
}

function editsConflict(left: ResolvedEdit, right: ResolvedEdit): boolean {
  const leftPoint = left.start === left.end;
  const rightPoint = right.start === right.end;
  if (leftPoint && rightPoint) return left.start === right.start;
  if (leftPoint) return left.start >= right.start && left.start <= right.end;
  if (rightPoint) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function applyResolvedEdits(parentSkillMd: string, edits: ResolvedEdit[]): string {
  for (let left = 0; left < edits.length; left += 1) {
    for (let right = left + 1; right < edits.length; right += 1) {
      if (editsConflict(edits[left], edits[right])) {
        throw new U1SkillEditError(
          "U1_EDIT_OVERLAP",
          "edits must target independent, non-overlapping ranges in the parent SKILL.md",
        );
      }
    }
  }

  let result = parentSkillMd;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  return result;
}

export function u1SkillGrowthLimit(parentSkillMd: string): number {
  return Math.max(
    U1_EDIT_MIN_GROWTH_ALLOWANCE,
    Math.ceil(parentSkillMd.length * U1_EDIT_GROWTH_RATIO),
  );
}

export function applyU1SkillEditEnvelope(input: {
  proposalText: string;
  parentSkillMd: string;
}): AppliedU1SkillChange {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.proposalText);
  } catch {
    throw new U1SkillEditError(
      "U1_EDIT_INVALID_JSON",
      `the U1 proposer returned non-JSON content (${input.proposalText.length} chars)`,
    );
  }
  if (!isObject(parsed)) {
    throw new U1SkillEditError("U1_EDIT_INVALID", "the U1 proposal must be a JSON object");
  }

  const hypothesis = requiredNonEmptyString(parsed.hypothesis, "hypothesis");
  if (parsed.decision === "no_change") {
    assertExactKeys(parsed, ["hypothesis", "decision"], "no_change envelope");
    return {
      hypothesis,
      decision: "no_change",
      skillMd: input.parentSkillMd,
      appliedEdits: 0,
    };
  }
  if (parsed.decision !== "edit") {
    throw new U1SkillEditError(
      "U1_EDIT_INVALID",
      'decision must be either "edit" or "no_change"',
    );
  }
  assertExactKeys(parsed, ["hypothesis", "decision", "edits"], "edit envelope");
  if (!Array.isArray(parsed.edits) || parsed.edits.length === 0) {
    throw new U1SkillEditError("U1_EDIT_INVALID", "an edit decision requires at least one edit");
  }
  if (parsed.edits.length > U1_EDIT_MAX_EDITS) {
    throw new U1SkillEditError(
      "U1_EDIT_LIMIT_EXCEEDED",
      `an U1 proposal may contain at most ${U1_EDIT_MAX_EDITS} edits`,
    );
  }

  const edits = parsed.edits.map((edit) => resolveEdit(input.parentSkillMd, edit));
  if (new Set(edits.map((edit) => edit.anchor)).size !== edits.length) {
    throw new U1SkillEditError(
      "U1_EDIT_ANCHOR_NOT_UNIQUE",
      "each exact anchor may be used by only one edit",
    );
  }
  const skillMd = applyResolvedEdits(input.parentSkillMd, edits);
  if (!skillMd.trim()) {
    throw new U1SkillEditError("U1_EDIT_RESULT_EMPTY", "the edited SKILL.md may not be empty");
  }
  if (skillMd === input.parentSkillMd) {
    throw new U1SkillEditError("U1_EDIT_NOOP", "an edit decision must change the parent SKILL.md");
  }
  const growth = skillMd.length - input.parentSkillMd.length;
  const limit = u1SkillGrowthLimit(input.parentSkillMd);
  if (growth > limit) {
    throw new U1SkillEditError(
      "U1_EDIT_GROWTH_LIMIT_EXCEEDED",
      `net growth ${growth} chars exceeds the frozen ${limit}-char allowance`,
    );
  }
  assertNoIntroducedGovernanceMetadata(input.parentSkillMd, skillMd);

  return { hypothesis, decision: "edit", skillMd, appliedEdits: edits.length };
}
