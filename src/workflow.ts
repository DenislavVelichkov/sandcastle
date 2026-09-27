import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Cause, Data, Effect, Exit, Option } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import type { Worktree, WorktreeRunOptions } from "./createWorktree.js";
import type { SandboxProvider } from "./SandboxProvider.js";

/** Exact tracker task selected for a workflow run. */
export interface WorkflowTask {
  /** Stable task identity within the project tracker. */
  readonly id: string;
  /** Exact tracker reference supplied at selection. */
  readonly reference: string;
  /** Only ready tasks can run; complete dependencies can satisfy admission. */
  readonly state: "ready" | "complete";
  /** Task IDs that must be complete or accepted first. */
  readonly dependencies: readonly string[];
  /** Repository-relative paths this task may edit. */
  readonly scope: readonly string[];
  /** Roles after implementation, in execution order. */
  readonly requiredRoles: readonly string[];
  /** Project capabilities required before dispatch. */
  readonly requiredCapabilities: readonly string[];
}

/** Candidate produced by the selected branch worktree. */
export interface WorkflowCandidate {
  /** Task whose scope and checks govern this candidate. */
  readonly task: WorkflowTask;
  /** Named source branch. */
  readonly branch: string;
  /** Exact Git commit checked for acceptance. */
  readonly head: string;
  /** Commits produced after the task's baseline head. */
  readonly commits: readonly { readonly sha: string }[];
  /** Required roles completed for this candidate. */
  readonly completedRoles: readonly string[];
}

/** Project-owned verification result. */
export interface WorkflowDecision {
  /** Whether the project check passed. */
  readonly status: "passed" | "failed";
  /** Paths or identifiers for the project's supporting evidence. */
  readonly evidence: readonly string[];
  /** Human-readable failure reason. */
  readonly reason?: string;
}

/** Project-owned acceptance result for a checked candidate. */
export interface WorkflowAcceptance {
  /** A waiting result must include an exact owner request. */
  readonly status: "accepted" | "blocked" | "waiting";
  /** Paths or identifiers for acceptance evidence. */
  readonly evidence: readonly string[];
  /** Human-readable blocked reason. */
  readonly reason?: string;
  /** Required when the project has presented an exact question to its owner. */
  readonly request?: WorkflowHumanQuestion;
}

/** Exact question shown through a trusted host route. */
export interface WorkflowHumanQuestion {
  /** Project-designated human decision maker. */
  readonly owner: string;
  /** Acceptance phase that needs the answer. */
  readonly phase: string;
  /** Project-owned target of the decision. */
  readonly target: string;
  /** Text presented to the owner. */
  readonly question: string;
  /** Versioned project acceptance contract. */
  readonly contract: string;
  /** Project-owned source, build, environment and acceptance manifest digest. */
  readonly manifest: string;
  /** Project checkpoint identity attached to the question. */
  readonly checkpoint: string;
  /** Exact evidence files and hashes displayed for this request. */
  readonly evidence: readonly {
    /** Absolute evidence file path. */
    readonly path: string;
    /** SHA-256 of the displayed bytes. */
    readonly sha256: string;
  }[];
  /** The trusted host route's durable displayed-question mapping. */
  readonly display: {
    /** Stable displayed question identity. */
    readonly questionId: string;
    /** Host event or page reference for the displayed question. */
    readonly sourceRef: string;
    /** Answers must arrive through the host route. */
    readonly route: "host";
  };
}

