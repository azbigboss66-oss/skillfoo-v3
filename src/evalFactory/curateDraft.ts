import { createHash } from "node:crypto";
import { stableStringify } from "../intake/taskCard.js";
import {
  confidenceLevelForScore,
  CurationResultSchema,
  type CurationFinding,
  type CurationResult,
  type CurationVerdict,
  type EvaluationBlueprint,
  type EvaluationDraft,
  type GeneratorCuratorIsolation,
  type Producer,
  type TaskCard,
} from "../types.js";

// ── T04: draft curation ──────────────────────────────────────────
//
// A curator audits a draft WITHOUT scoring any candidate skill. The
// offline rule curator is deterministic; model curators must implement
// the same interface. If generator and curator are the same model, the
// result is recorded as same_model_isolated_context — never claimed
// independent — and confidence drops.

export interface DraftCurator {
  producer: Producer;
  review(
    draft: EvaluationDraft,
    taskCard: TaskCard,
    blueprint: EvaluationBlueprint,
  ): Promise<CurationFinding[]>;
}

/**
 * Producers are distinguishable when kind OR name differs. Same kind and
 * name means one actor generating and reviewing — isolated context only.
 */
export function resolveGeneratorCuratorIsolation(
  generator: Producer,
  curator: Producer,
): GeneratorCuratorIsolation {
  return generator.kind === curator.kind && generator.name === curator.name
    ? "same_model_isolated_context"
    : "independent";
}

const MIN_JUDGING_RULE_LENGTH = 10;

/**
 * Deterministic offline curator: duplicate, holdout leak, undecidable,
 * contradiction, sensitive behaviour, coverage and redline checks.
 */
