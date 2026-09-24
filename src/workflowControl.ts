import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Worktree } from "./createWorktree.js";
import {
  inspectWorkflow,
  runWorkflow,
  type WorkflowAcceptance,
  type WorkflowHumanQuestion,
  type WorkflowOptions,
  type WorkflowProject,
  type WorkflowTask,
} from "./workflow.js";

type Decision = "Approve" | "Reject";
type TaskState =
  | "ready"
  | "active"
  | "waiting"
  | "accepted"
  | "rejected"
  | "rework-requested"
  | "blocked"
  | "cancelled";

export interface WorkflowRequest extends WorkflowHumanQuestion {
  readonly id: string;
  readonly projectId: string;
  readonly invocationId: string;
  readonly taskId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly candidate: string;
  readonly evidenceHash: string;
  readonly status: "pending" | "applied" | "stale" | "cancelled";
}

export interface WorkflowResponseReceipt {
  readonly responseId: string;
  readonly requestId: string;
  readonly status: "applied" | "stale";
  readonly decision: Decision;
  readonly payloadHash: string;
  readonly observedAt: string;
  readonly owner: string;
  readonly sourceRef: string;
  readonly eventId: string;
  readonly originalText: string;
  readonly reason?: string;
}

interface WorkflowResponse {
  readonly version: 1;
  readonly responseId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly invocationId: string;
  readonly taskId: string;
  readonly phase: string;
  readonly owner: string;
  readonly candidate: string;
  readonly evidenceHash: string;
  readonly manifest: string;
  readonly checkpoint: string;
  readonly contract: string;
  readonly questionId: string;
  readonly sourceRef: string;
  readonly eventId: string;
  readonly originalText: string;
  readonly decision: Decision;
}

export interface WorkflowSnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly projectId: string;
  readonly invocationId: string;
  readonly projectRoot: string;
  readonly observedAt: string;
  readonly lifecycle: "running" | "stopped" | "recovery-required";
  readonly failure?: string;
  readonly owner: { readonly pid: number; readonly start: string };
  readonly tasks: Record<
    string,
    { status: TaskState; reason?: string; remaining: number }
  >;
  readonly active: readonly string[];
  readonly requests: readonly WorkflowRequest[];
  readonly responses: readonly WorkflowResponseReceipt[];
  readonly checkpoints: readonly string[];
  readonly resources: {
    readonly reservationId: string;
    readonly retained: boolean;
    readonly scopes: Readonly<Record<string, readonly string[]>>;
  };
  readonly allowances: { readonly iterations: number };
}

export interface WorkflowStatus extends WorkflowSnapshot {
  readonly observationAgeMs: number;
  readonly liveness: "live" | "last-known";
}

export interface WorkflowAuthenticatedAnswer {
  readonly owner: string;
  readonly questionId: string;
  readonly sourceRef: string;
  readonly eventId: string;
  readonly originalText: string;
}

export interface WorkflowResponseRoute {
  /** Implement only in the owner-verified host route. Never expose it to an agent. */
  authenticate(
    sourceEvent: unknown,
    request: WorkflowRequest,
  ): Promise<WorkflowAuthenticatedAnswer>;
}

export interface DurableWorkflowOptions extends Omit<
  WorkflowOptions,
  "worktree"
> {
  readonly project: WorkflowProject & {
    validateHumanRequest(request: WorkflowRequest): Promise<boolean>;
  };
  readonly directory: string;
  readonly projectId: string;
  readonly invocationId: string;
  /** Separate worktrees keep a waiting candidate frozen while another task runs. */
  readonly worktrees: Readonly<Record<string, Worktree>>;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const statePath = (directory: string): string => join(directory, "state.json");
const inboxPath = (directory: string): string => join(directory, "inbox");
const lockPath = (directory: string): string =>
  join(directory, "execution.lock");

const readState = async (directory: string): Promise<WorkflowSnapshot> => {
  const state = JSON.parse(
    await readFile(statePath(directory), "utf8"),
  ) as WorkflowSnapshot;
  if (state.version !== 1)
    throw new Error("Unsupported workflow state version");
  return state;
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const publish = async (
  path: string,
  value: unknown,
  exclusive = false,
): Promise<void> => {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true });
  }
};

