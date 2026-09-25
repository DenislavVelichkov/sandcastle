import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkflowDecision } from "./workflow.js";

export interface NativeProofContext {
  readonly candidateHead: string;
  readonly operationId: string;
  readonly evidenceDirectory: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
}

export interface NativeProofRequest {
  /** Clean project worktree at the exact candidate commit. */
  readonly worktree: string;
  readonly candidateHead: string;
  readonly operationId: string;
  /** Trusted host destination; each operation creates its own directory. */
  readonly evidenceRoot: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Host-wide state root. All projects on this host must use the same root. */
  readonly stateRoot?: string;
  /** Direct call to the project's declared proof owner, not an agent command. */
  run(context: NativeProofContext): Promise<string>;
  /** Independently observe current applicability using the project's validator. */
  validate(
    context: NativeProofContext,
    receipt: string,
  ): Promise<WorkflowDecision>;
  /** Confirm every owned child, device, port and fixture operation has stopped. */
  stopped(context: NativeProofContext): Promise<boolean>;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly processStart: string;
  readonly operationId: string;
  readonly candidateHead: string;
  readonly worktree: string;
  readonly evidenceDirectory: string;
}

const stateDirectory = (root?: string) =>
  join(
    root ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "sandcastle",
    "native-proof",
  );

const processStart = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

const checkedCandidate = (worktree: string, head: string) => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== head)
    throw new Error("Native proof candidate commit changed");
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Native proof candidate worktree is dirty");
};

const inside = (directory: string, file: string) =>
  file === directory || file.startsWith(`${directory}${sep}`);

const readOwner = async (lock: string): Promise<LockOwner> => {
  try {
    const owner = JSON.parse(
      await readFile(join(lock, "owner.json"), "utf8"),
    ) as LockOwner;
    if (!owner.token || !Number.isInteger(owner.pid) || !owner.processStart)
      throw new Error("Invalid native proof owner");
    return owner;
  } catch {
    throw new Error(
      "Native proof reservation is incomplete; owner recovery required",
    );
  }
};

/** Serialize native proof across projects, then call the existing project owner. */
export const runNativeProof = async (
  request: NativeProofRequest,
): Promise<WorkflowDecision> => {
  if (!/^[A-Za-z0-9_-]+$/.test(request.operationId))
    throw new Error("Native proof operation ID must be a path-safe identity");
  if (!isAbsolute(request.worktree) || !isAbsolute(request.evidenceRoot))
    throw new Error("Native proof paths must be absolute");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)
    throw new Error("Native proof timeout must be positive");
  const worktree = await realpath(request.worktree);
  const evidenceRoot = resolve(request.evidenceRoot);
  const directory = stateDirectory(request.stateRoot);
  if (!isAbsolute(directory))
    throw new Error("Native proof state root must be absolute");
  if (inside(worktree, directory))
    throw new Error(
      "Native proof reservation must stay outside the project worktree",
    );
  const currentProcessStart = processStart(process.pid);
  if (!currentProcessStart)
    throw new Error("Native proof requires a readable host process identity");
  checkedCandidate(worktree, request.candidateHead);
  const deadlineAt = Date.now() + request.timeoutMs;
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    : AbortSignal.timeout(request.timeoutMs);
  const lock = join(directory, "lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let incompleteReads = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockOwner;
      try {
        owner = await readOwner(lock);
      } catch (cause) {
        if (++incompleteReads >= 10) throw cause;
        await delay(50, undefined, { signal });
        continue;
      }
      if (processStart(owner.pid) !== owner.processStart)
        throw new Error(
          `Native proof ${owner.operationId} needs owner recovery before a new operation`,
        );
      await delay(50, undefined, { signal });
    }
  }
  const token = randomUUID();
  const evidenceDirectory = join(evidenceRoot, request.operationId);
  const owner: LockOwner = {
    token,
    pid: process.pid,
    processStart: currentProcessStart,
    operationId: request.operationId,
    candidateHead: request.candidateHead,
    worktree,
    evidenceDirectory,
  };
  const context: NativeProofContext = {
    candidateHead: request.candidateHead,
    operationId: request.operationId,
    evidenceDirectory,
    deadlineAt,
    signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
  };
  let active = false;
  let validated = false;
  try {
    const file = await open(join(lock, "owner.json"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
    } finally {
      await file.close();
    }
    checkedCandidate(worktree, request.candidateHead);
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    await mkdir(evidenceDirectory);
    active = true;
    const receipt = await request.run(context);
    signal.throwIfAborted();
    const canonicalEvidence = await realpath(evidenceDirectory);
    const canonicalReceipt = await realpath(receipt);
    if (
      !inside(canonicalEvidence, canonicalReceipt) ||
      canonicalEvidence === canonicalReceipt
    )
      throw new Error(
        "Native proof receipt must be inside its dedicated evidence directory",
      );
    checkedCandidate(worktree, request.candidateHead);
    const decision = await request.validate(context, canonicalReceipt);
    signal.throwIfAborted();
    checkedCandidate(worktree, request.candidateHead);
    if (
      decision.status === "passed" &&
      (!decision.evidence.length ||
        !decision.evidence.includes(canonicalReceipt))
    )
      throw new Error(
        "Native proof passed without its validated owner receipt",
      );
    validated = decision.status === "passed";
    return validated
      ? decision
      : {
          ...decision,
          reason: `${decision.reason ?? "Native proof validation failed"}; host reservation retained for recovery`,
        };
  } finally {
    // A failed or interrupted capture keeps the reservation if cleanup is uncertain.
    if (active && !(await request.stopped(context)))
      throw new Error(
        `Native proof ${request.operationId} resources remain active; reservation retained`,
      );
    if (active && signal.aborted) {
      validated = false;
      signal.throwIfAborted();
    }
    if (!active || validated) {
      if ((await readOwner(lock)).token !== token)
        throw new Error(
          "Native proof reservation owner changed; reservation retained",
        );
      await rm(lock, { recursive: true });
    }
  }
};

/** Explicit host recovery after the old process and every native resource stop. */
export const recoverNativeProofReservation = async (
  stateRoot: string | undefined,
  inspectStopped: (owner: Readonly<LockOwner>) => Promise<boolean>,
): Promise<void> => {
  const lock = join(stateDirectory(stateRoot), "lock");
  const owner = await readOwner(lock);
  if (
    processStart(owner.pid) === owner.processStart &&
    owner.pid !== process.pid
  )
    throw new Error("Native proof owner is still alive");
  if (!(await inspectStopped(owner)))
    throw new Error(
      "Native proof resources are still active; reservation retained",
    );
  if ((await readOwner(lock)).token !== owner.token)
    throw new Error("Native proof owner changed; reservation retained");
  await rm(lock, { recursive: true });
};
