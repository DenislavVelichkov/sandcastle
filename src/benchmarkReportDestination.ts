import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImplementationAttempt } from "./implementationBenchmark.js";

export const destinationSourceUrl = import.meta.url;

// Resolve existing symlink ancestors even when the requested folder is new.
const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), relative(parent, path));
  }
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
};

/** Both CLI and public API must protect frozen evidence before any output write. */
export const assertBenchmarkReportDestination = async (
  directory: string,
  output: string,
  attempts: readonly ImplementationAttempt[],
) => {
  const destination = await canonicalPath(resolve(output));
  const roots = [
    ...["candidates", "assessments", "visuals", "runtime", "protected"].map(
      (name) => join(directory, name),
    ),
    ...attempts.flatMap((attempt) =>
      attempt.candidate ? [attempt.candidate.worktree] : [],
    ),
  ];
  for (const root of roots)
    if (inside(await canonicalPath(resolve(root)), destination))
      throw new Error(
        "Report output must stay outside retained candidate and evidence directories",
      );
  const retained = attempts.flatMap((attempt) => [
    ...(attempt.candidate ? [attempt.candidate.patch] : []),
    ...(attempt.judge.records?.map((record) => record.path) ?? []),
    ...(attempt.judge.assessments?.flatMap((assessment) => [
      assessment.provenance.stream,
      ...assessment.provenance.sessions.map((file) => file.path),
      ...assessment.requirements.flatMap((rule) =>
        rule.evidence
          .filter((file) => file.kind !== "code")
          .map((file) => file.path),
      ),
    ]) ?? []),
    ...(attempt.project?.evidence.map((file) => file.path) ?? []),
    ...(attempt.project?.receipt ? [attempt.project.receipt.path] : []),
  ]);
  const outputs = ["report.html", "report.json", "evaluations.csv"].map(
    (name) => join(destination, name),
  );
  // Do not replace existing aliases to evidence when installing final exports.
  for (const path of outputs) {
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.nlink > 1)
        throw new Error("Report export files must not alias retained evidence");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const path of retained)
    if (outputs.includes(await canonicalPath(resolve(path))))
      throw new Error("Report output would overwrite retained evidence");
};