/** Project functions retain tracker, reservation, check and acceptance authority. */
export interface WorkflowProject {
  /** Absolute root of the project's Git repository. */
  readonly root: string;
  /** Capabilities the project can actually supply. */
  readonly capabilities: readonly string[];
  /** Read an exact task by its stable ID. */
  getTask(id: string): Promise<WorkflowTask | undefined>;
  /** Reserve selected scopes and role allowance before execution. */
  reserve(request: WorkflowReservation): Promise<
    | (() => Promise<void> | void)
    | {
        /** Stable logical reservation identity for recovery. */
        readonly id: string;
        /** Release a completed or terminal reservation. */
        release(): Promise<void> | void;
        /** Preserve a logical reservation after the controller stops waiting. */
        retain(): Promise<void> | void;
      }
  >;
  /** Supply exactly one prompt source; include rejectionFeedback for a repair. */
  prompt(
    task: WorkflowTask,
    role: string,
    context?: { readonly rejectionFeedback?: string },
  ):
    | string
    | Pick<
        WorktreeRunOptions,
        "prompt" | "promptFile" | "promptArgs" | "hooks"
      >;
  /** Run project verification for the exact candidate. */
  check(candidate: WorkflowCandidate): Promise<WorkflowDecision>;
  /** Decide acceptance after a passed project check. */
  accept(
    candidate: WorkflowCandidate,
    check: WorkflowDecision,
  ): Promise<WorkflowAcceptance>;
}

/** Scope and allowance passed to the project reservation owner. */
export interface WorkflowReservation {
  /** Exact selected tasks in execution order. */
  readonly tasks: readonly WorkflowTask[];
  /** Branch of the first selected worktree. */
  readonly branch: string;
  /** Per-task branch identities when selected tasks use separate worktrees. */
  readonly branches?: Readonly<Record<string, string>>;
  /** Maximum implementation invocations per task. */
  readonly implementationIterations: number;
  /** Ordered roles reserved for each task ID. */
  readonly roles: Readonly<Record<string, readonly string[]>>;
  /** Existing reservation identity when an explicitly stopped invocation resumes. */
  readonly resumeId?: string;
}

/** Fixed role assignments and implementation allowance. */
export interface WorkflowPolicy {
  /** A fixed, finite number of implementation invocations per task. */
  readonly iterations: number;
  /** Frozen second configuration for a protected benchmark retry. */
  readonly implementationFallback?: {
    /** Fallback agent used only by the guarded retry. */
    readonly agent: AgentProvider;
    /** Sandbox paired with the fallback agent. */
    readonly sandbox: SandboxProvider;
  };
  /** Agent and sandbox assigned to each role name. */
  readonly roles: Readonly<
    Record<
      string,
      { readonly agent: AgentProvider; readonly sandbox: SandboxProvider }
    >
  >;
}

/** Inputs for a Promise-based public workflow run. */
export interface WorkflowOptions {
  /** Tracker, reservation, check, and acceptance bindings. */
  readonly project: WorkflowProject;
  /** An existing branch-strategy worktree. The workflow never merges it. */
  readonly worktree: Worktree;
  /** Exact task IDs and references in dependency order. */
  readonly selected: readonly {
    /** Stable task ID. */
    readonly id: string;
    /** Exact tracker reference. */
    readonly reference: string;
  }[];
  /** Fixed role and iteration policy. */
  readonly policy: WorkflowPolicy;
  /** Cancels this run without destroying the worktree. */
  readonly signal?: AbortSignal;
  /** Report a captured provider session, including interrupted work. */
  readonly onSessionCaptured?: (
    taskId: string,
    role: string,
    session: { readonly sessionId?: string; readonly sessionFilePath?: string },
  ) => Promise<void>;
  /** Record that a required role reached its first provider invocation. */
  readonly onRoleStarted?: (taskId: string, role: string) => Promise<void>;
  /** Record that a required role completed. */
  readonly onRoleCompleted?: (taskId: string, role: string) => Promise<void>;
  /** Report cleanup failure so a durable owner can retain recovery state. */
  readonly onCleanupFailure?: (taskId: string, error: unknown) => Promise<void>;
  /** Reserve an invocation and guard the actual agent before provider dispatch. */
  readonly onInvocationStart?: (
    taskId: string,
    role: string,
    agent: AgentProvider,
  ) => Promise<void>;
  /** Settle a completed invocation's usage before another can start. */
  readonly onInvocationComplete?: (
    taskId: string,
    role: string,
    result: {
      readonly sessionId?: string;
      readonly usage?: import("./AgentProvider.js").IterationUsage;
    },
  ) => Promise<void>;
  /** Verified interrupted role and candidate baseline to continue. */
  readonly resume?: {
    /** Task to resume. */
    readonly taskId: string;
    /** First unfinished role. */
    readonly role: string;
    /** Provider-owned filesystem session to resume, when present. */
    readonly sessionId?: string;
    /** Original commit before this task began. */
    readonly baselineHead: string;
    /** Roles already completed for the retained candidate. */
    readonly completedRoles: readonly string[];
    /** Applied owner rejection passed to the project's repair prompt. */
    readonly rejectionFeedback?: string;
  };
}

