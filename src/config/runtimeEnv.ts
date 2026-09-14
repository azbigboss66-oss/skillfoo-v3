import dotenv from "dotenv";
import { join } from "node:path";

/**
 * Load environment variables from a `.env` file in the project root.
 *
 * Uses `override: false` so that variables already set in the parent process
 * take priority over file values. If the file does not exist, this is a no-op.
 * dotenv errors are silently ignored to avoid leaking file contents.
 */
export function loadRuntimeEnv(projectRoot: string): void {
  dotenv.config({
    path: join(projectRoot, ".env"),
    override: false,
  });
}
