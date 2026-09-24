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
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Worktree } from "./createWorktree.js";
import {
  beginPilotInvocation,
  recordPilotUsage,
  settlePilotInvocation,
  type PilotBudgetState,
} from "./pilotBudget.js";
import {
  accrueWorkflowTime,
  discoverConfiguredModels,
  finishWorkflowInvocation,
  initialWorkflowUsage,
  observeWorkflowUsage,
  resumeWorkflowUsage,
  startWorkflowInvocation,
  startWorkflowTask,
  finishWorkflowTask,
  validateActivityConfiguration,
  type WorkflowUsageOptions,
  type WorkflowUsageState,
} from "./workflowUsage.js";
import {
  captureWorkflowCheckpoint,
  restoreWorkflowCheckpoint,
  verifyWorkflowCheckpoint,
  type WorkflowCheckpoint,
} from "./workflowCheckpoint.js";
import {
  inspectWorkflow,
  runWorkflow,
  type WorkflowAcceptance,
  type WorkflowCandidate,
  type WorkflowDecision,
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
  | "integrated"
  | "rejected"
  | "rework-requested"
  | "blocked"
  | "paused"
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
  readonly integration?: WorkflowIntegrationInput;
}

interface WorkflowIntegrationInput {
  readonly worktree: string;
  readonly candidate: WorkflowCandidate;
  readonly check: WorkflowDecision;
  readonly evidence: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly targetBranch: string;
  readonly targetHead: string;
  readonly requestId?: string;
}

export interface WorkflowIntegrationIntent extends WorkflowIntegrationInput {
  readonly id: string;
  readonly status: "ready" | "applying" | "integrated" | "blocked";
  readonly responseId?: string;
  readonly commit?: string;
  readonly gate?: WorkflowDecision;
  readonly gateEvidence?: WorkflowIntegrationInput["evidence"];
  readonly postconditions?: {
    readonly branch: string;
    readonly tree: string;
    readonly clean: true;
  };
  readonly reason?: string;
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
  readonly lifecycle: "running" | "stopping" | "stopped" | "recovery-required";
  readonly failure?: string;
  readonly owner: { readonly pid: number; readonly start: string };
  readonly processes?: readonly {
    readonly pid: number;
    readonly start: string;
  }[];
  readonly tasks: Record<
    string,
    { status: TaskState; reason?: string; remaining: number }
  >;
  readonly active: readonly string[];
  readonly startedTasks?: readonly string[];
  readonly requests: readonly WorkflowRequest[];
  readonly responses: readonly WorkflowResponseReceipt[];
  readonly checksPassed?: Readonly<
    Record<
      string,
      { readonly candidate: string; readonly check: WorkflowDecision }
    >
  >;
  readonly integrations?: Readonly<Record<string, WorkflowIntegrationIntent>>;
  readonly checkpoints: readonly string[];
  readonly checkpoint?: WorkflowCheckpoint;
  readonly sourceRestoration?: "verified" | "unavailable";
  readonly sessionRestoration?: "verified" | "unavailable";
  readonly runtimeIdentity?: string;
  readonly targetHead?: string;
  readonly targetBranch?: string;
  readonly baselineHeads?: Readonly<Record<string, string>>;
  readonly selectedTasks?: readonly WorkflowTask[];
  readonly evidence?: Readonly<Record<string, readonly string[]>>;
  readonly sessions?: Readonly<
    Record<
      string,
      readonly {
        role: string;
        id: string;
        path?: string;
        capturedAt?: string;
      }[]
    >
  >;
  readonly resources: {
    readonly reservationId: string;
    readonly retained: boolean;
    readonly scopes: Readonly<Record<string, readonly string[]>>;
  };
  readonly allowances: { readonly iterations: number };
  readonly usage?: WorkflowUsageState;
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
    /** Hold the project's target-branch lock for the entire callback. */
    withTargetLock?<T>(branch: string, action: () => Promise<T>): Promise<T>;
    /** Recheck every project-owned gate that authorizes this exact integration. */
    validateIntegration?(
      intent: WorkflowIntegrationIntent,
    ): Promise<WorkflowDecision>;
  };
  readonly directory: string;
  readonly projectId: string;
  readonly invocationId: string;
  /** Separate worktrees keep a waiting candidate frozen while another task runs. */
  readonly worktrees: Readonly<Record<string, Worktree>>;
  /** Stable project and provider/build identity required for recovery. */
  readonly runtimeIdentity?: string;
  /** Ignored files or directories the project requires in a checkpoint. */
  readonly requiredIgnoredArtifacts?: Readonly<
    Record<string, readonly string[]>
  >;
  /** Project-owned proof that the original logical reservation still exists. */
  readonly recoverReservation?: (id: string) => Promise<void>;
  /** Model-free account and worker-catalog readers for bounded live activities. */
  readonly usage?: WorkflowUsageOptions;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const statePath = (directory: string): string => join(directory, "state.json");
const inboxPath = (directory: string): string => join(directory, "inbox");
const responseIdentityPath = (directory: string, responseId: string): string =>
  join(inboxPath(directory), "identities", `${responseId}.json`);
const lockPath = (directory: string): string =>
  join(directory, "execution.lock");
const stopPath = (directory: string): string => join(directory, "stop.json");
const usagePath = (directory: string): string => join(directory, "usage.json");
const pilotBudgetPath = (directory: string): string =>
  join(directory, "budget.json");
