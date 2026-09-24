import type { IterationUsage } from "./AgentProvider.js";

export interface AccountObservation {
  readonly accountId: string;
  readonly observedAt: number;
  readonly denied: boolean;
  readonly windows: Readonly<
    Record<
      string,
      {
        readonly usedPercent: number;
        readonly resetsAt: number;
      }
    >
  >;
}

export interface ModelCatalogPage {
  readonly data: readonly {
    readonly model: string;
    readonly supportedReasoningEfforts: readonly {
      readonly reasoningEffort: string;
    }[];
  }[];
  readonly nextCursor?: string | null;
}

/** The caller must execute this callback in the actual isolated worker runtime. */
export const discoverConfiguredModels = async (
  listPage: (cursor?: string) => Promise<ModelCatalogPage>,
  requested: readonly { model: string; effort: string }[],
): Promise<void> => {
  const models = new Map<string, Set<string>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listPage(cursor);
    if (!Array.isArray(page.data)) throw new Error("Invalid model-list page");
    for (const item of page.data) {
      if (!item.model || !Array.isArray(item.supportedReasoningEfforts))
        throw new Error("Invalid model-list entry");
      const efforts = models.get(item.model) ?? new Set<string>();
      item.supportedReasoningEfforts.forEach(
        (choice: { reasoningEffort: string }) =>
          efforts.add(choice.reasoningEffort),
      );
      models.set(item.model, efforts);
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor))
      throw new Error("Model-list pagination repeated a cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  for (const { model, effort } of requested)
    if (!models.get(model)?.has(effort))
      throw new Error(`Worker model/effort unavailable: ${model}/${effort}`);
};

/** A fresh reading is needed before each dispatch and every 60 seconds during work. */
export const accountGuardReason = (
  baseline: AccountObservation,
  current: AccountObservation,
  now: number,
): string | undefined => {
  if (
    !baseline.accountId ||
    current.accountId !== baseline.accountId ||
    !Number.isFinite(current.observedAt) ||
    current.observedAt > now ||
    now - current.observedAt > 120_000
  )
    return "Account identity or observation is missing or stale";
  if (current.denied !== false) return "Ordinary account usage was denied";
  const names = Object.keys(baseline.windows);
  if (
    names.length < 2 ||
    !current.windows ||
    names.some((name) => !(name in current.windows))
  )
    return "Applicable account window is missing";
  for (const name of names) {
    const before = baseline.windows[name]!;
    const after = current.windows[name]!;
    if (
      !Number.isFinite(before.usedPercent) ||
      !Number.isFinite(after.usedPercent) ||
      before.usedPercent < 0 ||
      after.usedPercent < 0 ||
      before.usedPercent > 100 ||
      after.usedPercent > 100 ||
      after.usedPercent < before.usedPercent ||
      !Number.isFinite(before.resetsAt) ||
      !Number.isFinite(after.resetsAt) ||
      after.resetsAt <= current.observedAt ||
      before.resetsAt !== after.resetsAt
    )
      return `Account window ${name} changed or is invalid`;
    if (after.usedPercent - before.usedPercent >= 5)
      return `Account window ${name} rose by 5 percentage points`;
    if (after.usedPercent > 80)
      return `Account window ${name} has less than 20% remaining`;
  }
};

export interface TokenCounter {
  readonly counterId: string;
  readonly coverageId: string;
  readonly usage: IterationUsage;
}

export interface TokenLedger {
  readonly counters: Readonly<Record<string, TokenCounter>>;
  readonly deltas: Readonly<Record<string, IterationUsage>>;
  readonly estimates: Readonly<Record<string, IterationUsage | null>>;
  readonly unknown: readonly string[];
}