/** Read-only admission result for a selected task set. */
export interface WorkflowAdmission {
  /** Ready only when every contract and worktree check passes. */
  readonly status: "ready" | "blocked";
  /** Specific reasons when admission is blocked. */
  readonly reasons: readonly string[];
  /** Tracker tasks copied at admission. */
  readonly tasks: readonly WorkflowTask[];
  /** Project capabilities observed at admission. */
  readonly capabilities: readonly string[];
  /** Current source branch, commit, and cleanliness when readable. */
  readonly worktreeState?: {
    /** Current branch name. */
    readonly branch: string;
    /** Current Git head. */
    readonly head: string;
    /** Whether the worktree has no changes. */
    readonly clean: boolean;
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();

const repository = (cwd: string): string =>
  realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));

const validPath = (path: string): boolean =>
  path.length > 0 &&
  path !== "." &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes(":") &&
  path.split("/").every((part) => part !== ".." && part !== "" && part !== ".");

const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

const validAssignment = (
  assignment: WorkflowPolicy["roles"][string] | undefined,
): boolean =>
  typeof assignment?.agent?.buildPrintCommand === "function" &&
  typeof assignment.agent.parseStreamLine === "function" &&
  typeof assignment.sandbox?.create === "function" &&
  ["bind-mount", "isolated", "none"].includes(assignment.sandbox.tag);

const candidateCurrent = (path: string, head: string): boolean =>
  git(path, "rev-parse", "HEAD") === head &&
  !git(path, "status", "--porcelain", "--untracked-files=all");

class WorkflowOperationError extends Data.TaggedError(
  "WorkflowOperationError",
)<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

const workflowStep = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new WorkflowOperationError({
        operation,
        cause,
        message: `${operation}: ${String(cause)}`,
      }),
  });

const workflowSync = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      new WorkflowOperationError({
        operation,
        cause,
        message: `${operation}: ${String(cause)}`,
      }),
  });

const runWorkflowEffect = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
};