const ownerStart = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
};

const update = async (
  directory: string,
  state: WorkflowSnapshot,
  patch: Partial<WorkflowSnapshot>,
): Promise<WorkflowSnapshot> => {
  const next = {
    ...state,
    ...patch,
    revision: state.revision + 1,
    observedAt: new Date().toISOString(),
  } satisfies WorkflowSnapshot;
  await publish(statePath(directory), next);
  return next;
};

/** Reads one complete snapshot without taking execution ownership. */
export const workflowStatus = async (
  directory: string,
): Promise<WorkflowStatus> => {
  const state = await readState(directory);
  const observationAgeMs = Math.max(
    0,
    Date.now() - Date.parse(state.observedAt),
  );
  let live = false;
  if (state.lifecycle === "running" && observationAgeMs < 5000) {
    try {
      live = ownerStart(state.owner.pid) === state.owner.start;
    } catch {
      /* exited */
    }
  }
  return { ...state, observationAgeMs, liveness: live ? "live" : "last-known" };
};

const exactReply = (text: string): Decision => {
  if (text.trim() === "Approve") return "Approve";
  if (/^Reject(?:\s*:\s*.+)?$/s.test(text.trim())) return "Reject";
  throw new Error("Reply must be Approve or Reject with feedback");
};

const validId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** The owner-verified host route publishes an answer. It never starts an agent. */
export const respondWorkflow = async (options: {
  directory: string;
  responseId: string;
  requestId: string;
  sourceEvent: unknown;
  route: WorkflowResponseRoute;
}): Promise<{
  status: "queued" | "applied";
  responseId: string;
  receipt?: WorkflowResponseReceipt;
}> => {
  const { directory, responseId, requestId } = options;
  if (!validId(responseId) || !validId(requestId))
    throw new Error("Invalid response or request identity");
  const state = await readState(directory);
  const request = state.requests.find((item) => item.id === requestId);
  if (!request) throw new Error("Request is not pending");
  const human = await options.route.authenticate(options.sourceEvent, request);
  if (
    !human ||
    human.owner !== request.owner ||
    human.questionId !== request.display.questionId ||
    human.sourceRef !== request.display.sourceRef ||
    !human.eventId ||
    !human.originalText
  )
    throw new Error(
      "Human answer is not authenticated for the displayed question",
    );
  const response: WorkflowResponse = {
    version: 1,
    responseId,
    requestId,
    projectId: request.projectId,
    invocationId: request.invocationId,
    taskId: request.taskId,
    phase: request.phase,
    owner: human.owner,
    candidate: request.candidate,
    evidenceHash: request.evidenceHash,
    contract: request.contract,
    manifest: request.manifest,
    checkpoint: request.checkpoint,
    questionId: human.questionId,
    sourceRef: human.sourceRef,
    eventId: human.eventId,
    originalText: human.originalText,
    decision: exactReply(human.originalText),
  };
  const payloadHash = digest(response);
  const applied = state.responses.find(
    (item) => item.responseId === responseId,
  );
  if (applied) {
    if (applied.payloadHash !== payloadHash)
      throw new Error("Conflicting response identity");
    return { status: "applied", responseId, receipt: applied };
  }
  // One inbox slot per request lets the first durable answer win.
  const path = join(inboxPath(directory), `${requestId}.json`);
  try {
    const queued = JSON.parse(await readFile(path, "utf8")) as WorkflowResponse;
    if (digest(queued) !== payloadHash)
      throw new Error("Conflicting response identity");
    return { status: "queued", responseId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    request.status !== "pending" ||
    state.tasks[request.taskId]?.status !== "waiting"
  )
    throw new Error("Request is not pending");
  try {
    await publish(path, response, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let prior: WorkflowResponse;
    try {
      prior = JSON.parse(await readFile(path, "utf8")) as WorkflowResponse;
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== "ENOENT")
        throw readError;
      const receipt = (await readState(directory)).responses.find(
        (item) => item.responseId === responseId,
      );
      if (receipt?.payloadHash === payloadHash)
        return { status: "applied", responseId, receipt };
      throw new Error("Response publication changed during redelivery");
    }
    if (digest(prior) !== payloadHash)
      throw new Error("Conflicting response identity");
  }
  return { status: "queued", responseId };
};

const validEvidence = async (request: WorkflowRequest): Promise<boolean> => {
  for (const item of request.evidence) {
    if (!isAbsolute(item.path)) return false;
    try {
      const bytes = await readFile(item.path);
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256)
        return false;
    } catch {
      return false;
    }
  }
  return true;
};

