import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path";
import {
  codex,
  type CodexOptions,
  type IterationUsage,
} from "./AgentProvider.js";
import type { ExecResult } from "./SandboxProvider.js";
import type { TicketBenchmarkPlan } from "./ticketBenchmark.js";
import { protectedBenchmarkPath } from "./benchmarkLaunch.js";
import {
  privateWorktree,
  seal,
  workspaceFiles,
  workspaceFingerprint,
  verifyBenchmarkCandidate,
  type Candidate,
} from "./benchmarkCandidate.js";
import {
  createBenchmarkRuntime,
  benchmarkCredentialRedactor,
  reconcileBenchmarkDocker,
} from "./implementationBenchmarkRuntime.js";
import {
  createBenchmarkProjectRuntime,
  recoverBenchmarkProjectRuntime,
  serveBenchmarkProjectInspection,
  type OwnedBenchmarkProjectRuntime,
  type BenchmarkProjectEvidence,
} from "./benchmarkProjectRuntime.js";
import {
  openBenchmarkProgress,
  type BenchmarkResource,
} from "./benchmarkProgress.js";
import {
  assessJudgeOutput,
  judgePrompt,
  judgeProtocolId,
  judgeReservationMs,
  failJudgeAssessment,
  sealJudgeAssessment,
  readBenchmarkAssessments,
  type BenchmarkJudgeState,
  type JudgeAssessment,
} from "./benchmarkJudge.js";
import { writeImplementationBenchmarkReport } from "./implementationBenchmarkReport.js";
import { prepareBenchmarkInstructions } from "./benchmarkInstructions.js";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const save = async (path: string, value: unknown) => {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export interface BenchmarkRuntimeRequest {
  readonly id: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly plan: TicketBenchmarkPlan;
  readonly root: string;
  readonly worktree: string;
  readonly role: "implementation" | "checks" | "control" | "judge";
  readonly signal: AbortSignal;
}
export interface BenchmarkRuntime {
  readonly id: string;
  exec(request: {
    command: string;
    stdin?: string;
    signal: AbortSignal;
    onLine?: (line: string) => void;
  }): Promise<ExecResult>;
  stop(signal: AbortSignal): Promise<void>;
  redact?(text: string): string;
}
export interface ImplementationBenchmarkDependencies {
  readonly createRuntime?: (
    request: BenchmarkRuntimeRequest,
  ) => Promise<BenchmarkRuntime>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly resume?: boolean;
  readonly retryAttemptId?: string;
  readonly rejudgeAssessmentId?: string;
  readonly rejudgeReason?: string;
  /** Stop the exact recorded resource and verify its absence before returning. */
  readonly recoverResource?: (
    resource: BenchmarkResource,
    runId: string,
    signal: AbortSignal,
  ) => Promise<void>;
}
export interface ImplementationAttempt {
  id: string;
  armId: string;
  retryOf?: string;
  slotId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  /** Full attempt settlement, including independent judging and owned cleanup. */
  settledAt?: string;
  reason?: string;
  implementation?: {
    exitCode: number | null;
    usage: IterationUsage | null;
    streamSha256: string | null;
    requested: unknown;
    observed:
      | readonly {
          model: string;
          effort: string | null;
          serviceTier: string | null;
        }[]
      | null;
    sessions?: readonly { path: string; sha256: string }[];
  };
  phases: {
    name: string;
    limitMs: number;
    elapsedMs: number;
    outcome: string;
  }[];
  resources: string[];
  check?: {
    status: "passed" | "failed" | "not-run" | "unavailable";
    exitCode?: number;
    outputSha256?: string;
    candidateHead?: string;
    candidateTree?: string;
    frozenInputsSha256?: string;
    failure?: string;
  };
  candidate?: Candidate;
  project?: BenchmarkProjectEvidence;
  cleanup: { status: "passed" | "failed"; resources: string[] };
  judge: BenchmarkJudgeState;
}
type Attempt = ImplementationAttempt;

export interface ImplementationExecution {
  version: 2;
  runId: string;
  planId: string;
  startedAt: string;
  status: string;
  budget: {
    limitMs: number;
    elapsedMs: number;
    judgeReservedMs: number;
    cleanupReservedMs: number;
    activeReservedMs: number;
    maxCalls: number;
    implementationCalls: number;
    judgeCalls: number;
    judgeReservedCalls: number;
  };
  controls: {
    status: string;
    results: {
      kind: string;
      commit: string;
      exitCode: number | null;
      status: string;
      outputSha256: string | null;
      phases: Attempt["phases"];
    }[];
  };
  attempts: Attempt[];
  unrun: string[];
  phases: Attempt["phases"];
  resources: BenchmarkResource[];
  cleanup: { status: "passed" | "failed"; resources: string[] };
  reason: string | null;
  blockers: readonly string[];
}

const captureSessions = async (
  root: string,
  output: string,
  slotId: string,
  redact: (text: string) => string,
  signal: AbortSignal,
  role = "implementation",
) => {
  const source = join(root, role, "home", ".codex", "sessions");
  const sessions: { path: string; sha256: string }[] = [];
  const observed: {
    model: string;
    effort: string | null;
    serviceTier: string | null;
  }[] = [];
  try {
    if (!isWithin(root, await realpath(source)))
      throw new Error("Session storage escaped its owned runtime");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { sessions, observed: null };
    throw error;
  }
  let bytes = 0;
  for (const path of await workspaceFiles(source, "", undefined, signal)) {
    if (!path.endsWith(".jsonl")) continue;
    const file = join(source, path);
    const info = await lstat(file);
    bytes += info.size;
    if (!info.isFile() || bytes > 32 * 1024 * 1024)
      throw new Error("Session evidence exceeds its owned capture policy");
    const text = redact(await readFile(file, { encoding: "utf8", signal }));
    const target = join(output, "sessions", slotId, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600, signal });
    sessions.push({ path: target, sha256: hash(text) });
    for (const line of text.split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (
          entry.type === "turn_context" &&
          typeof entry.payload?.model === "string"
        ) {
          const identity = {
            model: entry.payload.model,
            effort:
              typeof entry.payload.effort === "string"
                ? entry.payload.effort
                : null,
            serviceTier:
              typeof entry.payload.service_tier === "string"
                ? entry.payload.service_tier
                : null,
          };
          if (
            !observed.some(
              (item) => JSON.stringify(item) === JSON.stringify(identity),
            )
          )
            observed.push(identity);
        }
      } catch {
        /* Retain malformed records as evidence without inventing an identity. */
      }
    }
  }
  return { sessions, observed: observed.length ? observed : null };
};

