import {
  accountGuardReason,
  accrueWorkflowTime,
  continueAfterAccountReset,
  initialWorkflowUsage,
  type AccountObservation,
  type WorkflowUsageOptions,
  type WorkflowUsageState,
} from "./workflowUsage.js";

/** One pilot spans separate, sequential durable workflow invocations. */
export interface PilotBudgetState {
  readonly version: 2;
  readonly id: string;
  readonly policyId: string;
  readonly runtimeIdentity: string;
  readonly baseline: AccountObservation;
  readonly guardBaseline: AccountObservation;
  readonly latest: AccountObservation;
  readonly resetContinuations: WorkflowUsageState["resetContinuations"];
  readonly activeMs: number;
  readonly measurementCalls: number;
  readonly evaluations: number;
  readonly activeInvocationId?: string;
  readonly episodes: Readonly<
    Record<
      string,
      {
        readonly activity: "measurement" | "pilot";
        readonly taskIds: readonly string[];
        readonly usage: WorkflowUsageState;
        readonly complete: boolean;
      }
    >
  >;
}

export const beginPilotInvocation = (
  prior: PilotBudgetState | undefined,
  options: WorkflowUsageOptions,
  invocationId: string,
  runtimeIdentity: string,
  reading: AccountObservation,
  tasks: readonly { id: string; requiredRoles: readonly string[] }[],
  iterations: number,
  requested: WorkflowUsageState["requested"],
  startedAt: number,
  now: number,
): { budget: PilotBudgetState; usage: WorkflowUsageState } => {
  const id = options.pilot?.id;
  if (
    !id ||
    !options.pilot?.directory ||
    options.activity === "library-proof" ||
    !tasks.length
  )
    throw new Error("Pilot activity needs a shared pilot identity and tasks");
  if (
    prior &&
    (prior.version !== 2 ||
      !Number.isSafeInteger(prior.activeMs) ||
      prior.activeMs < 0 ||
      !Number.isSafeInteger(prior.measurementCalls) ||
      prior.measurementCalls < 0 ||
      prior.measurementCalls > 6 ||
      !Number.isSafeInteger(prior.evaluations) ||
      prior.evaluations < 0 ||
      prior.evaluations > 64 ||
      !prior.baseline?.accountId ||
      !prior.guardBaseline ||
      !Array.isArray(prior.resetContinuations) ||
      !prior.episodes ||
      prior.id !== id ||
      prior.policyId !== options.policyId ||
      prior.runtimeIdentity !== runtimeIdentity ||
      prior.activeInvocationId ||
      prior.episodes[invocationId])
  )
    throw new Error(
      "Pilot identity changed or another evaluation is unfinished",
    );
  if (prior && prior.activeMs >= 4 * 60 * 60_000)
    throw new Error("Pilot active-time limit reached");
  if (options.activity === "measurement") {
    if (prior?.evaluations)
      throw new Error("Measurement must precede scored evaluations");
    if (
      (prior?.measurementCalls ?? 0) >= 6 ||
      (prior?.activeMs ?? 0) >= 15 * 60_000
    )
      throw new Error("Pilot measurement allowance is exhausted");
    if (
      (prior?.measurementCalls ?? 0) +
        tasks.reduce(
          (total, task) => total + iterations + task.requiredRoles.length,
          0,
        ) >
      6
    )
      throw new Error(
        "Required roles exceed the remaining measurement allowance",
      );
  } else if (
    !prior ||
    !Object.values(prior.episodes).some(
      (episode) => episode.activity === "measurement" && episode.complete,
    )
  )
    throw new Error("Pilot measurement prerequisite is incomplete");
  if (
    options.activity === "pilot" &&
    (prior?.evaluations ?? 0) + tasks.length > 64
  )
    throw new Error("Pilot permits at most 64 evaluations");
  const baseline = prior?.baseline ?? reading;
  const guardBaseline = prior?.guardBaseline ?? reading;
  const reason = accountGuardReason(guardBaseline, reading, now);
  if (reason && !options.resetContinuation) throw new Error(reason);
  const fresh = initialWorkflowUsage(
    options,
    runtimeIdentity,
    reading,
    tasks,
    iterations,
    requested,
  );
  let usage: WorkflowUsageState = {
    ...fresh,
    baseline,
    guardBaseline,
    latest: reading,
    accountHistory:
      baseline === reading
        ? [{ reading }]
        : [{ reading: baseline }, { reading }],
    activeMs: prior?.activeMs ?? 0,
    activeUpdatedAt: startedAt,
    invocations:
      options.activity === "measurement" ? (prior?.measurementCalls ?? 0) : 0,
    resetContinuations: prior?.resetContinuations ?? [],
  };
  if (options.resetContinuation)
    usage = continueAfterAccountReset(
      accrueWorkflowTime(
        { ...usage, ...(reason ? { stopReason: reason } : {}) },
        now,
      ),
      reading,
      now,
      options.resetContinuation,
    );
  const budget: PilotBudgetState = {
    version: 2,
    id,
    policyId: options.policyId,
    runtimeIdentity,
    baseline,
    guardBaseline: usage.guardBaseline,
    latest: reading,
    resetContinuations: usage.resetContinuations,
    activeMs: usage.activeMs,
    measurementCalls: prior?.measurementCalls ?? 0,
    evaluations:
      (prior?.evaluations ?? 0) +
      (options.activity === "pilot" ? tasks.length : 0),
    activeInvocationId: invocationId,
    episodes: {
      ...prior?.episodes,
      [invocationId]: {
        activity: options.activity,
        taskIds: tasks.map((task) => task.id),
        usage,
        complete: false,
      },
    },
  };
  return { budget, usage };
};

