import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { FrozenLaunch } from "./benchmarkLaunch.js";

/** Preserve relative reference paths while keeping frozen instructions outside candidate edits. */
export const prepareBenchmarkInstructions = async (
  launch: FrozenLaunch,
  root: string,
  role: "implementation" | "judge",
  changedFiles?: readonly string[],
) => {
  const references = [];
  for (const [index, file] of launch.instructions.entries()) {
    const location = join(
      root,
      "instructions",
      isAbsolute(file.path) ? `external/${index}.md` : file.path,
    );
    await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    await writeFile(location, file.text, { mode: 0o400 });
    if (
      role === "implementation" &&
      /(?:^|\/)CODING_STANDARDS\.md$/.test(file.path)
    )
      continue;
    const nested =
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file.path) &&
      dirname(file.path) !== ".";
    if (
      role === "judge" &&
      nested &&
      !isAbsolute(file.path) &&
      changedFiles &&
      !changedFiles.some((path) => path.startsWith(`${dirname(file.path)}/`))
    )
      continue;
    references.push({ path: file.path, sha256: file.sha256, location });
  }
  return references;
};
