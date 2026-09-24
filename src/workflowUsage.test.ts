import { expect, it } from "vitest";
import {
  accountGuardReason,
  continueAfterAccountReset,
  discoverConfiguredModels,
  recordTokenCounter,
  finishWorkflowInvocation,
  initialWorkflowUsage,
  startWorkflowInvocation,
  startWorkflowTask,
  observeWorkflowUsage,
  pilotConfigurations,
  validateActivityConfiguration,
  type AccountObservation,
  type TokenLedger,
} from "./workflowUsage.js";

it("checks every worker model-list page without substituting an effort", async () => {
  const seen: (string | undefined)[] = [];
  const list = async (cursor?: string) => {
    seen.push(cursor);
    return cursor
      ? {
          data: [
            {
              model: "gpt-6-luna",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }],
            },
          ],
        }
      : {
          data: [
            {
              model: "gpt-6-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            },
          ],
          nextCursor: "page-2",
        };
  };
  await discoverConfiguredModels(list, [
    { model: "gpt-6-sol", effort: "high" },
    { model: "gpt-6-luna", effort: "max" },
  ]);
  expect(seen).toEqual([undefined, "page-2"]);
  await expect(
    discoverConfiguredModels(list, [{ model: "gpt-6-sol", effort: "max" }]),
  ).rejects.toThrow("unavailable");
});

it("admits only the seven named pilot implementation choices", () => {
  expect(pilotConfigurations).toHaveLength(7);
  for (const choice of pilotConfigurations)
    expect(() =>
      validateActivityConfiguration("pilot", "implementation", choice),
    ).not.toThrow();
  expect(() =>
    validateActivityConfiguration("pilot", "implementation", {
      model: "gpt-6-sol",
      effort: "max",
    }),
  ).toThrow(/seven-policy/);
  expect(() =>
    validateActivityConfiguration("library-proof", "review", {
      model: "gpt-6-astra",
      effort: "high",
    }),
  ).toThrow(/Sol High/);
});

it("blocks denied, stale, reset and exhausted account readings", () => {
  const now = 1_000_000;
  const baseline: AccountObservation = {
    accountId: "account-a",
    observedAt: now,
    denied: false,
    windows: {
      short: { usedPercent: 40, resetsAt: 2_000_000 },
      weekly: { usedPercent: 70, resetsAt: 3_000_000 },
    },
  };
  expect(accountGuardReason(baseline, baseline, now)).toBeUndefined();
  expect(
    accountGuardReason(baseline, { ...baseline, denied: true }, now),
  ).toMatch(/denied/);
  expect(accountGuardReason(baseline, baseline, now + 120_001)).toMatch(
    /stale/,
  );
  expect(
    accountGuardReason(
      baseline,
      {
        ...baseline,
        windows: {
          ...baseline.windows,
          short: { usedPercent: 40, resetsAt: 4_000_000 },
        },
      },
      now,
    ),
  ).toMatch(/changed/);
  expect(
    accountGuardReason(
      baseline,
      {
        ...baseline,
        windows: {
          ...baseline.windows,
          short: { usedPercent: 45, resetsAt: 2_000_000 },
        },
      },
      now,
    ),
  ).toMatch(/5 percentage/);
  const nearLimit = {
    ...baseline,
    windows: {
      ...baseline.windows,
      weekly: { usedPercent: 79, resetsAt: 3_000_000 },
    },
  };
  expect(
    accountGuardReason(
      nearLimit,
      {
        ...nearLimit,
        windows: {
          ...nearLimit.windows,
          weekly: { usedPercent: 80.01, resetsAt: 3_000_000 },
        },
      },
      now,
    ),
  ).toMatch(/20%/);
  const weeklyOnly = {
    ...baseline,
    windows: { weekly: baseline.windows.weekly! },
  };
  expect(accountGuardReason(weeklyOnly, weeklyOnly, now)).toBeUndefined();
  expect(accountGuardReason(weeklyOnly, baseline, now)).toMatch(/changed/);
  expect(accountGuardReason(baseline, weeklyOnly, now)).toMatch(/missing/);
});

it("continues only an explicit reset and retains spent allowances and original baseline", () => {
  const now = Date.now();
  const original: AccountObservation = {
    accountId: "account-a",
    observedAt: now,
    denied: false,
    windows: {
      short: { usedPercent: 30, resetsAt: now + 10_000 },
      weekly: { usedPercent: 40, resetsAt: now + 100_000 },
    },
  };
  const options = {
    policyId: "fixed",
    activity: "library-proof" as const,
    readAccount: async () => original,
    listModels: async () => ({ data: [] }),
  };
  const initial = initialWorkflowUsage(
    options,
    "worker",
    original,
    [{ id: "task", requiredRoles: [] }],
    2,
    {},
  );
  const reset = {
    ...original,
    observedAt: now + 1_000,
    windows: {
      ...original.windows,
      short: { usedPercent: 1, resetsAt: now + 200_000 },
    },
  };
  const stopped = observeWorkflowUsage(initial, reset, now + 1_000);
  expect(stopped.stopReason).toMatch(/changed/);
  const continued = continueAfterAccountReset(stopped, reset, now + 1_000, {
    id: "owner-reset-1",
    reason: "Continue after recorded reset",
  });
  expect(continued.baseline).toBe(original);
  expect(continued.guardBaseline).toBe(reset);
  expect(continued.remaining).toEqual(stopped.remaining);
  expect(continued.activeMs).toBe(stopped.activeMs);
  expect(continued.resetContinuations).toHaveLength(1);
  expect(continued.stopReason).toBeUndefined();
  expect(() =>
    continueAfterAccountReset(continued, reset, now + 1_000, {
      id: "owner-reset-1",
      reason: "Replay",
    }),
  ).toThrow(/new decision/);
  expect(() =>
    continueAfterAccountReset(
      stopped,
      { ...reset, denied: true },
      now + 1_000,
      {
        id: "owner-reset-2",
        reason: "Unsafe",
      },
    ),
  ).toThrow(/No account-window reset/);
});