export interface WorkflowUsageOptions {
  /** Stable policy identity; changing it requires a new invocation. */
  readonly policyId: string;
  readonly activity: "library-proof" | "pilot" | "measurement";
  readonly readAccount: () => Promise<AccountObservation>;
  /** Run model/list in the same isolated Codex Home, CLI, image and account as the worker. */
  readonly listModels: (cursor?: string) => Promise<ModelCatalogPage>;
  /** Verify cumulative counters and coverage of every required descendant. */
  readonly readTokenCounters?: (
    taskId: string,
    role: string,
    sessionId?: string,
  ) => Promise<{
    readonly counters: readonly TokenCounter[];
    readonly complete: boolean;
  }>;
}

export const pilotConfigurations = [
  { model: "gpt-6-luna", effort: "max" },
  { model: "gpt-6-astra", effort: "medium" },
  { model: "gpt-6-astra", effort: "high" },
  { model: "gpt-6-astra", effort: "max" },
  { model: "gpt-6-sol", effort: "medium" },
  { model: "gpt-6-sol", effort: "high" },
  { model: "gpt-6-sol", effort: "xhigh" },
] as const;

export const validateActivityConfiguration = (
  activity: WorkflowUsageOptions["activity"],
  role: string,
  requested: { model: string; effort: string },
): void => {
  const fixed = requested.model === "gpt-6-sol" && requested.effort === "high";
  if (activity === "library-proof" && !fixed)
    throw new Error("Library recovery proof requires Sol High for every role");
  if (
    role === "implementation" &&
    activity !== "library-proof" &&
    !pilotConfigurations.some(
      (item) =>
        item.model === requested.model && item.effort === requested.effort,
    )
  )
    throw new Error(
      `Implementation configuration is outside the seven-policy pilot: ${requested.model}/${requested.effort}`,
    );
};

export interface WorkflowUsageState {
  readonly policyId: string;
  readonly activity: WorkflowUsageOptions["activity"];
  readonly runtimeIdentity: string;
  readonly requested: Readonly<
    Record<
      string,
      {
        readonly model: string;
        readonly effort: string;
        readonly serviceTier: "default";
      }
    >
  >;
  readonly effective: null;
  readonly observed: null;
  readonly baseline: AccountObservation;
  readonly latest: AccountObservation;
  readonly remaining: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  readonly activeMs: number;
  readonly activeUpdatedAt: number;
  readonly taskMs: Readonly<Record<string, number>>;
  readonly currentTask?: string;
  readonly roleMs: Readonly<Record<string, number>>;
  readonly invocations: number;
  readonly active?: {
    readonly taskId: string;
    readonly role: string;
    readonly startedAt: number;
  };
  readonly tokens: TokenLedger;
  readonly stopReason?: string;
}

const activityLimits = {
  "library-proof": { overallMs: 45 * 60_000, taskMs: 45 * 60_000, calls: 4 },
  pilot: { overallMs: 4 * 60 * 60_000, taskMs: 30 * 60_000 },
  measurement: { overallMs: 15 * 60_000, taskMs: 15 * 60_000, calls: 6 },
} as const;
const invocationMs = 15 * 60_000;
const roleLimitMs = (role: string): number =>
  role === "implementation" ? 30 * 60_000 : invocationMs;
const roleKey = (taskId: string, role: string): string => `${taskId}/${role}`;

export const initialWorkflowUsage = (
  options: WorkflowUsageOptions,
  runtimeIdentity: string,
  baseline: AccountObservation,
  tasks: readonly { id: string; requiredRoles: readonly string[] }[],
  iterations: number,
  requested: WorkflowUsageState["requested"],
): WorkflowUsageState => {
  if (!options.policyId || !runtimeIdentity || iterations < 1 || iterations > 2)
    throw new Error(
      "Guarded workflow needs a fixed policy, runtime and at most two implementation attempts",
    );
  if (options.activity === "pilot" && tasks.length > 64)
    throw new Error("Pilot permits at most 64 evaluations");
  const reason = accountGuardReason(baseline, baseline, Date.now());
  if (reason) throw new Error(reason);
  return {
    policyId: options.policyId,
    activity: options.activity,
    runtimeIdentity,
    requested,
    effective: null,
    observed: null,
    baseline,
    latest: baseline,
    remaining: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        {
          ...Object.fromEntries(task.requiredRoles.map((role) => [role, 1])),
          implementation: iterations,
        },
      ]),
    ),
    activeMs: 0,
    activeUpdatedAt: Date.now(),
    taskMs: {},
    roleMs: {},
    invocations: 0,
    tokens: { counters: {}, deltas: {}, estimates: {}, unknown: [] },
  };
};