const candidateCurrent = (request: WorkflowRequest): boolean => {
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: request.worktree,
        encoding: "utf8",
      }).trim();
    return (
      git("branch", "--show-current") === request.branch &&
      git("rev-parse", "HEAD") === request.candidate &&
      !git("status", "--porcelain", "--untracked-files=all")
    );
  } catch {
    return false;
  }
};

const applyQueued = async (
  directory: string,
  state: WorkflowSnapshot,
  validate: (request: WorkflowRequest) => Promise<boolean>,
): Promise<WorkflowSnapshot> => {
  for (const name of (await readdir(inboxPath(directory)))
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const path = join(inboxPath(directory), name);
    let response: WorkflowResponse;
    try {
      response = JSON.parse(await readFile(path, "utf8")) as WorkflowResponse;
    } catch {
      continue;
    }
    const prior = state.responses.find(
      (item) => item.responseId === response.responseId,
    );
    if (prior) {
      if (prior.payloadHash === digest(response)) await rm(path);
      continue;
    }
    const request = state.requests.find(
      (item) => item.id === response.requestId,
    );
    const same =
      request &&
      response.version === 1 &&
      request.status === "pending" &&
      state.tasks[request.taskId]?.status === "waiting" &&
      response.projectId === request.projectId &&
      response.invocationId === request.invocationId &&
      response.taskId === request.taskId &&
      response.phase === request.phase &&
      response.owner === request.owner &&
      response.candidate === request.candidate &&
      response.evidenceHash === request.evidenceHash &&
      response.contract === request.contract &&
      response.manifest === request.manifest &&
      response.checkpoint === request.checkpoint &&
      response.questionId === request.display.questionId &&
      response.sourceRef === request.display.sourceRef &&
      name === `${response.requestId}.json` &&
      typeof response.eventId === "string" &&
      response.eventId.length > 0 &&
      typeof response.originalText === "string" &&
      (response.originalText.trim() === "Approve" ||
        /^Reject(?:\s*:\s*.+)?$/s.test(response.originalText.trim())) &&
      response.decision === exactReply(response.originalText);
    const current = Boolean(
      same &&
      candidateCurrent(request!) &&
      (await validEvidence(request!)) &&
      (await validate(request!)),
    );
    const invalidated = Boolean(same && !current && request);
    const receipt: WorkflowResponseReceipt = {
      responseId: response.responseId,
      requestId: response.requestId,
      status: current ? "applied" : "stale",
      decision: response.decision,
      payloadHash: digest(response),
      observedAt: new Date().toISOString(),
      owner: response.owner,
      sourceRef: response.sourceRef,
      eventId: response.eventId,
      originalText: response.originalText,
      ...(!current
        ? { reason: "Request binding, candidate, evidence or contract changed" }
        : {}),
    };
    state = await update(directory, state, {
      responses: [...state.responses, receipt],
      requests: state.requests.map((item) =>
        item.id === response.requestId && (current || invalidated)
          ? {
              ...item,
              status: current ? ("applied" as const) : ("stale" as const),
            }
          : item,
      ),
      tasks:
        (current || invalidated) && request
          ? {
              ...state.tasks,
              [request.taskId]: {
                ...state.tasks[request.taskId]!,
                status: current
                  ? response.decision === "Approve"
                    ? "accepted"
                    : "rejected"
                  : "blocked",
                ...(!current
                  ? { reason: receipt.reason }
                  : response.decision === "Reject"
                    ? { reason: response.originalText }
                    : {}),
              },
            }
          : state.tasks,
    });
    await rm(path);
  }
  return state;
};

