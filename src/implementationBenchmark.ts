import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
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
  type Candidate,
} from "./benchmarkCandidate.js";
import { createBenchmarkRuntime } from "./implementationBenchmarkRuntime.js";

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
  readonly plan: TicketBenchmarkPlan;
  readonly root: string;
  readonly worktree: string;
  readonly role: "implementation" | "checks" | "control";
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
}
interface Attempt {
  slotId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  reason?: string;
  implementation?: {
    exitCode: number | null;
    usage: IterationUsage | null;
    streamSha256: string;
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
  };
  candidate?: Candidate;
  cleanup: { status: "passed" | "failed"; resources: string[] };
  judge: { status: "pending" | "no-candidate"; model: string; effort: string };
}

const captureSessions = async (
  root: string,
  output: string,
  slotId: string,
  redact: (text: string) => string,
  signal: AbortSignal,
) => {
  const source = join(root, "implementation", "home", ".codex", "sessions");
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
  const started = now();
  const create = dependencies.createRuntime ?? createBenchmarkRuntime;
  const attempts: Attempt[] = [];
  const ledger = {
    version: 2,
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
      judgeReservedCalls: 0,
    },
    controls: {
      status: launch.checking.controls.length ? "pending" : "absent",
      results: [] as {
        kind: string;
        commit: string;
        exitCode: number;
        status: string;
        outputSha256: string;
        phases: Attempt["phases"];
      }[],
    },
    attempts,
    unrun: plan.slots.map((slot) => slot.id),
    phases: [] as Attempt["phases"],
    cleanup: { status: "passed", resources: [] as string[] },
    reason: null as string | null,
    blockers: plan.readiness?.blockers ?? [],
  };
  await mkdir(plan.output, { recursive: true, mode: 0o700 });
  const lock = await open(join(plan.output, "benchmark.lock"), "wx", 0o600);
  const persist = async () => {
    ledger.budget.elapsedMs = Math.max(0, now() - started);
    await save(join(plan.output, "execution.json"), ledger);
  };
  const remaining = () =>
    allowances.overallMs -
    Math.max(0, now() - started) -
    ledger.budget.judgeReservedMs -
    ledger.budget.cleanupReservedMs;
  const phase = async <T>(
    name: string,
    limitMs: number,
    phases: Attempt["phases"],
    operation: (signal: AbortSignal) => Promise<T>,
    cleanup = false,
  ): Promise<T> => {
    const group = (phaseName: string) =>
      phaseName.startsWith("checker-") ||
      phaseName === "checks" ||
      phaseName === "control-check"
        ? "checks"
        : ["setup", "preparation", "worktree"].includes(phaseName)
          ? "setup"
          : phaseName.includes("cleanup") ||
              phaseName === "remove-owned-runtime"
            ? "cleanup"
            : phaseName;
    const groupLimit = group(name) === "checks" ? allowances.checksMs : limitMs;
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
    const signal =
      cleanup || !dependencies.signal
        ? controller.signal
        : AbortSignal.any([controller.signal, dependencies.signal]);
    const begin = now();
    let outcome = "passed";
    ledger.budget.activeReservedMs = admittedMs;
    let abort: (() => void) | undefined;
    let pending: Promise<T> | undefined;
    try {
      await persist();
      if (signal.aborted)
        throw new PhaseFailure(
          dependencies.signal?.aborted && !cleanup ? "cancelled" : "timed-out",
          `${name} interrupted`,
        );
      const interrupted = new Promise<never>((_, reject) => {
        abort = () =>
          reject(
            new PhaseFailure(
              dependencies.signal?.aborted && !cleanup
                ? "cancelled"
                : "timed-out",
              `${name} interrupted`,
            ),
          );
        signal.addEventListener("abort", abort, { once: true });
      });
      pending = operation(signal);
      const result = await Promise.race([pending, interrupted]);
      if (now() - begin > admittedMs)
        throw new PhaseFailure("timed-out", `${name} exceeded its allowance`);
      return result;
    } catch (error) {
      if (pending && signal.aborted) {
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          pending.then(
            () => null,
            (failure: unknown) => failure,
          ),
          new Promise<null>((accept) => {
            drainTimer = setTimeout(() => accept(null), allowances.cleanupMs);
          }),
        ]);
        if (drainTimer) clearTimeout(drainTimer);
        const resources = (settled as { resources?: string[] } | null)
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
      await persist();
    }
  };
  let protectedBase: Awaited<ReturnType<typeof privateWorktree>> | undefined;
  const setup = async (
    request: Omit<BenchmarkRuntimeRequest, "signal">,
    phases: Attempt["phases"],
  ): Promise<BenchmarkRuntime> =>
    phase(
      request.role === "checks" ? "checker-setup" : "setup",
      allowances.setupMs,
      phases,
      async (signal) => {
        const runtime = await create({ ...request, signal });
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
  const stop = async (runtime: BenchmarkRuntime, phases: Attempt["phases"]) =>
    phase(
      "cleanup",
      allowances.cleanupMs,
      phases,
      (signal) => runtime.stop(signal),
      true,
    );
  let initialized = false;
  const report = async () => {
    await persist();
    await save(join(plan.output, "report.json"), {
      status: ledger.status,
      evaluated: 0,
      judge: "pending #49",
      projectAcceptance: "not assessed",
      scheduled: plan.slots.length,
      attempted: attempts.length,
      unrun: ledger.unrun,
      controls: ledger.controls,
      budget: ledger.budget,
      cleanup: ledger.cleanup,
      attempts,
    });
    await writeFile(
      join(plan.output, "report.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Implementation benchmark</title><h1>Implementation benchmark</h1><p>${attempts.length}/${plan.slots.length} slots attempted. ${ledger.status}. 0 candidates evaluated. Independent judging is pending #49. Project acceptance is not assessed.</p>`,
      { mode: 0o600 },
    );
    return {
      output: plan.output,
      status: ledger.status,
      completed: attempts.length,
    };
  };
  try {
    try {
      await readFile(join(plan.output, "execution.json"));
      throw new Error(
        "An existing execution is retained; durable recovery requires #48",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((await readdir(plan.output)).some((name) => name !== "benchmark.lock"))
      throw new Error(
        "Benchmark output is not empty; select a fresh external directory",
      );
    await save(join(plan.output, "manifest.json"), plan);
    await persist();
    initialized = true;
    const attemptMs =
      allowances.setupMs +
      allowances.implementationMs +
      allowances.sealMs +
      allowances.checksMs +
      allowances.cleanupMs +
      allowances.judgeMs;
    const slotLimit = Math.min(
      maxNewSlots,
      allowances.maxSlotsPerDispatch ?? Infinity,
    );
    if (
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
    else if (dependencies.signal?.aborted) ledger.status = "cancelled";
    else {
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
      for (const control of launch.checking.controls) {
        const root = await mkdtemp(
          join(dirname(plan.output), ".benchmark-control-"),
        );
        const controlPhases: Attempt["phases"] = [];
        let runtime: BenchmarkRuntime | undefined;
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
          runtime = await setup(
            { plan, root, worktree: source.worktree, role: "control" },
            controlPhases,
          );
          await prepareRuntime(runtime, controlPhases);
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
            (signal) => runtime!.exec({ command: plan.check!, signal }),
          );
          const output =
            runtime.redact?.(`${checked.stdout}\n${checked.stderr}`) ??
            `${checked.stdout}\n${checked.stderr}`;
          await writeFile(join(plan.output, `${control.kind}.log`), output, {
            mode: 0o600,
          });
          const result = {
            ...control,
            exitCode: checked.exitCode,
            status: "unavailable",
            outputSha256: hash(output),
            phases: controlPhases,
          };
          ledger.controls.results.push(result);
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
          const resources = (error as { resources?: string[] }).resources;
          if (resources?.length) {
            ledger.cleanup.status = "failed";
            ledger.cleanup.resources.push(...resources, root);
          }
          throw error;
        } finally {
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
        for (const slot of plan.slots.slice(0, slotLimit)) {
          if (dependencies.signal?.aborted) {
            ledger.status = "cancelled";
            break;
          }
          if (
            remaining() < attemptMs ||
            allowances.maxCalls -
              ledger.budget.implementationCalls -
              ledger.budget.judgeReservedCalls <
              2
          ) {
            ledger.status = "budget-exhausted";
            break;
          }
          ledger.budget.judgeReservedMs += allowances.judgeMs;
          ledger.budget.judgeReservedCalls++;
          const attempt: Attempt = {
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
          ledger.unrun.shift();
          await persist();
          const root = await mkdtemp(
            join(dirname(plan.output), ".benchmark-attempt-"),
          );
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
            const prompt = `Implement exactly this frozen task in one invocation. Do not delegate or invoke another agent. Keep edits inside ${JSON.stringify(launch.allowedEdits)}. Candidate commits or completion messages do not establish acceptance.\n\n${plan.tickets[slot.ticket]!.text}\n\nFrozen governing instructions:\n${launch.instructions.map((file) => `${file.path}\n${file.text}`).join("\n\n")}`;
            const built = provider.buildPrintCommand({
              prompt,
              dangerouslySkipPermissions: true,
            });
            let stream = "";
            let usage: IterationUsage | null = null;
            let sessionId: string | null = null;
            const observe = (line: string) => {
              stream += `${redact(line)}\n`;
              for (const event of provider.parseStreamLine(line)) {
                if (event.type === "usage") usage = event.usage;
                if (event.type === "session_id") sessionId = event.sessionId;
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
              attempt.implementation ??= {
                exitCode: null,
                usage,
                streamSha256: hash(stream),
                requested: { ...arm, serviceTier: "default" },
                observed: null,
              };
              await writeFile(
                join(plan.output, `${slot.id}-implementation.jsonl`),
                stream,
                { mode: 0o600 },
              );
              await save(join(plan.output, `${slot.id}-provenance.json`), {
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
                    slot.id,
                    redact,
                    signal,
                  );
                  if (attempt.implementation)
                    Object.assign(attempt.implementation, captured);
                  return seal(
                    plan,
                    slot.id,
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
                if (
                  dependencies.signal?.aborted ||
                  attempt.status === "timed-out" ||
                  attempt.status === "cancelled"
                )
                  throw new PhaseFailure(
                    dependencies.signal?.aborted ? "cancelled" : "timed-out",
                    "Configured checks did not run after interrupted implementation",
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
                  (signal) => checker!.exec({ command: plan.check!, signal }),
                );
                const output = redact(`${checked.stdout}\n${checked.stderr}`);
                await writeFile(
                  join(plan.output, `${slot.id}-check.log`),
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
              }
            }
          } catch (error) {
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
            attempt.reason =
              error instanceof PhaseFailure
                ? error.message
                : attempt.candidate
                  ? "Protected checking runtime unavailable"
                  : "Candidate sealing failed";
            if (attempt.candidate)
              attempt.check = {
                ...attempt.check,
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
              await rm(join(plan.output, "candidates", slot.id), {
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
              } catch {
                attempt.cleanup.status = "failed";
                attempt.cleanup.resources.push(root);
              }
            } else attempt.cleanup.resources.push(root);
            if (!attempt.candidate) {
              ledger.budget.judgeReservedMs -= allowances.judgeMs;
              ledger.budget.judgeReservedCalls--;
            }
            attempt.finishedAt = new Date(now()).toISOString();
            await persist();
          }
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
          : "partial";
    }
  } catch (error) {
    if (!initialized) throw error;
    ledger.status =
      ledger.cleanup.status === "failed"
        ? "cleanup-failed"
        : error instanceof PhaseFailure
          ? error.outcome
          : "environment-unavailable";
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
        } catch {
          ledger.cleanup.status = "failed";
          ledger.cleanup.resources.push(join(plan.output, "protected"));
        }
        if (ledger.cleanup.status === "failed")
          ledger.status = "cleanup-failed";
        await report();
      }
    } finally {
      await lock.close();
      await rm(join(plan.output, "benchmark.lock"), { force: true });
    }
  }
  return {
    output: plan.output,
    status: ledger.status,
    completed: attempts.length,
  };
};
