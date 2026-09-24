import type { IterationUsage } from "./AgentProvider.js";

export interface AccountObservation {
  /** Stable identity of the account that owns both usage windows. */
  readonly accountId: string;
  /** Time of the authoritative reading, in Unix milliseconds. */
  readonly observedAt: number;
  /** Whether ordinary subscription usage was denied. */
  readonly denied: boolean;
  /** Non-null applicable account windows, keyed by stable window name. */
  readonly windows: Readonly<
    Record<
      string,
      {
        /** Percent of the window already used. */
        readonly usedPercent: number;
        /** Unix milliseconds when this window resets. */
        readonly resetsAt: number;
      }
    >
  >;
}

export interface ModelCatalogPage {
  /** Model entries returned by one worker model/list page. */
  readonly data: readonly {
    /** Exact model identifier accepted by Codex. */
    readonly model: string;
    /** Reasoning choices the worker offers for this model. */
    readonly supportedReasoningEfforts: readonly {
      /** Exact effort value accepted by Codex. */
      readonly reasoningEffort: string;
    }[];
  }[];
  /** Cursor for the next page, absent after the final page. */
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
  const currentNames = Object.keys(current.windows ?? {});
  if (
    names.length < 1 ||
    currentNames.length !== names.length ||
    names.some((name) => !(name in current.windows))
  )
    return "Applicable account window is missing or changed";
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
  /** Stable identifier for one cumulative counter. */
  readonly counterId: string;
  /** Scope used to detect overlapping counters. */
  readonly coverageId: string;
  /** Codex session that owns this counter. */
  readonly sessionId?: string;
  /** Parent session for a delegated descendant. */
  readonly parentSessionId?: string;
  /** Host-verifiable raw counter source, such as a captured rollout path. */
  readonly rawSource?: string;
  /** Cumulative token values for this counter. */
  readonly usage: IterationUsage;
}

export interface TokenInvocation {
  /** Selected task and role charged for this attempt. */
  readonly taskId: string;
  /** Required role charged for this attempt. */
  readonly role: string;
  /** Root Codex session, when captured. */
  readonly sessionId?: string;
  /** Provider dispatch time in Unix milliseconds. */
  readonly startedAt: number;
  /** Settlement time in Unix milliseconds. */
  readonly settledAt: number;
  /** Whether the provider returned or failed. */
  readonly outcome: "completed" | "failed";
  /** Session IDs the host proved belong to this invocation. */
  readonly requiredSessionIds: readonly string[];
  /** Raw counter identities observed during settlement. */
  readonly counterIds: readonly string[];
  /** False when a descendant, raw source or counter is missing or overlaps. */
  readonly coverageComplete: boolean;
}

export interface TokenLedger {
  /** Latest verified value for each cumulative counter. */
  readonly counters: Readonly<Record<string, TokenCounter>>;
  /** Verified increments, deduplicated across resumed observations. */
  readonly deltas: Readonly<Record<string, IterationUsage>>;
  /** Nullable last-message snapshots, separate from verified totals. */
  readonly estimates: Readonly<Record<string, IterationUsage | null>>;
  /** Invocation or coverage identities whose attributable cost is incomplete. */
  readonly unknown: readonly string[];
  /** Settled invocation lineage, including failures and resumed sessions. */
  readonly invocations?: Readonly<Record<string, TokenInvocation>>;
  /** Sum of disjoint verified counters; null while any attributable cost is unknown. */
  readonly attributableTotal?: IterationUsage | null;
}