/** Applies queued answers under the single-writer lock; dispatches no model. */
export const processWorkflowResponses = async (
  directory: string,
  validate: (request: WorkflowRequest) => Promise<boolean>,
): Promise<WorkflowSnapshot> => {
  await mkdir(lockPath(directory));
  try {
    const state = await readState(directory);
    if (state.lifecycle === "recovery-required")
      throw new Error(
        "Workflow requires recovery before answers can be applied",
      );
    return await applyQueued(directory, state, validate);
  } finally {
    await rm(lockPath(directory), { recursive: true, force: true });
  }
};

/** Control-only cancellation invalidates any unanswered request. */
export const cancelWorkflowTask = async (
  directory: string,
  taskId: string,
): Promise<WorkflowSnapshot> => {
  await mkdir(lockPath(directory));
  try {
    const state = await readState(directory);
    const task = state.tasks[taskId];
    if (!task || state.lifecycle !== "stopped")
      throw new Error("Task is not safely stopped");
    return await update(directory, state, {
      tasks: { ...state.tasks, [taskId]: { ...task, status: "cancelled" } },
      requests: state.requests.map((item) =>
        item.taskId === taskId && item.status === "pending"
          ? { ...item, status: "cancelled" as const }
          : item,
      ),
    });
  } finally {
    await rm(lockPath(directory), { recursive: true, force: true });
  }
};

/** Records explicit rework intent; dispatch remains a separate operation. */
export const requestWorkflowRework = async (
  directory: string,
  taskId: string,
): Promise<WorkflowSnapshot> => {
  await mkdir(lockPath(directory));
  try {
    const state = await readState(directory);
    const task = state.tasks[taskId];
    if (
      !task ||
      task.status !== "rejected" ||
      task.remaining < 1 ||
      state.lifecycle !== "stopped"
    )
      throw new Error("Rejected task has no remaining rework allowance");
    return await update(directory, state, {
      tasks: {
        ...state.tasks,
        [taskId]: { ...task, status: "rework-requested" },
      },
    });
  } finally {
    await rm(lockPath(directory), { recursive: true, force: true });
  }
};

const requestFrom = (
  options: DurableWorkflowOptions,
  task: WorkflowTask,
  acceptance: WorkflowAcceptance,
  candidate: string,
): WorkflowRequest => {
  const question = acceptance.request;
  const worktree = options.worktrees[task.id];
  if (
    !question ||
    !worktree ||
    !question.owner ||
    !question.phase ||
    !question.target ||
    !question.question ||
    !question.contract ||
    !question.manifest ||
    !question.checkpoint ||
    question.display?.route !== "host" ||
    !question.display.questionId ||
    !question.display.sourceRef ||
    !Array.isArray(question.evidence) ||
    !question.evidence.length
  )
    throw new Error(`Task ${task.id} did not supply an exact host question`);
  return {
    ...question,
    id: randomUUID(),
    projectId: options.projectId,
    invocationId: options.invocationId,
    taskId: task.id,
    worktree: worktree.worktreePath,
    branch: worktree.branch,
    candidate,
    evidenceHash: digest(question.evidence),
    status: "pending",
  };
};

