import { expect, it } from "vitest";
import {
  beginPilotInvocation,
  recordPilotUsage,
  settlePilotInvocation,
} from "./pilotBudget.js";
import {
  finishWorkflowInvocation,
  finishWorkflowTask,
  startWorkflowInvocation,
  startWorkflowTask,
  type AccountObservation,
  type WorkflowUsageOptions,
} from "./workflowUsage.js";

it("carries measurement time, calls and the original account baseline into scored invocations", () => {
  const now = Date.now();
  const baseline: AccountObservation = {
    accountId: "account-a",
    observedAt: now - 10_000,
    denied: false,
    windows: {
      short: { usedPercent: 30, resetsAt: now + 5 * 60 * 60_000 },
      weekly: { usedPercent: 40, resetsAt: now + 7 * 24 * 60 * 60_000 },
    },
  };
  const common = {
    policyId: "seven-configurations-v1",
    pilot: { id: "pilot-1", directory: "/tmp/pilot-1" },
    readAccount: async () => baseline,
    listModels: async () => ({ data: [] }),
  };
  const measurement: WorkflowUsageOptions = {
    ...common,
    activity: "measurement",
  };
  const pilot: WorkflowUsageOptions = { ...common, activity: "pilot" };
  const requested = {
    implementation: {
      model: "gpt-6-sol",
      effort: "high",
      serviceTier: "default" as const,
    },
  };
  const task = [{ id: "calibration", requiredRoles: [] }];
  const begun = beginPilotInvocation(
    undefined,
    measurement,
    "calibration-1",
    "worker-image-cli-home-account",
    baseline,
    task,
    2,
    requested,
    now - 10_000,
    now,
  );
  expect(() =>
    beginPilotInvocation(
      begun.budget,
      pilot,
      "scored-1",
      "worker-image-cli-home-account",
      baseline,
      [{ id: "score", requiredRoles: [] }],
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/unfinished/);
  let usage = startWorkflowTask(begun.usage, "calibration", now);
  usage = startWorkflowInvocation(
    usage,
    "calibration",
    "implementation",
    baseline,
    now,
  );
  usage = finishWorkflowInvocation(usage, now + 1_000);
  usage = finishWorkflowTask(usage, now + 1_000);
  const recorded = recordPilotUsage(begun.budget, "calibration-1", usage);
  const settled = settlePilotInvocation(recorded, "calibration-1", usage, true);
  expect(settled.measurementCalls).toBe(1);
  expect(settled.activeMs).toBeGreaterThan(10_000);
  const fresh = { ...baseline, observedAt: now, windows: baseline.windows };
  const scored = beginPilotInvocation(
    settled,
    pilot,
    "scored-1",
    "worker-image-cli-home-account",
    fresh,
    [{ id: "score", requiredRoles: [] }],
    2,
    requested,
    now,
    now,
  );
  expect(scored.usage.baseline).toBe(baseline);
  expect(scored.usage.activeMs).toBe(settled.activeMs);
  expect(scored.budget.evaluations).toBe(1);
  expect(() =>
    beginPilotInvocation(
      { ...settled, measurementCalls: 6 },
      measurement,
      "calibration-2",
      "worker-image-cli-home-account",
      fresh,
      task,
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/measurement allowance/);
  expect(() =>
    beginPilotInvocation(
      { ...settled, measurementCalls: 5 },
      measurement,
      "calibration-2",
      "worker-image-cli-home-account",
      fresh,
      task,
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/remaining measurement allowance/);
  expect(() =>
    beginPilotInvocation(
      { ...settled, evaluations: 64 },
      pilot,
      "scored-65",
      "worker-image-cli-home-account",
      fresh,
      [{ id: "score", requiredRoles: [] }],
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/64 evaluations/);
  expect(() =>
    beginPilotInvocation(
      { ...settled, activeMs: 4 * 60 * 60_000 },
      pilot,
      "over-time",
      "worker-image-cli-home-account",
      fresh,
      [{ id: "score", requiredRoles: [] }],
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/active-time limit/);
  expect(() =>
    beginPilotInvocation(
      settled,
      pilot,
      "reset-crossing",
      "worker-image-cli-home-account",
      {
        ...fresh,
        windows: {
          ...fresh.windows,
          short: { usedPercent: 0, resetsAt: now + 6 * 60 * 60_000 },
        },
      },
      [{ id: "score", requiredRoles: [] }],
      2,
      requested,
      now,
      now,
    ),
  ).toThrow(/changed or is invalid/);
  const resetReading = {
    ...fresh,
    windows: {
      ...fresh.windows,
      short: { usedPercent: 0, resetsAt: now + 6 * 60 * 60_000 },
    },
  };
  const afterDecision = beginPilotInvocation(
    settled,
    {
      ...pilot,
      resetContinuation: {
        id: "owner-reset-1",
        reason: "Continue with split account intervals",
      },
    },
    "after-reset",
    "worker-image-cli-home-account",
    resetReading,
    [{ id: "score", requiredRoles: [] }],
    2,
    requested,
    now - 1_000,
    now,
  );
  expect(afterDecision.budget.baseline).toBe(baseline);
  expect(afterDecision.budget.guardBaseline).toBe(resetReading);
  expect(afterDecision.budget.measurementCalls).toBe(1);
  expect(afterDecision.budget.activeMs).toBe(settled.activeMs + 1_000);
  expect(afterDecision.budget.resetContinuations).toHaveLength(1);
});
