import test from "node:test";
import assert from "node:assert/strict";
import {
  getAdapterContract,
  listAdapterContracts,
  resolveAdapterFactory,
  validateAdapterBinding,
} from "../runtime/adapterRegistry.js";
import type { CapabilityPolicy } from "../types.js";

const minimalPolicy: CapabilityPolicy = {
  adapterId: "instruction-v1",
  allowedTools: [],
  maxToolCalls: 4,
  networkMode: "fixture",
  lockedPaths: [],
};

test("instruction-v1 is registered as a tool-free executable adapter", () => {
  const contract = getAdapterContract("instruction-v1");
  assert.ok(contract);
  assert.equal(contract.implemented, true);
  assert.deepEqual([...contract.tools], []);
  assert.deepEqual([...contract.capabilities], ["instruction"]);
  assert.equal(typeof resolveAdapterFactory("instruction-v1"), "function");
});

test("reference-v1 is implemented with exactly the frozen three-tool surface", () => {
  const contract = getAdapterContract("reference-v1");
  assert.ok(contract);
  assert.equal(contract.implemented, true);
  assert.deepEqual([...contract.tools], ["reference.read", "attachment.read", "tool.replay"]);
  assert.deepEqual([...contract.capabilities], ["reference"]);
  assert.equal(typeof resolveAdapterFactory("reference-v1"), "function");
});

test("an unregistered adapterId has no contract", () => {
  for (const adapterId of ["github-v1", "script-v1", "plugin-v1", "web-search-v1"]) {
    assert.equal(getAdapterContract(adapterId), undefined);
  }
});

test("registry lists only the two executable current U1 adapters", () => {
  const contracts = listAdapterContracts();
  const ids = contracts.map((c) => c.adapterId);
  assert.deepEqual(ids, ["instruction-v1", "reference-v1"]);
  assert.ok(contracts.every((contract) => contract.implemented));
});

test("resolveAdapterFactory rejects an unregistered adapterId", () => {
  assert.throws(() => resolveAdapterFactory("web-search-v1"), /not registered/);
});

test("current binding validation rejects undeclared tools and capabilities", () => {
  assert.equal(validateAdapterBinding(minimalPolicy, [], new Set(["instruction"])).adapterId, "instruction-v1");
  assert.throws(
    () => validateAdapterBinding({ ...minimalPolicy, allowedTools: ["script.run"] }, [], new Set(["instruction"])),
    /not declared/,
  );
  assert.throws(
    () => validateAdapterBinding(minimalPolicy, [], new Set(["github"])),
    /not declared/,
  );
});