/** Runs exact selected tasks with durable human waits and independent worktrees. */
export const runDurableWorkflow = async (
  options: DurableWorkflowOptions,
): Promise<WorkflowSnapshot> => {
  if (!validId(options.projectId) || !validId(options.invocationId))
    throw new Error("Invalid project or invocation identity");
  if (
    !isAbsolute(options.directory) ||
    typeof options.project.validateHumanRequest !== "function"
  )
    throw new Error(
      "Durable workflow requires an absolute host state directory and project request validator",
    );
  const first = options.worktrees[options.selected[0]?.id ?? ""];
  if (!first) throw new Error("Every selected task needs a worktree");
  const admission = await inspectWorkflow({ ...options, worktree: first });
  if (admission.status !== "ready")
    throw new Error(admission.reasons.join("; "));
  if (
    new Set(
      admission.tasks.map((task) => options.worktrees[task.id]?.worktreePath),
    ).size !== admission.tasks.length
  )
    throw new Error(
      "Selected tasks need separate worktrees to preserve exact candidates",
    );
  for (const task of admission.tasks) {
    const worktree = options.worktrees[task.id];
    if (!worktree) throw new Error(`Missing worktree for ${task.id}`);
    const check = await inspectWorkflow({
      ...options,
      worktree,
      selected: [{ id: task.id, reference: task.reference }],
      project: {
        ...options.project,
        getTask: async (id) => {
          const found = await options.project.getTask(id);
          return found &&
            id !== task.id &&
            admission.tasks.some((item) => item.id === id)
            ? { ...found, state: "complete" }
            : found;
        },
      },
    });
    if (check.status !== "ready")
      throw new Error(
        check.reasons.join("; ") || `Invalid worktree for ${task.id}`,
      );
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await mkdir(inboxPath(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(lockPath(options.directory));
  let reservation: Awaited<ReturnType<WorkflowProject["reserve"]>> | undefined;
  let state: WorkflowSnapshot | undefined;
  try {
    try {
      await stat(statePath(options.directory));
      throw new Error("Invocation already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    reservation = await options.project.reserve({
      tasks: admission.tasks,
      branch: first.branch,
      branches: Object.fromEntries(
        admission.tasks.map((task) => [
          task.id,
          options.worktrees[task.id]!.branch,
        ]),
      ),
      implementationIterations: options.policy.iterations,
      roles: Object.fromEntries(
        admission.tasks.map((task) => [
          task.id,
          ["implementation", ...task.requiredRoles],
        ]),
      ),
    });
    if (
      typeof reservation === "function" ||
      !reservation?.id ||
      typeof reservation.retain !== "function" ||
      typeof reservation.release !== "function"
    )
      throw new Error(
        "Durable workflow requires a project-owned durable reservation",
      );
    state = {
      version: 1,
      revision: 1,
      projectId: options.projectId,
      invocationId: options.invocationId,
      projectRoot: options.project.root,
      observedAt: new Date().toISOString(),
      lifecycle: "running",
      owner: { pid: process.pid, start: ownerStart(process.pid) },
      tasks: Object.fromEntries(
        admission.tasks.map((task) => [
          task.id,
          { status: "ready", remaining: options.policy.iterations },
        ]),
      ),
      active: [],
      requests: [],
      responses: [],
      checkpoints: [],
      resources: {
        reservationId: reservation.id,
        retained: false,
        scopes: Object.fromEntries(
          admission.tasks.map((task) => [task.id, task.scope]),
        ),
      },
      allowances: { iterations: options.policy.iterations },
    };
    await publish(statePath(options.directory), state, true);
    for (const task of admission.tasks) {
      state = await applyQueued(
        options.directory,
        state,
        options.project.validateHumanRequest,
      );
      if (
        task.dependencies.some(
          (id) =>
            state!.tasks[id]?.status !== "accepted" &&
            admission.tasks.some((item) => item.id === id),
        )
      ) {
        state = await update(options.directory, state, {
          tasks: {
            ...state.tasks,
            [task.id]: {
              ...state.tasks[task.id]!,
              status: "blocked",
              reason: "Selected dependency has not been accepted",
            },
          },
        });
        continue;
      }
      const worktree = options.worktrees[task.id]!;
      const activeAbort = new AbortController();
      state = await update(options.directory, state, {
        active: [task.id],
        tasks: {
          ...state.tasks,
          [task.id]: {
            ...state.tasks[task.id]!,
            status: "active",
            remaining: 0,
          },
        },
      });
      const resultPromise = runWorkflow({
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, activeAbort.signal])
          : activeAbort.signal,
        worktree,
        selected: [{ id: task.id, reference: task.reference }],
        project: {
          ...options.project,
          getTask: async (id) => {
            const found = await options.project.getTask(id);
            return found && state!.tasks[id]?.status === "accepted"
              ? { ...found, state: "complete" }
              : found;
          },
          reserve: async () => async () => {},
        },
      });
      let finished = false;
      let result: Awaited<typeof resultPromise> | undefined;
      let failure: unknown;
      void resultPromise.then(
        (value) => {
          result = value;
          finished = true;
        },
        (error) => {
          failure = error;
          finished = true;
        },
      );
      try {
        while (!finished) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          state = await applyQueued(
            options.directory,
            state,
            options.project.validateHumanRequest,
          );
          if (Date.now() - Date.parse(state.observedAt) > 1000)
            state = await update(options.directory, state, {});
        }
      } catch (error) {
        activeAbort.abort(error);
        await resultPromise.catch(() => {});
        throw error;
      }
      if (failure) {
        state = await update(options.directory, state, {
          active: [],
          tasks: {
            ...state.tasks,
            [task.id]: {
              status: "blocked",
              remaining: 0,
              reason: String(failure),
            },
          },
        });
        continue;
      }
      result ??= await resultPromise;
      const acceptance = result.completed.at(-1)?.acceptance;
      const remaining = Math.max(
        0,
        options.policy.iterations -
          (result.completed.at(-1)?.usedImplementationIterations ??
            options.policy.iterations),
      );
      if (acceptance?.status === "waiting") {
        const request = requestFrom(
          options,
          task,
          acceptance,
          result.completed.at(-1)!.candidate.head,
        );
        if (
          !candidateCurrent(request) ||
          !(await validEvidence(request)) ||
          !(await options.project.validateHumanRequest(request))
        )
          throw new Error(
            `Task ${task.id} question evidence or contract is invalid`,
          );
        state = await update(options.directory, state, {
          active: [],
          requests: [...state.requests, request],
          checkpoints: [...state.checkpoints, request.checkpoint],
          tasks: {
            ...state.tasks,
            [task.id]: { status: "waiting", remaining },
          },
        });
      } else {
        state = await update(options.directory, state, {
          active: [],
          tasks: {
            ...state.tasks,
            [task.id]: {
              status: result.status === "accepted" ? "accepted" : "blocked",
              remaining,
              ...(result.reason ? { reason: result.reason } : {}),
            },
          },
        });
      }
    }
    state = await applyQueued(
      options.directory,
      state,
      options.project.validateHumanRequest,
    );
    const waiting = Object.values(state.tasks).some(
      (task) => task.status === "waiting" || task.status === "rejected",
    );
    if (waiting) await reservation.retain();
    else await reservation.release();
    state = await update(options.directory, state, {
      lifecycle: "stopped",
      resources: { ...state.resources, retained: waiting },
    });
    return state;
  } catch (error) {
    if (state) {
      try {
        if (reservation && typeof reservation !== "function")
          await reservation.retain();
        state = await update(options.directory, state, {
          lifecycle: "recovery-required",
          active: [],
          failure: String(error),
          resources: { ...state.resources, retained: true },
        });
      } catch {
        // Keep the last complete snapshot and retained work for owner recovery.
      }
    }
    throw error;
  } finally {
    await rm(lockPath(options.directory), { recursive: true, force: true });
    if (!state && reservation && typeof reservation !== "function")
      await reservation.release();
  }
};