export interface WorkflowUsageOptions {
  /** Stable policy identity; changing it requires a new invocation. */
  readonly policyId: string;
  /** Bound activity whose ceilings apply to this invocation. */
  readonly activity: "library-proof" | "pilot" | "measurement";
  /** Shared host-only budget for every measurement and evaluation in one pilot. */
  readonly pilot?: { readonly id: string; readonly directory: string };
  /** Explicit owner decision to continue after an account-window reset. */
  readonly resetContinuation?: { readonly id: string; readonly reason: string };
  /** Read every non-null applicable window from the worker's ordinary account. */
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
    /** Every session in the verified root/descendant lineage. */
    readonly requiredSessionIds?: readonly string[];
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
  /** Frozen policy identity. */
  readonly policyId: string;
  /** Activity whose ceilings govern this run. */
  readonly activity: WorkflowUsageOptions["activity"];
  /** Frozen worker CLI, image, home and account configuration identity. */
  readonly runtimeIdentity: string;
  /** Explicit settings requested for each role. */
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
  /** Effective worker settings, unavailable without separate runtime proof. */
  readonly effective: null;
  /** Per-response settings, unavailable from catalog discovery alone. */
  readonly observed: null;
  /** Original account reading retained across resumes. */
  readonly baseline: AccountObservation;
  /** Current guard interval; the original baseline above is never replaced. */
  readonly guardBaseline: AccountObservation;
  /** Most recent account reading. */
  readonly latest: AccountObservation;
  /** Account readings retained for delayed usage and comparison audit. */
  readonly accountHistory: readonly {
    readonly taskId?: string;
    readonly resetDecisionId?: string;
    readonly reading: AccountObservation;
  }[];
  /** Reset crossings invalidate comparison of the joined account intervals. */
  readonly resetContinuations: readonly {
    readonly id: string;
    readonly reason: string;
    readonly from: AccountObservation;
    readonly to: AccountObservation;
  }[];
  /** Unused provider calls by task and role. */
  readonly remaining: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  /** Cumulative active wall time in milliseconds. */
  readonly activeMs: number;
  /** Last wall-clock update used to accrue active time. */
  readonly activeUpdatedAt: number;
  /** Active evaluation time by task, in milliseconds. */
  readonly taskMs: Readonly<Record<string, number>>;
  /** Task whose evaluation clock is currently running. */
  readonly currentTask?: string;
  /** Provider phase time by task and role, in milliseconds. */
  readonly roleMs: Readonly<Record<string, number>>;
  /** Number of reserved provider calls already spent. */
  readonly invocations: number;
  /** Provider call that has started but not settled. */
  readonly active?: {
    readonly taskId: string;
    readonly role: string;
    readonly startedAt: number;
  };
  /** Verified token deltas and incomplete estimates. */
  readonly tokens: TokenLedger;
  /** Guard reason that denies further dispatch. */
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
  const reservedCalls = tasks.reduce(
    (total, task) => total + iterations + task.requiredRoles.length,
    0,
  );
  const limits = activityLimits[options.activity];
  const callLimit = "calls" in limits ? limits.calls : undefined;
  if (callLimit !== undefined && reservedCalls > callLimit)
    throw new Error("Required roles exceed the activity invocation allowance");
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
    guardBaseline: baseline,
    latest: baseline,
    accountHistory: [{ reading: baseline }],
    resetContinuations: [],
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
    tokens: {
      counters: {},
      deltas: {},
      estimates: {},
      unknown: [],
      invocations: {},
      attributableTotal: null,
    },
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
    accountGuardReason(state.guardBaseline ?? state.baseline, reading, now) ??
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
    accountHistory:
      reading === state.latest
        ? state.accountHistory
        : [
            ...state.accountHistory,
            {
              ...(state.currentTask ? { taskId: state.currentTask } : {}),
              reading,
            },
          ],
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
    tokens: {
      ...state.tokens,
      unknown: [
        ...state.tokens.unknown,
        `${taskId}/${role}/${state.invocations + 1}`,
      ],
      attributableTotal: null,
    },
  };
};

const coversInvocation = (
  rootSessionId: string | undefined,
  counters: readonly TokenCounter[],
  requiredSessionIds: readonly string[],
): boolean => {
  if (
    !rootSessionId ||
    !requiredSessionIds.includes(rootSessionId) ||
    new Set(requiredSessionIds).size !== requiredSessionIds.length ||
    counters.length !== requiredSessionIds.length
  )
    return false;
  const bySession = new Map(counters.map((item) => [item.sessionId, item]));
  if (bySession.size !== requiredSessionIds.length) return false;
  for (const id of requiredSessionIds) {
    const sample = bySession.get(id);
    if (!id || !sample?.rawSource?.trim()) return false;
    const visited = new Set<string>();
    let current = id;
    while (current !== rootSessionId) {
      if (visited.has(current)) return false;
      visited.add(current);
      const parent = bySession.get(current)?.parentSessionId;
      if (!parent || !bySession.has(parent)) return false;
      current = parent;
    }
  }
  return !bySession.get(rootSessionId)?.parentSessionId;
};

