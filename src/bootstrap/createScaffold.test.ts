import test from "node:test";
import assert from "node:assert/strict";
import { createScaffold, forbiddenToolViolations, ScaffoldError } from "./createScaffold.js";
import { getAdapterDeclaration } from "../runtime/adapterRegistry.js";
import { TaskCardSchema } from "../types.js";
import { sampleTaskCard } from "../evalFactory/composeBlueprint.test.js";
import { confirmTaskCard } from "../intake/taskCard.js";
import { frozenSampleContract, ROUGH_B0_MARKER } from "./runBootstrap.test.js";

test("forbiddenToolViolations flags usage lines and ignores prohibition lines", () => {
  const boundary = sampleTaskCard().capabilityBoundary;
  const text = [
    "You must not fetch anything from the internet.",
    "Network access is forbidden; do not call HTTP APIs.",
    "First, fetch the repository events.",
    "Then execute a shell command to summarize.",
  ].join("\n");
  const violations = forbiddenToolViolations(text, boundary);
  assert.equal(violations.length, 2);
});

test("forbiddenToolViolations stays silent when no side-effect channel is forbidden", () => {
  const card = sampleTaskCard();
  const boundary = { ...card.capabilityBoundary, network: "allowed" as const };
  const text = "First, fetch the repository events, then save the summary.";
  assert.deepEqual(forbiddenToolViolations(text, boundary), []);
});

test("createScaffold is deterministic", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1");
  assert.ok(adapter);
  const first = createScaffold({ taskCard: card, contract, adapter });
  const second = createScaffold({ taskCard: card, contract, adapter });
  assert.ok(first.skillMd.length > 0);
  assert.equal(first.skillMd, second.skillMd);
});

test("S0 carries only the behavior/capability charter, not governance or evaluation metadata", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const { skillMd } = createScaffold({ taskCard: card, contract, adapter });

  assert.ok(skillMd.includes(card.goal));
  for (const redline of card.redlines) {
    assert.ok(skillMd.includes(redline), `redline missing: ${redline}`);
  }
  for (const scenario of card.scenarios) {
    assert.equal(skillMd.includes(scenario.userRequest), false, `scenario request leaked: ${scenario.id}`);
    if (scenario.expectedOutcome) {
      assert.equal(skillMd.includes(scenario.expectedOutcome), false, `expected outcome leaked: ${scenario.id}`);
    }
    assert.equal(skillMd.includes(scenario.id), false, `scenario id leaked: ${scenario.id}`);
  }
  assert.ok(skillMd.includes(card.capabilityBoundary.allowedCapabilities.join(", ")));
  assert.equal(skillMd.includes(adapter.id), false);
  assert.equal(skillMd.includes(contract.contractSha256), false);
  for (const gate of [...contract.safetyGates, ...contract.qualityGates]) {
    assert.equal(skillMd.includes(gate.gateId), false, `gate metadata leaked: ${gate.gateId}`);
  }
  assert.doesNotMatch(skillMd, /adapter|contract binding|train(?:ing)?|select|sealed|holdout|governance/i);
  assert.equal(/public evaluation scenarios/i.test(skillMd), false);
});

test("the scaffold carries zero forbidden-tool violations and no B0 workflow text", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const { skillMd } = createScaffold({ taskCard: card, contract, adapter });
  assert.deepEqual(forbiddenToolViolations(skillMd, card.capabilityBoundary), []);
  assert.equal(skillMd.includes(ROUGH_B0_MARKER), false);
  assert.equal(skillMd.includes("Run scripts"), false);
});

test("an unconfirmed task card is refused", async () => {
  const { contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("instruction-v1")!;
  const draftCard = TaskCardSchema.parse({
    ...sampleTaskCard(),
    confirmation: { status: "draft" },
  });
  assert.throws(
    () => createScaffold({ taskCard: draftCard, contract, adapter }),
    (e: unknown) => e instanceof ScaffoldError && e.code === "SCAFFOLD_TASK_CARD_NOT_CONFIRMED",
  );
});

test("an adapter mismatched with the contract is refused", async () => {
  const { card, contract } = await frozenSampleContract();
  const adapter = getAdapterDeclaration("reference-v1")!;
  assert.throws(
    () => createScaffold({ taskCard: card, contract, adapter }),
    (e: unknown) => e instanceof ScaffoldError && e.code === "SCAFFOLD_ADAPTER_MISMATCH",
  );
});

test("an adapter whose capabilities exceed the card boundary is refused", async () => {
  const { card, contract } = await frozenSampleContract();
  const wideAdapter = {
    ...getAdapterDeclaration("instruction-v1")!,
    requiredCapabilities: ["instruction", "github"],
  };
  assert.throws(
    () => createScaffold({ taskCard: card, contract, adapter: wideAdapter }),
    (e: unknown) => e instanceof ScaffoldError && e.code === "SCAFFOLD_CAPABILITY_NOT_ALLOWED",
  );
});
