import { randomUUID } from "node:crypto";
import { readFileSync, createReadStream } from "node:fs";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { IterationUsage } from "./AgentProvider.js";
import type {
  ImplementationAttempt,
  ImplementationExecution,
  ImplementationBenchmarkDependencies,
} from "./implementationBenchmark.js";
import { reconcileBenchmarkDocker } from "./implementationBenchmarkRuntime.js";
import type { TicketBenchmarkPlan } from "./ticketBenchmark.js";
import {
  readBenchmarkAssessments,
  judgeReservationMs,
  type JudgeAssessment,
} from "./benchmarkJudge.js";

export type BenchmarkPhase =
  | "preflight"
  | "worktree-preparation"
  | "environment-readiness"
  | "implementation"
  | "checks"
  | "judge-preparation"
  | "judge-assessment"
  | "assessment-complete"
  | "evidence-sealing"
  | "cleanup"
  | "report-generation"
  | "idle";
export interface BenchmarkOwner {
  pid: number;
  start: string | null;
  boot: string | null;
  host: string;
  token: string;
}
export interface BenchmarkResource {
  id: string;
  kind: "directory" | "docker" | "runtime" | "project-runtime";
  adapterSha256?: string;
  contextSha256?: string;
  runtimeId?: string;
  attemptId: string | null;
  status: "owned" | "released" | "cleanup-failed";
}
export interface BenchmarkCancellation {
  version: 1;
  runId: string;
  ownerToken: string;
  at: string;
  reason: string;
}
export interface BenchmarkEvent {
  version: 1;
  runId: string;
  planId: string;
  sequence: number;
  at: string;
  kind: string;
  phase: BenchmarkPhase;
  attemptId: string | null;
  slotId: string | null;
  armId: string | null;
}
export interface BenchmarkSnapshot {
  version: 1;
  runId: string;
  planId: string;
  sequence: number;
  at: string;
  startedAt: string;
  status: string;
  phase: BenchmarkPhase;
  controllerHeartbeat: string;
  lastImplementationEvent: BenchmarkEvent | null;
  lastJudgeEvent: BenchmarkEvent | null;
  owner: BenchmarkOwner | null;
  recoveryOwner: BenchmarkOwner | null;
  cancellation: BenchmarkCancellation | null;
  counts: {
    scheduled: number;
    attempted: number;
    completed: number;
    graded: number;
    attempts: number;
    retries: number;
    implementationCalls: number;
    implementationCompleted: number;
    judgeCalls: number;
    judgeCompleted: number;
  };
  allowance: ImplementationExecution["budget"] & {
    remainingMs: number;
    remainingCalls: number;
  };
  attempts: {
    id: string;
    slotId: string;
    armId: string;
    retryOf: string | null;
    status: string;
    check: string;
    judge: string;
    usage: IterationUsage | null;
    judgeUsage: IterationUsage | null;
    assessment: {
      id: string;
      status: string;
      score: JudgeAssessment["score"];
      failure: string | null;
    } | null;
    evidence: string[];
    reason: string | null;
  }[];
  unrun: string[];
  resources: BenchmarkResource[];
  controls: ImplementationExecution["controls"];
  cleanup: ImplementationExecution["cleanup"];
  arms: { id: string; model: string; effort: string }[];
  judge: { model: string; effort: string };
  reason: string | null;
  recovery: string;
}
interface RecordEntry {
  event: BenchmarkEvent;
  snapshot: BenchmarkSnapshot;
  execution: ImplementationExecution;
}
const executionView = (
  plan: TicketBenchmarkPlan,
  saved: ImplementationExecution,
) => {
  const completed = saved.attempts.filter(
    (item) =>
      !item.retryOf &&
      item.finishedAt &&
      ["passed", "failed"].includes(item.check?.status ?? ""),
  );
  return {
    counts: {
      scheduled: plan.slots.length,
      attempted: new Set(saved.attempts.map((item) => item.slotId)).size,
      completed: new Set(completed.map((item) => item.slotId)).size,
      graded: new Set(
        saved.attempts
          .filter((item) => !item.retryOf && item.judge.status === "complete")
          .map((item) => item.slotId),
      ).size,
      attempts: saved.attempts.length,
      retries: saved.attempts.filter((item) => item.retryOf).length,
      implementationCalls: saved.budget.implementationCalls,
      implementationCompleted: saved.attempts.filter(
        (item) =>
          item.implementation?.exitCode !== null &&
          item.implementation !== undefined,
      ).length,
      judgeCalls: saved.budget.judgeCalls,
      judgeCompleted: saved.attempts.reduce(
        (count, item) =>
          count +
          (item.judge.assessments?.filter((assessment) => assessment.finishedAt)
            .length ?? 0),
        0,
      ),
    },
    allowance: {
      ...saved.budget,
      remainingMs: Math.max(
        0,
        saved.budget.limitMs -
          saved.budget.elapsedMs -
          saved.budget.judgeReservedMs -
          saved.budget.cleanupReservedMs -
          saved.budget.activeReservedMs,
      ),
      remainingCalls: Math.max(
        0,
        saved.budget.maxCalls -
          saved.budget.implementationCalls -
          saved.budget.judgeCalls -
          saved.budget.judgeReservedCalls,
      ),
    },
    attempts: saved.attempts.map((item) => ({
      id: item.id,
      slotId: item.slotId,
      armId: item.armId,
      retryOf: item.retryOf ?? null,
      status: item.status,
      check: item.check?.status ?? "not-run",
      judge: item.judge.status,
      usage: item.implementation?.usage ?? null,
      judgeUsage: item.judge.assessments?.at(-1)?.usage ?? null,
      assessment: item.judge.assessments?.length
        ? {
            id: item.judge.assessments.at(-1)!.id,
            status: item.judge.assessments.at(-1)!.status,
            score: item.judge.assessments.at(-1)!.score,
            failure: item.judge.assessments.at(-1)!.failure,
          }
        : null,
      evidence: [
        item.candidate?.patch,
        item.candidate?.worktree,
        item.implementation
          ? join(
              plan.output,
              `${item.retryOf ? item.id : item.slotId}-implementation.jsonl`,
            )
          : undefined,
        ...(item.implementation?.sessions?.map((file) => file.path) ?? []),
        ...(item.judge.records?.map((file) => file.path) ?? []),
        ...(item.judge.assessments?.flatMap((assessment) => [
          assessment.provenance.stream,
          ...assessment.provenance.sessions.map((file) => file.path),
        ]) ?? []),
      ].filter((path): path is string => Boolean(path)),
      reason: item.reason ?? null,
    })),
    unrun: saved.unrun,
    resources: saved.resources,
    reason: saved.reason,
    controls: saved.controls,
    cleanup: saved.cleanup,
    arms: plan.arms.map((arm, index) => ({
      id: `arm-${index + 1}`,
      model: arm.model,
      effort: arm.effort,
    })),
    judge: { model: plan.judge!.model, effort: plan.judge!.effort },
  };
};
const atomicJson = async (path: string, value: unknown) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
};
const onceJson = async <T>(path: string, value: T): Promise<T> => {
  const temporary = `${path}.${randomUUID()}.ready`;
  await atomicJson(temporary, value);
  try {
    await link(temporary, path);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } finally {
    await rm(temporary, { force: true });
  }
};
const commitRecord = async (directory: string, record: RecordEntry) => {
  const journal = await open(join(directory, "events.jsonl"), "a", 0o600);
  try {
    await journal.writeFile(`${JSON.stringify(record)}\n`);
    await journal.sync();
  } finally {
    await journal.close();
  }
  await atomicJson(join(directory, "execution.json"), record.execution);
  await atomicJson(join(directory, "status.json"), record.snapshot);
};
const boundedRecovery = async (
  operation: () => Promise<void>,
  signal: AbortSignal,
  graceMs: number,
) => {
  signal.throwIfAborted();
  let abort!: () => void;
  let settled = false;
  let pending: Promise<void> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new Error(
          typeof signal.reason === "string"
            ? signal.reason
            : "Owned recovery exceeded its bounded allowance",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    pending = operation().finally(() => {
      settled = true;
    });
    await Promise.race([pending, interrupted]);
  } catch (error) {
    if (pending && signal.aborted && !settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!settled && error && typeof error === "object")
        Object.assign(error, { unsettled: true });
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
const processStart = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};
const bootIdentity = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};
const owner = (): BenchmarkOwner => ({
  pid: process.pid,
  start: processStart(process.pid),
  boot: bootIdentity(),
  host: hostname(),
  token: randomUUID(),
});
const ownerAlive = (value: BenchmarkOwner) => {
  if (value.host !== hostname())
    throw new Error(
      "Benchmark ownership belongs to another host; reconcile it there",
    );
  if (value.boot && bootIdentity() && value.boot !== bootIdentity())
    return false;
  const start = processStart(value.pid);
  if (value.start && start) return value.start === start;
  try {
    process.kill(value.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
const claim = async (
  directory: string,
  name: string,
  value: BenchmarkOwner,
) => {
  const temporary = join(directory, `.owner-${value.token}-${name}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await atomicJson(join(temporary, "owner.json"), value);
    await rename(temporary, join(directory, name));
  } catch {
    throw new Error("Benchmark already has an execution or recovery owner");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
const claimRecovery = async (directory: string, value: BenchmarkOwner) => {
  try {
    await claim(directory, "benchmark-recovery.lock", value);
    return;
  } catch {
    const path = join(directory, "benchmark-recovery.lock");
    const prior = JSON.parse(
      await readFile(join(path, "owner.json"), "utf8"),
    ) as BenchmarkOwner;
    if (ownerAlive(prior))
      throw new Error("Benchmark already has a running recovery owner");
    if (!/^[a-f0-9-]{36}$/.test(prior.token))
      throw new Error("Unknown recovery ownership requires inspection");
    // Keep this nonempty tombstone. A delayed contender for the old token cannot
    // rename a newer live owner's directory over it after ownership changes.
    await rename(path, `${path}.stale-${prior.token}`);
    await claim(directory, "benchmark-recovery.lock", value);
  }
};
const publicPhase = (name: string): BenchmarkPhase => {
  if (name === "judge-sealing") return "evidence-sealing";
  if (name.startsWith("judge-"))
    return name === "judge-assessment"
      ? "judge-assessment"
      : "judge-preparation";
  if (name.includes("cleanup") || name.startsWith("remove-")) return "cleanup";
  if (name.startsWith("checker-") || name === "control-check") return "checks";
  if (name.includes("worktree") || name === "freeze-base")
    return "worktree-preparation";
  if (["setup", "preparation"].includes(name)) return "environment-readiness";
  if (name === "sealing") return "evidence-sealing";
  return name as BenchmarkPhase;
};

const records = async (directory: string, after = 0, limit = 0) => {
  let latest: RecordEntry | undefined;
  const events: BenchmarkEvent[] = [];
  const input = createReadStream(join(directory, "events.jsonl"), {
    encoding: "utf8",
  });
  // Only newline-terminated records are committed. A crash can leave a partial tail.
  let pending = "";
  let committedBytes = 0;
  for await (const chunk of input) {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      const record = JSON.parse(line) as RecordEntry;
      if (
        record.event.version !== 1 ||
        record.event.sequence !== (latest?.event.sequence ?? 0) + 1 ||
        record.snapshot.sequence !== record.event.sequence ||
        record.snapshot.runId !== record.event.runId ||
        record.execution.runId !== record.event.runId ||
        record.execution.planId !== record.event.planId ||
        (latest &&
          (latest.event.runId !== record.event.runId ||
            latest.event.planId !== record.event.planId))
      )
        throw new Error("Benchmark progress journal is inconsistent");
      latest = record;
      if (record.event.sequence > after && events.length < limit)
        events.push(record.event);
      committedBytes += Buffer.byteLength(line) + 1;
    }
  }
  if (!latest) throw new Error("Benchmark has no committed progress records");
  return { latest, events, committedBytes };
};

const readCancellation = async (
  directory: string,
  runId: string,
  ownerToken: string,
): Promise<BenchmarkCancellation | null> => {
  if (!/^[a-f0-9-]{36}$/.test(ownerToken))
    throw new Error("Unknown cancellation ownership requires inspection");
  try {
    const request = JSON.parse(
      await readFile(join(directory, `cancel-${ownerToken}.json`), "utf8"),
    ) as BenchmarkCancellation;
    if (
      request.version !== 1 ||
      request.runId !== runId ||
      request.ownerToken !== ownerToken ||
      typeof request.reason !== "string" ||
      !request.reason.trim() ||
      request.reason.length > 2048 ||
      !Number.isFinite(Date.parse(request.at))
    )
      throw new Error("Cancellation request does not match the active owner");
    return request;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const signalCancellationReason = (signal: AbortSignal) =>
  typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason.slice(0, 2048)
    : "Execution signal requested cancellation";
const ownerCancellation = async (
  directory: string,
  runId: string,
  ownerToken: string,
  now: () => number,
  signal?: AbortSignal,
) => {
  if (signal?.aborted)
    await onceJson(join(directory, `cancel-${ownerToken}.json`), {
      version: 1,
      runId,
      ownerToken,
      at: new Date(now()).toISOString(),
      reason: signalCancellationReason(signal),
    } satisfies BenchmarkCancellation);
  return readCancellation(directory, runId, ownerToken);
};

/** Passive reads never acquire execution ownership or dispatch worker work. */
export const readBenchmarkProgress = async (
  directory: string,
  options: { after?: number; limit?: number } = {},
) => {
  const after = options.after ?? 0;
  const limit = options.limit ?? 500;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error(
      "Progress cursor/limit must be nonnegative/positive integers; limit is at most 1000",
    );
  const { latest, events } = await records(directory, after, limit);
  if (after > latest.event.sequence)
    throw new Error("Progress cursor is ahead of this run");
  const controlOwner = latest.snapshot.recoveryOwner ?? latest.snapshot.owner;
  const request = controlOwner
    ? await readCancellation(directory, latest.event.runId, controlOwner.token)
    : null;
  const pendingCancellation =
    request?.ownerToken !== latest.snapshot.cancellation?.ownerToken
      ? request
      : null;
  if (
    !controlOwner &&
    latest.snapshot.attempts.some((attempt) => attempt.assessment)
  ) {
    const current = await readBenchmarkAssessments(directory);
    for (const attempt of latest.snapshot.attempts) {
      const assessment = current.assessments
        .filter((item) => item.attemptId === attempt.id)
        .at(-1);
      if (assessment && !assessment.applicable) {
        attempt.judge = "invalidated";
        if (attempt.assessment) {
          attempt.assessment.status = "invalidated";
          attempt.assessment.score = {
            ...attempt.assessment.score,
            value: null,
            coverage: 0,
            range: null,
          };
          attempt.assessment.failure = assessment.reason;
        }
      }
    }
    latest.snapshot.counts.graded = new Set(
      latest.snapshot.attempts
        .filter((attempt) => !attempt.retryOf && attempt.judge === "complete")
        .map((attempt) => attempt.slotId),
    ).size;
  }
  return {
    snapshot: latest.snapshot,
    pendingCancellation,
    events,
    cursor: events.at(-1)?.sequence ?? after,
    hasMore: after + events.length < latest.event.sequence,
  };
};
export type BenchmarkProgressRead = Awaited<
  ReturnType<typeof readBenchmarkProgress>
>;

/** Aborting this iterator disconnects only the observer. */
export async function* watchBenchmarkProgress(
  directory: string,
  options: { after?: number; signal?: AbortSignal } = {},
): AsyncGenerator<BenchmarkProgressRead, void> {
  let after = options.after ?? 0;
  while (!options.signal?.aborted) {
    const progress = await readBenchmarkProgress(directory, { after });
    if (progress.events.length || after === 0) yield progress;
    after = progress.cursor;
    if (
      !progress.hasMore &&
      !progress.snapshot.owner &&
      !progress.snapshot.recoveryOwner
    )
      return;
    if (progress.hasMore) continue;
    await new Promise<void>((accept) => {
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", done);
        accept();
      };
      const timer = setTimeout(done, 250);
      options.signal?.addEventListener("abort", done, { once: true });
      if (options.signal?.aborted) done();
    });
  }
}

/** Raw logs are an explicit private diagnostic, capped at 16 KiB per read. */
export const readBenchmarkLog = async (
  directory: string,
  attemptId: string,
  role: "implementation" | "checks" | "judge" = "implementation",
  bytes = 4096,
): Promise<string> => {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 16384)
    throw new Error("Private log tail must be between 1 and 16384 bytes");
  const { snapshot } = await readBenchmarkProgress(directory, { limit: 1 });
  const attempt = snapshot.attempts.find((item) => item.id === attemptId);
  if (!attempt || !/^ticket-\d+-arm-\d+-attempt-\d+$/.test(attempt.id))
    throw new Error("Unknown benchmark attempt");
  const evidenceId = attempt.retryOf ? attempt.id : attempt.slotId;
  const path =
    role === "judge" && attempt.assessment
      ? join(directory, "assessments", `${attempt.assessment.id}-judge.jsonl`)
      : join(
          directory,
          `${evidenceId}-${role === "checks" ? "check.log" : "implementation.jsonl"}`,
        );
  if (role === "judge" && !attempt.assessment)
    throw new Error("This attempt has no judge log");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const buffer = Buffer.alloc(Math.min(bytes, info.size));
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.length,
      Math.max(0, info.size - buffer.length),
    );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

export const resumeTicketBenchmark = async (
  directory: string,
  options: {
    maxNewSlots?: number;
    retryAttemptId?: string;
    rejudgeAssessmentId?: string;
    rejudgeReason?: string;
  } = {},
  dependencies: ImplementationBenchmarkDependencies = {},
) => {
  const plan = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as TicketBenchmarkPlan;
  if (plan.version !== 2 || resolve(plan.output) !== resolve(directory))
    throw new Error(
      "Recovery requires the original version-two benchmark directory and manifest",
    );
  const { runTicketBenchmark } = await import("./ticketBenchmark.js");
  return runTicketBenchmark(plan, undefined, options.maxNewSlots ?? Infinity, {
    ...dependencies,
    resume: true,
    retryAttemptId: options.retryAttemptId,
    rejudgeAssessmentId: options.rejudgeAssessmentId,
    rejudgeReason: options.rejudgeReason,
  });
};

/** An explicit control operation, separate from the passive observer. */
export const cancelBenchmark = async (
  directory: string,
  reason: string,
): Promise<BenchmarkCancellation> => {
  if (!reason.trim() || reason.length > 2048)
    throw new Error(
      "Cancellation requires a reason of at most 2048 characters",
    );
  const { snapshot } = await readBenchmarkProgress(directory);
  const controlOwner = snapshot.recoveryOwner ?? snapshot.owner;
  if (!controlOwner)
    throw new Error(
      "Benchmark has no active execution owner; inspect status before recovery",
    );
  const existing = await readCancellation(
    directory,
    snapshot.runId,
    controlOwner.token,
  );
  if (existing) return existing;
  const path = join(directory, `cancel-${controlOwner.token}.json`);
  const request: BenchmarkCancellation = {
    version: 1,
    runId: snapshot.runId,
    ownerToken: controlOwner.token,
    at: new Date().toISOString(),
    reason,
  };
  await onceJson(path, request);
  return (await readCancellation(
    directory,
    snapshot.runId,
    controlOwner.token,
  ))!;
};

interface BenchmarkProgressController {
  readonly signal: AbortSignal;
  publish(
    kind: string,
    phase?: string,
    attempt?: ImplementationAttempt,
  ): Promise<void>;
  activity(
    attempt: ImplementationAttempt,
    kind: string,
    role?: "implementation" | "judge",
  ): void;
  log(
    attempt: ImplementationAttempt,
    line: string,
    role?: "implementation" | "judge",
  ): void;
  ownResource(resource: BenchmarkResource): Promise<BenchmarkResource>;
  releaseResource(id: string): Promise<void>;
  /** Finalize exports against the settled snapshot while retaining the ownership lock. */
  close(beforeRelease?: () => Promise<void>): Promise<void>;
}
export const openBenchmarkProgress = async (
  plan: TicketBenchmarkPlan,
  execution: ImplementationExecution,
  options: {
    now: () => number;
    signal?: AbortSignal;
    resume?: boolean;
    retryAttemptId?: string;
    rejudgeAssessmentId?: string;
    rejudgeReason?: string;
    recoverResource?: ImplementationBenchmarkDependencies["recoverResource"];
    sealInterrupted?: (
      attempt: ImplementationAttempt,
      signal: AbortSignal,
    ) => Promise<void>;
    sealInterruptedJudge?: (
      attempt: ImplementationAttempt,
      signal: AbortSignal,
      commit: () => Promise<void>,
    ) => Promise<void>;
  },
): Promise<BenchmarkProgressController> => {
  await mkdir(plan.output, { recursive: true, mode: 0o700 });
  if (!options.resume && (await readdir(plan.output)).length) {
    if ((await readdir(plan.output)).includes("execution.json"))
      throw new Error(
        "An existing execution is retained; use explicit durable recovery with benchmark-resume",
      );
    throw new Error(
      "Benchmark output is not empty; select a fresh external directory",
    );
  }
  const ownership = owner();
  let previous: RecordEntry | undefined;
  if (options.resume) {
    await claimRecovery(plan.output, ownership);
    let reconciling = false;
    let retainRecoveryOwner = false;
    let recoveryRequest: BenchmarkCancellation | null = null;
    const recoveryCancellation = new AbortController();
    const recoverySignal = options.signal
      ? AbortSignal.any([options.signal, recoveryCancellation.signal])
      : recoveryCancellation.signal;
    let recoveryTimer: ReturnType<typeof setInterval> | undefined;
    let recoveryPoll: Promise<void> | undefined;
    const checkRecoveryCancellation = async () => {
      if (recoveryRequest) return;
      const request = await ownerCancellation(
        plan.output,
        execution.runId,
        ownership.token,
        options.now,
        options.signal,
      );
      if (request && !recoveryRequest) {
        recoveryRequest = request;
        execution.reason = request.reason;
        recoveryCancellation.abort(request.reason);
      }
    };
    const checkpoint = async (kind: string, finished = false) => {
      const at = new Date(options.now()).toISOString();
      execution.budget.elapsedMs = Math.max(
        execution.budget.elapsedMs,
        options.now() - Date.parse(execution.startedAt),
      );
      const saved = structuredClone(execution);
      const event: BenchmarkEvent = {
        ...previous!.event,
        sequence: previous!.event.sequence + 1,
        at,
        kind,
        phase: "cleanup",
        attemptId: null,
        slotId: null,
        armId: null,
      };
      const record: RecordEntry = {
        event,
        execution: saved,
        snapshot: {
          ...previous!.snapshot,
          ...executionView(plan, saved),
          sequence: event.sequence,
          at,
          status: saved.status,
          phase: "cleanup",
          controllerHeartbeat: at,
          owner:
            kind === "recovery-finished" ? ownership : previous!.snapshot.owner,
          recoveryOwner: finished ? null : ownership,
          cancellation: recoveryRequest ?? previous!.snapshot.cancellation,
        },
      };
      await commitRecord(plan.output, record);
      previous = record;
    };
    try {
      const manifest = JSON.parse(
        await readFile(join(plan.output, "manifest.json"), "utf8"),
      );
      if (JSON.stringify(manifest) !== JSON.stringify(plan))
        throw new Error("Frozen benchmark manifest changed");
      const { latest, committedBytes } = await records(plan.output);
      previous = latest;
      if (previous.execution.planId !== plan.id)
        throw new Error("Progress belongs to another frozen plan");
      if (options.rejudgeAssessmentId) {
        if (options.retryAttemptId || !options.rejudgeReason?.trim())
          throw new Error(
            "Rejudging requires a reason and cannot retry implementation",
          );
        const target = previous.execution.attempts.find((attempt) =>
          attempt.judge.assessments?.some(
            (assessment) => assessment.id === options.rejudgeAssessmentId,
          ),
        );
        if (!target?.candidate)
          throw new Error(
            "Rejudging must name an existing candidate assessment",
          );
      }
      if (options.retryAttemptId) {
        const target = previous.execution.attempts.find(
          (attempt) => attempt.id === options.retryAttemptId,
        );
        if (
          previous.execution.attempts.some(
            (attempt) => attempt.retryOf === options.retryAttemptId,
          )
        )
          throw new Error(
            "This attempt was already retried; name its interrupted successor for another explicit retry",
          );
        if (
          !target ||
          (target.finishedAt &&
            ![
              "interrupted",
              "cancelled",
              "timed-out",
              "environment-unavailable",
              "worker-failed",
              "seal-failed",
              "no-candidate",
              "check-failed",
              "cleanup-failed",
              "scope-violation",
              "identity-mismatch",
            ].includes(target.status))
        )
          throw new Error(
            "Explicit retry must name an interrupted or failed attempt",
          );
      }
      let locked: BenchmarkOwner | null = null;
      try {
        locked = JSON.parse(
          await readFile(
            join(plan.output, "benchmark.lock", "owner.json"),
            "utf8",
          ),
        ) as BenchmarkOwner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        [locked, previous.snapshot.owner].some(
          (value) => value && ownerAlive(value),
        )
      )
        throw new Error("Original benchmark owner is still running");
      const priorCancellation = previous.snapshot.owner
        ? await readCancellation(
            plan.output,
            previous.event.runId,
            previous.snapshot.owner.token,
          )
        : null;
      if (priorCancellation) previous.snapshot.cancellation = priorCancellation;
      Object.assign(execution, structuredClone(previous.execution));
      await truncate(join(plan.output, "events.jsonl"), committedBytes);
      reconciling = true;
      execution.status = "recovering";
      await checkpoint("recovery-started");
      await checkRecoveryCancellation();
      recoverySignal.throwIfAborted();
      recoveryTimer = setInterval(() => {
        if (recoveryPoll) return;
        recoveryPoll = checkRecoveryCancellation()
          .catch((error) => {
            recoveryCancellation.abort(error);
          })
          .finally(() => {
            recoveryPoll = undefined;
          });
      }, 100);
      recoveryTimer.unref();
      const cleanupStarted = Date.now();
      const signal = AbortSignal.any([
        AbortSignal.timeout(plan.launch!.allowances.cleanupMs),
        recoverySignal,
      ]);
      for (const resource of execution.resources
        .filter(
          (item) => item.status !== "released" && item.kind !== "directory",
        )
        .reverse()) {
        await boundedRecovery(
          () =>
            (
              options.recoverResource ??
              ((item, runId, signal) =>
                reconcileBenchmarkDocker(item, runId, signal))
            )(resource, execution.runId, signal),
          signal,
          plan.launch!.allowances.cleanupMs,
        );
        signal.throwIfAborted();
        resource.status = "released";
        await checkpoint("resource-reconciled");
      }
      const cleanupRemainingMs =
        plan.launch!.allowances.cleanupMs - (Date.now() - cleanupStarted);
      const captureSignal = AbortSignal.any([
        AbortSignal.timeout(plan.launch!.allowances.sealMs),
        recoverySignal,
      ]);
      for (const attempt of execution.attempts.filter(
        (attempt) =>
          attempt.implementation &&
          !attempt.candidate &&
          execution.resources.some(
            (resource) =>
              resource.kind === "directory" &&
              resource.attemptId === attempt.id &&
              resource.status !== "released",
          ),
      )) {
        if (options.sealInterrupted)
          await boundedRecovery(
            () => options.sealInterrupted!(attempt, captureSignal),
            captureSignal,
            plan.launch!.allowances.cleanupMs,
          );
        await checkpoint("interrupted-evidence-sealed");
      }
      for (const attempt of execution.attempts.filter(
        (attempt) => attempt.judge.assessments?.length,
      )) {
        if (options.sealInterruptedJudge)
          await boundedRecovery(
            () =>
              options.sealInterruptedJudge!(attempt, captureSignal, () =>
                checkpoint("judge-finalized"),
              ),
            captureSignal,
            plan.launch!.allowances.cleanupMs,
          );
        await checkpoint("interrupted-judge-sealed");
      }
      const directorySignal = AbortSignal.any([
        AbortSignal.timeout(Math.max(1, cleanupRemainingMs)),
        recoverySignal,
      ]);
      for (const resource of execution.resources
        .filter(
          (item) => item.status !== "released" && item.kind === "directory",
        )
        .reverse()) {
        if (cleanupRemainingMs <= 0)
          throw new Error("Owned recovery exceeded its bounded allowance");
        const path = relative(plan.output, resource.id);
        if (
          isAbsolute(path) ||
          !(path === "protected" || path.startsWith("runtime/"))
        )
          throw new Error(
            "Retained directory is outside this benchmark's disposable resources",
          );
        // Parent links must not turn owned cleanup into deletion outside the run.
        const parent = resolve(resource.id, "..");
        try {
          const actual = relative(
            await realpath(plan.output),
            await realpath(parent),
          );
          if (isAbsolute(actual) || actual === ".." || actual.startsWith("../"))
            throw new Error(
              "Owned resource parent escaped the benchmark directory",
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await boundedRecovery(
          async () => {
            await rm(resource.id, { recursive: true, force: true });
            try {
              await lstat(resource.id);
              throw new Error("Owned directory removal was not verified");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          },
          directorySignal,
          plan.launch!.allowances.cleanupMs,
        );
        directorySignal.throwIfAborted();
        resource.status = "released";
        await checkpoint("resource-reconciled");
      }
      await checkRecoveryCancellation();
      recoverySignal.throwIfAborted();
      for (const attempt of execution.attempts) {
        if (!attempt.finishedAt) {
          attempt.status = priorCancellation ? "cancelled" : "interrupted";
          attempt.reason =
            priorCancellation?.reason ??
            "Controller stopped before this attempt was durably finished; completed invocations will not be replayed";
          attempt.finishedAt = new Date(options.now()).toISOString();
        }
        attempt.cleanup = { status: "passed", resources: [] };
      }
      if (
        execution.controls.results.some(
          (result) =>
            result.status === "running" || result.status === "unavailable",
        )
      ) {
        for (const result of execution.controls.results.filter(
          (result) => result.status === "running",
        ))
          result.status = "unavailable";
        execution.controls.status = "unavailable";
      }
      execution.cleanup = { status: "passed", resources: [] };
      execution.budget.activeReservedMs = 0;
      execution.budget.judgeReservedMs =
        execution.attempts.filter(
          (attempt) => attempt.candidate && attempt.judge.status === "pending",
        ).length * judgeReservationMs(plan);
      execution.budget.judgeReservedCalls = execution.attempts.filter(
        (attempt) => attempt.candidate && attempt.judge.status === "pending",
      ).length;
      execution.budget.cleanupReservedMs = plan.launch!.allowances.cleanupMs;
      execution.status = "recovered";
      await checkpoint("recovery-finished", true);
      await rm(join(plan.output, "benchmark.lock"), {
        recursive: true,
        force: true,
      });
      await claim(plan.output, "benchmark.lock", ownership);
    } catch (error) {
      retainRecoveryOwner = Boolean(
        (error as { unsettled?: boolean })?.unsettled,
      );
      if (reconciling) {
        await checkRecoveryCancellation();
        execution.status = recoveryRequest ? "cancelled" : "recovery-required";
        execution.reason = recoveryRequest
          ? (recoveryRequest as BenchmarkCancellation).reason
          : "Resource reconciliation or interrupted candidate capture failed; no replacement execution was dispatched";
        if (recoveryRequest) await checkpoint("cancellation-requested");
        await checkpoint("recovery-stopped", !retainRecoveryOwner);
      }
      throw error;
    } finally {
      if (recoveryTimer) clearInterval(recoveryTimer);
      await recoveryPoll;
      if (!retainRecoveryOwner)
        await rm(join(plan.output, "benchmark-recovery.lock"), {
          recursive: true,
          force: true,
        });
    }
  } else {
    await claim(plan.output, "benchmark.lock", ownership);
    execution.runId = randomUUID();
  }
  let sequence = previous?.event.sequence ?? 0;
  let currentPhase: BenchmarkPhase = previous?.snapshot.phase ?? "preflight";
  let heartbeat = new Date(options.now()).toISOString();
  let lastImplementationEvent: BenchmarkEvent | null =
    previous?.snapshot.lastImplementationEvent ?? null;
  let lastJudgeEvent: BenchmarkEvent | null =
    previous?.snapshot.lastJudgeEvent ?? null;
  let activeAttempt: ImplementationAttempt | undefined;
  let released = false;
  let cancellationRequest: BenchmarkCancellation | null =
    previous?.snapshot.cancellation ?? null;
  let cancellationHandled = false;
  const cancellation = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, cancellation.signal])
    : cancellation.signal;
  let queue = Promise.resolve();
  let failure: unknown;
  const publish = (
    kind: string,
    phase?: string,
    attempt?: ImplementationAttempt,
  ) => {
    execution.budget.elapsedMs = Math.max(
      execution.budget.elapsedMs,
      options.now() - Date.parse(execution.startedAt),
    );
    if (phase) currentPhase = publicPhase(phase);
    activeAttempt =
      attempt ??
      [...execution.attempts].reverse().find((item) => !item.finishedAt);
    const at = new Date(options.now()).toISOString();
    const event: BenchmarkEvent = {
      version: 1,
      runId: execution.runId,
      planId: plan.id,
      sequence: ++sequence,
      at,
      kind,
      phase: currentPhase,
      attemptId: activeAttempt?.id ?? null,
      slotId: activeAttempt?.slotId ?? null,
      armId: activeAttempt?.armId ?? null,
    };
    if (kind === "heartbeat" || sequence === 1) heartbeat = at;
    if (kind.startsWith("implementation-"))
      lastImplementationEvent = {
        ...event,
        kind: kind.slice("implementation-".length),
      };
    if (kind.startsWith("judge-")) lastJudgeEvent = event;
    const saved = structuredClone(execution);
    const snapshot: BenchmarkSnapshot = {
      version: 1,
      runId: saved.runId,
      planId: saved.planId,
      sequence,
      at,
      startedAt: saved.startedAt,
      status: saved.status,
      phase: currentPhase,
      controllerHeartbeat: heartbeat,
      lastImplementationEvent,
      lastJudgeEvent,
      owner: released ? null : ownership,
      recoveryOwner: null,
      cancellation: cancellationRequest,
      ...executionView(plan, saved),
      recovery: released
        ? "Use benchmark-resume with the unchanged manifest and remaining allowance. Explicit retries must name an interrupted attempt."
        : "Execution belongs to the recorded owner. Observers may disconnect; do not start a replacement owner.",
    };
    const record: RecordEntry = { event, snapshot, execution: saved };
    queue = queue.then(async () => {
      if (failure) throw failure;
      await commitRecord(plan.output, record);
    });
    // Always observe asynchronous failures, including events emitted by synchronous streams.
    void queue.catch((error) => {
      failure = error;
      cancellation.abort(error);
    });
    return queue;
  };
  const checkCancellation = async () => {
    if (cancellationHandled) return;
    try {
      const request = await ownerCancellation(
        plan.output,
        execution.runId,
        ownership.token,
        options.now,
        options.signal,
      );
      if (cancellationHandled || !request) return;
      cancellationRequest = request;
      cancellationHandled = true;
      execution.reason = request.reason;
      await publish("cancellation-requested");
      cancellation.abort(request.reason);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  let checking = false;
  const poll = async () => {
    if (checking) return;
    checking = true;
    try {
      await checkCancellation();
    } catch (error) {
      failure = error;
      cancellation.abort(error);
    } finally {
      checking = false;
    }
  };
  const cancellationTimer = setInterval(() => {
    void poll();
  }, 100);
  cancellationTimer.unref();
  const timer = setInterval(() => {
    void publish("heartbeat");
  }, 2000);
  timer.unref();
  return {
    signal,
    publish: async (
      kind: string,
      phase?: string,
      attempt?: ImplementationAttempt,
    ) => {
      await checkCancellation();
      await publish(kind, phase, attempt);
    },
    activity: (
      attempt: ImplementationAttempt,
      kind: string,
      role = "implementation",
    ) => {
      void publish(
        `${role}-${kind}`,
        role === "judge" ? "judge-assessment" : "implementation",
        attempt,
      );
    },
    log: (
      attempt: ImplementationAttempt,
      line: string,
      role = "implementation",
    ) => {
      const evidenceId = attempt.retryOf ? attempt.id : attempt.slotId;
      queue = queue.then(() =>
        appendFile(
          role === "judge"
            ? attempt.judge.assessments!.at(-1)!.provenance.stream
            : join(plan.output, `${evidenceId}-implementation.jsonl`),
          `${line}\n`,
          { mode: 0o600 },
        ),
      );
      void queue.catch((error) => {
        failure = error;
        cancellation.abort(error);
      });
    },
    ownResource: async (resource: BenchmarkResource) => {
      const existing = execution.resources.find(
        (item) => item.id === resource.id,
      );
      if (existing) Object.assign(existing, resource);
      else execution.resources.push(resource);
      await publish("resource-owned");
      return existing ?? resource;
    },
    releaseResource: async (id: string) => {
      for (const resource of execution.resources.filter(
        (item) => item.id === id,
      ))
        resource.status = "released";
      await publish("resource-released");
    },
    close: async (beforeRelease) => {
      clearInterval(timer);
      clearInterval(cancellationTimer);
      await checkCancellation();
      released =
        execution.cleanup.status === "passed" &&
        execution.attempts.every(
          (attempt) => attempt.cleanup.status === "passed",
        ) &&
        execution.resources.every((resource) => resource.status === "released");
      await publish(released ? "owner-released" : "owner-retained", "idle");
      try {
        await beforeRelease?.();
      } finally {
        if (released)
          await rm(join(plan.output, "benchmark.lock"), { recursive: true });
      }
    },
  };
};
