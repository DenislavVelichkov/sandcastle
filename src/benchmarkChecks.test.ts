import { expect, it } from "vitest";
import { benchmarkCheckCoverage } from "./benchmarkChecks.js";
import type { FrozenLaunch } from "./benchmarkLaunch.js";

const rule = {
  id: "runtime",
  requirement: "Runtime case",
  weight: 1,
  partialCredit: 0.5,
  applicability: "always" as const,
  evidence: ["check"] as "check"[],
  checkCases: ["one", "two"],
};
const checking: FrozenLaunch["checking"] = {
  files: [],
  policy: "Frozen inputs",
  cases: ["one", "two"].map((id) => ({
    id,
    command: `sh ${id}.sh`,
    files: [`${id}.sh`],
  })),
  controls: ["one", "two"].flatMap((checkCaseId) =>
    ["known-bad", "known-good"].map((kind) => ({
      kind: kind as "known-bad" | "known-good",
      commit: kind,
      checkCaseId,
    })),
  ),
};

it("requires both calibrations for every case and never substitutes generic controls", () => {
  expect(benchmarkCheckCoverage([rule], checking, [false])).toEqual([]);
  const incomplete = {
    ...checking,
    controls: checking.controls.filter(
      (item) => !(item.checkCaseId === "two" && item.kind === "known-good"),
    ),
  };
  incomplete.controls.push({ kind: "known-good", commit: "generic" });
  expect(benchmarkCheckCoverage([rule], incomplete, [false])).toEqual([
    "Check case two requires its own known-good calibration control",
  ]);
});

it("applies coverage requirements only to the selected task's visual policy", () => {
  const visual = {
    ...rule,
    id: "visual",
    applicability: "visual" as const,
    checkCases: undefined,
    task: 1,
  };
  const nonvisual = {
    ...rule,
    id: "nonvisual",
    applicability: "nonvisual" as const,
    checkCases: undefined,
    task: 2,
  };
  expect(
    benchmarkCheckCoverage([visual, nonvisual], checking, [false, true]),
  ).toEqual([]);
  expect(
    benchmarkCheckCoverage([visual, nonvisual], checking, [true, false]),
  ).toHaveLength(2);
});