const readWithin = async <T>(
  read: () => Promise<T>,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const readGuardedAccount = (usage: WorkflowUsageOptions) =>
  readWithin(usage.readAccount, "Account reading timed out");
const sessionPath = (directory: string): string => join(directory, "sessions");
const roleStartPath = (directory: string): string =>
  join(directory, "role-starts");
const rolePath = (directory: string): string => join(directory, "roles");
const cleanupPath = (directory: string): string => join(directory, "cleanup");

const assertHostDirectory = (
  directory: string,
  worktrees: Readonly<Record<string, Worktree>>,
): void => {
  const control = realpathSync(directory);
  for (const worktree of Object.values(worktrees)) {
    const path = relative(realpathSync(worktree.worktreePath), control);
    if (!path || (path.split(sep)[0] !== ".." && !isAbsolute(path)))
      throw new Error("Host state directory must be outside agent worktrees");
  }
};

const stopRequested = async (directory: string): Promise<boolean> => {
  try {
    await stat(stopPath(directory));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

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

const claimResponseIdentity = async (
  directory: string,
  response: WorkflowResponse,
): Promise<string> => {
  const path = responseIdentityPath(directory, response.responseId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await publish(path, response, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(path, "utf8")) as WorkflowResponse;
    if (digest(prior) !== digest(response))
      throw new Error("Conflicting response identity");
  }
  return path;
};

const ownerStart = (pid: number): string => {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
};

const ownerAlive = (owner: { pid: number; start: string }): boolean => {
  try {
    return ownerStart(owner.pid) === owner.start;
  } catch {
    return false;
  }
};

const descendants = (pid: number): { pid: number; start: string }[] => {
  const found: { pid: number; start: string }[] = [];
  const visit = (parent: number): void => {
    let children: number[];
    try {
      children = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      return;
    }
    for (const child of children) {
      try {
        found.push({ pid: child, start: ownerStart(child) });
        visit(child);
      } catch {
        /* exited during inspection */
      }
    }
  };
  visit(pid);
  return found;
};

const writeLockOwner = async (directory: string): Promise<void> =>
  publish(
    join(lockPath(directory), "owner.json"),
    { pid: process.pid, start: ownerStart(process.pid) },
    true,
  );

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
  let usage: WorkflowUsageState | undefined;
  try {
    usage = JSON.parse(
      await readFile(usagePath(directory), "utf8"),
    ) as WorkflowUsageState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const observationAgeMs = Math.max(
    0,
    Date.now() - Date.parse(state.observedAt),
  );
  let live = false;
  if (
    (state.lifecycle === "running" || state.lifecycle === "stopping") &&
    observationAgeMs < 5000
  ) {
    try {
      live = ownerStart(state.owner.pid) === state.owner.start;
    } catch {
      /* exited */
    }
  }
  return {
    ...state,
    ...(usage ? { usage } : {}),
    observationAgeMs,
    liveness: live ? "live" : "last-known",
  };
};

/** Request a durable stop, then wait for the controller's verified receipt. */
export const checkpointStopWorkflow = async (
  directory: string,
): Promise<WorkflowSnapshot> => {
  const initial = await readState(directory);
  if (initial.lifecycle === "stopped" && initial.checkpoint) {
    await verifyWorkflowCheckpoint(directory, initial.checkpoint);
    if (
      initial.sourceRestoration !== "verified" ||
      initial.sessionRestoration !== "verified"
    )
      throw new Error(
        "Workflow checkpoint is missing required restoration proof",
      );
    return initial;
  }
  if (initial.lifecycle === "stopped")
    throw new Error("Stopped workflow has no verified checkpoint");
  if (initial.lifecycle === "recovery-required")
    throw new Error(initial.failure ?? "Workflow requires recovery");
  try {
    await publish(
      stopPath(directory),
      { invocationId: initial.invocationId },
      true,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(stopPath(directory), "utf8")) as {
      invocationId: string;
    };
    if (prior.invocationId !== initial.invocationId)
      throw new Error("Stop intent belongs to another invocation");
  }
  for (let attempt = 0; attempt < 600; attempt++) {
    const state = await readState(directory);
    if (state.lifecycle === "stopped" && state.checkpoint) {
      await verifyWorkflowCheckpoint(directory, state.checkpoint);
      if (
        state.sourceRestoration !== "verified" ||
        state.sessionRestoration !== "verified"
      )
        throw new Error(
          "Workflow checkpoint is missing required restoration proof",
        );
      return state;
    }
    if (state.lifecycle === "recovery-required")
      throw new Error(state.failure ?? "Workflow requires recovery");
    try {
      if (ownerStart(state.owner.pid) !== state.owner.start)
        throw new Error("Workflow owner exited before a stopped receipt");
    } catch (error) {
      throw new Error(
        `Workflow owner exited before a stopped receipt: ${String(error)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workflow stop has not produced a verified receipt");
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
    await claimResponseIdentity(directory, response);
    await syncDirectory(inboxPath(directory));
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
    const identity = await claimResponseIdentity(directory, response);
    await link(identity, path);
    await syncDirectory(inboxPath(directory));
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
    await syncDirectory(inboxPath(directory));
  }
  return { status: "queued", responseId };
};

const validEvidence = async (
  evidence: readonly { readonly path: string; readonly sha256: string }[],
): Promise<boolean> => {
  for (const item of evidence) {
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

const captureEvidence = async (
  paths: readonly string[],
): Promise<WorkflowIntegrationInput["evidence"]> =>
  Promise.all(
    [...new Set(paths)].map(async (path) => {
      if (!isAbsolute(path))
        throw new Error(
          `Integration evidence must have an absolute path: ${path}`,
        );
      return {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    }),
  );

const candidateCurrent = (request: {
  worktree: string;
  branch: string;
  candidate: string;
}): boolean => {
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

const acceptedCurrent = async (
  intent: WorkflowIntegrationInput,
): Promise<boolean> =>
  candidateCurrent({
    worktree: intent.worktree,
    branch: intent.candidate.branch,
    candidate: intent.candidate.head,
  }) && (await validEvidence(intent.evidence));

const targetCurrent = (root: string, branch: string, head: string): boolean => {
  try {
    return (
      git(root, "branch", "--show-current") === branch &&
      git(root, "rev-parse", "HEAD") === head
    );
  } catch {
    return false;
  }
};

const integrationInput = async (
  state: WorkflowSnapshot,
  worktree: string,
  completed: {
    candidate: WorkflowCandidate;
    check: WorkflowDecision;
    acceptance?: WorkflowAcceptance;
  },
  requestId?: string,
): Promise<WorkflowIntegrationInput> => {
  if (!state.targetBranch || !state.targetHead)
    throw new Error("Integration target was not recorded");
  if (
    completed.acceptance?.request &&
    completed.acceptance.request.target !== state.targetBranch
  )
    throw new Error("Human request target does not match the recorded target");
  return {
    worktree,
    candidate: completed.candidate,
    check: completed.check,
    evidence: await captureEvidence([
      ...completed.check.evidence,
      ...(completed.acceptance?.evidence ?? []),
      ...(completed.acceptance?.request?.evidence.map((item) => item.path) ??
        []),
    ]),
    targetBranch: state.targetBranch,
    targetHead: state.targetHead,
    ...(requestId ? { requestId } : {}),
  };
};

const integrationIntent = (
  input: WorkflowIntegrationInput,
  responseId?: string,
): WorkflowIntegrationIntent => ({
  ...input,
  id: randomUUID(),
  status: "ready",
  ...(responseId ? { responseId } : {}),
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 30_000,
  }).trim();

const effectCommit = (
  root: string,
  intent: WorkflowIntegrationIntent,
): string | undefined => {
  const head = git(root, "rev-parse", "HEAD");
  if (
    git(root, "branch", "--show-current") !== intent.targetBranch ||
    head === intent.targetHead
  )
    return undefined;
  const parents = git(root, "show", "-s", "--format=%P", head).split(" ");
  const message = git(root, "show", "-s", "--format=%B", head).split("\n");
  if (
    parents.length !== 2 ||
    parents[0] !== intent.targetHead ||
    parents[1] !== intent.candidate.head ||
    !message.includes(`Sandcastle-Effect: ${intent.id}`) ||
    !message.includes(`Sandcastle-Candidate: ${intent.candidate.head}`) ||
    git(root, "status", "--porcelain", "--untracked-files=all")
  )
    return undefined;
  return head;
};

const reconcileIntegration = async (
  options: DurableWorkflowOptions,
  state: WorkflowSnapshot,
): Promise<WorkflowSnapshot> => {
  for (const [taskId, intent] of Object.entries(state.integrations ?? {})) {
    if (intent.status !== "applying") continue;
    if (!options.project.withTargetLock)
      throw new Error("Project target lock is unavailable during recovery");
    state = await options.project.withTargetLock(
      intent.targetBranch,
      async () => {
        const commit = effectCommit(options.project.root, intent);
        const tree = commit
          ? git(
              options.project.root,
              "merge-tree",
              "--write-tree",
              "--no-messages",
              intent.targetHead,
              intent.candidate.head,
            )
          : undefined;
        if (
          !commit ||
          git(options.project.root, "show", "-s", "--format=%T", commit) !==
            tree ||
          !(await acceptedCurrent(intent)) ||
          !(await validEvidence(intent.gateEvidence ?? []))
        )
          throw new Error(
            `Integration effect ${intent.id} is uncertain; owner recovery is required`,
          );
        return update(options.directory, state, {
          targetHead: commit,
          tasks: {
            ...state.tasks,
            [taskId]: { ...state.tasks[taskId]!, status: "integrated" },
          },
          integrations: {
            ...state.integrations,
            [taskId]: {
              ...intent,
              status: "integrated",
              commit,
              postconditions: {
                branch: intent.targetBranch,
                tree: tree!,
                clean: true,
              },
            },
          },
        });
      },
    );
  }
  return state;
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
      if (prior.payloadHash !== digest(response))
        throw new Error("Conflicting response identity");
      await rm(path);
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
      (await validEvidence(request!.evidence)) &&
      (!request!.integration ||
        ((await validEvidence(request!.integration.evidence)) &&
          targetCurrent(
            state.projectRoot,
            request!.integration.targetBranch,
            request!.integration.targetHead,
          ))) &&
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
      integrations:
        current && response.decision === "Approve" && request?.integration
          ? {
              ...state.integrations,
              [request.taskId]: integrationIntent(
                request.integration,
                response.responseId,
              ),
            }
          : state.integrations,
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
  await writeLockOwner(directory);
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
  await writeLockOwner(directory);
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
  await writeLockOwner(directory);
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

const captureState = async (
  options: DurableWorkflowOptions,
  state: WorkflowSnapshot,
): Promise<WorkflowSnapshot> => {
  const usage = options.usage
    ? (JSON.parse(
        await readFile(usagePath(options.directory), "utf8"),
      ) as WorkflowUsageState)
    : undefined;
  const unfinished = (state.startedTasks ?? []).filter(
    (taskId) =>
      !["accepted", "cancelled"].includes(
        state.tasks[taskId]?.status ?? "ready",
      ),
  );
  const sessions = Object.values(state.sessions ?? {}).flat();
  let missingRequiredSession = sessions.some((session) => !session.path);
  if (options.project.capabilities.includes("recovery"))
    for (const taskId of unfinished) {
      const done = await completedRoles(options.directory, taskId);
      const started = await startedRoles(options.directory, taskId);
      if (
        started.some(
          (role) =>
            !done.includes(role) &&
            !state.sessions?.[taskId]?.some((session) => session.role === role),
        )
      )
        missingRequiredSession = true;
    }
  const artifacts = [
    ...(usage ? [usagePath(options.directory)] : []),
    ...state.requests.flatMap((request) =>
      request.evidence.map((item) => item.path),
    ),
    ...Object.values(state.evidence ?? {})
      .flat()
      .filter(isAbsolute),
    ...sessions
      .map((session) => session.path)
      .filter((path): path is string => Boolean(path)),
  ];
  const checkpoint = await captureWorkflowCheckpoint(
    options.directory,
    options.worktrees,
    options.requiredIgnoredArtifacts ?? {},
    artifacts,
  );
  return update(options.directory, state, {
    checkpoint,
    ...(usage ? { usage } : {}),
    sourceRestoration: "verified",
    sessionRestoration: missingRequiredSession ? "unavailable" : "verified",
  });
};

const capturedSessions = async (
  directory: string,
  taskId: string,
): Promise<
  { role: string; id: string; path?: string; capturedAt?: string }[]
> => {
  const result: {
    role: string;
    id: string;
    path?: string;
    capturedAt?: string;
  }[] = [];
  for (const name of await readdir(sessionPath(directory))) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(
      await readFile(join(sessionPath(directory), name), "utf8"),
    ) as {
      taskId: string;
      role: string;
      id: string;
      path?: string;
      capturedAt?: string;
    };
    if (record.taskId === taskId) result.push(record);
  }
  return result.sort((a, b) =>
    (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""),
  );
};

const recordedRoles = async (
  path: string,
  taskId: string,
): Promise<string[]> => {
  const result: string[] = [];
  for (const name of await readdir(path)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(path, name), "utf8")) as {
      taskId: string;
      role: string;
    };
    if (record.taskId === taskId) result.push(record.role);
  }
  return result;
};

const startedRoles = (directory: string, taskId: string): Promise<string[]> =>
  recordedRoles(roleStartPath(directory), taskId);

const completedRoles = (directory: string, taskId: string): Promise<string[]> =>
  recordedRoles(rolePath(directory), taskId);

/** Runs exact selected tasks with durable human waits and independent worktrees. */
const driveDurableWorkflow = async (
  options: DurableWorkflowOptions,
  resume = false,
  pilotContext?: {
    path: string;
    startedAt: number;
    budget?: PilotBudgetState;
  },
  operationStartedAt = Date.now(),
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
  if (
    Boolean(options.project.withTargetLock) !==
      Boolean(options.project.validateIntegration) ||
    (options.project.withTargetLock &&
      (!options.recoverReservation || !options.runtimeIdentity))
  )
    throw new Error(
      "Integration requires the project target lock, gate validator, runtime identity and reservation recovery",
    );
  const first = options.worktrees[options.selected[0]?.id ?? ""];
  if (!first) throw new Error("Every selected task needs a worktree");
  const previous = resume ? await readState(options.directory) : undefined;
  if (resume && (previous?.lifecycle !== "stopped" || !previous.selectedTasks))
    throw new Error("Workflow is not verified and stopped for resume");
  const admission = previous
    ? { status: "ready" as const, reasons: [], tasks: previous.selectedTasks! }
    : await inspectWorkflow({ ...options, worktree: first });
  if (admission.status !== "ready")
    throw new Error(admission.reasons.join("; "));
  let initialUsage: WorkflowUsageState | undefined;
  let requestedConfigurations: WorkflowUsageState["requested"] | undefined;
  if (options.usage) {
    if (!options.runtimeIdentity)
      throw new Error("Guarded workflow requires a stable runtime identity");
    const roles = new Set(
      admission.tasks.flatMap((task) => [
        "implementation",
        ...task.requiredRoles,
      ]),
    );
    const requested = Object.fromEntries(
      [...roles].map((role) => {
        const config = options.policy.roles[role]?.agent.codexConfiguration;
        if (
          !config?.model ||
          !config.effort ||
          config.serviceTier !== "default"
        )
          throw new Error(
            `Guarded role ${role} needs an explicit Codex model, effort and Standard tier`,
          );
        validateActivityConfiguration(options.usage!.activity, role, {
          model: config.model,
          effort: config.effort,
        });
        return [
          role,
          {
            model: config.model,
            effort: config.effort,
            serviceTier: "default" as const,
          },
        ];
      }),
    ) as WorkflowUsageState["requested"];
    requestedConfigurations = requested;
    await discoverConfiguredModels(
      options.usage.listModels,
      Object.values(requested),
    );
    if (!resume) {
      const reading = await readGuardedAccount(options.usage);
      if (pilotContext) {
        const begun = beginPilotInvocation(
          pilotContext.budget,
          options.usage,
          options.invocationId,
          options.runtimeIdentity,
          reading,
          admission.tasks,
          options.policy.iterations,
          requested,
          pilotContext.startedAt,
          Date.now(),
        );
        pilotContext.budget = begun.budget;
        initialUsage = begun.usage;
      } else
        initialUsage = {
          ...initialWorkflowUsage(
            options.usage,
            options.runtimeIdentity,
            reading,
            admission.tasks,
            options.policy.iterations,
            requested,
          ),
          activeUpdatedAt: operationStartedAt,
        };
    }
  }
  if (options.project.capabilities.includes("recovery")) {
    if (!options.runtimeIdentity)
      throw new Error(
        "Recoverable workflow requires a stable runtime identity",
      );
    for (const task of admission.tasks)
      for (const role of ["implementation", ...task.requiredRoles]) {
        const assignment = options.policy.roles[role];
        if (
          assignment?.sandbox.tag !== "bind-mount" ||
          !assignment.agent.captureSessions ||
          !assignment.agent.sessionStorage
        )
          throw new Error(
            `Recoverable workflow needs host session capture for ${task.id}/${role}`,
          );
      }
  }
  if (
    new Set(
      admission.tasks.map((task) => options.worktrees[task.id]?.worktreePath),
    ).size !== admission.tasks.length
  )
    throw new Error(
      "Selected tasks need separate worktrees to preserve exact candidates",
    );
  for (const task of resume ? [] : admission.tasks) {
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
  assertHostDirectory(options.directory, options.worktrees);
  await mkdir(inboxPath(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(sessionPath(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(roleStartPath(options.directory), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(rolePath(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(cleanupPath(options.directory), { recursive: true, mode: 0o700 });
  await mkdir(lockPath(options.directory));
  await writeLockOwner(options.directory);
  let reservation: Awaited<ReturnType<WorkflowProject["reserve"]>> | undefined;
  let state: WorkflowSnapshot | undefined;
  let usageState: WorkflowUsageState | undefined;
  let recoveredGuardStop: string | undefined;
  let usageMutation = Promise.resolve();
  const mutateUsage = async (
    action: (
      current: WorkflowUsageState,
    ) => Promise<WorkflowUsageState> | WorkflowUsageState,
  ): Promise<void> => {
    const next = usageMutation.then(async () => {
      if (!usageState) throw new Error("Missing durable usage reservation");
      const nextState = await action(usageState);
      if (pilotContext) {
        pilotContext.budget = recordPilotUsage(
          pilotContext.budget!,
          options.invocationId,
          nextState,
        );
        await publish(pilotContext.path, pilotContext.budget);
      }
      usageState = nextState;
      await publish(usagePath(options.directory), nextState);
    });
    usageMutation = next.catch(() => {});
    await next;
  };
  const requestGuardStop = async (): Promise<void> => {
    await publish(
      stopPath(options.directory),
      { invocationId: options.invocationId },
      true,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  };
  try {
    if (!resume) {
      try {
        await stat(statePath(options.directory));
        throw new Error("Invocation already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
      ...(resume ? { resumeId: previous!.resources.reservationId } : {}),
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
    if (resume && reservation.id !== previous!.resources.reservationId)
      throw new Error("Project changed the retained reservation identity");
    if (resume) {
      try {
        usageState = JSON.parse(
          await readFile(usagePath(options.directory), "utf8"),
        ) as WorkflowUsageState;
      } catch (error) {
        if (options.usage || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      if (
        Boolean(usageState) !== Boolean(options.usage) ||
        (usageState &&
          (usageState.policyId !== options.usage?.policyId ||
            usageState.runtimeIdentity !== options.runtimeIdentity ||
            usageState.activity !== options.usage?.activity ||
            JSON.stringify(usageState.requested) !==
              JSON.stringify(requestedConfigurations) ||
            usageState.active))
      )
        throw new Error(
          "Guarded policy, runtime or unsettled invocation changed on resume",
        );
      if (usageState) {
        if (
          pilotContext &&
          (pilotContext.budget?.activeInvocationId !== options.invocationId ||
            !pilotContext.budget.episodes[options.invocationId] ||
            digest(
              pilotContext.budget.episodes[options.invocationId]?.usage,
            ) !== digest(usageState))
        )
          throw new Error("Pilot ledger and durable usage state disagree");
        usageState = accrueWorkflowTime(
          { ...usageState, activeUpdatedAt: operationStartedAt },
          Date.now(),
        );
        const priorStop = usageState.stopReason;
        const reading = await readGuardedAccount(options.usage!);
        usageState = resumeWorkflowUsage(
          usageState,
          reading,
          Date.now(),
          options.usage?.resetContinuation,
        );
        if (priorStop && !usageState.stopReason) recoveredGuardStop = priorStop;
        if (pilotContext) {
          pilotContext.budget = recordPilotUsage(
            pilotContext.budget!,
            options.invocationId,
            usageState,
          );
          await publish(pilotContext.path, pilotContext.budget);
        }
        await publish(usagePath(options.directory), usageState);
      }
    } else if (initialUsage) {
      usageState = initialUsage;
      if (pilotContext) await publish(pilotContext.path, pilotContext.budget!);
      await publish(usagePath(options.directory), usageState, true);
    }
    if (resume) {
      await rm(stopPath(options.directory), { force: true });
      await syncDirectory(options.directory);
      state = await update(options.directory, previous!, {
        lifecycle: "running",
        owner: { pid: process.pid, start: ownerStart(process.pid) },
        processes: [],
        ...(recoveredGuardStop
          ? {
              tasks: Object.fromEntries(
                Object.entries(previous!.tasks).map(([id, task]) => [
                  id,
                  task.status === "blocked" &&
                  task.remaining > 0 &&
                  task.reason?.includes(recoveredGuardStop!)
                    ? { ...task, status: "ready", reason: undefined }
                    : task,
                ]),
              ),
            }
          : {}),
      });
    } else {
      state = {
        version: 1,
        revision: 1,
        projectId: options.projectId,
        invocationId: options.invocationId,
        projectRoot: options.project.root,
        observedAt: new Date().toISOString(),
        lifecycle: "running",
        owner: { pid: process.pid, start: ownerStart(process.pid) },
        processes: [],
        tasks: Object.fromEntries(
          admission.tasks.map((task) => [
            task.id,
            { status: "ready", remaining: options.policy.iterations },
          ]),
        ),
        active: [],
        startedTasks: [],
        requests: [],
        responses: [],
        checksPassed: {},
        integrations: {},
        checkpoints: [],
        runtimeIdentity: options.runtimeIdentity,
        targetHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: options.project.root,
          encoding: "utf8",
        }).trim(),
        targetBranch: execFileSync("git", ["branch", "--show-current"], {
          cwd: options.project.root,
          encoding: "utf8",
        }).trim(),
        selectedTasks: admission.tasks,
        baselineHeads: {},
        evidence: {},
        sessions: {},
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
      if (usageState)
        await mutateUsage((current) => accrueWorkflowTime(current, Date.now()));
      state = await captureState(options, state);
    }
    for (const task of admission.tasks) {
      const priorTask = state.tasks[task.id];
      if (
        resume &&
        priorTask?.status !== "ready" &&
        priorTask?.status !== "paused"
      )
        continue;
      let resumed: WorkflowOptions["resume"];
      if (resume && priorTask?.status === "paused") {
        const roles = ["implementation", ...task.requiredRoles];
        const done = await completedRoles(options.directory, task.id);
        const role = roles.find((item) => !done.includes(item));
        if (!role) continue;
        if (role === "implementation" && priorTask.remaining < 1) continue;
        const session = [...(state.sessions?.[task.id] ?? [])]
          .reverse()
          .find((item) => item.role === role);
        if (
          !session &&
          (await startedRoles(options.directory, task.id)).includes(role)
        )
          throw new Error(
            `Missing session for interrupted role ${task.id}/${role}`,
          );
        const baselineHead = state.baselineHeads?.[task.id];
        if (!baselineHead)
          throw new Error(`Missing baseline head for ${task.id}`);
        resumed = {
          taskId: task.id,
          role,
          ...(session ? { sessionId: session.id } : {}),
          baselineHead,
          completedRoles: roles.filter((item) => done.includes(item)),
        };
      }
      if (await stopRequested(options.directory)) {
        state = await update(options.directory, state, {
          lifecycle: "stopping",
        });
        break;
      }
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
      const allowanceBefore = priorTask?.remaining ?? options.policy.iterations;
      if (usageState) {
        try {
          await mutateUsage((current) =>
            startWorkflowTask(current, task.id, Date.now()),
          );
        } catch (error) {
          await mutateUsage((current) => ({
            ...current,
            stopReason: String(error),
          }));
          await requestGuardStop();
          state = await update(options.directory, state, {
            tasks: {
              ...state.tasks,
              [task.id]: {
                ...state.tasks[task.id]!,
                status: "blocked",
                reason: String(error),
              },
            },
          });
          break;
        }
      }
      state = await update(options.directory, state, {
        active: [task.id],
        startedTasks: [...new Set([...(state.startedTasks ?? []), task.id])],
        baselineHeads: {
          ...state.baselineHeads,
          [task.id]:
            resumed?.baselineHead ??
            execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: worktree.worktreePath,
              encoding: "utf8",
            }).trim(),
        },
        tasks: {
          ...state.tasks,
          [task.id]: {
            ...state.tasks[task.id]!,
            status: "active",
            remaining: 0,
          },
        },
      });
      const guardedUsage = options.usage;
      let activeSessionId: string | undefined;
      const readCounters = (
        taskId: string,
        role: string,
        sessionId?: string,
      ) => {
        const read = guardedUsage?.readTokenCounters;
        return read
          ? readWithin(
              () => read(taskId, role, sessionId),
              "Token counter reading timed out",
            ).catch(() => undefined)
          : Promise.resolve(undefined);
      };
      const resultPromise = runWorkflow({
        ...options,
        ...(guardedUsage
          ? {
              onInvocationStart: async (taskId: string, role: string) => {
                let reading:
                  | Awaited<ReturnType<WorkflowUsageOptions["readAccount"]>>
                  | undefined;
                try {
                  reading = await readGuardedAccount(guardedUsage);
                  await mutateUsage((current) =>
                    startWorkflowInvocation(
                      current,
                      taskId,
                      role,
                      reading!,
                      Date.now(),
                    ),
                  );
                  activeSessionId = undefined;
                } catch (error) {
                  await mutateUsage((current) => ({
                    ...(reading
                      ? observeWorkflowUsage(current, reading, Date.now())
                      : current),
                    stopReason: String(error),
                  }));
                  await requestGuardStop();
                  throw error;
                }
              },
              onInvocationComplete: async (
                taskId: string,
                role: string,
                result: {
                  sessionId?: string;
                  usage?: import("./AgentProvider.js").IterationUsage;
                },
              ) => {
                const counters = await readCounters(
                  taskId,
                  role,
                  result.sessionId,
                );
                await mutateUsage((current) =>
                  finishWorkflowInvocation(
                    current,
                    Date.now(),
                    result.sessionId,
                    result.usage,
                    counters?.counters,
                    counters?.complete,
                    counters?.requiredSessionIds,
                  ),
                );
                if (usageState?.stopReason) await requestGuardStop();
              },
            }
          : {}),
        onRoleStarted: async (taskId, role) => {
          await publish(
            join(roleStartPath(options.directory), `${randomUUID()}.json`),
            { taskId, role },
            true,
          );
        },
        onSessionCaptured: async (taskId, role, session) => {
          if (!session.sessionId || !session.sessionFilePath) return;
          const record = {
            eventId: randomUUID(),
            capturedAt: new Date().toISOString(),
            taskId,
            role,
            id: session.sessionId,
            path: session.sessionFilePath,
          };
          const path = join(
            sessionPath(options.directory),
            `${record.eventId}.json`,
          );
          await publish(path, record, true);
          if (
            usageState?.active?.taskId === taskId &&
            usageState.active.role === role
          )
            activeSessionId = session.sessionId;
        },
        onRoleCompleted: async (taskId, role) => {
          const record = { taskId, role };
          await publish(
            join(rolePath(options.directory), `${digest(record)}.json`),
            record,
            true,
          );
        },
        onCleanupFailure: async (taskId, error) => {
          await publish(
            join(cleanupPath(options.directory), `${randomUUID()}.json`),
            { taskId, reason: String(error), at: new Date().toISOString() },
            true,
          );
        },
        ...(resumed ? { resume: resumed } : {}),
        ...(resumed
          ? {
              policy: { ...options.policy, iterations: 1 },
            }
          : {}),
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
          if (
            options.usage &&
            usageState?.currentTask &&
            Date.now() - usageState.latest.observedAt >= 30_000
          ) {
            try {
              const reading = await readGuardedAccount(options.usage);
              await mutateUsage((current) =>
                observeWorkflowUsage(current, reading, Date.now()),
              );
            } catch (error) {
              await mutateUsage((current) => ({
                ...current,
                stopReason: String(error),
              }));
            }
            if (usageState?.stopReason) await requestGuardStop();
          }
          if (await stopRequested(options.directory)) {
            if (state.lifecycle !== "stopping")
              state = await update(options.directory, state, {
                lifecycle: "stopping",
              });
            activeAbort.abort(new Error("Workflow checkpoint stop requested"));
          } else
            state = await applyQueued(
              options.directory,
              state,
              options.project.validateHumanRequest,
            );
          if (Date.now() - Date.parse(state.observedAt) > 1000)
            state = await update(options.directory, state, {
              processes: descendants(process.pid),
            });
        }
      } catch (error) {
        activeAbort.abort(error);
        await resultPromise.catch(() => {});
        throw error;
      }
      if (options.usage && usageState?.currentTask) {
        const until =
          Date.now() + (options.usage.activity === "pilot" ? 120_000 : 0);
        do {
          try {
            const reading = await readGuardedAccount(options.usage);
            await mutateUsage((current) =>
              observeWorkflowUsage(current, reading, Date.now()),
            );
          } catch (error) {
            await mutateUsage((current) => ({
              ...current,
              stopReason: String(error),
            }));
          }
          if (
            usageState?.stopReason ||
            Date.now() >= until ||
            (await stopRequested(options.directory))
          )
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(30_000, until - Date.now())),
          );
        } while (true);
      }
      if (usageState?.currentTask)
        await mutateUsage((current) =>
          observeWorkflowUsage(current, current.latest, Date.now()),
        );
      if (usageState?.stopReason) {
        await requestGuardStop();
        failure ??= new Error(usageState.stopReason);
      }
      const stopAfterResult = await stopRequested(options.directory);
      if (options.usage && usageState?.active) {
        const { taskId, role } = usageState.active;
        const counters = activeSessionId
          ? await readCounters(taskId, role, activeSessionId)
          : undefined;
        await mutateUsage((current) =>
          finishWorkflowInvocation(
            current,
            Date.now(),
            activeSessionId,
            undefined,
            counters?.counters,
            counters?.complete,
            counters?.requiredSessionIds,
            "failed",
          ),
        );
      }
      if (stopAfterResult && failure) {
        if (usageState?.currentTask)
          await mutateUsage((current) =>
            finishWorkflowTask(current, Date.now()),
          );
        const sessions = await capturedSessions(options.directory, task.id);
        const used = sessions.filter(
          (session) => session.role === "implementation",
        ).length;
        state = await update(options.directory, state, {
          active: [],
          sessions: {
            ...state.sessions,
            [task.id]: sessions,
          },
          tasks: {
            ...state.tasks,
            [task.id]: {
              ...state.tasks[task.id]!,
              status: sessions.length ? "paused" : "blocked",
              remaining:
                usageState?.remaining[task.id]?.implementation ??
                (sessions.length
                  ? Math.max(0, options.policy.iterations - used)
                  : 0),
              reason: failure ? String(failure) : undefined,
            },
          },
        });
        break;
      }
      if (failure) {
        if (usageState?.currentTask)
          await mutateUsage((current) =>
            finishWorkflowTask(current, Date.now()),
          );
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
      const last = result.completed.at(-1);
      state = await update(options.directory, state, {
        ...(last?.acceptance
          ? {
              checksPassed: {
                ...state.checksPassed,
                [task.id]: {
                  candidate: last.candidate.head,
                  check: last.check,
                },
              },
            }
          : {}),
        evidence: {
          ...state.evidence,
          [task.id]: [
            ...(last?.check.evidence ?? []),
            ...(last?.acceptance?.evidence ?? []),
          ],
        },
        sessions: {
          ...state.sessions,
          [task.id]: [
            ...(state.sessions?.[task.id] ?? []),
            ...(last?.sessions ?? []),
          ],
        },
      });
      const acceptance = result.completed.at(-1)?.acceptance;
      const remaining = resumed
        ? Math.max(
            0,
            allowanceBefore -
              (resumed.role === "implementation"
                ? (last?.usedImplementationIterations ?? 1)
                : 0),
          )
        : Math.max(
            0,
            options.policy.iterations -
              (last?.usedImplementationIterations ?? options.policy.iterations),
          );
      if (acceptance?.status === "waiting") {
        let request = requestFrom(
          options,
          task,
          acceptance,
          result.completed.at(-1)!.candidate.head,
        );
        if (options.project.withTargetLock && last)
          request = {
            ...request,
            integration: await integrationInput(
              state,
              worktree.worktreePath,
              last,
              request.id,
            ),
          };
        if (
          !candidateCurrent(request) ||
          !(await validEvidence(request.evidence)) ||
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
        const intent =
          options.project.withTargetLock && result.status === "accepted" && last
            ? integrationIntent(
                await integrationInput(state, worktree.worktreePath, last),
              )
            : undefined;
        state = await update(options.directory, state, {
          active: [],
          ...(intent
            ? {
                integrations: { ...state.integrations, [task.id]: intent },
              }
            : {}),
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
      if (usageState?.currentTask)
        await mutateUsage((current) => finishWorkflowTask(current, Date.now()));
      if (usageState)
        await mutateUsage((current) => accrueWorkflowTime(current, Date.now()));
      state = await captureState(options, state);
      if (stopAfterResult) break;
    }
    if (await stopRequested(options.directory)) {
      if (state.lifecycle !== "stopping")
        state = await update(options.directory, state, {
          lifecycle: "stopping",
        });
    } else
      state = await applyQueued(
        options.directory,
        state,
        options.project.validateHumanRequest,
      );
    const waiting =
      Object.values(state.tasks).some((task) =>
        ["waiting", "rejected", "paused", "ready", "blocked"].includes(
          task.status,
        ),
      ) ||
      Object.values(state.integrations ?? {}).some(
        (intent) => intent.status !== "integrated",
      );
    if (descendants(process.pid).length)
      throw new Error("Owned child processes remain after workflow drain");
    if ((await readdir(cleanupPath(options.directory))).length)
      throw new Error(
        "Sandbox cleanup failed; retained work requires recovery",
      );
    if (usageState)
      await mutateUsage((current) => accrueWorkflowTime(current, Date.now()));
    state = await captureState(options, state);
    if (state.sessionRestoration === "unavailable")
      throw new Error(
        "Required agent session was not captured; source remains retained",
      );
    if (waiting) await reservation.retain();
    else await reservation.release();
    state = await update(options.directory, state, {
      lifecycle: "stopped",
      resources: { ...state.resources, retained: waiting },
    });
    if (pilotContext && usageState) {
      pilotContext.budget = settlePilotInvocation(
        pilotContext.budget!,
        options.invocationId,
        usageState,
        !waiting &&
          !usageState.stopReason &&
          Object.values(state.tasks).every((task) =>
            ["accepted", "integrated"].includes(task.status),
          ),
      );
      await publish(pilotContext.path, pilotContext.budget);
    }
    return state;
  } catch (error) {
    if (state) {
      try {
        if (reservation && typeof reservation !== "function")
          await reservation.retain();
        state = await update(options.directory, state, {
          lifecycle: "recovery-required",
          active: [],
          sourceRestoration: "unavailable",
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

/** Integrate one accepted candidate under the project's target lock. */
export const integrateWorkflowTask = async (
  options: DurableWorkflowOptions,
  taskId: string,
): Promise<WorkflowSnapshot> => {
  assertHostDirectory(options.directory, options.worktrees);
  await mkdir(lockPath(options.directory));
  await writeLockOwner(options.directory);
  try {
    let state = await readState(options.directory);
    const intent = state.integrations?.[taskId];
    if (
      !intent ||
      !options.project.withTargetLock ||
      !options.project.validateIntegration
    )
      throw new Error(`Task ${taskId} has no authorized integration intent`);
    const validateIntegration = options.project.validateIntegration;
    if (state.lifecycle !== "stopped")
      throw new Error(
        "Workflow must be verified and stopped before integration",
      );
    if (intent.status === "integrated") return state;
    if (intent.status !== "ready" || state.tasks[taskId]?.status !== "accepted")
      throw new Error(`Task ${taskId} is not ready for integration`);
    if (await stopRequested(options.directory))
      throw new Error("Workflow stop intent prohibits integration");
    if (
      !state.checkpoint ||
      !state.resources.retained ||
      !options.recoverReservation
    )
      throw new Error(
        "Integration requires a verified checkpoint and retained reservation",
      );
    await verifyWorkflowCheckpoint(options.directory, state.checkpoint);
    await options.recoverReservation(state.resources.reservationId);
    if (
      state.projectId !== options.projectId ||
      state.invocationId !== options.invocationId ||
      state.projectRoot !== options.project.root ||
      state.runtimeIdentity !== options.runtimeIdentity ||
      realpathSync(options.worktrees[taskId]?.worktreePath ?? "") !==
        realpathSync(intent.worktree)
    )
      throw new Error(
        "Integration project, runtime or worktree identity changed",
      );
    return await options.project.withTargetLock(
      intent.targetBranch,
      async () => {
        let applying = false;
        try {
          const selected = state.selectedTasks?.find(
            (task) => task.id === taskId,
          );
          if (
            !selected ||
            JSON.stringify(await options.project.getTask(taskId)) !==
              JSON.stringify(selected)
          )
            throw new Error("Task contract changed after acceptance");
          const passed = state.checksPassed?.[taskId];
          if (
            passed?.candidate !== intent.candidate.head ||
            digest(passed.check) !== digest(intent.check)
          )
            throw new Error("Accepted check record changed");
          if (!(await acceptedCurrent(intent)))
            throw new Error("Accepted candidate or evidence changed");
          if (intent.requestId) {
            const request = state.requests.find(
              (item) => item.id === intent.requestId,
            );
            const response = state.responses.find(
              (item) => item.responseId === intent.responseId,
            );
            if (
              !request ||
              !response ||
              request.status !== "applied" ||
              response.status !== "applied" ||
              response.decision !== "Approve" ||
              request.candidate !== intent.candidate.head ||
              !(await validEvidence(request.evidence)) ||
              !(await options.project.validateHumanRequest(request))
            )
              throw new Error("Exact-candidate human acceptance is stale");
          }
          const check = await options.project.check(intent.candidate);
          if (
            check.status !== "passed" ||
            digest(check) !== digest(intent.check)
          )
            throw new Error("Project check or reviewed result changed");
          const gate = await validateIntegration(intent);
          if (gate.status !== "passed")
            throw new Error(gate.reason ?? "Project integration gate failed");
          const gateEvidence = await captureEvidence(gate.evidence);
          const root = options.project.root;
          if (
            !(await acceptedCurrent(intent)) ||
            state.targetBranch !== intent.targetBranch ||
            state.targetHead !== intent.targetHead ||
            git(root, "branch", "--show-current") !== intent.targetBranch ||
            git(root, "rev-parse", "HEAD") !== intent.targetHead ||
            git(root, "status", "--porcelain", "--untracked-files=all")
          )
            throw new Error("Integration target changed or is not clean");
          let alreadyIntegrated = true;
          try {
            git(
              root,
              "merge-base",
              "--is-ancestor",
              intent.candidate.head,
              intent.targetHead,
            );
          } catch (error) {
            if ((error as { status?: number }).status !== 1) throw error;
            alreadyIntegrated = false;
          }
          if (alreadyIntegrated)
            throw new Error("Candidate is already in the integration target");
          let tree: string;
          try {
            tree = git(
              root,
              "merge-tree",
              "--write-tree",
              "--no-messages",
              intent.targetHead,
              intent.candidate.head,
            );
          } catch {
            throw new Error(
              "Integration has conflicts; project repair is required",
            );
          }
          state = await update(options.directory, state, {
            integrations: {
              ...state.integrations,
              [taskId]: { ...intent, status: "applying", gate, gateEvidence },
            },
          });
          applying = true;
          git(
            root,
            "merge",
            "--no-ff",
            "-m",
            `Integrate ${intent.candidate.task.reference}\n\nSandcastle-Effect: ${intent.id}\nSandcastle-Candidate: ${intent.candidate.head}`,
            intent.candidate.head,
          );
          const commit = effectCommit(root, intent);
          if (
            !commit ||
            git(root, "show", "-s", "--format=%T", commit) !== tree ||
            !(await acceptedCurrent(intent)) ||
            !(await validEvidence(gateEvidence))
          )
            throw new Error(
              "Git integration postconditions changed; recovery is required",
            );
          return update(options.directory, state, {
            targetHead: commit,
            tasks: {
              ...state.tasks,
              [taskId]: { ...state.tasks[taskId]!, status: "integrated" },
            },
            integrations: {
              ...state.integrations,
              [taskId]: {
                ...intent,
                status: "integrated",
                gate,
                gateEvidence,
                commit,
                postconditions: {
                  branch: intent.targetBranch,
                  tree,
                  clean: true,
                },
              },
            },
          });
        } catch (error) {
          if (!applying) {
            const reason = String(error);
            state = await update(options.directory, state, {
              tasks: {
                ...state.tasks,
                [taskId]: {
                  ...state.tasks[taskId]!,
                  status: "blocked",
                  reason,
                },
              },
              integrations: {
                ...state.integrations,
                [taskId]: { ...intent, status: "blocked", reason },
              },
            });
          }
          throw error;
        }
      },
    );
  } finally {
    await rm(lockPath(options.directory), { recursive: true, force: true });
  }
};

const driveWithPilotBudget = async (
  options: DurableWorkflowOptions,
  resume = false,
  startedAt = Date.now(),
): Promise<WorkflowSnapshot> => {
  const usage = options.usage;
  if (!usage || usage.activity === "library-proof") {
    if (usage?.pilot)
      throw new Error("Library proof cannot consume a pilot budget");
    return driveDurableWorkflow(options, resume, undefined, startedAt);
  }
  const pilot = usage.pilot;
  if (!pilot || !validId(pilot.id) || !isAbsolute(pilot.directory))
    throw new Error(
      "Pilot activity requires an absolute shared pilot directory",
    );
  if (resolve(pilot.directory) === resolve(options.directory))
    throw new Error("Shared pilot directory must differ from invocation state");
  await mkdir(pilot.directory, { recursive: true, mode: 0o700 });
  assertHostDirectory(pilot.directory, options.worktrees);
  await mkdir(lockPath(pilot.directory));
  try {
    await writeLockOwner(pilot.directory);
    let budget: PilotBudgetState | undefined;
    try {
      budget = JSON.parse(
        await readFile(pilotBudgetPath(pilot.directory), "utf8"),
      ) as PilotBudgetState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return await driveDurableWorkflow(
      options,
      resume,
      { path: pilotBudgetPath(pilot.directory), startedAt, budget },
      startedAt,
    );
  } finally {
    await rm(lockPath(pilot.directory), { recursive: true, force: true });
  }
};

/** Start selected tasks with a retained reservation and optional guarded usage. */
export const runDurableWorkflow = (
  options: DurableWorkflowOptions,
): Promise<WorkflowSnapshot> => driveWithPilotBudget(options);

/** Verify an interrupted invocation and restore only into a matching worktree. */
export const recoverDurableWorkflow = async (
  options: DurableWorkflowOptions,
): Promise<WorkflowSnapshot> => {
  if (!options.runtimeIdentity)
    throw new Error("Recovery requires a stable runtime identity");
  assertHostDirectory(options.directory, options.worktrees);
  const recoveryLock = join(options.directory, "recovery.lock");
  await mkdir(recoveryLock);
  let executionOwned = false;
  try {
    let state = await readState(options.directory);
    if (
      state.projectId !== options.projectId ||
      state.invocationId !== options.invocationId ||
      state.projectRoot !== options.project.root ||
      state.runtimeIdentity !== options.runtimeIdentity ||
      state.allowances.iterations !== options.policy.iterations ||
      Boolean(state.usage) !== Boolean(options.usage) ||
      (state.usage &&
        (state.usage.policyId !== options.usage?.policyId ||
          state.usage.activity !== options.usage?.activity ||
          state.usage.runtimeIdentity !== options.runtimeIdentity))
    )
      throw new Error(
        "Project, target, runtime or iteration allowance changed",
      );
    if (state.usage)
      for (const [role, requested] of Object.entries(state.usage.requested)) {
        const current = options.policy.roles[role]?.agent.codexConfiguration;
        if (
          current?.model !== requested.model ||
          current.effort !== requested.effort ||
          current.serviceTier !== requested.serviceTier
        )
          throw new Error(`Guarded role configuration changed: ${role}`);
      }
    if (
      !state.selectedTasks ||
      state.selectedTasks.length !== options.selected.length ||
      state.selectedTasks.some(
        (task, index) =>
          task.id !== options.selected[index]?.id ||
          task.reference !== options.selected[index]?.reference,
      )
    )
      throw new Error("Selected task identities changed");
    for (const task of state.selectedTasks) {
      if (
        JSON.stringify(await options.project.getTask(task.id)) !==
        JSON.stringify(task)
      )
        throw new Error(`Task contract changed for ${task.id}`);
    }
    if (state.lifecycle === "running" || state.lifecycle === "stopping") {
      if (ownerAlive(state.owner))
        throw new Error("Workflow owner is still running");
      if (state.processes?.some(ownerAlive))
        throw new Error("Owned descendant survived the workflow owner");
    }
    try {
      if (!state.checkpoint)
        throw new Error("No verified durable checkpoint exists");
      const manifest = await verifyWorkflowCheckpoint(
        options.directory,
        state.checkpoint,
      );
      const commonDir = realpathSync(
        resolve(
          options.project.root,
          execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: options.project.root,
            encoding: "utf8",
          }).trim(),
        ),
      );
      if (
        Object.values(manifest.worktrees).some(
          (worktree) => worktree.gitCommonDir !== commonDir,
        )
      )
        throw new Error("Checkpoint belongs to another Git repository");
      try {
        if ((await readdir(cleanupPath(options.directory))).length)
          throw new Error(
            "Sandbox cleanup failure still requires owner repair",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      await update(options.directory, state, {
        lifecycle: "recovery-required",
        sourceRestoration: "unavailable",
        failure: String(error),
      });
      throw error;
    }
    if (
      options.usage?.activity === "measurement" ||
      options.usage?.activity === "pilot"
    ) {
      const pilot = options.usage.pilot;
      if (!pilot || !isAbsolute(pilot.directory))
        throw new Error("Recovery requires the original pilot budget");
      const budget = JSON.parse(
        await readFile(pilotBudgetPath(pilot.directory), "utf8"),
      ) as PilotBudgetState;
      const localUsage = JSON.parse(
        await readFile(usagePath(options.directory), "utf8"),
      ) as WorkflowUsageState;
      if (
        budget.version !== 2 ||
        budget.id !== pilot.id ||
        budget.policyId !== options.usage.policyId ||
        budget.runtimeIdentity !== options.runtimeIdentity ||
        (budget.activeInvocationId !== options.invocationId &&
          !budget.episodes[options.invocationId]?.complete) ||
        !budget.episodes[options.invocationId] ||
        digest(budget.episodes[options.invocationId]?.usage) !==
          digest(localUsage)
      )
        throw new Error("Pilot budget and retained invocation disagree");
      try {
        await stat(lockPath(pilot.directory));
        const owner = JSON.parse(
          await readFile(join(lockPath(pilot.directory), "owner.json"), "utf8"),
        ) as { pid: number; start: string };
        if (ownerAlive(owner)) throw new Error("Pilot budget is still owned");
        await rm(lockPath(pilot.directory), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      const lockOwner = JSON.parse(
        await readFile(join(lockPath(options.directory), "owner.json"), "utf8"),
      ) as { pid: number; start: string };
      if (ownerAlive(lockOwner))
        throw new Error("Execution lock is still owned");
      await rm(lockPath(options.directory), { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(lockPath(options.directory));
    executionOwned = true;
    await writeLockOwner(options.directory);
    if (state.active.length)
      return update(options.directory, state, {
        lifecycle: "recovery-required",
        sourceRestoration: "unavailable",
        failure:
          "Interrupted active work has no verified final inventory; retained work needs owner inspection",
      });
    try {
      state = await reconcileIntegration(options, state);
      if (
        state.targetHead !== git(options.project.root, "rev-parse", "HEAD") ||
        state.targetBranch !==
          git(options.project.root, "branch", "--show-current")
      )
        throw new Error("Integration target changed after the recorded effect");
      if (!state.checkpoint)
        throw new Error("No verified durable checkpoint exists");
      await restoreWorkflowCheckpoint(
        options.directory,
        state.checkpoint,
        options.worktrees,
        options.requiredIgnoredArtifacts ?? {},
      );
      if (
        state.resources.retained ||
        state.lifecycle === "running" ||
        state.lifecycle === "stopping"
      ) {
        if (!options.recoverReservation)
          throw new Error("Project reservation recovery is required");
        await options.recoverReservation(state.resources.reservationId);
      }
      if (state.sessionRestoration !== "verified")
        throw new Error("Required agent session is unavailable");
      state = await update(options.directory, state, {
        lifecycle: "stopped",
        sourceRestoration: "verified",
        failure: undefined,
      });
      return await applyQueued(
        options.directory,
        state,
        options.project.validateHumanRequest,
      );
    } catch (error) {
      await update(options.directory, state, {
        lifecycle: "recovery-required",
        sourceRestoration: "unavailable",
        failure: String(error),
      });
      throw error;
    }
  } finally {
    if (executionOwned)
      await rm(lockPath(options.directory), { recursive: true, force: true });
    await rm(recoveryLock, { recursive: true, force: true });
  }
};

/** Explicitly continue only ready or paused tasks after recovery checks. */
export const resumeDurableWorkflow = async (
  options: DurableWorkflowOptions,
): Promise<WorkflowSnapshot> => {
  const startedAt = Date.now();
  const recovered = await recoverDurableWorkflow(options);
  if (recovered.lifecycle !== "stopped")
    throw new Error(recovered.failure ?? "Workflow requires recovery");
  return driveWithPilotBudget(options, true, startedAt);
};