export function createRuleCurator(): DraftCurator {
  return {
    producer: { kind: "curator", name: "skillfoo-rule-curator" },
    async review(draft, taskCard, blueprint) {
      const findings: CurationFinding[] = [];
      const items = draft.items;

      const byScenarioFamily = new Map<string, typeof items>();
      for (const item of items) {
        if (!item.scenarioFamily) continue;
        const group = byScenarioFamily.get(item.scenarioFamily) ?? [];
        group.push(item);
        byScenarioFamily.set(item.scenarioFamily, group);
      }
      for (const [family, group] of byScenarioFamily) {
        if (group.length < 2) continue;
        findings.push({
          category: "duplicate",
          severity: "critical",
          message: `scenario family "${family}" is duplicated across ${group.length} items; train/select/holdout families must stay semantically distinct`,
          itemIds: group.map((item) => item.itemId),
        });
      }

      const byInput = new Map<string, { splits: Set<string>; ids: string[] }>();
      for (const item of items) {
        const key = item.input.trim();
        const entry = byInput.get(key) ?? { splits: new Set<string>(), ids: [] };
        entry.splits.add(item.split);
        entry.ids.push(item.itemId);
        byInput.set(key, entry);
      }
      for (const [input, entry] of byInput) {
        if (entry.splits.size > 1) {
          findings.push({
            category: "holdout_leak",
            severity: "critical",
            message: `identical input "${input.slice(0, 60)}" appears in both public and holdout`,
            itemIds: entry.ids,
          });
        }
      }

      for (const item of items) {
        if (item.judgingRule.trim().length < MIN_JUDGING_RULE_LENGTH) {
          findings.push({
            category: "undecidable",
            severity: "critical",
            message: `item ${item.itemId} judging rule is too thin to decide an outcome`,
            itemIds: [item.itemId],
          });
        }
        if (item.rubric?.critical && item.rubric.passThreshold < 80) {
          findings.push({
            category: "undecidable",
            severity: "critical",
            message: `item ${item.itemId} is critical but its threshold ${item.rubric.passThreshold} is below the minimum critical threshold 80`,
            itemIds: [item.itemId],
          });
        }
        if (item.reviewStatus === "human-confirmed" && draft.producer.kind !== "human") {
          findings.push({
            category: "contradiction",
            severity: "critical",
            message: `item ${item.itemId} claims a human-confirmed review status elevation although generator ${draft.producer.kind}:${draft.producer.name} is not human`,
            itemIds: [item.itemId],
          });
        }
      }

      const rubricItems = items.filter((item) => item.rubric !== undefined);
      if (rubricItems.length > 0) {
        const expectedDimensions = blueprint.rubricDimensions ?? [
          "task_correctness",
          "evidence_boundary",
          "capability_boundary",
          "output_structure",
          "actionability",
        ];
        const coveredDimensions = new Set(
          rubricItems.flatMap((item) => item.rubric?.dimensions.map((entry) => entry.id) ?? []),
        );
        const missingDimensions = expectedDimensions.filter(
          (dimension) => !coveredDimensions.has(dimension),
        );
        if (missingDimensions.length > 0) {
          findings.push({
            category: "coverage_gap",
            severity: "critical",
            message: `U1 rubric dimensions are incomplete; missing: ${missingDimensions.join(", ")}`,
            itemIds: rubricItems.map((item) => item.itemId),
          });
        }
      }

      const allowed = new Set(taskCard.capabilityBoundary.allowedCapabilities);
      for (const item of items) {
        const undeclared = item.capabilityTags.filter((tag) => !allowed.has(tag));
        if (undeclared.length > 0) {
          findings.push({
            category: "contradiction",
            severity: "critical",
            message: `item ${item.itemId} requires undeclared capabilities: ${undeclared.join(", ")}`,
            itemIds: [item.itemId],
          });
        }
        const networkFixture = item.requiredFixtures?.some((fixture) => /^https?:\/\//.test(fixture));
        if (networkFixture && taskCard.capabilityBoundary.network === "forbidden") {
          findings.push({
            category: "sensitive_behavior",
            severity: "critical",
            message: `item ${item.itemId} needs a network fixture while the task card forbids network access`,
            itemIds: [item.itemId],
          });
        }
      }

      for (const capability of taskCard.capabilityBoundary.allowedCapabilities) {
        const covered = items.some((item) => item.capabilityTags.includes(capability));
        if (!covered) {
          findings.push({
            category: "coverage_gap",
            severity: "warning",
            message: `no item exercises the declared capability "${capability}"`,
            itemIds: [],
          });
        }
      }

      for (const redline of taskCard.redlines) {
        const covered = items.some(
          (item) => item.itemType === "negative" && item.redlineRefs?.includes(redline),
        );
        if (!covered) {
          findings.push({
            category: "redline_uncovered",
            severity: "critical",
            message: `no negative item covers the red line "${redline}"`,
            itemIds: [],
          });
        }
      }

      return findings;
    },
  };
}

function draftContentSha256(draft: EvaluationDraft): string {
  const { createdAt: _createdAt, ...content } = draft;
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}

function verdictFrom(findings: CurationFinding[]): CurationVerdict {
  if (findings.some((finding) => finding.severity === "critical")) return "rejected";
  if (findings.length > 0) return "needs_revision";
  return "accepted";
}

/**
 * Auditable confidence arithmetic: every adjustment is stated as a
 * reason. Draft-stage results can never reach high — that is reserved
 * for the frozen contract (T05) after human curation.
 */
function evalConfidenceFor(
  findings: CurationFinding[],
  verdict: CurationVerdict,
  isolation: GeneratorCuratorIsolation,
): { level: "low" | "medium" | "high"; score: number; reasons: string[] } {
  const reasons: string[] = ["base 60 for a fully machine-checked draft"];
  let score = 60;

  const criticals = findings.filter((finding) => finding.severity === "critical").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  if (criticals > 0) {
    reasons.push(`-20 per critical finding (${criticals})`);
    score -= 20 * criticals;
  }
  if (warnings > 0) {
    reasons.push(`-10 per warning (${warnings})`);
    score -= 10 * warnings;
  }
  if (isolation === "same_model_isolated_context") {
    reasons.push("-15: generator and curator are the same model in isolated contexts");
    score -= 15;
  }
  if (verdict === "rejected") {
    reasons.push("capped at 35: a rejected draft cannot support release decisions");
    score = Math.min(score, 35);
  } else if (verdict === "needs_revision") {
    reasons.push("capped at 55: needs revision before freeze");
    score = Math.min(score, 55);
  } else {
    reasons.push("capped at medium: draft stage — confidence can only rise at contract freeze (T05)");
    score = Math.min(score, 65);
  }

  score = Math.max(0, Math.min(100, score));
  return { level: confidenceLevelForScore(score), score, reasons };
}

/** Curate a draft: run the curator's review, then assemble the auditable result. */
export async function curateDraft(
  draft: EvaluationDraft,
  taskCard: TaskCard,
  blueprint: EvaluationBlueprint,
  curator: DraftCurator,
): Promise<CurationResult> {
  const findings = await curator.review(draft, taskCard, blueprint);
  const isolation = resolveGeneratorCuratorIsolation(draft.producer, curator.producer);
  const verdict = verdictFrom(findings);
  const evalConfidence = evalConfidenceFor(findings, verdict, isolation);

  const criticals = findings.filter((finding) => finding.severity === "critical").length;
  const warnings = findings.length - criticals;
  const summary =
    `verdict ${verdict}: ${criticals} critical / ${warnings} warning findings; ` +
    `generator ${draft.producer.kind}:${draft.producer.name} vs curator ${curator.producer.kind}:${curator.producer.name} (${isolation})`;

  return CurationResultSchema.parse({
    schemaVersion: 3,
    createdAt: new Date().toISOString(),
    producer: curator.producer,
    sourceHashes: {
      taskCard: draft.sourceHashes.taskCard,
      draft: draftContentSha256(draft),
    },
    verdict,
    findings,
    evalConfidence,
    generatorCuratorIsolation: isolation,
    summary,
  });
}