export const accrueWorkflowTime = (
  state: WorkflowUsageState,
  now: number,
): WorkflowUsageState => {
  const activeMs = state.activeMs + Math.max(0, now - state.activeUpdatedAt);
  return {
    ...state,
    activeMs,
    taskMs: state.currentTask
      ? {
          ...state.taskMs,
          [state.currentTask]:
            (state.taskMs[state.currentTask] ?? 0) +
            Math.max(0, now - state.activeUpdatedAt),
        }
      : state.taskMs,
    activeUpdatedAt: now,
    ...(activeMs >= activityLimits[state.activity].overallMs
      ? { stopReason: "Overall active-time limit reached" }
      : {}),
  };
};

export const startWorkflowTask = (
  state: WorkflowUsageState,
  taskId: string,
  now: number,
): WorkflowUsageState => {
  const next = accrueWorkflowTime(state, now);
  if (next.currentTask || !next.remaining[taskId])
    throw new Error("Task is not reserved or another task is active");
  if (
    next.stopReason ||
    (next.taskMs[taskId] ?? 0) >= activityLimits[next.activity].taskMs
  )
    throw new Error(next.stopReason ?? "Evaluation active-time limit reached");
  return { ...next, currentTask: taskId };
};

export const finishWorkflowTask = (
  state: WorkflowUsageState,
  now: number,
): WorkflowUsageState => {
  const next = accrueWorkflowTime(state, now);
  return { ...next, currentTask: undefined };
};

export const observeWorkflowUsage = (
  state: WorkflowUsageState,
  reading: AccountObservation,
  now: number,
): WorkflowUsageState => {
  state = accrueWorkflowTime(state, now);
  const activeElapsed = state.active
    ? Math.max(0, now - state.active.startedAt)
    : 0;
  const roleElapsed = state.active
    ? (state.roleMs[roleKey(state.active.taskId, state.active.role)] ?? 0) +
      activeElapsed
    : 0;
  const reason =
    accountGuardReason(state.baseline, reading, now) ??
    state.stopReason ??
    (state.currentTask &&
    (state.taskMs[state.currentTask] ?? 0) >=
      activityLimits[state.activity].taskMs
      ? "Evaluation active-time limit reached"
      : undefined) ??
    (state.active && roleElapsed >= roleLimitMs(state.active.role)
      ? "Phase active-time limit reached"
      : undefined) ??
    (state.active && activeElapsed >= invocationMs
      ? "Invocation active-time limit reached"
      : undefined);
  return {
    ...state,
    latest: reading,
    ...(reason ? { stopReason: reason } : {}),
  };
};

export const startWorkflowInvocation = (
  state: WorkflowUsageState,
  taskId: string,
  role: string,
  reading: AccountObservation,
  now: number,
): WorkflowUsageState => {
  if (state.active || state.stopReason)
    throw new Error(state.stopReason ?? "Invocation already active");
  if (state.currentTask !== taskId)
    throw new Error("Invocation task is not active");
  const observed = observeWorkflowUsage(state, reading, now);
  if (observed.stopReason) throw new Error(observed.stopReason);
  if ((state.taskMs[taskId] ?? 0) >= activityLimits[state.activity].taskMs)
    throw new Error("Evaluation active-time limit reached");
  if ((state.roleMs[roleKey(taskId, role)] ?? 0) >= roleLimitMs(role))
    throw new Error("Phase active-time limit reached");
  const remaining = state.remaining[taskId]?.[role];
  const callLimit =
    state.activity === "pilot"
      ? undefined
      : activityLimits[state.activity].calls;
  if (!remaining || (callLimit !== undefined && state.invocations >= callLimit))
    throw new Error(`No reserved invocation remains for ${taskId}/${role}`);
  return {
    ...observed,
    remaining: {
      ...state.remaining,
      [taskId]: { ...state.remaining[taskId], [role]: remaining - 1 },
    },
    invocations: state.invocations + 1,
    active: { taskId, role, startedAt: now },
  };
};

