import type { CapabilityPolicy, AdapterDeclaration } from "../types.js";
import type { CapabilityAdapter } from "./capabilityAdapter.js";
import { createInstructionAdapter } from "./instructionAdapter.js";
import { createReferenceAdapter } from "./referenceAdapter.js";
import type { LoadedFrozenRuntimeContext } from "./frozenContext.js";

// The current U1 composition root supports exactly two executable adapters:
// instruction-only evaluation and frozen, hash-bound reference access.

/** Builds one adapter instance per snapshot evaluation. */
export type CapabilityAdapterFactory = (options: {
  fixtureRoot: string;
  policy: CapabilityPolicy;
  /** Run-session live-request counter shared across per-snapshot instances. */
  sessionBudget?: { used: number };
  /** Required only by reference-v1; loaded and hash-verified before factory use. */
  runtimeContext?: LoadedFrozenRuntimeContext;
}) => CapabilityAdapter;

/** What an adapter declares about itself; the load-time gate reads this. */
export interface AdapterContract {
  readonly adapterId: string;
  /** Tool names projects may list in allowedTools and manifest.tools. */
  readonly tools: readonly string[];
  /** Capability ids eval scenarios and capabilityWeights may reference. */
  readonly capabilities: readonly string[];
  /** Every registered current adapter has a concrete implementation. */
  readonly implemented: boolean;
}

const contracts: readonly AdapterContract[] = [
  {
    adapterId: "instruction-v1",
    tools: [],
    capabilities: ["instruction"],
    implemented: true,
  },
  {
    adapterId: "reference-v1",
    tools: ["reference.read", "attachment.read", "tool.replay"],
    capabilities: ["reference"],
    implemented: true,
  },
];

const factories: Record<string, CapabilityAdapterFactory> = {
  "instruction-v1": createInstructionAdapter,
  "reference-v1": createReferenceAdapter,
};

export function getAdapterContract(adapterId: string): AdapterContract | undefined {
  return contracts.find((contract) => contract.adapterId === adapterId);
}

export function listAdapterContracts(): readonly AdapterContract[] {
  return contracts;
}

/**
 * Executable factory for a current adapterId. Unknown ids are refused;
 * there is no fallback adapter.
 */
export function resolveAdapterFactory(adapterId: string): CapabilityAdapterFactory {
  const contract = getAdapterContract(adapterId);
  if (!contract) {
    throw new Error(
      `ADAPTER_NOT_REGISTERED: adapterId "${adapterId}" is not registered in the adapter registry`,
    );
  }
  const factory = factories[adapterId];
  if (!factory) {
    throw new Error(
      `ADAPTER_FACTORY_MISSING: registered adapter "${adapterId}" has no executable factory`,
    );
  }
  return factory;
}

/**
 * Binding gate between a capability surface and the current adapter contract.
 */
export function validateAdapterBinding(
  policy: CapabilityPolicy,
  manifestTools: readonly string[],
  usedCapabilities: ReadonlySet<string>,
): AdapterContract {
  const contract = getAdapterContract(policy.adapterId);
  if (!contract) {
    throw new Error(
      `Adapter binding: adapterId "${policy.adapterId}" is not registered in the adapter registry`,
    );
  }
  for (const tool of [...policy.allowedTools, ...manifestTools]) {
    if (!contract.tools.includes(tool)) {
      throw new Error(
        `Adapter binding: tool "${tool}" is not declared by adapter "${contract.adapterId}"`,
      );
    }
  }
  for (const capabilityId of usedCapabilities) {
    if (!contract.capabilities.includes(capabilityId)) {
      throw new Error(
        `Adapter binding: capability "${capabilityId}" is not declared by adapter "${contract.adapterId}"`,
      );
    }
  }
  return contract;
}

const v3Declarations: readonly AdapterDeclaration[] = [
  {
    id: "instruction-v1",
    executionTier: "U1",
    implementation: "implemented",
    requiredCapabilities: ["instruction"],
    supportedModes: ["fixture", "replay"],
    networkPolicy: "denied",
    filesystemPolicy: "denied",
    limits: {},
    evidenceRequirements: ["finalEnvelope", "contentSha256"],
  },
  {
    id: "reference-v1",
    executionTier: "U1",
    implementation: "implemented",
    requiredCapabilities: ["reference"],
    supportedModes: ["fixture", "replay"],
    networkPolicy: "denied",
    filesystemPolicy: "readonly",
    limits: {},
    evidenceRequirements: ["logicalId", "contentSha256", "runtimeContextManifestSha256"],
  },
];

export function listAdapterDeclarations(): readonly AdapterDeclaration[] {
  return v3Declarations;
}

export function getAdapterDeclaration(id: string): AdapterDeclaration | undefined {
  return v3Declarations.find((declaration) => declaration.id === id);
}

/** Registered declarations providing a capability, in deterministic registry order. */
export function findAdaptersForCapability(capability: string): readonly AdapterDeclaration[] {
  return v3Declarations.filter((declaration) =>
    declaration.requiredCapabilities.includes(capability),
  );
}