export const finishWorkflowInvocation = (
  state: WorkflowUsageState,
  now: number,
  sessionId?: string,
  usage?: IterationUsage,
  verifiedCounters: readonly TokenCounter[] = [],
  coverageComplete = false,
  requiredSessionIds: readonly string[] = [],
  outcome: TokenInvocation["outcome"] = "completed",
): WorkflowUsageState => {
  if (!state.active) throw new Error("No active invocation to settle");
  const active = state.active;
  state = accrueWorkflowTime(state, now);
  const { taskId, role, startedAt } = active;
  const elapsed = Math.max(0, now - startedAt);
  const estimateId = `${taskId}/${role}/${state.invocations}`;
  const priorUnknown = state.tokens.unknown.filter((id) => id !== estimateId);
  const claimedComplete =
    coverageComplete &&
    coversInvocation(sessionId, verifiedCounters, requiredSessionIds);
  let tokens: TokenLedger = {
    ...state.tokens,
    estimates: { ...state.tokens.estimates, [estimateId]: usage ?? null },
    unknown: claimedComplete ? priorUnknown : [...priorUnknown, estimateId],
  };
  for (const counter of verifiedCounters)
    tokens = recordTokenCounter(tokens, counter);
  const complete =
    claimedComplete &&
    tokens.unknown.length === priorUnknown.length &&
    verifiedCounters.every(
      (counter) =>
        !state.tokens.unknown.includes(counter.counterId) &&
        !state.tokens.unknown.includes(counter.coverageId),
    );
  if (!complete && !tokens.unknown.includes(estimateId))
    tokens = { ...tokens, unknown: [...tokens.unknown, estimateId] };
  tokens = {
    ...tokens,
    invocations: {
      ...tokens.invocations,
      [estimateId]: {
        taskId,
        role,
        ...(sessionId ? { sessionId } : {}),
        startedAt,
        settledAt: now,
        outcome,
        requiredSessionIds,
        counterIds: verifiedCounters.map((counter) => counter.counterId),
        coverageComplete: complete,
      },
    },
  };
  tokens = { ...tokens, attributableTotal: verifiedTokenTotal(tokens) };
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

/** Reset continuation retains the original baseline, spent calls and active time. */
export const continueAfterAccountReset = (
  state: WorkflowUsageState,
  reading: AccountObservation,
  now: number,
  decision: { id: string; reason: string },
): WorkflowUsageState => {
  const guardBaseline = state.guardBaseline ?? state.baseline;
  if (
    !decision.id?.trim() ||
    !decision.reason?.trim() ||
    state.active ||
    state.resetContinuations?.some((item) => item.id === decision.id) ||
    (state.stopReason && !/changed or is invalid/.test(state.stopReason)) ||
    reading.accountId !== state.baseline.accountId ||
    !Object.keys(guardBaseline.windows).some(
      (name) =>
        guardBaseline.windows[name]?.resetsAt !==
        reading.windows?.[name]?.resetsAt,
    )
  )
    throw new Error(
      "Reset continuation needs a new decision and matching account",
    );
  const changed = accountGuardReason(guardBaseline, reading, now);
  if (!changed?.includes("changed or is invalid"))
    throw new Error("No account-window reset is awaiting continuation");
  const reconciled = {
    ...guardBaseline,
    windows: Object.fromEntries(
      Object.entries(guardBaseline.windows).map(([name, before]) => [
        name,
        before.resetsAt === reading.windows[name]?.resetsAt
          ? before
          : reading.windows[name],
      ]),
    ),
  } as AccountObservation;
  const reason = accountGuardReason(reconciled, reading, now);
  if (reason) throw new Error(reason);
  return {
    ...state,
    guardBaseline: reading,
    latest: reading,
    accountHistory: [
      ...state.accountHistory,
      { reading, resetDecisionId: decision.id },
    ],
    resetContinuations: [
      ...(state.resetContinuations ?? []),
      {
        id: decision.id,
        reason: decision.reason,
        from: guardBaseline,
        to: reading,
      },
    ],
    stopReason: undefined,
    activeUpdatedAt: now,
  };
};

/** An explicit resume may clear a transient account stop, never a spent allowance. */
export const resumeWorkflowUsage = (
  state: WorkflowUsageState,
  reading: AccountObservation,
  now: number,
  resetContinuation?: { id: string; reason: string },
): WorkflowUsageState => {
  if (resetContinuation)
    return continueAfterAccountReset(state, reading, now, resetContinuation);
  const reason = accountGuardReason(
    state.guardBaseline ?? state.baseline,
    reading,
    now,
  );
  const observed = {
    ...state,
    latest: reading,
    accountHistory: [...state.accountHistory, { reading }],
  };
  if (reason) return { ...observed, stopReason: reason };
  if (state.stopReason && !/denied|stale|missing/.test(state.stopReason))
    return observed;
  return {
    ...observed,
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

/** A partial or overlapping lineage has no defensible attributable token sum. */
export const verifiedTokenTotal = (
  ledger: TokenLedger,
): IterationUsage | null => {
  const invocations = Object.values(ledger.invocations ?? {});
  if (
    ledger.unknown.length ||
    !invocations.length ||
    invocations.some((item) => !item.coverageComplete)
  )
    return null;
  const recorded = new Set(invocations.flatMap((item) => item.counterIds));
  if (
    !recorded.size ||
    recorded.size !== Object.keys(ledger.deltas).length ||
    [...recorded].some((id) => !ledger.deltas[id])
  )
    return null;
  const total = Object.fromEntries(
    fields.map((field) => [
      field,
      Object.values(ledger.deltas).reduce(
        (sum, delta) => sum + delta[field],
        0,
      ),
    ]),
  ) as unknown as IterationUsage;
  return fields.every((field) => Number.isSafeInteger(total[field]))
    ? total
    : null;
};

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
    (previous &&
      (previous.coverageId !== sample.coverageId ||
        (previous.sessionId && sample.sessionId !== previous.sessionId)))
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
    ...ledger,
    counters: { ...ledger.counters, [sample.counterId]: sample },
    deltas: { ...ledger.deltas, [sample.counterId]: delta },
  };
};