it("deduplicates cumulative resumed counters and leaves overlap unknown", () => {
  const zero: TokenLedger = {
    counters: {},
    deltas: {},
    estimates: {},
    unknown: [],
  };
  const usage = (tokens: number) => ({
    inputTokens: tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  });
  const first = recordTokenCounter(zero, {
    counterId: "session-1",
    coverageId: "eval-1",
    usage: usage(10),
  });
  const resumed = recordTokenCounter(first, {
    counterId: "session-1",
    coverageId: "eval-1",
    usage: usage(15),
  });
  expect(resumed.deltas["session-1"]?.inputTokens).toBe(15);
  expect(
    recordTokenCounter(resumed, {
      counterId: "fork-1",
      coverageId: "eval-1",
      usage: usage(3),
    }).unknown,
  ).toEqual(["eval-1"]);
  expect(
    recordTokenCounter(resumed, {
      counterId: "session-1",
      coverageId: "eval-1",
      usage: usage(9),
    }).unknown,
  ).toEqual(["session-1"]);
});

it("reserves each role, keeps the baseline, and charges late completion", () => {
  const now = Date.now();
  const account: AccountObservation = {
    accountId: "account-a",
    observedAt: now,
    denied: false,
    windows: {
      short: { usedPercent: 30, resetsAt: now + 1_000_000 },
      weekly: { usedPercent: 40, resetsAt: now + 2_000_000 },
    },
  };
  const options = {
    policyId: "fixed-sol-high",
    activity: "library-proof" as const,
    readAccount: async () => account,
    listModels: async () => ({ data: [] }),
  };
  let state = initialWorkflowUsage(
    options,
    "runtime-1",
    account,
    [{ id: "task", requiredRoles: ["standards", "spec"] }],
    2,
    {
      implementation: {
        model: "gpt-6-sol",
        effort: "high",
        serviceTier: "default",
      },
    },
  );
  state = startWorkflowTask(state, "task", now);
  state = startWorkflowInvocation(
    state,
    "task",
    "implementation",
    account,
    now,
  );
  expect(state.remaining.task?.implementation).toBe(1);
  const partial = finishWorkflowInvocation(
    state,
    now + 500,
    "session-1",
    undefined,
    [
      {
        counterId: "session-1",
        coverageId: "session-1",
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        },
      },
    ],
  );
  expect(partial.tokens.deltas["session-1"]?.inputTokens).toBe(10);
  expect(partial.tokens.unknown).toEqual(["task/implementation/1"]);
  state = finishWorkflowInvocation(
    state,
    now + 500,
    "session-1",
    {
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
    },
    [
      {
        counterId: "session-1",
        coverageId: "session-1",
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1,
        },
      },
    ],
    true,
  );
  state = startWorkflowInvocation(
    state,
    "task",
    "implementation",
    { ...account, observedAt: now + 500 },
    now + 500,
  );
  state = finishWorkflowInvocation(
    state,
    now + 1_000,
    "session-1",
    {
      inputTokens: 15,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 2,
    },
    [
      {
        counterId: "session-1",
        coverageId: "session-1",
        usage: {
          inputTokens: 15,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2,
        },
      },
    ],
    true,
  );
  expect(state.tokens.deltas["session-1"]?.inputTokens).toBe(15);
  expect(() =>
    startWorkflowInvocation(
      state,
      "task",
      "implementation",
      account,
      now + 1_000,
    ),
  ).toThrow(/reserved/);
  state = startWorkflowInvocation(
    state,
    "task",
    "standards",
    { ...account, observedAt: now + 1_000 },
    now + 1_000,
  );
  state = observeWorkflowUsage(
    state,
    { ...account, observedAt: now + 900_000 },
    now + 900_000,
  );
  state = finishWorkflowInvocation(state, now + 901_000);
  expect(state.activeMs).toBe(901_000);
  expect(state.stopReason).toMatch(/limit/);
  expect(state.tokens.unknown).toHaveLength(1);
  expect(
    observeWorkflowUsage(
      state,
      { ...account, observedAt: now + 901_000, denied: true },
      now + 901_000,
    ).stopReason,
  ).toBeTruthy();
});
