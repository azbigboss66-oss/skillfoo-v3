import test from "node:test";
import assert from "node:assert/strict";
import {
  U1SkillEditError,
  applyU1SkillEditEnvelope,
} from "./u1SkillEdit.js";

const PARENT = "alpha\nbeta\ngamma\n";

function proposal(value: unknown): string {
  return JSON.stringify(value);
}

test("U1 edit applies at most four exact edits against the immutable parent", () => {
  const result = applyU1SkillEditEnvelope({
    parentSkillMd: PARENT,
    proposalText: proposal({
      hypothesis: "tighten beta and add one closing instruction",
      decision: "edit",
      edits: [
        { op: "replace_exact", oldText: "beta", newText: "BETA" },
        { op: "insert_after", anchor: "gamma", text: "\ndelta" },
      ],
    }),
  });

  assert.equal(result.decision, "edit");
  assert.equal(result.skillMd, "alpha\nBETA\ngamma\ndelta\n");
  assert.equal(result.appliedEdits, 2);
});

test("U1 no_change is a valid strict decision and preserves the parent bytes", () => {
  const result = applyU1SkillEditEnvelope({
    parentSkillMd: PARENT,
    proposalText: proposal({
      hypothesis: "the current instructions already cover the bounded feedback",
      decision: "no_change",
    }),
  });

  assert.equal(result.decision, "no_change");
  assert.equal(result.skillMd, PARENT);
  assert.equal(result.appliedEdits, 0);
});

test("U1 edit rejects full-document and non-SKILL envelopes", () => {
  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({ hypothesis: "rewrite", skillMd: "replacement" }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_INVALID",
  );

  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({
        hypothesis: "hide a full rewrite in replace_exact",
        decision: "edit",
        edits: [{ op: "replace_exact", oldText: PARENT, newText: "entirely different" }],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_SCOPE_VIOLATION",
  );

  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({
        hypothesis: "touch a dependency",
        decision: "edit",
        edits: [{
          op: "replace_exact",
          path: "references/private.md",
          oldText: "beta",
          newText: "BETA",
        }],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_SCOPE_VIOLATION",
  );
});

test("U1 edit rejects a fifth edit and unknown envelope keys", () => {
  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: "a b c d e",
      proposalText: proposal({
        hypothesis: "too many independent edits",
        decision: "edit",
        edits: ["a", "b", "c", "d", "e"].map((anchor) => ({
          op: "insert_after",
          anchor,
          text: "!",
        })),
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_LIMIT_EXCEEDED",
  );

  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({
        hypothesis: "ambiguous envelope",
        decision: "no_change",
        edits: [],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_INVALID",
  );

  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({
        hypothesis: "unsupported insertion direction",
        decision: "edit",
        edits: [{ op: "insert_before", anchor: "beta", text: "no" }],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_INVALID",
  );
});

test("U1 edit rejects missing, repeated, duplicate, and overlapping exact anchors", () => {
  for (const [parentSkillMd, edits] of [
    [PARENT, [{ op: "delete_exact", oldText: "missing" }]],
    ["same same", [{ op: "delete_exact", oldText: "same" }]],
    [PARENT, [
      { op: "insert_after", anchor: "beta", text: "two" },
      { op: "delete_exact", oldText: "beta" },
    ]],
  ] as const) {
    assert.throws(
      () => applyU1SkillEditEnvelope({
        parentSkillMd,
        proposalText: proposal({ hypothesis: "ambiguous anchor", decision: "edit", edits }),
      }),
      (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_ANCHOR_NOT_UNIQUE",
    );
  }

  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: "abcdef",
      proposalText: proposal({
        hypothesis: "overlapping replacements",
        decision: "edit",
        edits: [
          { op: "replace_exact", oldText: "bcd", newText: "B" },
          { op: "delete_exact", oldText: "cd" },
        ],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_OVERLAP",
  );
});

test("U1 edit rejects net growth above max 1200 characters or 25 percent", () => {
  assert.throws(
    () => applyU1SkillEditEnvelope({
      parentSkillMd: PARENT,
      proposalText: proposal({
        hypothesis: "grow without a bound",
        decision: "edit",
        edits: [{ op: "insert_after", anchor: "gamma", text: "x".repeat(1201) }],
      }),
    }),
    (error: unknown) => error instanceof U1SkillEditError && error.code === "U1_EDIT_GROWTH_LIMIT_EXCEEDED",
  );

  const largeParent = `anchor${"p".repeat(4994)}`;
  const allowed = applyU1SkillEditEnvelope({
    parentSkillMd: largeParent,
    proposalText: proposal({
      hypothesis: "use the proportional allowance",
      decision: "edit",
      edits: [{ op: "insert_after", anchor: "anchor", text: "x".repeat(1250) }],
    }),
  });
  assert.equal(allowed.skillMd.length, largeParent.length + 1250);
});

test("U1 edit cannot introduce internal contract, split, budget, or hidden-test governance into candidate text", () => {
  for (const text of [
    "\ncontractSha256: deadbeef",
    "\nUse the public-select split.",
    "\nmaxLogicalCalls: 90",
    "\nExplain the hidden tests.",
  ]) {
    assert.throws(
      () => applyU1SkillEditEnvelope({
        parentSkillMd: PARENT,
        proposalText: proposal({
          hypothesis: "add internal evaluator metadata",
          decision: "edit",
          edits: [{ op: "insert_after", anchor: "gamma", text }],
        }),
      }),
      (error: unknown) =>
        error instanceof U1SkillEditError && error.code === "U1_EDIT_GOVERNANCE_METADATA_FORBIDDEN",
    );
  }

  const inherited = "alpha\ncontractSha256: legacy-evidence\ngamma\n";
  const cleanup = applyU1SkillEditEnvelope({
    parentSkillMd: inherited,
    proposalText: proposal({
      hypothesis: "remove inherited governance",
      decision: "edit",
      edits: [{ op: "delete_exact", oldText: "contractSha256: legacy-evidence\n" }],
    }),
  });
  assert.equal(cleanup.skillMd, "alpha\ngamma\n", "bounded cleanup of inherited metadata remains possible");
});