export const recordPilotUsage = (
  budget: PilotBudgetState,
  invocationId: string,
  usage: WorkflowUsageState,
): PilotBudgetState => {
  const episode = budget.episodes[invocationId];
  if (
    budget.activeInvocationId !== invocationId ||
    !episode ||
    usage.policyId !== budget.policyId ||
    usage.runtimeIdentity !== budget.runtimeIdentity ||
    JSON.stringify(usage.baseline) !== JSON.stringify(budget.baseline) ||
    !Array.isArray(usage.resetContinuations) ||
    !Array.isArray(budget.resetContinuations) ||
    JSON.stringify(
      usage.resetContinuations.slice(0, budget.resetContinuations.length),
    ) !== JSON.stringify(budget.resetContinuations) ||
    (usage.resetContinuations.length === budget.resetContinuations.length &&
      JSON.stringify(usage.guardBaseline) !==
        JSON.stringify(budget.guardBaseline)) ||
    !Number.isSafeInteger(usage.activeMs) ||
    !Number.isSafeInteger(usage.invocations) ||
    usage.activeMs < budget.activeMs ||
    (episode.activity === "measurement" &&
      (usage.invocations < budget.measurementCalls || usage.invocations > 6))
  )
    throw new Error("Pilot usage continuity was lost");
  return {
    ...budget,
    latest: usage.latest,
    guardBaseline: usage.guardBaseline,
    resetContinuations: usage.resetContinuations,
    activeMs: usage.activeMs,
    measurementCalls:
      episode.activity === "measurement"
        ? usage.invocations
        : budget.measurementCalls,
    episodes: {
      ...budget.episodes,
      [invocationId]: { ...episode, usage },
    },
  };
};

export const settlePilotInvocation = (
  budget: PilotBudgetState,
  invocationId: string,
  usage: WorkflowUsageState,
  complete: boolean,
): PilotBudgetState => {
  const updated = recordPilotUsage(budget, invocationId, usage);
  if (!complete) return updated;
  const episode = updated.episodes[invocationId]!;
  return {
    ...updated,
    activeInvocationId: undefined,
    episodes: {
      ...updated.episodes,
      [invocationId]: { ...episode, complete: true },
    },
  };
};