class PhaseFailure extends Error {
  constructor(
    readonly outcome:
      | "timed-out"
      | "cancelled"
      | "environment-unavailable"
      | "worker-failed"
      | "seal-failed",
    message: string,
  ) {
    super(message);
  }
}
const isWithin = (parent: string, child: string) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
  );
};
const assertExternalOutput = async (plan: TicketBenchmarkPlan) => {
  let parent = plan.output;
  const suffix: string[] = [];
  while (true) {
    try {
      const actual = resolve(await realpath(parent), ...suffix);
      if (isWithin(await realpath(plan.cwd), actual))
        throw new Error("Benchmark output resolves inside the host project");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(parent.slice(dirname(parent).length + 1));
      parent = dirname(parent);
    }
  }
};
const validatePlan = async (plan: TicketBenchmarkPlan) => {
  const { id, output: _output, ...frozen } = plan;
  if (hash(JSON.stringify(frozen)) !== id)
    throw new Error("Frozen implementation plan changed");
  const launch = plan.launch;
  if (!launch?.checking || !plan.judge || plan.readiness?.mode !== "preflight")
    throw new Error(
      "Implementation execution requires successful worker preflight",
    );
  const runnerRoot = resolve(import.meta.dirname, "..");
  for (const file of launch.runner.files) {
    if (hash(await readFile(join(runnerRoot, file.path))) !== file.sha256)
      throw new Error("Frozen runner changed after planning");
  }
  for (const file of [
    ...launch.instructions,
    ...launch.dependencies,
    ...launch.checking.files,
    ...launch.grading.references,
    ...(launch.adapter.module ? [launch.adapter.module] : []),
  ]) {
    if (
      hash(file.base64 ? Buffer.from(file.base64, "base64") : file.text) !==
      file.sha256
    )
      throw new Error("Frozen file bytes changed");
  }
  await assertExternalOutput(plan);
};
const restoreChecks = async (plan: TicketBenchmarkPlan, worktree: string) => {
  const frozenPaths = new Set(
    plan.launch!.checking.files.map((file) => file.path),
  );
  for (const path of await workspaceFiles(worktree)) {
    if (protectedBenchmarkPath(path, plan.check) && !frozenPaths.has(path))
      await rm(join(worktree, path), { force: true });
  }
  for (const file of plan.launch!.checking.files) {
    const path = join(worktree, file.path);
    if (!isWithin(worktree, path) || file.path.split("/").includes(".git"))
      throw new Error("Unsafe frozen grading path");
    let parent = dirname(path);
    while (parent !== worktree) {
      try {
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error(
            "Candidate replaced a grading directory with a symlink",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      parent = dirname(parent);
    }
    await rm(path, { recursive: true, force: true });
    await mkdir(dirname(path), { recursive: true });
    if (file.mode === "120000") {
      const target = relative(worktree, resolve(dirname(path), file.text));
      if (isAbsolute(file.text) || target === ".." || target.startsWith("../"))
        throw new Error("Frozen grading symlink escapes its worktree");
      await symlink(file.text, path);
    } else
      await writeFile(
        path,
        file.base64 ? Buffer.from(file.base64, "base64") : file.text,
        { mode: file.mode === "100755" ? 0o755 : 0o644 },
      );
  }
};

const verifyChecks = async (
  plan: TicketBenchmarkPlan,
  worktree: string,
  signal: AbortSignal,
  ignoredAt: string,
  expected: Awaited<ReturnType<typeof workspaceFingerprint>>,
) => {
  for (const file of plan.launch!.checking.files) {
    signal.throwIfAborted();
    const path = join(worktree, file.path);
    try {
      if (!isWithin(worktree, await realpath(dirname(path))))
        throw new Error("Grading directory escaped its worktree");
      const info = await lstat(path);
      const bytes =
        file.mode === "120000"
          ? info.isSymbolicLink()
            ? Buffer.from(await readlink(path))
            : null
          : info.isFile()
            ? await readFile(path, { signal })
            : null;
      if (
        !bytes ||
        hash(bytes) !== file.sha256 ||
        (file.mode !== "120000" &&
          Boolean(info.mode & 0o100) !== (file.mode === "100755"))
      )
        throw new Error("Frozen grading bytes or mode changed");
    } catch {
      signal.throwIfAborted();
      throw new PhaseFailure(
        "environment-unavailable",
        `Protected grading inputs changed: ${file.path}`,
      );
    }
  }
  const actual = await workspaceFingerprint(
    worktree,
    ignoredAt,
    signal,
    expected.paths,
  );
  if (actual.sha256 !== expected.sha256)
    throw new PhaseFailure(
      "environment-unavailable",
      "Checked candidate changed during preparation or checking",
    );
};

export const runImplementationBenchmark = async (
  plan: TicketBenchmarkPlan,
  maxNewSlots: number,
  dependencies: ImplementationBenchmarkDependencies = {},
) => {
  if (
    maxNewSlots !== Infinity &&
    (!Number.isSafeInteger(maxNewSlots) || maxNewSlots < 1)
  )
    throw new Error("--max-new-slots must be a positive integer");
  await validatePlan(plan);
  const launch = plan.launch!;
  const allowances = launch.allowances;
  const now = dependencies.now ?? Date.now;
  let started = now();
  const create = dependencies.createRuntime ?? createBenchmarkRuntime;
  let attempts: Attempt[] = [];
  const ledger: ImplementationExecution = {
    version: 2,
    runId: "",
    planId: plan.id,
    startedAt: new Date(started).toISOString(),
    status: "running",
    budget: {
      limitMs: allowances.overallMs,
      elapsedMs: 0,
      judgeReservedMs: 0,
      cleanupReservedMs: allowances.cleanupMs,
      activeReservedMs: 0,
      maxCalls: allowances.maxCalls,
      implementationCalls: 0,
      judgeCalls: 0,
      judgeReservedCalls: 0,
    },
    controls: {
      status: launch.checking.controls.length ? "pending" : "absent",
      results: [],
    },
    attempts,
    unrun: plan.slots.map((slot) => slot.id),
    phases: [] as Attempt["phases"],
    resources: [],
    cleanup: { status: "passed", resources: [] as string[] },
    reason: null as string | null,
    blockers: plan.readiness?.blockers ?? [],
  };
  if (dependencies.retryAttemptId && !dependencies.resume)
    throw new Error(
      "Explicit retries require durable recovery of an existing attempt",
    );
  if (dependencies.rejudgeAssessmentId && !dependencies.resume)
    throw new Error(
      "Explicit rejudging requires durable recovery of the original frozen run",
    );
  const progress = await openBenchmarkProgress(plan, ledger, {
    now,
    signal: dependencies.signal,
    resume: dependencies.resume,
    retryAttemptId: dependencies.retryAttemptId,
    rejudgeAssessmentId: dependencies.rejudgeAssessmentId,
    rejudgeReason: dependencies.rejudgeReason,
    recoverResource: (resource, runId, signal) =>
      resource.kind === "project-runtime"
        ? recoverBenchmarkProjectRuntime(plan, resource, runId, signal)
        : (dependencies.recoverResource ?? reconcileBenchmarkDocker)(
            resource,
            runId,
            signal,
          ),
    sealInterrupted: async (attempt, signal) => {
      const root = join(plan.output, "runtime", attempt.id);
      const redact = benchmarkCredentialRedactor([
        join(root, "controller-auth", "auth.json"),
        join(root, "implementation", "home", ".codex", "auth.json"),
      ]);
      const evidenceId = `${attempt.id}-recovered-${randomUUID()}`;
      const sessions = await captureSessions(
        root,
        plan.output,
        evidenceId,
        redact,
        signal,
      );
      Object.assign(attempt.implementation!, sessions);
      attempt.candidate = await seal(
        plan,
        evidenceId,
        join(root, "implementation", "worktree"),
        join(plan.output, "protected", "storage.git"),
        redact,
        signal,
      );
      if (attempt.candidate) attempt.judge.status = "pending";
    },
    sealInterruptedJudge: async (attempt, signal, commit) => {
      const assessment = attempt.judge.assessments?.at(-1);
      if (!assessment) return;
      if (assessment.finishedAt && assessment.status !== "running") {
        await sealJudgeAssessment(plan, attempt, assessment, commit);
        attempt.judge.status = assessment.status;
        return;
      }
      const root = join(plan.output, "runtime", `judge-${assessment.id}`);
      const redact = benchmarkCredentialRedactor([
        join(root, "controller-auth", "auth.json"),
        join(root, "judge", "home", ".codex", "auth.json"),
      ]);
      const captured = await captureSessions(
        root,
        plan.output,
        assessment.id,
        redact,
        signal,
        "judge",
      );
      assessment.provenance.sessions = captured.sessions;
      assessment.judge.observed = captured.observed;
      let stream = "";
      try {
        stream = await readFile(assessment.provenance.stream, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const provider = codex(plan.judge!.model);
      for (const line of stream.split("\n"))
        for (const event of provider.parseStreamLine(line)) {
          if (event.type === "usage") assessment.usage = event.usage;
          if (event.type === "session_id")
            assessment.provenance.sessionId = event.sessionId;
        }
      assessment.provenance.streamSha256 = hash(stream);
      await mkdir(dirname(assessment.provenance.stream), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(assessment.provenance.stream, stream, { mode: 0o600 });
      failJudgeAssessment(
        assessment,
        "Controller stopped during judging; this call is not replayed",
      );
      assessment.finishedAt = new Date(now()).toISOString();
      attempt.judge.status = "incomplete";
      await sealJudgeAssessment(plan, attempt, assessment, commit);
    },
  });
  attempts = ledger.attempts;
  started = Date.parse(ledger.startedAt);
  const signal = progress.signal;
  let judgingAttempt: Attempt | undefined;
  const persist = async (kind = "checkpoint", phase?: string) => {
    ledger.budget.elapsedMs = Math.max(
      ledger.budget.elapsedMs,
      0,
      now() - started,
    );
    await progress.publish(kind, phase, judgingAttempt);
  };
  const remaining = () =>
    allowances.overallMs -
    Math.max(ledger.budget.elapsedMs, 0, now() - started) -
    ledger.budget.judgeReservedMs -
    ledger.budget.cleanupReservedMs;
  const phase = async <T>(
    name: string,
    limitMs: number,
    phases: Attempt["phases"],
    operation: (signal: AbortSignal, remainingMs: number) => Promise<T>,
    cleanup = false,
  ): Promise<T> => {
    const group = (phaseName: string) =>
      phaseName === "judge-sealing"
        ? "judge-sealing"
        : phaseName.startsWith("judge-") || phaseName === "assessment-complete"
          ? "judge"
          : phaseName.startsWith("checker-") ||
              phaseName === "checks" ||
              phaseName === "control-check"
            ? "checks"
            : ["setup", "preparation", "worktree"].includes(phaseName)
              ? "setup"
              : phaseName.includes("cleanup") ||
                  phaseName === "remove-owned-runtime"
                ? "cleanup"
                : phaseName;
    const groupLimit =
      group(name) === "checks"
        ? allowances.checksMs
        : group(name) === "judge"
          ? allowances.judgeMs
          : limitMs;
    const spent = phases
      .filter((item) => group(item.name) === group(name))
      .reduce((total, item) => total + item.elapsedMs, 0);
    const admittedMs = Math.min(
      groupLimit - spent,
      cleanup ? groupLimit - spent : remaining(),
    );
    if (admittedMs <= 0)
      throw new PhaseFailure("timed-out", `${name} has no remaining allowance`);
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new PhaseFailure("timed-out", `${name} timed out`)),
      admittedMs,
    );
    const signal = cleanup
      ? controller.signal
      : AbortSignal.any([controller.signal, progress.signal]);
    const begin = now();
    let outcome = "passed";
    ledger.budget.activeReservedMs = admittedMs;
    let abort: (() => void) | undefined;
    let pending: Promise<T> | undefined;
    try {
      await persist("phase-started", name);
      if (signal.aborted)
        throw new PhaseFailure(
          progress.signal.aborted && !cleanup ? "cancelled" : "timed-out",
          `${name} interrupted`,
        );
      const interrupted = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            new PhaseFailure(
              progress.signal.aborted && !cleanup ? "cancelled" : "timed-out",
              `${name} interrupted`,
            ),
          );
        signal.addEventListener("abort", abort, { once: true });
      });
      pending = operation(signal, Math.max(0, admittedMs - (now() - begin)));
      const result = await Promise.race([pending, interrupted]);
      if (now() - begin > admittedMs)
        throw new PhaseFailure("timed-out", `${name} exceeded its allowance`);
      return result;
    } catch (error) {
      if (pending && signal.aborted) {
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          pending.then(
            () => ({ settled: true, failure: null }),
            (failure: unknown) => ({ settled: true, failure }),
          ),
          new Promise<{ settled: false; failure: null }>((accept) => {
            drainTimer = setTimeout(
              () => accept({ settled: false, failure: null }),
              allowances.cleanupMs,
            );
          }),
        ]);
        if (drainTimer) clearTimeout(drainTimer);
        if (!settled.settled && error && typeof error === "object")
          Object.assign(error, { unsettled: true });
        const resources = (settled.failure as { resources?: string[] } | null)
          ?.resources;
        if (resources?.length && error && typeof error === "object")
          Object.assign(error, { resources });
      }
      outcome = error instanceof PhaseFailure ? error.outcome : "failed";
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      phases.push({
        name,
        limitMs: admittedMs,
        elapsedMs: Math.max(0, now() - begin),
        outcome,
      });
      ledger.budget.activeReservedMs = 0;
      await persist("phase-finished", name);
    }
  };
  let protectedBase: Awaited<ReturnType<typeof privateWorktree>> | undefined;
  const runtimeResources = new Map<BenchmarkRuntime, BenchmarkResource>();
  const setup = async (
    request: Omit<
      BenchmarkRuntimeRequest,
      "signal" | "id" | "runId" | "attemptId"
    >,
    phases: Attempt["phases"],
    attempt?: Attempt,
  ): Promise<BenchmarkRuntime> => {
    const attemptId =
      attempt?.id ??
      [...attempts].reverse().find((attempt) => !attempt.finishedAt)?.id ??
      null;
    const id = `sandcastle-benchmark-${ledger.runId.slice(0, 8)}-${randomUUID()}`;
    const resource = await progress.ownResource({
      id,
      kind: dependencies.createRuntime ? "runtime" : "docker",
      attemptId,
      status: "owned",
    });
    try {
      return await phase(
        request.role === "judge"
          ? "judge-preparation"
          : request.role === "checks"
            ? "checker-setup"
            : "setup",
        allowances.setupMs,
        phases,
        async (signal) => {
          const runtime = await create({
            ...request,
            id,
            runId: ledger.runId,
            attemptId,
            signal,
          });
          resource.runtimeId = runtime.id;
          runtimeResources.set(runtime, resource);
          await persist("resource-ready");
          if (signal.aborted) {
            try {
              await runtime.stop(AbortSignal.timeout(allowances.cleanupMs));
            } catch {
              throw Object.assign(new Error("Late runtime cleanup failed"), {
                resources: [runtime.id],
              });
            }
            throw signal.reason;
          }
          return runtime;
        },
      );
    } catch (error) {
      if (
        (error as { resources?: string[]; unsettled?: boolean }).resources
          ?.length ||
        (error as { unsettled?: boolean }).unsettled
      ) {
        resource.status = "cleanup-failed";
        Object.assign(error as object, {
          resources: [
            resource.id,
            ...((error as { resources?: string[] }).resources ?? []),
          ],
        });
      } else await progress.releaseResource(id);
      throw error;
    }
  };
  const prepareRuntime = async (
    runtime: BenchmarkRuntime,
    phases: Attempt["phases"],
    checking = false,
  ) =>
    phase(
      checking ? "checker-preparation" : "preparation",
      allowances.setupMs,
      phases,
      async (signal) => {
        if (plan.prepare) {
          const result = await runtime.exec({ command: plan.prepare, signal });
          if (result.exitCode !== 0)
            throw new PhaseFailure(
              "environment-unavailable",
              "Frozen preparation command failed",
            );
        }
        for (const environment of launch.capabilities.environments) {
          const result = await runtime.exec({
            command: environment.probe,
            signal,
          });
          if (result.exitCode !== 0)
            throw new PhaseFailure(
              "environment-unavailable",
              `Required environment unavailable: ${environment.name}`,
            );
        }
      },
    );
  const stop = async (runtime: BenchmarkRuntime, phases: Attempt["phases"]) => {
    const resource = runtimeResources.get(runtime)!;
    try {
      await phase(
        "cleanup",
        allowances.cleanupMs,
        phases,
        (signal) => runtime.stop(signal),
        true,
      );
      await progress.releaseResource(resource.id);
    } catch (error) {
      resource.status = "cleanup-failed";
      throw error;
    }
  };
  const projects = new Map<string, OwnedBenchmarkProjectRuntime>();
  const retainUnsettledProject = (attempt: Attempt, error: unknown) => {
    if (!(error as { unsettled?: boolean })?.unsettled) return;
    const project = projects.get(attempt.id);
    if (!project) return;
    project.resource.status = "cleanup-failed";
    project.report.status = "cleanup-failed";
    project.report.failure =
      "Project operation did not settle after cancellation; retain ownership for reconciliation";
    attempt.cleanup.status = "failed";
    if (!attempt.cleanup.resources.includes(project.resource.id))
      attempt.cleanup.resources.push(project.resource.id);
  };
  const prepareProject = async (
    attempt: Attempt,
    checkWorktree: string,
    phases = attempt.phases,
  ) => {
    let project: OwnedBenchmarkProjectRuntime | undefined;
    attempt.project = {
      status: "preparing",
      adapterSha256: launch.adapter.sha256,
      evidence: [],
    };
    try {
      project = await createBenchmarkProjectRuntime({
        plan,
        runId: ledger.runId,
        attemptId: attempt.id,
        slotId: attempt.slotId,
        candidate: attempt.candidate!,
        checkWorktree,
        own: (resource) => progress.ownResource(resource),
        release: (id) => progress.releaseResource(id),
        publish: () =>
          persist("project-runtime-owned", "environment-readiness"),
      });
      projects.set(attempt.id, project);
      attempt.project = project.report;
      await phase(
        phases === attempt.phases
          ? "checker-project-readiness"
          : "judge-project-readiness",
        phases === attempt.phases ? allowances.checksMs : allowances.judgeMs,
        phases,
        (signal, remainingMs) => project!.prepare(signal, remainingMs),
      );
      await persist("project-runtime-ready", "environment-readiness");
      return project;
    } catch (error) {
      attempt.project.status = "unavailable";
      attempt.project.failure =
        error instanceof Error ? error.message : "Project runtime unavailable";
      retainUnsettledProject(attempt, error);
      throw error;
    }
  };
  const stopProject = async (attempt: Attempt) => {
    const project = projects.get(attempt.id);
    if (!project) return;
    if (project.report.status === "cleanup-failed") return;
    try {
      await phase(
        "project-cleanup",
        allowances.cleanupMs,
        attempt.phases,
        (signal, remainingMs) => project.stop(signal, remainingMs),
        true,
      );
      await progress.releaseResource(project.resource.id);
      projects.delete(attempt.id);
    } catch (error) {
      project.resource.status = "cleanup-failed";
      project.report.status = "cleanup-failed";
      project.report.failure ??=
        error instanceof Error
          ? error.message
          : "Owned project cleanup journal release failed";
      attempt.cleanup.status = "failed";
      attempt.cleanup.resources.push(project.resource.id);
    }
  };
  const runJudge = async (
    attempt: Attempt,
    previousAssessmentId: string | null = null,
  ) => {
    if (
      !attempt.candidate ||
      attempt.judge.status !== "pending" ||
      attempt.cleanup.status !== "passed"
    )
      return;
    const candidate = attempt.candidate;
    judgingAttempt = attempt;
    const id = randomUUID();
    const root = join(plan.output, "runtime", `judge-${id}`);
    const assessment: JudgeAssessment = {
      version: 1,
      id,
      previousAssessmentId,
      reason: previousAssessmentId ? dependencies.rejudgeReason! : null,
      candidateId:
        attempt.judge.assessments?.[0]?.candidateId ??
        `candidate-${randomUUID()}`,
      protocolId: judgeProtocolId(plan),
      taskSha256:
        plan.tickets[
          plan.slots.find((slot) => slot.id === attempt.slotId)!.ticket
        ]!.sha256,
      rubricSha256: launch.grading.rubricSha256,
      candidate: {
        head: candidate.head,
        tree: candidate.tree,
        worktree: candidate.worktree,
        sourceSha256: candidate.sourceSha256,
        paths: candidate.paths,
      },
      status: "running",
      failure: null,
      startedAt: new Date(now()).toISOString(),
      requirements: [],
      deviations: [],
      disclosures: [
        "Frozen task, references, repository content and Git history may disclose author or model identity; these materials are retained verbatim.",
        "Candidate and reference paths include the caller's project/output naming, which can disclose identity.",
      ],
      score: {
        value: null,
        coverage: 0,
        applicableWeight: 0,
        assessedWeight: 0,
        range: null,
      },
      mandatoryChecks: attempt.check?.status ?? "not-run",
      projectAcceptance: "not_assessed",
      judge: {
        model: plan.judge!.model,
        effort: plan.judge!.effort,
        serviceTier: "default",
        observed: null,
      },
      usage: null,
      provenance: {
        sessionId: null,
        stream: join(plan.output, "assessments", `${id}-judge.jsonl`),
        streamSha256: null,
        sessions: [],
        source: "codex-stream",
      },
    };
    (attempt.judge.assessments ??= []).push(assessment);
    attempt.judge.status = "running";
    ledger.budget.judgeReservedMs = Math.max(
      0,
      ledger.budget.judgeReservedMs - judgeReservationMs(plan),
    );
    ledger.budget.judgeReservedCalls = Math.max(
      0,
      ledger.budget.judgeReservedCalls - 1,
    );
    const phases: Attempt["phases"] = [];
    let runtime: BenchmarkRuntime | undefined;
    let inspection:
      Awaited<ReturnType<typeof serveBenchmarkProjectInspection>> | undefined;
    let stream = "",
      output = "",
      stdoutSeen = "";
    let redact = (text: string) => text;
    await mkdir(join(plan.output, "assessments"), {
      recursive: true,
      mode: 0o700,
    });
    await progress.publish("judge-preparation", "judge-preparation", attempt);
    await progress.ownResource({
      id: root,
      kind: "directory",
      attemptId: attempt.id,
      status: "owned",
    });
    try {
      const instructionReferences = await prepareBenchmarkInstructions(
        launch,
        join(root, "judge"),
        "judge",
        candidate.changedFiles,
      );
      const source = await phase(
        "judge-worktree",
        allowances.judgeMs,
        phases,
        async (signal) => {
          await verifyBenchmarkCandidate(candidate, signal);
          const source = await privateWorktree(
            join(root, "judge"),
            join(dirname(candidate.worktree), "storage.git"),
            candidate.head,
            signal,
          );
          const actual = await workspaceFingerprint(
            source.worktree,
            source.worktree,
            signal,
            candidate.paths,
          );
          if (actual.sha256 !== candidate.sourceSha256)
            throw new Error("Judge worktree differs from the sealed candidate");
          const references = join(root, "judge", "references");
          await mkdir(references, { recursive: true, mode: 0o700 });
          for (const [index, file] of launch.grading.references.entries())
            await writeFile(
              join(references, String(index)),
              file.base64 ? Buffer.from(file.base64, "base64") : file.text,
              { mode: 0o400 },
            );
          return source;
        },
      );
      runtime = await setup(
        {
          plan,
          root: join(root, "judge"),
          worktree: source.worktree,
          role: "judge",
        },
        phases,
        attempt,
      );
      if (
        launch.adapter.module &&
        !projects.has(attempt.id) &&
        attempt.project?.status !== "unavailable"
      ) {
        const checks = await phase(
          "judge-project-worktree",
          allowances.judgeMs,
          phases,
          async (signal) => {
            const checks = await privateWorktree(
              join(root, "project-checks"),
              join(dirname(candidate.worktree), "storage.git"),
              candidate.head,
              signal,
            );
            await restoreChecks(plan, checks.worktree);
            return checks;
          },
        );
        const project = await prepareProject(attempt, checks.worktree, phases);
        await phase(
          "judge-project-capture",
          allowances.judgeMs,
          phases,
          (signal, remainingMs) => project.capture(signal, remainingMs),
        );
      }
      const project = projects.get(attempt.id);
      if (project?.report.status === "ready") {
        await phase(
          "judge-project-integrity",
          allowances.judgeMs,
          phases,
          (signal) => project.verify(signal),
        );
        const inspectionMs = Math.max(
          1,
          Math.min(
            remaining(),
            allowances.judgeMs -
              phases
                .filter((item) => item.name.startsWith("judge-"))
                .reduce((total, item) => total + item.elapsedMs, 0),
          ),
        );
        const inspectionDeadline = now() + inspectionMs;
        inspection = await serveBenchmarkProjectInspection(
          project,
          join(root, "judge", "references", "inspection.sock"),
          AbortSignal.any([signal, AbortSignal.timeout(inspectionMs)]),
          () => Math.max(0, inspectionDeadline - now()),
        );
      }
      redact = runtime.redact?.bind(runtime) ?? redact;
      const provider = codex(plan.judge!.model, {
        effort: plan.judge!.effort as CodexOptions["effort"],
        serviceTier: "default",
        readOnly: true,
      });
      let checkOutput = "Unavailable";
      if (
        attempt.check?.outputSha256 &&
        ["passed", "failed"].includes(attempt.check.status)
      ) {
        const bytes = await readFile(
          join(
            plan.output,
            `${attempt.retryOf ? attempt.id : attempt.slotId}-check.log`,
          ),
        );
        if (hash(bytes) !== attempt.check.outputSha256)
          throw new Error("Trusted configured-check evidence changed");
        checkOutput = `${bytes.subarray(0, 16384).toString("utf8")}${bytes.length > 16384 ? "\n[Excerpt; the complete bound log is available in references/configured-check.log]" : ""}`;
        await writeFile(
          join(root, "judge", "references", "configured-check.log"),
          bytes,
          { mode: 0o400 },
        );
      }
      const references = launch.grading.references.map((file, index) => ({
        path: file.path,
        sha256: file.sha256,
        location: join(root, "judge", "references", String(index)),
      }));
      if (
        attempt.check?.outputSha256 &&
        ["passed", "failed"].includes(attempt.check.status)
      )
        references.push({
          path: "configured-check.log",
          sha256: attempt.check.outputSha256,
          location: join(root, "judge", "references", "configured-check.log"),
        });
      for (const [index, file] of (attempt.project?.evidence ?? []).entries()) {
        const bytes = await readFile(file.path);
        if (hash(bytes) !== file.sha256)
          throw new Error("Candidate visual evidence changed");
        const location = join(root, "judge", "references", `visual-${index}`);
        await writeFile(location, bytes, { mode: 0o400 });
        references.push({ path: file.id, sha256: file.sha256, location });
      }
      const built = provider.buildPrintCommand({
        prompt: await judgePrompt(
          plan,
          attempt,
          assessment,
          checkOutput,
          references,
          instructionReferences,
          inspection
            ? join(root, "judge", "references", "inspection.sock")
            : undefined,
        ),
        dangerouslySkipPermissions: false,
      });
      const observe = (line: string) => {
        stdoutSeen += `${line}\n`;
        stream += `${redact(line)}\n`;
        progress.log(attempt, redact(line), "judge");
        for (const event of provider.parseStreamLine(line)) {
          if (event.type === "usage") assessment.usage = event.usage;
          if (event.type === "session_id")
            assessment.provenance.sessionId = event.sessionId;
          if (event.type === "result") output = redact(event.result);
          if (event.type === "tool_call")
            progress.activity(attempt, "inspection", "judge");
          progress.activity(attempt, event.type, "judge");
        }
      };
      if (
        ledger.budget.implementationCalls +
          ledger.budget.judgeCalls +
          ledger.budget.judgeReservedCalls >=
        ledger.budget.maxCalls
      )
        throw new Error("Judge call allowance exhausted");
      ledger.budget.judgeCalls++;
      await progress.publish("judge-call-started", "judge-assessment", attempt);
      const result = await phase(
        "judge-assessment",
        allowances.judgeMs,
        phases,
        (signal) => runtime!.exec({ ...built, signal, onLine: observe }),
      );
      const remainingOutput = result.stdout.startsWith(stdoutSeen)
        ? result.stdout.slice(stdoutSeen.length)
        : result.stdout;
      for (const line of remainingOutput.split("\n").filter(Boolean))
        observe(line);
      stream += redact(result.stderr);
      if (result.exitCode !== 0) throw new Error("Judge invocation failed");
      if (inspection) {
        const completedInspection = inspection;
        inspection = undefined;
        await phase(
          "judge-project-inspection",
          allowances.judgeMs,
          phases,
          () => completedInspection.close(),
        );
      }
      await phase(
        "assessment-complete",
        allowances.judgeMs,
        phases,
        async (signal) => {
          await verifyBenchmarkCandidate(candidate, signal);
          const actual = await workspaceFingerprint(
            source.worktree,
            source.worktree,
            signal,
            candidate.paths,
          );
          if (actual.sha256 !== candidate.sourceSha256)
            throw new Error("Judge changed the candidate worktree");
          await assessJudgeOutput(plan, attempt, assessment, output, signal);
        },
      );
    } catch (error) {
      retainUnsettledProject(attempt, error);
      failJudgeAssessment(
        assessment,
        error instanceof PhaseFailure
          ? error.outcome
          : error instanceof Error
            ? redact(error.message)
            : "Judge assessment failed",
      );
      if (signal.aborted) ledger.status = "cancelled";
      if (
        (error as { unsettled?: boolean; resources?: string[] }).unsettled ||
        (error as { resources?: string[] }).resources?.length
      ) {
        attempt.cleanup.status = "failed";
        attempt.cleanup.resources.push(
          runtime?.id ?? root,
          ...((error as { resources?: string[] }).resources ?? []),
        );
      }
    } finally {
      if (inspection) {
        try {
          await phase(
            "judge-sealing",
            allowances.sealMs,
            phases,
            () => inspection!.close(),
            true,
          );
        } catch (error) {
          retainUnsettledProject(attempt, error);
          failJudgeAssessment(
            assessment,
            "Owned candidate live inspection failed",
          );
          attempt.cleanup.status = "failed";
          attempt.cleanup.resources.push(root);
        }
      }
      if (runtime)
        try {
          await stop(runtime, phases);
        } catch {
          attempt.cleanup.status = "failed";
          attempt.cleanup.resources.push(runtime.id, root);
        }
      try {
        const captured = await phase(
          "judge-sealing",
          allowances.sealMs,
          phases,
          (signal) =>
            captureSessions(root, plan.output, id, redact, signal, "judge"),
          true,
        );
        assessment.provenance.sessions = captured.sessions;
        assessment.judge.observed = captured.observed;
        if (
          captured.observed?.some(
            (item) =>
              item.model !== plan.judge!.model ||
              (item.effort !== null && item.effort !== plan.judge!.effort) ||
              (item.serviceTier !== null && item.serviceTier !== "default"),
          )
        ) {
          failJudgeAssessment(
            assessment,
            "Observed judge identity differs from the frozen request",
          );
        }
      } catch {
        failJudgeAssessment(assessment, "Judge provenance capture failed");
      }
      assessment.provenance.streamSha256 = hash(stream);
      await writeFile(assessment.provenance.stream, stream, { mode: 0o600 });
      assessment.finishedAt = new Date(now()).toISOString();
      attempt.judge.status = assessment.status;
      await phase(
        "judge-sealing",
        allowances.sealMs,
        phases,
        () =>
          sealJudgeAssessment(plan, attempt, assessment, () =>
            progress.publish(
              "judge-stream-finished",
              "assessment-complete",
              attempt,
            ),
          ),
        true,
      );
      if (attempt.cleanup.status === "passed")
        try {
          await phase(
            "remove-owned-runtime",
            allowances.cleanupMs,
            phases,
            () => rm(root, { recursive: true, force: true }),
            true,
          );
          await progress.releaseResource(root);
        } catch {
          attempt.cleanup.status = "failed";
          attempt.cleanup.resources.push(root);
        }
      attempt.phases.push(...phases);
      await stopProject(attempt);
      if (
        ["judge-pending", "completed", "assessment-incomplete"].includes(
          attempt.status,
        )
      )
        attempt.status =
          assessment.status === "complete"
            ? "completed"
            : "assessment-incomplete";
      attempt.settledAt = new Date(now()).toISOString();
      await progress.publish("judge-completed", "assessment-complete", attempt);
      judgingAttempt = undefined;
    }
  };
  let initialized = false;
  const report = async () => {
    await writeImplementationBenchmarkReport({
      directory: plan.output,
      outputDirectory: plan.output,
    });
  };
  try {
    if (!dependencies.resume)
      await save(join(plan.output, "manifest.json"), plan);
    ledger.status = "running";
    ledger.reason = null;
    await persist(dependencies.resume ? "resumed" : "run-started");
    initialized = true;
    const rejudge = dependencies.rejudgeAssessmentId
      ? attempts.find((attempt) =>
          attempt.judge.assessments?.some(
            (assessment) => assessment.id === dependencies.rejudgeAssessmentId,
          ),
        )
      : undefined;
    if (rejudge) {
      if (
        remaining() < judgeReservationMs(plan) ||
        ledger.budget.maxCalls -
          ledger.budget.implementationCalls -
          ledger.budget.judgeCalls -
          ledger.budget.judgeReservedCalls <
          1
      ) {
        ledger.status = "budget-exhausted";
        await progress.publish(
          "judge-budget-exhausted",
          "judge-preparation",
          rejudge,
        );
      } else {
        ledger.budget.judgeReservedMs += judgeReservationMs(plan);
        ledger.budget.judgeReservedCalls++;
        rejudge.judge.status = "pending";
        await runJudge(rejudge, dependencies.rejudgeAssessmentId!);
      }
    } else
      for (const attempt of attempts.filter(
        (attempt) => attempt.judge.status === "pending",
      ))
        await runJudge(attempt);
    const attemptMs =
      allowances.setupMs +
      allowances.implementationMs +
      allowances.sealMs +
      allowances.checksMs +
      allowances.cleanupMs +
      judgeReservationMs(plan);
    const slotLimit = Math.min(
      maxNewSlots,
      allowances.maxSlotsPerDispatch ?? Infinity,
    );
    const retry = attempts.find(
      (attempt) => attempt.id === dependencies.retryAttemptId,
    );
    const scheduled = rejudge
      ? []
      : retry
        ? plan.slots.filter((slot) => slot.id === retry.slotId)
        : plan.slots.filter((slot) => ledger.unrun.includes(slot.id));
    if (!scheduled.length) {
      if (ledger.status === "running")
        ledger.status = attempts.some(
          (attempt) => attempt.judge.status === "pending",
        )
          ? "judge-pending"
          : attempts.some((attempt) => attempt.judge.status === "incomplete")
            ? "assessment-incomplete"
            : ledger.unrun.length
              ? "partial"
              : "complete";
    } else if (ledger.controls.status === "failed")
      ledger.status = "control-failed";
    else if (
      ledger.controls.status === "unavailable" &&
      ledger.controls.results.length
    )
      ledger.status = "control-unavailable";
    else if (
      remaining() < attemptMs + allowances.controlsMs + allowances.setupMs ||
      allowances.maxCalls < 2
    )
      ledger.status = "budget-exhausted";
    else if (!plan.check) ledger.status = "missing-checks";
    else if (
      plan.readiness?.workerStatus !== "ready" ||
      plan.readiness.blockers.length
    )
      ledger.status = "environment-unavailable";
    else if (signal.aborted) ledger.status = "cancelled";
    else {
      await progress.ownResource({
        id: join(plan.output, "protected"),
        kind: "directory",
        attemptId: null,
        status: "owned",
      });
      protectedBase = await phase(
        "freeze-base",
        allowances.setupMs,
        ledger.phases,
        (signal) =>
          privateWorktree(
            join(plan.output, "protected"),
            plan.cwd,
            plan.baseCommit,
            signal,
          ),
      );
      for (const control of launch.checking.controls.filter(
        (control) =>
          !ledger.controls.results.some(
            (result) =>
              result.kind === control.kind && result.status === "passed",
          ),
      )) {
        const root = join(plan.output, "runtime", `control-${control.kind}`);
        await progress.ownResource({
          id: root,
          kind: "directory",
          attemptId: null,
          status: "owned",
        });
        await mkdir(root, { recursive: true, mode: 0o700 });
        const controlPhases: Attempt["phases"] = [];
        const result: ImplementationExecution["controls"]["results"][number] = {
          ...control,
          exitCode: null,
          status: "running",
          outputSha256: null,
          phases: controlPhases,
        };
        ledger.controls.results.push(result);
        await persist("control-started");
        let runtime: BenchmarkRuntime | undefined;
        let controlAttempt: Attempt | undefined;
        try {
          const source = await phase(
            "worktree",
            allowances.setupMs,
            controlPhases,
            async (signal) => {
              const source = await privateWorktree(
                root,
                plan.cwd,
                control.commit,
                signal,
              );
              await restoreChecks(plan, source.worktree);
              return source;
            },
          );
          const expected = await phase(
            "checker-baseline",
            allowances.checksMs,
            controlPhases,
            (signal) =>
              workspaceFingerprint(
                source.worktree,
                protectedBase!.worktree,
                signal,
              ),
          );
          if (launch.adapter.module) {
            const candidate = await phase(
              "checker-control-sealing",
              allowances.checksMs,
              controlPhases,
              (signal) =>
                seal(
                  plan,
                  `control-${control.kind}`,
                  source.worktree,
                  protectedBase!.storage,
                  (text) => text,
                  signal,
                ),
            );
            if (!candidate)
              throw new Error("Control candidate could not be sealed");
            controlAttempt = {
              id: `control-${control.kind}`,
              slotId: plan.slots[0]!.id,
              armId: "control",
              status: "running",
              startedAt: new Date(now()).toISOString(),
              phases: controlPhases,
              resources: [],
              cleanup: { status: "passed", resources: [] },
              judge: {
                status: "no-candidate",
                model: plan.judge!.model,
                effort: plan.judge!.effort,
              },
              candidate,
            };
            await prepareProject(controlAttempt, source.worktree);
          } else {
            runtime = await setup(
              { plan, root, worktree: source.worktree, role: "control" },
              controlPhases,
            );
            await prepareRuntime(runtime, controlPhases);
          }
          await phase(
            "checker-input-integrity",
            allowances.checksMs,
            controlPhases,
            (signal) =>
              verifyChecks(
                plan,
                source.worktree,
                signal,
                protectedBase!.worktree,
                expected,
              ),
          );
          const checked = await phase(
            "control-check",
            allowances.checksMs,
            controlPhases,
            (signal, remainingMs) =>
              controlAttempt
                ? projects.get(controlAttempt.id)!.check(signal, remainingMs)
                : runtime!.exec({ command: plan.check!, signal }),
          );
          const output =
            runtime?.redact?.(`${checked.stdout}\n${checked.stderr}`) ??
            `${checked.stdout}\n${checked.stderr}`;
          await writeFile(join(plan.output, `${control.kind}.log`), output, {
            mode: 0o600,
          });
          Object.assign(result, {
            exitCode: checked.exitCode,
            status: "unavailable",
            outputSha256: hash(output),
          });
          await phase(
            "checker-result-integrity",
            allowances.checksMs,
            controlPhases,
            (signal) =>
              verifyChecks(
                plan,
                source.worktree,
                signal,
                protectedBase!.worktree,
                expected,
              ),
          );
          const passed =
            control.kind === "known-good"
              ? checked.exitCode === 0
              : checked.exitCode !== 0;
          result.status = passed ? "passed" : "failed";
          if (!passed) ledger.controls.status = "failed";
        } catch (error) {
          if (controlAttempt) retainUnsettledProject(controlAttempt, error);
          result.status = "unavailable";
          const resources = (error as { resources?: string[] }).resources;
          if (resources?.length) {
            ledger.cleanup.status = "failed";
            ledger.cleanup.resources.push(...resources, root);
          }
          throw error;
        } finally {
          if (controlAttempt) {
            await stopProject(controlAttempt);
            if (controlAttempt.cleanup.status === "failed") {
              ledger.cleanup.status = "failed";
              ledger.cleanup.resources.push(
                ...controlAttempt.cleanup.resources,
                root,
              );
            }
          }
          try {
            if (runtime) await stop(runtime, controlPhases);
          } catch {
            ledger.cleanup.status = "failed";
            ledger.cleanup.resources.push(runtime!.id, root);
          }
          if (ledger.cleanup.status === "passed") {
            try {
              await phase(
                "remove-owned-runtime",
                allowances.cleanupMs,
                controlPhases,
                () => rm(root, { recursive: true, force: true }),
                true,
              );
              await progress.releaseResource(root);
            } catch {
              ledger.cleanup.status = "failed";
              ledger.cleanup.resources.push(root);
            }
          }
        }
        if (ledger.cleanup.status === "failed")
          throw new Error("Control cleanup failed");
      }
      if (ledger.controls.status === "pending")
        ledger.controls.status = "passed";
      if (ledger.controls.status === "failed") ledger.status = "control-failed";
      else
        for (const slot of scheduled.slice(0, slotLimit)) {
          if (signal.aborted) {
            ledger.status = "cancelled";
            break;
          }
          if (
            remaining() < attemptMs ||
            allowances.maxCalls -
              ledger.budget.implementationCalls -
              ledger.budget.judgeCalls -
              ledger.budget.judgeReservedCalls <
              2
          ) {
            ledger.status = "budget-exhausted";
            break;
          }
          ledger.budget.judgeReservedMs += judgeReservationMs(plan);
          ledger.budget.judgeReservedCalls++;
          const attempt: Attempt = {
            id: `${slot.id}-attempt-${attempts.filter((attempt) => attempt.slotId === slot.id).length + 1}`,
            armId: `arm-${slot.arm + 1}`,
            ...(retry ? { retryOf: retry.id } : {}),
            slotId: slot.id,
            status: "running",
            startedAt: new Date(now()).toISOString(),
            phases: [],
            resources: [],
            cleanup: { status: "passed", resources: [] },
            check: { status: "not-run" },
            judge: {
              status: "no-candidate",
              model: plan.judge!.model,
              effort: plan.judge!.effort,
            },
          };
          attempts.push(attempt);
          const evidenceId = retry ? attempt.id : slot.id;
          ledger.unrun = ledger.unrun.filter((id) => id !== slot.id);
          await persist();
          const root = join(plan.output, "runtime", attempt.id);
          await progress.ownResource({
            id: root,
            kind: "directory",
            attemptId: attempt.id,
            status: "owned",
          });
          await mkdir(root, { recursive: true, mode: 0o700 });
          let runtime: BenchmarkRuntime | undefined;
          let checker: BenchmarkRuntime | undefined;
          let worker: Awaited<ReturnType<typeof privateWorktree>> | undefined;
          let invoked = false;
          let redact = (text: string) => text;
          try {
            worker = await phase(
              "worktree",
              allowances.setupMs,
              attempt.phases,
              (signal) =>
                privateWorktree(
                  join(root, "implementation"),
                  protectedBase!.storage,
                  plan.baseCommit,
                  signal,
                ),
            );
            const instructionReferences = await prepareBenchmarkInstructions(
              launch,
              join(root, "implementation"),
              "implementation",
            );
            runtime = await setup(
              {
                plan,
                root: join(root, "implementation"),
                worktree: worker.worktree,
                role: "implementation",
              },
              attempt.phases,
            );
            attempt.resources.push(runtime.id);
            redact = runtime.redact?.bind(runtime) ?? redact;
            await prepareRuntime(runtime, attempt.phases);
            const arm = plan.arms[slot.arm]!;
            const provider = codex(arm.model, {
              effort: arm.effort as CodexOptions["effort"],
              serviceTier: "default",
            });
            const prompt = `Implement exactly this frozen task in one invocation. Do not delegate or invoke another agent. Keep edits inside ${JSON.stringify(launch.allowedEdits)}. Candidate commits or completion messages do not establish acceptance.\n\n${plan.tickets[slot.ticket]!.text}\n\nFrozen governing instructions, available read-only:\n${JSON.stringify(instructionReferences)}\nRead root governing files before editing. Read nested governing files for each directory you edit and follow their reference loading conditions. Resolve linked reference paths against the frozen file's location. Review criteria are applied by the independent judge.`;
            const built = provider.buildPrintCommand({
              prompt,
              dangerouslySkipPermissions: true,
            });
            let stream = "";
            let usage: IterationUsage | null = null;
            let sessionId: string | null = null;
            attempt.implementation = {
              exitCode: null,
              usage: null,
              streamSha256: null,
              requested: { ...arm, serviceTier: "default" },
              observed: null,
            };
            const observe = (line: string) => {
              stream += `${redact(line)}\n`;
              progress.log(attempt, redact(line));
              for (const event of provider.parseStreamLine(line)) {
                if (event.type === "usage") {
                  usage = event.usage;
                  attempt.implementation!.usage = usage;
                }
                if (event.type === "session_id") sessionId = event.sessionId;
                progress.activity(attempt, event.type);
              }
            };
            ledger.budget.implementationCalls++;
            invoked = true;
            await persist();
            try {
              const result = await phase(
                "implementation",
                allowances.implementationMs,
                attempt.phases,
                (signal) =>
                  runtime!.exec({ ...built, signal, onLine: observe }),
              );
              if (!stream)
                for (const line of result.stdout.split("\n")) observe(line);
              stream += redact(result.stderr);
              attempt.implementation = {
                exitCode: result.exitCode,
                usage,
                streamSha256: hash(stream),
                requested: { ...arm, serviceTier: "default" },
                observed: null,
              };
              attempt.status =
                result.exitCode === 0 ? "judge-pending" : "worker-failed";
            } finally {
              attempt.implementation = {
                exitCode: attempt.implementation?.exitCode ?? null,
                usage,
                streamSha256: hash(stream),
                requested: { ...arm, serviceTier: "default" },
                observed: null,
              };
              // Drain live log writes before finalizing the exact stream bytes.
              await persist("implementation-stream-finished", "implementation");
              await writeFile(
                join(plan.output, `${evidenceId}-implementation.jsonl`),
                stream,
                { mode: 0o600 },
              );
              await save(join(plan.output, `${evidenceId}-provenance.json`), {
                sessionId,
                requested: arm,
                serviceTier: "default",
                observed: null,
                usage,
                source: "codex-stream",
                streamSha256: hash(stream),
              });
            }
          } catch (error) {
            if ((error as { unsettled?: boolean }).unsettled) {
              attempt.cleanup.status = "failed";
              attempt.cleanup.resources.push(runtime?.id ?? root);
            }
            attempt.status =
              error instanceof PhaseFailure
                ? error.outcome
                : invoked
                  ? "worker-failed"
                  : "environment-unavailable";
            attempt.reason =
              error instanceof PhaseFailure
                ? error.message
                : "Implementation runtime failed";
            const resources = (error as { resources?: string[] }).resources;
            if (resources?.length) {
              attempt.cleanup.status = "failed";
              attempt.cleanup.resources.push(...resources);
            }
          } finally {
            if (runtime) {
              try {
                await stop(runtime, attempt.phases);
                runtime = undefined;
              } catch {
                attempt.cleanup.status = "failed";
                attempt.cleanup.resources.push(runtime!.id);
              }
            }
          }
          try {
            if (worker && invoked && attempt.cleanup.status === "passed") {
              attempt.candidate = await phase(
                "sealing",
                allowances.sealMs,
                attempt.phases,
                async (signal) => {
                  const captured = await captureSessions(
                    root,
                    plan.output,
                    evidenceId,
                    redact,
                    signal,
                  );
                  if (attempt.implementation)
                    Object.assign(attempt.implementation, captured);
                  return seal(
                    plan,
                    evidenceId,
                    worker!.worktree,
                    protectedBase!.storage,
                    redact,
                    signal,
                  );
                },
                true,
              );
              if (!attempt.candidate && attempt.status === "judge-pending")
                attempt.status = "no-candidate";
              if (attempt.candidate) {
                attempt.judge.status = "pending";
                const arm = plan.arms[slot.arm]!;
                if (
                  attempt.implementation?.observed?.some(
                    (identity) =>
                      identity.model !== arm.model ||
                      (identity.effort !== null &&
                        identity.effort !== arm.effort) ||
                      (identity.serviceTier !== null &&
                        identity.serviceTier !== "default"),
                  )
                ) {
                  attempt.status = "identity-mismatch";
                  attempt.reason =
                    "Captured worker identity differs from the frozen request";
                }
                const allowed = attempt.candidate.changedFiles.every((path) =>
                  launch.allowedEdits.some((pattern) =>
                    matchesGlob(path, pattern),
                  ),
                );
                if (!allowed) {
                  attempt.status = "scope-violation";
                  attempt.reason = "Candidate edits exceed the frozen scope";
                }
                if (signal.aborted || attempt.status === "cancelled")
                  throw new PhaseFailure(
                    signal.aborted ? "cancelled" : "timed-out",
                    "Configured checks did not run after cancellation",
                  );
                const checkWorkspace = await phase(
                  "checker-worktree",
                  allowances.setupMs,
                  attempt.phases,
                  (signal) =>
                    privateWorktree(
                      join(root, "checks"),
                      join(dirname(attempt.candidate!.worktree), "storage.git"),
                      attempt.candidate!.head,
                      signal,
                    ),
                );
                await phase(
                  "checker-inputs",
                  allowances.checksMs,
                  attempt.phases,
                  () => restoreChecks(plan, checkWorkspace.worktree),
                );
                const expected = await phase(
                  "checker-baseline",
                  allowances.checksMs,
                  attempt.phases,
                  (signal) =>
                    workspaceFingerprint(
                      checkWorkspace.worktree,
                      protectedBase!.worktree,
                      signal,
                    ),
                );
                if (launch.adapter.module)
                  await prepareProject(attempt, checkWorkspace.worktree);
                else {
                  checker = await setup(
                    {
                      plan,
                      root: join(root, "checks"),
                      worktree: checkWorkspace.worktree,
                      role: "checks",
                    },
                    attempt.phases,
                  );
                  attempt.resources.push(checker.id);
                  await prepareRuntime(checker, attempt.phases, true);
                }
                await phase(
                  "checker-input-integrity",
                  allowances.checksMs,
                  attempt.phases,
                  (signal) =>
                    verifyChecks(
                      plan,
                      checkWorkspace.worktree,
                      signal,
                      protectedBase!.worktree,
                      expected,
                    ),
                );
                const checked = await phase(
                  "checks",
                  allowances.checksMs,
                  attempt.phases,
                  (signal, remainingMs) =>
                    projects.has(attempt.id)
                      ? projects.get(attempt.id)!.check(signal, remainingMs)
                      : checker!.exec({ command: plan.check!, signal }),
                );
                const output = redact(`${checked.stdout}\n${checked.stderr}`);
                await writeFile(
                  join(plan.output, `${evidenceId}-check.log`),
                  output,
                  { mode: 0o600 },
                );
                attempt.check = {
                  status: "unavailable",
                  exitCode: checked.exitCode,
                  outputSha256: hash(output),
                  candidateHead: attempt.candidate.head,
                  candidateTree: attempt.candidate.tree,
                  frozenInputsSha256: hash(JSON.stringify(launch.checking)),
                };
                await phase(
                  "checker-result-integrity",
                  allowances.checksMs,
                  attempt.phases,
                  (signal) =>
                    verifyChecks(
                      plan,
                      checkWorkspace.worktree,
                      signal,
                      protectedBase!.worktree,
                      expected,
                    ),
                );
                attempt.check.status =
                  checked.exitCode === 0 ? "passed" : "failed";
                if (
                  attempt.status === "judge-pending" &&
                  checked.exitCode !== 0
                )
                  attempt.status = "check-failed";
                if (projects.has(attempt.id))
                  await phase(
                    "checker-project-capture",
                    allowances.checksMs,
                    attempt.phases,
                    (signal, remainingMs) =>
                      projects.get(attempt.id)!.capture(signal, remainingMs),
                  );
              }
            }
          } catch (error) {
            retainUnsettledProject(attempt, error);
            if ((error as { unsettled?: boolean }).unsettled) {
              attempt.cleanup.status = "failed";
              attempt.cleanup.resources.push(checker?.id ?? root);
            }
            const resources = (error as { resources?: string[] }).resources;
            if (resources?.length) {
              attempt.cleanup.status = "failed";
              attempt.cleanup.resources.push(...resources);
            }
            const outcome =
              error instanceof PhaseFailure
                ? error.outcome
                : attempt.candidate
                  ? "environment-unavailable"
                  : "seal-failed";
            if (
              attempt.status === "judge-pending" ||
              attempt.status === "running"
            )
              attempt.status = outcome;
            const checkingFailure =
              error instanceof PhaseFailure
                ? error.message
                : attempt.candidate
                  ? error instanceof Error
                    ? error.message
                    : "Protected checking runtime unavailable"
                  : "Candidate sealing failed";
            attempt.reason ??= checkingFailure;
            if (attempt.candidate)
              attempt.check = {
                ...attempt.check,
                failure: checkingFailure,
                status:
                  error instanceof PhaseFailure &&
                  ["cancelled", "timed-out"].includes(error.outcome)
                    ? "not-run"
                    : "unavailable",
              };
          } finally {
            if (checker) {
              try {
                await stop(checker, attempt.phases);
              } catch {
                attempt.cleanup.status = "failed";
                attempt.cleanup.resources.push(checker.id);
              }
            }
            if (!attempt.candidate)
              await rm(join(plan.output, "candidates", evidenceId), {
                recursive: true,
                force: true,
              });
            if (attempt.cleanup.status === "passed") {
              try {
                await phase(
                  "remove-owned-runtime",
                  allowances.cleanupMs,
                  attempt.phases,
                  () => rm(root, { recursive: true, force: true }),
                  true,
                );
                await progress.releaseResource(root);
              } catch {
                attempt.cleanup.status = "failed";
                attempt.cleanup.resources.push(root);
              }
            } else attempt.cleanup.resources.push(root);
            if (!attempt.candidate) {
              ledger.budget.judgeReservedMs -= judgeReservationMs(plan);
              ledger.budget.judgeReservedCalls--;
            }
            attempt.finishedAt = new Date(now()).toISOString();
            await persist();
          }
          await runJudge(attempt);
          await stopProject(attempt);
          attempt.settledAt = new Date(now()).toISOString();
          if (attempt.cleanup.status === "failed") {
            if (attempt.status === "judge-pending")
              attempt.status = "cleanup-failed";
            ledger.status = "cleanup-failed";
            break;
          }
          if (
            attempt.status === "cancelled" ||
            attempt.status === "timed-out"
          ) {
            ledger.status = attempt.status;
            break;
          }
        }
      if (ledger.status === "running")
        ledger.status = attempts.some(
          (attempt) => attempt.judge.status === "pending",
        )
          ? "judge-pending"
          : attempts.some((attempt) => attempt.judge.status === "incomplete")
            ? "assessment-incomplete"
            : ledger.unrun.length
              ? "partial"
              : "complete";
    }
  } catch (error) {
    if (!initialized) throw error;
    ledger.status =
      ledger.cleanup.status === "failed"
        ? "cleanup-failed"
        : error instanceof PhaseFailure
          ? error.outcome
          : "infrastructure-failed";
    ledger.reason =
      error instanceof PhaseFailure
        ? error.message
        : "Frozen base or control runtime unavailable";
    if (ledger.controls.status === "pending")
      ledger.controls.status = "unavailable";
    const resources = (error as { resources?: string[] }).resources;
    if (resources?.length) {
      ledger.cleanup.status = "failed";
      ledger.cleanup.resources.push(...resources);
    }
  } finally {
    try {
      if (initialized) {
        ledger.budget.cleanupReservedMs = 0;
        const retained = ledger.resources.filter(
          (resource) => resource.status === "cleanup-failed",
        );
        if (retained.length) {
          ledger.cleanup.status = "failed";
          ledger.cleanup.resources = [
            ...new Set([
              ...ledger.cleanup.resources,
              ...retained.map((resource) => resource.id),
            ]),
          ];
        }
        const retainBase = attempts.some(
          (attempt) =>
            attempt.implementation &&
            !attempt.candidate &&
            attempt.cleanup.status === "failed",
        );
        if (retainBase) {
          ledger.cleanup.status = "failed";
          ledger.cleanup.resources.push(join(plan.output, "protected"));
          await persist("protected-base-retained", "cleanup");
        } else
          try {
            await phase(
              "remove-protected-base",
              allowances.cleanupMs,
              ledger.phases,
              () =>
                rm(join(plan.output, "protected"), {
                  recursive: true,
                  force: true,
                }),
              true,
            );
            await progress.releaseResource(join(plan.output, "protected"));
          } catch {
            ledger.cleanup.status = "failed";
            ledger.cleanup.resources.push(join(plan.output, "protected"));
          }
        if (ledger.cleanup.status === "failed")
          ledger.status = "cleanup-failed";
        await persist("report", "report-generation");
      }
    } finally {
      await progress.close(initialized ? report : undefined);
    }
  }
  return {
    output: plan.output,
    status: ledger.status,
    completed: attempts.length,
  };
};