/** Read-only contract and state inspection. Also used as the single run admission check. */
export const inspectWorkflow = async (
  options: WorkflowOptions,
): Promise<WorkflowAdmission> => {
  const { project, worktree, selected, policy } = options;
  const reasons: string[] = [];
  const tasks: WorkflowTask[] = [];
  let worktreeState: WorkflowAdmission["worktreeState"];
  if (!project || !worktree || !policy || !Array.isArray(selected)) {
    return {
      status: "blocked" as const,
      reasons: ["Project, worktree, policy and selected tasks are required"],
      tasks,
      capabilities: [],
    };
  }
  const capabilities = project.capabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    !policy.roles ||
    typeof policy.roles !== "object"
  ) {
    reasons.push("Project capabilities and fixed role policy are required");
  }
  if (
    typeof project.getTask !== "function" ||
    typeof project.reserve !== "function" ||
    typeof project.prompt !== "function" ||
    typeof project.check !== "function" ||
    typeof project.accept !== "function"
  ) {
    reasons.push(
      "Project tracker, reservation, prompt, check and acceptance functions are required",
    );
    return { status: "blocked" as const, reasons, tasks, capabilities };
  }
  if (!Number.isSafeInteger(policy.iterations) || policy.iterations < 1) {
    reasons.push("Policy iterations must be a positive finite integer");
  }
  if (!validAssignment(policy.roles?.implementation)) {
    reasons.push("An implementation agent and sandbox are required");
  }
  if (worktree.branchStrategyType !== "branch") {
    reasons.push("Selected worktree must use the branch strategy");
  }
  try {
    const root = realpathSync(project.root);
    const path = realpathSync(worktree.worktreePath);
    if (
      root !== realpathSync(git(root, "rev-parse", "--show-toplevel")) ||
      path !== realpathSync(git(path, "rev-parse", "--show-toplevel")) ||
      root === path ||
      repository(root) !== repository(path)
    ) {
      reasons.push(
        "Selected worktree must belong to a separate worktree in the selected project",
      );
    }
    const branch = git(path, "branch", "--show-current");
    const clean = !git(path, "status", "--porcelain", "--untracked-files=all");
    worktreeState = { branch, head: git(path, "rev-parse", "HEAD"), clean };
    if (branch !== worktree.branch) {
      reasons.push("Selected worktree branch does not match its handle");
    }
    if (
      !clean &&
      !(
        options.resume &&
        selected.length === 1 &&
        selected[0]?.id === options.resume.taskId
      )
    ) {
      reasons.push("Selected worktree has uncommitted changes");
    }
  } catch {
    reasons.push(
      "Selected project or worktree is not a readable Git repository",
    );
  }
  if (selected.length === 0) reasons.push("Select at least one exact task");
  const ids = new Set<string>();
  for (const item of selected) {
    if (!item?.id || !item.reference || ids.has(item.id)) {
      reasons.push(
        `Invalid or duplicate task selection: ${item?.id ?? "<missing>"}`,
      );
      continue;
    }
    ids.add(item.id);
    const task = await project.getTask(item.id);
    if (
      !task ||
      task.id !== item.id ||
      task.reference !== item.reference ||
      task.state !== "ready"
    ) {
      reasons.push(`Task ${item.id} is missing, changed or not ready`);
      continue;
    }
    if (
      !Array.isArray(task.scope) ||
      !task.scope.length ||
      task.scope.some((path) => !validPath(path))
    ) {
      reasons.push(
        `Task ${item.id} needs an exact repository-relative edit scope`,
      );
      continue;
    }
    if (
      !Array.isArray(task.dependencies) ||
      !Array.isArray(task.requiredRoles) ||
      !Array.isArray(task.requiredCapabilities)
    ) {
      reasons.push(
        `Task ${item.id} has missing dependency, role or capability metadata`,
      );
      continue;
    }
    if (new Set(task.requiredRoles).size !== task.requiredRoles.length) {
      reasons.push(`Task ${item.id} repeats a required role`);
    }
    for (const role of task.requiredRoles) {
      if (role === "implementation" || !validAssignment(policy.roles?.[role])) {
        reasons.push(`Task ${item.id} requires an unavailable role: ${role}`);
      }
    }
    for (const capability of task.requiredCapabilities) {
      if (!capabilities.includes(capability))
        reasons.push(
          `Task ${item.id} requires unsupported capability: ${capability}`,
        );
    }
    tasks.push(structuredClone(task));
  }
  const byId = new Map(tasks.map((task, index) => [task.id, index]));
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependencies) {
      const selectedIndex = byId.get(dependency);
      if (selectedIndex !== undefined) {
        if (selectedIndex >= index)
          reasons.push(`Task ${task.id} must follow dependency ${dependency}`);
      } else {
        const upstream = await project.getTask(dependency);
        if (
          !upstream ||
          upstream.id !== dependency ||
          upstream.state !== "complete"
        ) {
          reasons.push(
            `Task ${task.id} has unfinished dependency ${dependency}`,
          );
        }
      }
    }
    for (const other of tasks.slice(0, index)) {
      if (task.scope.some((a) => other.scope.some((b) => overlaps(a, b)))) {
        reasons.push(
          `Tasks ${other.id} and ${task.id} have overlapping edit scopes`,
        );
      }
    }
  }
  return {
    status: reasons.length ? ("blocked" as const) : ("ready" as const),
    reasons,
    tasks,
    capabilities,
    worktreeState,
  };
};

