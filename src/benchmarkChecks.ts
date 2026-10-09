import type { FrozenLaunch } from "./benchmarkLaunch.js";

/** Structural coverage only. Project owners must calibrate the actual behavior. */
export const benchmarkCheckCoverage = (
  rubric: FrozenLaunch["grading"]["rubric"],
  checking: FrozenLaunch["checking"],
  visualRequiredByTask: readonly boolean[],
): string[] => {
  const blockers = new Set<string>();
  for (const [index, visual] of visualRequiredByTask.entries()) {
    for (const rule of rubric) {
      if (
        (rule.task !== undefined && rule.task !== index + 1) ||
        (rule.applicability === "visual" && !visual) ||
        (rule.applicability === "nonvisual" && visual) ||
        !rule.evidence.includes("check")
      )
        continue;
      if (!rule.checkCases?.length) {
        blockers.add(
          `Criterion ${rule.id} requires mapped checkCases; a generic --check is insufficient`,
        );
        continue;
      }
      for (const id of rule.checkCases) {
        if (!checking.cases?.some((item) => item.id === id))
          blockers.add(
            `Criterion ${rule.id} references missing check case ${id}`,
          );
        for (const kind of ["known-bad", "known-good"])
          if (
            !checking.controls.some(
              (item) => item.checkCaseId === id && item.kind === kind,
            )
          )
            blockers.add(
              `Check case ${id} requires its own ${kind} calibration control`,
            );
      }
    }
  }
  return [...blockers];
};

export const benchmarkControlId = (
  control: FrozenLaunch["checking"]["controls"][number],
) => `${control.kind}${control.checkCaseId ? `-${control.checkCaseId}` : ""}`;
