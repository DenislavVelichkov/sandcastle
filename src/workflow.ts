import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentProvider } from "./AgentProvider.js";
import type { Worktree, WorktreeRunOptions } from "./createWorktree.js";
import type { SandboxProvider } from "./SandboxProvider.js";

export interface WorkflowTask {
  readonly id: string;
  readonly reference: string;
  readonly state: "ready" | "complete";
  readonly dependencies: readonly string[];
  /** Repository-relative paths this task may edit. */
  readonly scope: readonly string[];
  /** Roles after implementation, in execution order. */
  readonly requiredRoles: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

export interface WorkflowCandidate {
  readonly task: WorkflowTask;
  readonly branch: string;
  readonly head: string;
  readonly commits: readonly { readonly sha: string }[];
  readonly completedRoles: readonly string[];
}

export interface WorkflowDecision {
  readonly status: "passed" | "failed";
  readonly evidence: readonly string[];
  readonly reason?: string;
}

export interface WorkflowAcceptance {
  readonly status: "accepted" | "blocked";
  readonly evidence: readonly string[];
  readonly reason?: string;
}

/** Project functions retain tracker, reservation, check and acceptance authority. */
export interface WorkflowProject {
  readonly root: string;
  readonly capabilities: readonly string[];
  getTask(id: string): Promise<WorkflowTask | undefined>;
  reserve(request: WorkflowReservation): Promise<() => Promise<void> | void>;
  prompt(
    task: WorkflowTask,
    role: string,
    iteration: number,
  ):
    | string
    | Pick<
        WorktreeRunOptions,
        "prompt" | "promptFile" | "promptArgs" | "hooks"
      >;
  check(candidate: WorkflowCandidate): Promise<WorkflowDecision>;
  accept(
    candidate: WorkflowCandidate,
    check: WorkflowDecision,
  ): Promise<WorkflowAcceptance>;
}

export interface WorkflowReservation {
  readonly tasks: readonly WorkflowTask[];
  readonly branch: string;
  readonly implementationIterations: number;
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

export interface WorkflowPolicy {
  /** A fixed, finite number of implementation invocations per task. */
  readonly iterations: number;
  readonly roles: Readonly<
    Record<
      string,
      { readonly agent: AgentProvider; readonly sandbox: SandboxProvider }
    >
  >;
}

export interface WorkflowOptions {
  readonly project: WorkflowProject;
  /** An existing named-branch worktree. The workflow never merges it. */
  readonly worktree: Worktree;
  readonly selected: readonly {
    readonly id: string;
    readonly reference: string;
  }[];
  readonly policy: WorkflowPolicy;
  readonly signal?: AbortSignal;
}

export interface WorkflowAdmission {
  readonly status: "ready" | "blocked";
  readonly reasons: readonly string[];
  readonly tasks: readonly WorkflowTask[];
  readonly capabilities: readonly string[];
  readonly worktreeState?: {
    readonly branch: string;
    readonly head: string;
    readonly clean: boolean;
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

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
      status: "blocked",
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
    return { status: "blocked", reasons, tasks, capabilities };
  }
  if (!Number.isSafeInteger(policy.iterations) || policy.iterations < 1) {
    reasons.push("Policy iterations must be a positive finite integer");
  }
  if (!validAssignment(policy.roles?.implementation)) {
    reasons.push("An implementation agent and sandbox are required");
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
    if (!clean) {
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
    status: reasons.length ? "blocked" : "ready",
    reasons,
    tasks,
    capabilities,
    worktreeState,
  };
};

export interface WorkflowResult {
  readonly status: "accepted" | "blocked";
  readonly completed: readonly {
    readonly candidate: WorkflowCandidate;
    readonly check: WorkflowDecision;
    readonly acceptance?: WorkflowAcceptance;
  }[];
  readonly reason?: string;
}

/** Run selected tasks on their named branch. Project acceptance remains authoritative. */
export const runWorkflow = async (
  options: WorkflowOptions,
): Promise<WorkflowResult> => {
  const admission = await inspectWorkflow(options);
  if (admission.status === "blocked")
    return {
      status: "blocked",
      completed: [],
      reason: admission.reasons.join("; "),
    };
  const { project, worktree, policy, signal } = options;
  const admittedTasks = JSON.stringify(admission.tasks);
  const release = await project.reserve({
    tasks: admission.tasks,
    branch: worktree.branch,
    implementationIterations: policy.iterations,
    roles: Object.fromEntries(
      admission.tasks.map((task) => [
        task.id,
        ["implementation", ...task.requiredRoles],
      ]),
    ),
  });
  if (typeof release !== "function")
    throw new Error("Project reservation did not return a release function");
  try {
    const current = await inspectWorkflow(options);
    if (current.status === "blocked")
      return {
        status: "blocked",
        completed: [],
        reason: current.reasons.join("; "),
      };
    if (JSON.stringify(current.tasks) !== admittedTasks) {
      return {
        status: "blocked",
        completed: [],
        reason: "Selected task metadata changed during reservation",
      };
    }
    const completed: {
      candidate: WorkflowCandidate;
      check: WorkflowDecision;
      acceptance?: WorkflowAcceptance;
    }[] = [];
    for (const task of current.tasks) {
      const startHead = git(worktree.worktreePath, "rev-parse", "HEAD");
      const commits: { sha: string }[] = [];
      const completedRoles: string[] = [];
      const roles = ["implementation", ...task.requiredRoles];
      for (const role of roles) {
        const count = role === "implementation" ? policy.iterations : 1;
        const assignment = policy.roles[role];
        if (!assignment) throw new Error(`Required role disappeared: ${role}`);
        for (let iteration = 1; iteration <= count; iteration++) {
          signal?.throwIfAborted();
          const provided = project.prompt(task, role, iteration);
          const invocation =
            typeof provided === "string" ? { prompt: provided } : provided;
          if (
            !invocation ||
            Boolean(invocation.prompt) === Boolean(invocation.promptFile)
          )
            throw new Error(
              `Project must supply exactly one prompt or prompt file for ${task.id}/${role}`,
            );
          const result = await worktree.run({
            agent: assignment.agent,
            sandbox: assignment.sandbox,
            ...invocation,
            maxIterations: 1,
            signal,
          });
          commits.push(...result.commits);
        }
        completedRoles.push(role);
      }
      const candidate: WorkflowCandidate = {
        task,
        branch: worktree.branch,
        head: git(worktree.worktreePath, "rev-parse", "HEAD"),
        commits,
        completedRoles,
      };
      if (
        git(
          worktree.worktreePath,
          "status",
          "--porcelain",
          "--untracked-files=all",
        )
      ) {
        return {
          status: "blocked",
          completed,
          reason: `Task ${task.id} left uncommitted changes`,
        };
      }
      const changed = git(
        worktree.worktreePath,
        "diff",
        "--name-only",
        "-z",
        startHead,
        candidate.head,
      )
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
          status: "blocked",
          completed,
          reason: `Task ${task.id} edited outside its scope: ${outside.join(", ")}`,
        };
      }
      const check = await project.check(candidate);
      if (!candidateCurrent(worktree.worktreePath, candidate.head)) {
        completed.push({ candidate, check });
        return {
          status: "blocked",
          completed,
          reason: `Task ${task.id} changed during its project check`,
        };
      }
      if (check.status !== "passed") {
        completed.push({ candidate, check });
        return {
          status: "blocked",
          completed,
          reason: check.reason ?? `Project check failed for ${task.id}`,
        };
      }
      const acceptance = await project.accept(candidate, check);
      completed.push({ candidate, check, acceptance });
      if (!candidateCurrent(worktree.worktreePath, candidate.head)) {
        return {
          status: "blocked",
          completed,
          reason: `Task ${task.id} changed during project acceptance`,
        };
      }
      if (acceptance.status !== "accepted") {
        return {
          status: "blocked",
          completed,
          reason: acceptance.reason ?? `Project acceptance blocked ${task.id}`,
        };
      }
    }
    return { status: "accepted", completed };
  } finally {
    await release();
  }
};