/** Final result of running the selected tasks and project gates. */
export interface WorkflowResult {
  /** Accepted only when every selected task passed checks and acceptance. */
  readonly status: "accepted" | "blocked";
  /** A completed project check rejected the candidate; recovery cannot change that result. */
  readonly terminalFailure?: true;
  /** Candidates that reached a completed project check. */
  readonly completed: readonly {
    /** Exact candidate checked. */
    readonly candidate: WorkflowCandidate;
    /** Project verification result. */
    readonly check: WorkflowDecision;
    /** Project acceptance result, when the check passed. */
    readonly acceptance?: WorkflowAcceptance;
    /** Implementation invocations spent in this run. */
    readonly usedImplementationIterations: number;
    /** Provider sessions captured for this task. */
    readonly sessions: readonly {
      /** Role that produced the session. */
      readonly role: string;
      /** Provider session identity. */
      readonly id: string;
      /** Host session file when the provider supports capture. */
      readonly path?: string;
    }[];
  }[];
  /** Explanation for a blocked result. */
  readonly reason?: string;
}

/** Run selected tasks on their branch. Project acceptance remains authoritative. */
export const runWorkflow = (
  options: WorkflowOptions,
): Promise<WorkflowResult> =>
  runWorkflowEffect(
    Effect.gen(function* () {
      const admission = yield* workflowStep("Inspect workflow", () =>
        inspectWorkflow(options),
      );
      if (admission.status === "blocked")
        return {
          status: "blocked" as const,
          completed: [],
          reason: admission.reasons.join("; "),
        };
      const { project, worktree, policy, signal } = options;
      const admittedTasks = JSON.stringify(admission.tasks);
      const iterations = policy.iterations;
      const assignments = yield* workflowSync(
        "Resolve workflow roles",
        () =>
          new Map(
            admission.tasks
              .flatMap((task) => ["implementation", ...task.requiredRoles])
              .map((role) => {
                const assignment = policy.roles[role];
                if (!assignment)
                  throw new Error(`Required role disappeared: ${role}`);
                return [
                  role,
                  { agent: assignment.agent, sandbox: assignment.sandbox },
                ] as const;
              }),
          ),
      );
      const reservation = {
        tasks: admission.tasks,
        branch: worktree.branch,
        implementationIterations: iterations,
        roles: Object.fromEntries(
          admission.tasks.map((task) => [
            task.id,
            ["implementation", ...task.requiredRoles],
          ]),
        ),
      };
      return yield* Effect.acquireUseRelease(
        workflowStep("Reserve workflow", () => project.reserve(reservation)),
        (release) =>
          Effect.gen(function* () {
            if (
              typeof release !== "function" &&
              typeof release?.release !== "function"
            )
              return yield* Effect.fail(
                new WorkflowOperationError({
                  operation: "Reserve workflow",
                  cause: undefined,
                  message:
                    "Project reservation did not return a release function",
                }),
              );
            const current = yield* workflowStep(
              "Inspect reserved workflow",
              () => inspectWorkflow(options),
            );
            if (current.status === "blocked")
              return {
                status: "blocked" as const,
                completed: [],
                reason: current.reasons.join("; "),
              };
            if (JSON.stringify(current.tasks) !== admittedTasks) {
              return {
                status: "blocked" as const,
                completed: [],
                reason: "Selected task metadata changed during reservation",
              };
            }
            if (
              policy.iterations !== iterations ||
              [...assignments].some(
                ([role, assignment]) =>
                  policy.roles[role]?.agent !== assignment.agent ||
                  policy.roles[role]?.sandbox !== assignment.sandbox,
              )
            ) {
              return {
                status: "blocked" as const,
                completed: [],
                reason: "Fixed policy changed during reservation",
              };
            }
            const completed: {
              candidate: WorkflowCandidate;
              check: WorkflowDecision;
              acceptance?: WorkflowAcceptance;
              usedImplementationIterations: number;
              sessions: { role: string; id: string; path?: string }[];
            }[] = [];
            for (const task of current.tasks) {
              const resumed =
                options.resume?.taskId === task.id ? options.resume : undefined;
              const startHead =
                resumed?.baselineHead ??
                (yield* workflowSync("Read worktree head", () =>
                  git(worktree.worktreePath, "rev-parse", "HEAD"),
                ));
              const commits: { sha: string }[] = resumed
                ? (yield* workflowSync("Read resumed commits", () =>
                    git(
                      worktree.worktreePath,
                      "rev-list",
                      "--reverse",
                      `${startHead}..HEAD`,
                    ),
                  ))
                    .split("\n")
                    .filter(Boolean)
                    .map((sha) => ({ sha }))
                : [];
              const completedRoles: string[] = [
                ...(resumed?.completedRoles ?? []),
              ];
              const sessions: { role: string; id: string; path?: string }[] =
                [];
              let usedImplementationIterations = 0;
              const roles = ["implementation", ...task.requiredRoles];
              const startRole = resumed ? roles.indexOf(resumed.role) : 0;
              if (startRole < 0)
                return yield* Effect.fail(
                  new WorkflowOperationError({
                    operation: "Resume workflow",
                    cause: undefined,
                    message: `Resume role disappeared: ${resumed?.role}`,
                  }),
                );
              for (const role of roles.slice(startRole)) {
                const assignment = assignments.get(role);
                if (!assignment)
                  return yield* Effect.fail(
                    new WorkflowOperationError({
                      operation: "Resolve workflow role",
                      cause: undefined,
                      message: `Required role disappeared: ${role}`,
                    }),
                  );
                signal?.throwIfAborted();
                const provided = yield* workflowSync(
                  `Read prompt for ${task.id}/${role}`,
                  () =>
                    project.prompt(
                      task,
                      role,
                      role === "implementation" && resumed?.rejectionFeedback
                        ? { rejectionFeedback: resumed.rejectionFeedback }
                        : undefined,
                    ),
                );
                const invocation =
                  typeof provided === "string"
                    ? { prompt: provided }
                    : provided;
                if (
                  !invocation ||
                  Boolean(invocation.prompt) === Boolean(invocation.promptFile)
                )
                  return yield* Effect.fail(
                    new WorkflowOperationError({
                      operation: "Validate workflow prompt",
                      cause: undefined,
                      message: `Project must supply exactly one prompt or prompt file for ${task.id}/${role}`,
                    }),
                  );
                if (
                  Object.keys(invocation).some(
                    (key) =>
                      !["prompt", "promptFile", "promptArgs", "hooks"].includes(
                        key,
                      ),
                  )
                )
                  return yield* Effect.fail(
                    new WorkflowOperationError({
                      operation: "Validate workflow prompt",
                      cause: undefined,
                      message:
                        "Unsupported workflow prompt option; policy and retry settings belong to the controller",
                    }),
                  );
                if (!options.onInvocationStart)
                  yield* workflowStep("Record role start", async () =>
                    options.onRoleStarted?.(task.id, role),
                  );
                let roleStarted = false;
                const result = yield* workflowStep(
                  `Run ${task.id}/${role}`,
                  () =>
                    worktree.run({
                      agent: assignment.agent,
                      sandbox: assignment.sandbox,
                      ...invocation,
                      maxIterations:
                        role === "implementation"
                          ? resumed
                            ? 1
                            : iterations
                          : 1,
                      ...(resumed?.sessionId && role === resumed.role
                        ? { resumeSession: resumed.sessionId }
                        : {}),
                      signal,
                      onSessionCaptured: (session) =>
                        options.onSessionCaptured?.(task.id, role, session) ??
                        Promise.resolve(),
                      onCleanupFailure: (error) =>
                        options.onCleanupFailure?.(task.id, error) ??
                        Promise.resolve(),
                      onIterationStart: async () => {
                        await options.onInvocationStart?.(
                          task.id,
                          role,
                          assignment.agent,
                        );
                        if (options.onInvocationStart && !roleStarted) {
                          await options.onRoleStarted?.(task.id, role);
                          roleStarted = true;
                        }
                      },
                      onIterationComplete: (_iteration, result) =>
                        options.onInvocationComplete?.(task.id, role, result) ??
                        Promise.resolve(),
                    }),
                );
                signal?.throwIfAborted();
                if (role === "implementation")
                  usedImplementationIterations = Array.isArray(
                    result.iterations,
                  )
                    ? result.iterations.length
                    : resumed
                      ? 1
                      : iterations;
                commits.push(...result.commits);
                yield* workflowStep("Record role completion", async () =>
                  options.onRoleCompleted?.(task.id, role),
                );
                for (const iteration of result.iterations)
                  if (iteration.sessionId)
                    sessions.push({
                      role,
                      id: iteration.sessionId,
                      ...(iteration.sessionFilePath
                        ? { path: iteration.sessionFilePath }
                        : {}),
                    });
                completedRoles.push(role);
              }
              const candidate: WorkflowCandidate = {
                task,
                branch: worktree.branch,
                head: yield* workflowSync("Read candidate head", () =>
                  git(worktree.worktreePath, "rev-parse", "HEAD"),
                ),
                commits,
                completedRoles,
              };
              if (
                yield* workflowSync("Check worktree cleanliness", () =>
                  git(
                    worktree.worktreePath,
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                  ),
                )
              ) {
                return {
                  status: "blocked" as const,
                  completed,
                  reason: `Task ${task.id} left uncommitted changes`,
                };
              }
              const changed = (yield* workflowSync("Read changed paths", () =>
                git(
                  worktree.worktreePath,
                  "diff",
                  "--name-only",
                  "-z",
                  startHead,
                  candidate.head,
                ),
              ))
                .split("\0")
                .filter(Boolean);
              const outside = changed.filter(
                (path) =>
                  !task.scope.some(
                    (scope) => path === scope || path.startsWith(`${scope}/`),
                  ),
              );
              if (outside.length) {
                return {
                  status: "blocked" as const,
                  completed,
                  reason: `Task ${task.id} edited outside its scope: ${outside.join(", ")}`,
                };
              }
              const check = yield* workflowStep("Project check", () =>
                project.check(candidate),
              );
              signal?.throwIfAborted();
              if (
                !(yield* workflowSync("Verify checked candidate", () =>
                  candidateCurrent(worktree.worktreePath, candidate.head),
                ))
              ) {
                completed.push({
                  candidate,
                  check,
                  usedImplementationIterations,
                  sessions,
                });
                return {
                  status: "blocked" as const,
                  completed,
                  reason: `Task ${task.id} changed during its project check`,
                };
              }
              if (check.status !== "passed") {
                completed.push({
                  candidate,
                  check,
                  usedImplementationIterations,
                  sessions,
                });
                return {
                  status: "blocked" as const,
                  terminalFailure: true as const,
                  completed,
                  reason: check.reason ?? `Project check failed for ${task.id}`,
                };
              }
              const acceptance = yield* workflowStep("Project acceptance", () =>
                project.accept(candidate, check),
              );
              signal?.throwIfAborted();
              completed.push({
                candidate,
                check,
                acceptance,
                usedImplementationIterations,
                sessions,
              });
              if (
                !(yield* workflowSync("Verify accepted candidate", () =>
                  candidateCurrent(worktree.worktreePath, candidate.head),
                ))
              ) {
                return {
                  status: "blocked" as const,
                  completed,
                  reason: `Task ${task.id} changed during project acceptance`,
                };
              }
              if (acceptance.status !== "accepted") {
                return {
                  status: "blocked" as const,
                  completed,
                  reason:
                    acceptance.reason ??
                    `Project acceptance blocked ${task.id}`,
                };
              }
            }
            return { status: "accepted" as const, completed };
          }),
        (release) =>
          workflowStep("Release workflow reservation", async () => {
            if (typeof release === "function") await release();
            else if (typeof release?.release === "function")
              await release.release();
          }).pipe(Effect.orDie),
      );
    }),
  ).catch((error: unknown) => {
    if (options.signal?.aborted) throw options.signal.reason;
    throw error;
  });
