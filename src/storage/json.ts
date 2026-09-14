import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Read and parse a UTF-8 JSON file. */
export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/** Atomically write a UTF-8 JSON file (write to temp, then rename). */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2) + "\n";
  const tmp = join(
    filePath.replace(/[/\\][^/\\]+$/, ""),
    `.tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, filePath);
}

/** Atomically write UTF-8 text (write to a same-directory temp file, then rename). */
export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const tmp = join(
    filePath.replace(/[/\\][^/\\]+$/, ""),
    `.tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(tmp, text, "utf-8");
  await rename(tmp, filePath);
}

/** Read a JSONL file and return parsed records. */
export async function readJsonl<T = unknown>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as T);
}

/** Append a record to a JSONL file (or create it). */
export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  const { appendFile } = await import("node:fs/promises");
  await appendFile(filePath, line, "utf-8");
}

/** Write an array of records as a JSONL file. */
export async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const tmp = join(
    filePath.replace(/[/\\][^/\\]+$/, ""),
    `.tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(tmp, lines, "utf-8");
  await rename(tmp, filePath);
}

/** Read a UTF-8 text file. */
export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8");
}
