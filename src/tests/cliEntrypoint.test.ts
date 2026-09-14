import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "../cli.js";

test("direct CLI entrypoint delays forced exit until after CLI completion", async () => {
  const source = await readFile(join(packageRoot, "src", "cli.ts"), "utf-8");
  assert.match(source, /process\.exitCode\s*=/);
  assert.match(source, /setTimeout\(\(\)\s*=>\s*process\.exit\(exitCode\),\s*250\)/);
  assert.match(source, /export async function runCli[\s\S]*return runCliInternal\(args\)/);
  assert.doesNotMatch(
    source,
    /runCliForHistoricalDevelopmentFixtures|historical-development-fixture|allow-recognized-superseded|development-bypass|runEvolutionV2|writeV2Artifacts/,
  );
  assert.doesNotMatch(
    source,
    /directScoringIdentity\s*\?|sealedScoringIdentity\s*\?|U1ScoringIdentitySchema\.optional\(\)/,
    "current formal Direct and sealed paths must not retain optional scoring-identity fallbacks",
  );
  assert.match(source, /applicationRecovery:\s*terminalSelection\.applicationRecovery/);
  assert.match(source, /applicationRecovery:\s*directResult\.applicationRecovery\s*\?\?\s*\[\]/);
  assert.match(source, /Public decision: delta/);
  assert.doesNotMatch(source, /public-select stability:|normalizeU1PublicDecision|verdict === "uncertain"/);
});
