import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { benchmarkPostRunInstructions } from "./benchmarkPostRun.js";

it("prints opening instructions that preserve shell characters and frozen evidence locations", () => {
  const evidence = "/tmp/evidence's $(printf injected) `printf injected`";
  const output = "/tmp/report copy";
  const lines = benchmarkPostRunInstructions(evidence, output, "linux");
  expect(lines.join("\n")).toContain(join(evidence, "candidates"));
  expect(lines.join("\n")).toContain(join(output, "report.json"));
  expect(lines.join("\n")).toContain("docs/benchmark-reports.md");
  expect(lines.join("\n")).toContain(
    "do not grant human or project acceptance",
  );
  const open = benchmarkPostRunInstructions(evidence, evidence, "linux")[1]!;
  const quotedPath = open.slice("Open: xdg-open ".length);
  // Exercise only shell argument parsing. This does not open a browser.
  const printed = execFileSync("sh", ["-c", `printf '%s' ${quotedPath}`], {
    encoding: "utf8",
  });
  expect(printed).toBe(join(evidence, "report.html"));
  expect(
    benchmarkPostRunInstructions(evidence, evidence, "darwin")[1],
  ).toContain("Open: open '");
  expect(
    benchmarkPostRunInstructions(evidence, evidence, "win32")[1],
  ).toContain("evidence''s");
});
