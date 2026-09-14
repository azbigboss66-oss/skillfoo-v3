import { z } from "zod";
import type { CapabilityPolicy } from "../types.js";
import { stableStringify } from "../intake/taskCard.js";
import {
  computeReplayKey,
  type AdapterContext,
  type AdapterResult,
  type CapabilityAdapter,
  type RequestedToolCall,
} from "./capabilityAdapter.js";
import {
  FrozenContextError,
  getFrozenContextReplay,
  readFrozenContextEntry,
  readFrozenContextReplay,
  type LoadedFrozenRuntimeContext,
} from "./frozenContext.js";

const LogicalIdArgsSchema = z.object({ id: z.string().trim().min(1) }).strict();
const ReplayArgsSchema = z
  .object({
    id: z.string().trim().min(1),
    request: z.record(z.unknown()),
  })
  .strict();

type ReferenceToolName = (typeof REFERENCE_TOOL_NAMES)[number];

function parseArgs<T>(schema: z.ZodType<T>, args: unknown, tool: string): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_TOOL_ARGUMENT_INVALID",
      `${tool} accepts only its frozen logical-id argument contract`,
    );
  }
  return parsed.data;
}

function isReferenceToolName(tool: string): tool is ReferenceToolName {
  return REFERENCE_TOOL_NAMES.includes(tool as ReferenceToolName);
}

export const REFERENCE_TOOL_NAMES = [
  "reference.read",
  "attachment.read",
  "tool.replay",
] as const;

export function createReferenceAdapter(options: {
  policy: CapabilityPolicy;
  runtimeContext?: LoadedFrozenRuntimeContext;
}): CapabilityAdapter {
  if (!options.runtimeContext) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_REQUIRED",
      "reference-v1 requires an explicitly loaded runtime-context.v1.json",
    );
  }
  const runtimeContext = options.runtimeContext;
  const allowed = options.policy.allowedTools;
  if (allowed.some((tool) => !isReferenceToolName(tool))) {
    throw new FrozenContextError(
      "FROZEN_CONTEXT_TOOL_UNDECLARED",
      "reference-v1 policy contains a tool outside its fixed three-tool surface",
    );
  }
  const references = runtimeContext.manifest.entries
    .filter((entry) => entry.kind === "reference")
    .map((entry) => entry.id);
  const attachments = runtimeContext.manifest.entries
    .filter((entry) => entry.kind === "attachment")
    .map((entry) => entry.id);
  const replayCatalog = runtimeContext.manifest.replays.map((replay) => ({
    id: replay.id,
    tool: replay.tool,
    request: replay.request,
  }));
  const toolContractSection = [
    "# Available Tools",
    "This environment is zero-network and read-only. Calls accept logical ids only; never provide a path, URL, command, working directory or executable.",
    "",
    "## reference.read",
    'Arguments: { "id": string }',
    `Declared reference ids: ${JSON.stringify(references)}`,
    "",
    "## attachment.read",
    'Arguments: { "id": string }',
    `Declared attachment ids: ${JSON.stringify(attachments)}`,
    "",
    "## tool.replay",
    'Arguments: { "id": string, "request": object }',
    `Frozen replay catalog: ${stableStringify(replayCatalog)}`,
    "The request must canonically match the catalog entry exactly.",
    "",
    "# Action Envelope Format",
    "Respond with EXACTLY one JSON object per turn. No prose, markdown fences, paths or commands outside the JSON object.",
    'Tool call envelope: {"type":"tool_call","tool":"reference.read","args":{"id":"..."}}',
    'Final answer envelope: {"type":"final","answer":{...}}',
  ].join("\n");
  return {
    id: options.policy.adapterId,
    allowedToolNames: allowed,
    promptContract: {
      toolContractSection,
      usageInstructions: "Use only a declared logical id when the task actually needs that frozen dependency. Do not infer or request filesystem paths.",
    },
    async execute(
      call: RequestedToolCall,
      context: AdapterContext,
    ): Promise<AdapterResult> {
      if (context.mode === "record" || context.allowNetwork) {
        throw new FrozenContextError(
          "FROZEN_CONTEXT_RECORD_MODE_FORBIDDEN",
          "reference-v1 is replay-only and never authorizes network or record mode",
        );
      }
      if (!isReferenceToolName(call.tool) || !allowed.includes(call.tool)) {
        throw new FrozenContextError(
          "FROZEN_CONTEXT_TOOL_UNDECLARED",
          `tool ${call.tool || "(empty)"} is not declared by the frozen reference-v1 surface`,
        );
      }

      if (call.tool === "reference.read" || call.tool === "attachment.read") {
        const args = parseArgs(LogicalIdArgsSchema, call.args, call.tool);
        const kind = call.tool === "reference.read" ? "reference" : "attachment";
        const payload = await readFrozenContextEntry(
          runtimeContext,
          args.id,
          kind,
          context.maxResponseBytes,
        );
        return {
          result: payload.value,
          evidence: {
            source: `runtime-context:${kind}:${args.id}`,
            contentSha256: payload.contentSha256,
            replayKey: computeReplayKey(options.policy.adapterId, call.tool, args),
          },
        };
      }

      const args = parseArgs(ReplayArgsSchema, call.args, call.tool);
      const descriptor = getFrozenContextReplay(runtimeContext, args.id);
      if (stableStringify(args.request) !== stableStringify(descriptor.request)) {
        throw new FrozenContextError(
          "FROZEN_CONTEXT_REPLAY_MISMATCH",
          `tool.replay request does not exactly match the frozen request for id ${args.id}`,
        );
      }
      const { payload } = await readFrozenContextReplay(
        runtimeContext,
        args.id,
        context.maxResponseBytes,
      );
      return {
        result: payload.value,
        evidence: {
          source: `runtime-context:replay:${args.id}`,
          contentSha256: payload.contentSha256,
          replayKey: computeReplayKey(options.policy.adapterId, call.tool, args),
        },
      };
    },
  };
}
