import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImplementationExecution } from "./implementationBenchmark.js";

const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Candidate inventories are immutable and shared by controller checkpoints. */
export const storeProgressExecution = async (
  directory: string,
  execution: ImplementationExecution,
) => {
  const root = join(directory, "progress-inputs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inventories = new Map<string, string>();
  const encoded = JSON.stringify(execution, (key, value) => {
    if (key !== "paths" || !Array.isArray(value)) return value;
    const bytes = JSON.stringify(value);
    const sha256 = hash(bytes);
    inventories.set(sha256, bytes);
    return { inventorySha256: sha256 };
  });
  for (const [sha256, bytes] of inventories) {
    const path = join(root, `${sha256}.json`);
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        !(await lstat(path)).isFile() ||
        hash(await readFile(path, "utf8")) !== sha256
      )
        throw new Error("Immutable progress inventory changed");
      continue;
    }
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  return JSON.parse(encoded) as ImplementationExecution;
};

/** Also reads legacy checkpoints with inline path inventories. */
export const restoreProgressExecution = async (
  directory: string,
  execution: ImplementationExecution,
) => {
  const inventories = new Map<string, string[]>();
  const load = async (value: unknown) => {
    if (Array.isArray(value)) return value;
    const sha256 = (value as { inventorySha256?: string } | undefined)
      ?.inventorySha256;
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error("Invalid progress inventory reference");
    if (!inventories.has(sha256)) {
      const path = join(directory, "progress-inputs", `${sha256}.json`);
      if (!(await lstat(path)).isFile())
        throw new Error("Invalid progress inventory file");
      const bytes = await readFile(path, "utf8");
      const paths: unknown = JSON.parse(bytes);
      if (
        hash(bytes) !== sha256 ||
        !Array.isArray(paths) ||
        paths.some((path) => typeof path !== "string")
      )
        throw new Error("Immutable progress inventory changed");
      inventories.set(sha256, paths);
    }
    return inventories.get(sha256)!;
  };
  for (const attempt of execution.attempts) {
    if (attempt.candidate)
      attempt.candidate.paths = await load(attempt.candidate.paths);
    for (const assessment of attempt.judge.assessments ?? [])
      assessment.candidate.paths = await load(assessment.candidate.paths);
  }
  return execution;
};
