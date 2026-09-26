import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gradeHistoricalCase } from "./issue-26-grader.mjs";

const source = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "sandcastle-issue26-grader-smoke-"));
const candidate = join(root, "reference");
try {
  execFileSync("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    source,
    candidate,
  ]);
  execFileSync(
    "git",
    [
      "checkout",
      "--quiet",
      "--detach",
      "9f3f6d5c5f2527d5e1d8349f80eec2d36e797540",
    ],
    { cwd: candidate },
  );
  const result = await gradeHistoricalCase(source, "output-retry", candidate);
  assert.deepEqual(
    [result.focusPassed, result.otherGatesPassed, result.environmentFailure],
    [true, true, false],
    result.evidence.join("\n"),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