export const finishWorkflowInvocation = (
  state: WorkflowUsageState,
  now: number,
  sessionId?: string,
  usage?: IterationUsage,
  verifiedCounters: readonly TokenCounter[] = [],
  coverageComplete = false,
): WorkflowUsageState => {
  if (!state.active) throw new Error("No active invocation to settle");
  const active = state.active;
  state = accrueWorkflowTime(state, now);
  const { taskId, role, startedAt } = active;
  const elapsed = Math.max(0, now - startedAt);
  const estimateId = `${taskId}/${role}/${state.invocations}`;
  let tokens: TokenLedger = {
    ...state.tokens,
    estimates: { ...state.tokens.estimates, [estimateId]: usage ?? null },
    ...(verifiedCounters.length && coverageComplete
      ? {}
      : { unknown: [...state.tokens.unknown, estimateId] }),
  };
  for (const counter of verifiedCounters)
    tokens = recordTokenCounter(tokens, counter);
  const next = {
    ...state,
    active: undefined,
    roleMs: {
      ...state.roleMs,
      [roleKey(taskId, role)]:
        (state.roleMs[roleKey(taskId, role)] ?? 0) + elapsed,
    },
    tokens,
    ...(elapsed >= invocationMs
      ? { stopReason: "Invocation active-time limit reached" }
      : {}),
  };
  return observeWorkflowUsage(next, state.latest, now);
};

/** An explicit resume may clear a transient account stop, never a spent allowance. */
export const resumeWorkflowUsage = (
  state: WorkflowUsageState,
  reading: AccountObservation,
  now: number,
): WorkflowUsageState => {
  const reason = accountGuardReason(state.baseline, reading, now);
  if (reason) return { ...state, latest: reading, stopReason: reason };
  if (state.stopReason && !/denied|stale|missing/.test(state.stopReason))
    return state;
  return {
    ...state,
    latest: reading,
    stopReason: undefined,
    activeUpdatedAt: now,
  };
};

const fields = [
  "inputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
] as const;

/** Cumulative resumed or forked counters count only their verified increment. */
export const recordTokenCounter = (
  ledger: TokenLedger,
  sample: TokenCounter,
): TokenLedger => {
  const previous = ledger.counters[sample.counterId];
  const valid = fields.every(
    (field) =>
      Number.isSafeInteger(sample.usage[field]) &&
      sample.usage[field] >= 0 &&
      (!previous || sample.usage[field] >= previous.usage[field]),
  );
  if (
    !sample.counterId ||
    !sample.coverageId ||
    !valid ||
    (previous && previous.coverageId !== sample.coverageId)
  )
    return {
      ...ledger,
      unknown: [
        ...new Set([...ledger.unknown, sample.counterId || "unidentified"]),
      ],
    };
  if (
    Object.values(ledger.counters).some(
      (item) =>
        item.counterId !== sample.counterId &&
        item.coverageId === sample.coverageId,
    )
  )
    return {
      ...ledger,
      unknown: [...new Set([...ledger.unknown, sample.coverageId])],
    };
  const delta = Object.fromEntries(
    fields.map((field) => [
      field,
      (ledger.deltas[sample.counterId]?.[field] ?? 0) +
        sample.usage[field] -
        (previous?.usage[field] ?? 0),
    ]),
  ) as unknown as IterationUsage;
  return {
    counters: { ...ledger.counters, [sample.counterId]: sample },
    deltas: { ...ledger.deltas, [sample.counterId]: delta },
    estimates: ledger.estimates,
    unknown: ledger.unknown,
  };
};
