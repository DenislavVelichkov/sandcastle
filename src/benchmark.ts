import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AgentProvider } from "./AgentProvider.js";
import type { WorktreeRunResult } from "./createWorktree.js";
import type { PilotBudgetState } from "./pilotBudget.js";
import {
  resumeDurableWorkflow,
  runDurableWorkflow,
  workflowStatus,
  type DurableWorkflowOptions,
  type WorkflowSnapshot,
} from "./workflowControl.js";
import {
  pilotConfigurations,
  type AccountObservation,
} from "./workflowUsage.js";

export const benchmarkFixtures = [
  {
    id: "stream-log",
    split: "development",
    kind: "regression",
    base: "c505d4964ce6806211259e8bff9ad1d8c319a9ef",
    reference: "badf657b5dc81a71c141d8cd736a67804c6a86ff",
    focus:
      "Keep raw streamed chunks contiguous and start later structured file-log entries on a new line",
  },
  {
    id: "output-retry",
    split: "development",
    kind: "feature",
    base: "2867118a575faa697b000be87d429900804786cf",
    reference: "9f3f6d5c5f2527d5e1d8349f80eec2d36e797540",
    focus:
      "Bound structured-output retries with default zero, session checks, exhaustion errors and caps",
  },
  {
    id: "merge-to-head",
    split: "held-out",
    kind: "regression",
    base: "2867118a575faa697b000be87d429900804786cf",
    reference: "f7879c5ca6853c6afa79cb836d918de8de64db03",
    focus:
      "Reach the disposable target from affected entry points while preserving the reusable source branch",
  },
  {
    id: "sandbox-handle",
    split: "held-out",
    kind: "feature",
    base: "f1aa0809d097db0d5c674e13c9ac3374ba2a629b",
    reference: "0f577a42fdbfe49111b8e00694399ee0c9ddd559",
    focus:
      "Public execution on reusable sandbox handles with working-directory and nonzero-exit behavior",
  },
] as const;

type Fixture = (typeof benchmarkFixtures)[number];
export type BenchmarkArm = number | "adaptive";
export interface BenchmarkSlot {
  readonly id: string;
  readonly fixture: Fixture["id"];
  readonly split: Fixture["split"];
  readonly repetition: 1 | 2;
  readonly arm: BenchmarkArm;
}

/** Replication two reverses the fixed arm order within each case. */
const fixedSlots = benchmarkFixtures.flatMap((fixture) =>
  ([1, 2] as const).flatMap((repetition) =>
    pilotConfigurations.map((_, index) => ({
      id: `${fixture.id}-${repetition}-${index}`,
      fixture: fixture.id,
      split: fixture.split,
      repetition,
      arm: repetition === 1 ? index : 6 - index,
    })),
  ),
);
export const benchmarkSlots: readonly BenchmarkSlot[] = [
  ...fixedSlots.filter((slot) => slot.split === "development"),
  ...fixedSlots.filter((slot) => slot.split === "held-out"),
  ...benchmarkFixtures.flatMap((fixture) =>
    ([1, 2] as const).map((repetition) => ({
      id: `${fixture.id}-${repetition}-adaptive`,
      fixture: fixture.id,
      split: fixture.split,
      repetition,
      arm: "adaptive" as const,
    })),
  ),
];

export interface BenchmarkCost {
  readonly lower: number;
  readonly upper: number;
  readonly durationMs: number;
  readonly before: AccountObservation;
  readonly after: AccountObservation;
}
export interface BenchmarkEvaluation {
  readonly slotId: string;
  readonly invocationId: string;
  readonly fixture: BenchmarkFixtureReceipt;
  readonly worktree: string;
  readonly sessionIds: readonly string[];
  readonly requested: string;
  readonly effective: string | null;
  readonly status: "accepted" | "incomplete";
  readonly firstIterationSuccess: boolean;
  readonly reviewPassed: boolean;
  readonly falseAcceptance: boolean;
  readonly cost: Readonly<Record<string, BenchmarkCost>> | null;
  readonly usage: WorkflowSnapshot["usage"] | null;
  readonly reason?: string;
  readonly interruptions?: readonly string[];
}
export interface BenchmarkFixtureReceipt {
  readonly fixtureId: Fixture["id"];
  readonly base: string;
  readonly reference: string;
  readonly exportHead: string;
  readonly tree: string;
}
export interface BenchmarkProbe {
  readonly status: "passed" | "implementation-failure" | "environment-failure";
  readonly reason: string;
  readonly evidence: readonly string[];
}
export interface BenchmarkPair {
  readonly start: number;
  readonly fallback: number;
  readonly rule: "independent-implementation-failure";
}
export interface BenchmarkLedger {
  readonly version: 1;
  readonly protocolHash: string;
  readonly policyId: string;
  readonly accountResolution?: Readonly<Record<string, number>>;
  readonly windowDurationMs?: Readonly<Record<string, number>>;
  readonly fixtureConditions?: Readonly<Record<string, string>>;
  readonly evaluations: readonly BenchmarkEvaluation[];
  readonly pair?: BenchmarkPair;
  readonly promotion?: "admitted" | "fixed-policy";
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const benchmarkProtocolHash = hash({
  benchmarkFixtures,
  benchmarkSlots,
  pilotConfigurations,
});
const ledgerPath = (directory: string) => join(directory, "benchmark.json");
const withBenchmarkLock = async <T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "benchmark.lock");
  await mkdir(lock);
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

/** Export one historical tree without its answer-bearing Git history. Invocation belongs to the later pilot's clock. */
export const exportBenchmarkFixture = async (input: {
  source: string;
  fixtureId: Fixture["id"];
  directory: string;
  grade: (worktree: string) => Promise<boolean>;
}): Promise<BenchmarkFixtureReceipt> => {
  const fixture = benchmarkFixtures.find((item) => item.id === input.fixtureId);
  if (!fixture) throw new Error("Unknown historical fixture");
  return exportFixtureTree(input, {
    fixtureId: fixture.id,
    base: fixture.base,
    reference: fixture.reference,
  });
};

/** Internal tree operation, also exercised with disposable synthetic commits. */
export const exportFixtureTree = async (
  input: {
    source: string;
    directory: string;
    grade: (worktree: string) => Promise<boolean>;
  },
  fixture: Pick<BenchmarkFixtureReceipt, "fixtureId" | "base" | "reference">,
): Promise<BenchmarkFixtureReceipt> => {
  if (!isAbsolute(input.directory) || !outside(input.source, input.directory))
    throw new Error(
      "Fixture export needs a known case and new external directory",
    );
  if (
    git(input.source, "rev-parse", fixture.base) !== fixture.base ||
    git(input.source, "rev-parse", fixture.reference) !== fixture.reference
  )
    throw new Error("Historical fixture identity changed");
  await mkdir(input.directory, { mode: 0o700 });
  const archive = execFileSync(
    "git",
    ["archive", "--format=tar", fixture.base],
    { cwd: input.source, maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", input.directory], { input: archive });
  git(input.directory, "init", "-b", "main");
  git(input.directory, "config", "user.name", "Sandcastle fixture");
  git(input.directory, "config", "user.email", "fixture@example.invalid");
  git(input.directory, "add", ".");
  git(input.directory, "commit", "-m", "Answer-free benchmark base");
  const exportHead = git(input.directory, "rev-parse", "HEAD");
  const tree = git(input.source, "rev-parse", `${fixture.base}^{tree}`);
  if (git(input.directory, "rev-parse", "HEAD^{tree}") !== tree)
    throw new Error("Exported fixture differs from the historical base tree");
  if (await input.grade(input.directory))
    throw new Error("Historical base unexpectedly passed protected grading");
  if (
    git(input.directory, "status", "--porcelain") ||
    git(input.directory, "rev-parse", "HEAD") !== exportHead
  )
    throw new Error("Protected base grading changed the fixture");
  const correction = execFileSync(
    "git",
    ["diff", "--binary", fixture.base, fixture.reference],
    { cwd: input.source, maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("git", ["apply", "--binary", "-"], {
    cwd: input.directory,
    input: correction,
  });
  const corrected = await input.grade(input.directory);
  git(input.directory, "reset", "--hard", exportHead);
  git(input.directory, "clean", "-fdx");
  if (
    !corrected ||
    git(input.directory, "status", "--porcelain") ||
    git(input.directory, "rev-list", "--count", "HEAD") !== "1"
  )
    throw new Error(
      "Historical correction failed preflight or the export is dirty",
    );
  return {
    fixtureId: fixture.fixtureId,
    base: fixture.base,
    reference: fixture.reference,
    exportHead,
    tree,
  };
};

const save = async (
  directory: string,
  ledger: BenchmarkLedger,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = ledgerPath(directory);
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(ledger));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
};

export const readBenchmark = async (
  directory: string,
  policyId: string,
): Promise<BenchmarkLedger> => {
  if (!isAbsolute(directory) || !policyId)
    throw new Error(
      "Benchmark needs an absolute host directory and policy identity",
    );
  let ledger: BenchmarkLedger;
  try {
    ledger = JSON.parse(
      await readFile(ledgerPath(directory), "utf8"),
    ) as BenchmarkLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    ledger = {
      version: 1,
      protocolHash: benchmarkProtocolHash,
      policyId,
      evaluations: [],
    };
  }
  if (
    ledger.version !== 1 ||
    ledger.protocolHash !== benchmarkProtocolHash ||
    ledger.policyId !== policyId
  )
    throw new Error("Benchmark protocol or policy identity changed");
  return ledger;
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(realpathSync(dirname(path)), basename(path));
  }
};
const outside = (root: string, path: string): boolean => {
  const rel = relative(canonical(root), canonical(path));
  return rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel);
};

/** The caller's project supplies the protected grader and ordinary acceptance gates. */
export const runBenchmarkEvaluation = async (input: {
  directory: string;
  slotId: string;
  options: DurableWorkflowOptions;
  /** Continue the same incomplete slot through verified controller recovery. */
  resume?: boolean;
  protectedGrader: string;
  fixture: BenchmarkFixtureReceipt;
  /** Hash of frozen task prompt, tools, cache, non-implementation roles and project gates. */
  conditionsHash: string;
  accountResolution: Readonly<Record<string, number>>;
  windowDurationMs: Readonly<Record<string, number>>;
  settled: boolean;
  reviewPassed: boolean;
  falseAcceptance?: boolean;
  /** Trusted project-owned check, run after the first candidate before a second model call. */
  probe: (candidate: {
    readonly worktree: string;
    readonly head: string;
    readonly grader: string;
  }) => Promise<BenchmarkProbe>;
  /** Host-verified effective worker configuration; per-response identity may remain unknown. */
  effective: {
    readonly model: string;
    readonly effort: string;
    readonly serviceTier: "default";
    readonly source: string;
  };
  fallbackEffective?: {
    readonly model: string;
    readonly effort: string;
    readonly serviceTier: "default";
    readonly source: string;
  };
}): Promise<BenchmarkEvaluation> =>
  withBenchmarkLock(input.directory, async () => {
    const { options } = input;
    const usage = options.usage;
    if (
      !usage ||
      usage.activity !== "pilot" ||
      usage.pilot?.directory !== input.directory
    )
      throw new Error(
        "Benchmark evaluation needs the installed pilot controller and shared budget",
      );
    const slot = benchmarkSlots.find((item) => item.id === input.slotId);
    if (!slot) throw new Error("Unknown benchmark slot");
    const ledger = await readBenchmark(input.directory, usage.policyId);
    if (
      !Object.keys(input.accountResolution).length ||
      Object.values(input.accountResolution).some(
        (value) => !Number.isFinite(value) || value <= 0,
      ) ||
      Object.keys(input.accountResolution).sort().join() !==
        Object.keys(input.windowDurationMs).sort().join() ||
      Object.values(input.windowDurationMs).some(
        (value) => !Number.isFinite(value) || value <= 0,
      ) ||
      !input.conditionsHash
    )
      throw new Error(
        "Benchmark conditions and account precision must be declared before dispatch",
      );
    if (
      ledger.accountResolution &&
      hash(ledger.accountResolution) !== hash(input.accountResolution)
    )
      throw new Error("Account measurement precision changed during benchmark");
    if (
      ledger.windowDurationMs &&
      hash(ledger.windowDurationMs) !== hash(input.windowDurationMs)
    )
      throw new Error("Account window durations changed during benchmark");
    if (
      ledger.fixtureConditions?.[slot.fixture] &&
      ledger.fixtureConditions[slot.fixture] !== input.conditionsHash
    )
      throw new Error("Matched fixture conditions changed during benchmark");
    const prior = ledger.evaluations.find((item) => item.slotId === slot.id);
    if (input.resume ? prior?.status !== "incomplete" : Boolean(prior))
      throw new Error(
        "Benchmark slot is not eligible for this start or continuation",
      );
    if (
      !input.resume &&
      ledger.evaluations.some((item) => item.status === "incomplete")
    )
      throw new Error(
        "Recover or report the incomplete evaluation before starting another slot",
      );
    if (ledger.evaluations.length >= 64 && !input.resume)
      throw new Error("Benchmark evaluation limit reached");
    if (
      (input.resume
        ? ledger.evaluations.at(-1)?.slotId
        : benchmarkSlots[ledger.evaluations.length]?.id) !== slot.id
    )
      throw new Error(
        "Benchmark evaluations must follow the frozen sequential order",
      );
    const budget = JSON.parse(
      await readFile(join(input.directory, "budget.json"), "utf8"),
    ) as PilotBudgetState;
    if (
      budget.evaluations !== ledger.evaluations.length ||
      (budget.activeInvocationId &&
        budget.activeInvocationId !== (input.resume ? slot.id : undefined)) ||
      !Object.values(budget.episodes).some(
        (episode) => episode.activity === "measurement" && episode.complete,
      )
    )
      throw new Error(
        "Pilot measurement, evaluation count or unfinished invocation disagrees with the benchmark ledger",
      );
    if (slot.split === "held-out" && !ledger.pair && !ledger.promotion)
      throw new Error("Freeze development routing before held-out outcomes");
    if (slot.arm === "adaptive" && !ledger.pair)
      throw new Error("Adaptive evaluation needs a frozen routing pair");
    if (slot.arm !== "adaptive" && slot.split === "development" && ledger.pair)
      throw new Error("Development configuration was frozen");
    if (options.policy.iterations !== 2 || options.selected.length !== 1)
      throw new Error(
        "Each evaluation needs one task and two reserved implementation iterations",
      );
    const worktree = options.worktrees[options.selected[0]!.id];
    if (
      !input.resume &&
      (options.resume ||
        ledger.evaluations.some(
          (item) => item.worktree === worktree?.worktreePath,
        ))
    )
      throw new Error("Each new evaluation needs a fresh worktree and session");
    const historical = benchmarkFixtures.find(
      (item) => item.id === slot.fixture,
    )!;
    if (
      !worktree ||
      input.fixture.fixtureId !== historical.id ||
      input.fixture.base !== historical.base ||
      input.fixture.reference !== historical.reference ||
      (!input.resume &&
        input.fixture.exportHead !==
          git(worktree.worktreePath, "rev-parse", "HEAD")) ||
      (!input.resume &&
        input.fixture.tree !==
          git(worktree.worktreePath, "rev-parse", "HEAD^{tree}")) ||
      (input.resume &&
        prior?.fixture.exportHead !== input.fixture.exportHead) ||
      (input.resume &&
        git(
          worktree.worktreePath,
          "merge-base",
          input.fixture.exportHead,
          "HEAD",
        ) !== input.fixture.exportHead) ||
      !outside(worktree.worktreePath, input.protectedGrader) ||
      !outside(worktree.worktreePath, input.directory) ||
      (!input.resume &&
        git(worktree.worktreePath, "rev-list", "--count", "HEAD") !== "1") ||
      (!input.resume && git(worktree.worktreePath, "status", "--porcelain"))
    )
      throw new Error(
        "Evaluation needs a clean answer-free fixture and external grader/state",
      );
    const configured =
      options.policy.roles.implementation?.agent.codexConfiguration;
    const expected =
      slot.arm === "adaptive"
        ? pilotConfigurations[ledger.pair!.start]
        : pilotConfigurations[slot.arm];
    if (
      !expected ||
      configured?.model !== expected.model ||
      configured.effort !== expected.effort ||
      configured.serviceTier !== "default"
    )
      throw new Error(
        "Requested implementation configuration differs from the frozen arm",
      );
    if (
      !input.effective.source ||
      input.effective.model !== configured.model ||
      input.effective.effort !== configured.effort ||
      input.effective.serviceTier !== configured.serviceTier
    )
      throw new Error(
        "Effective worker configuration is unverified or rerouted",
      );
    if (options.invocationId !== slot.id)
      throw new Error("Invocation identity must match the frozen slot");
    const fallback =
      slot.arm === "adaptive"
        ? pilotConfigurations[ledger.pair!.fallback]
        : expected;
    const fallbackAssignment =
      slot.arm === "adaptive"
        ? options.policy.implementationFallback
        : options.policy.roles.implementation;
    const fallbackConfig = fallbackAssignment?.agent.codexConfiguration;
    if (
      !fallback ||
      !fallbackAssignment ||
      fallbackConfig?.model !== fallback.model ||
      fallbackConfig.effort !== fallback.effort ||
      fallbackConfig.serviceTier !== "default"
    )
      throw new Error("Second iteration differs from the frozen configuration");
    if (
      slot.arm === "adaptive" &&
      (!input.fallbackEffective?.source ||
        input.fallbackEffective.model !== fallback.model ||
        input.fallbackEffective.effort !== fallback.effort ||
        input.fallbackEffective.serviceTier !== "default")
    )
      throw new Error(
        "Fallback worker configuration is unverified or rerouted",
      );
    let activeAssignment = options.policy.roles.implementation!;
    const startAgent = activeAssignment.agent;
    const selectedAgent: AgentProvider = {
      ...startAgent,
      get codexConfiguration() {
        return activeAssignment.agent.codexConfiguration;
      },
      buildPrintCommand: (command) =>
        activeAssignment.agent.buildPrintCommand(command),
      parseStreamLine: (line) => activeAssignment.agent.parseStreamLine(line),
    };
    const wrappedWorktree = {
      ...worktree,
      run: async (
        runOptions: Parameters<typeof worktree.run>[0],
      ): Promise<WorktreeRunResult> => {
        if (runOptions.maxIterations !== 2) {
          if (input.resume && runOptions.agent === selectedAgent) {
            try {
              const action = JSON.parse(
                await readFile(
                  join(options.directory, "benchmark-action.json"),
                  "utf8",
                ),
              ) as { slotId: string; model: string; effort: string };
              if (
                action.slotId !== slot.id ||
                action.model !== fallback.model ||
                action.effort !== fallback.effort
              )
                throw new Error("Recorded benchmark retry action changed");
              activeAssignment = fallbackAssignment;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          return worktree.run(runOptions);
        }
        const first = await worktree.run({ ...runOptions, maxIterations: 1 });
        const head = git(worktree.worktreePath, "rev-parse", "HEAD");
        if (git(worktree.worktreePath, "status", "--porcelain"))
          throw new Error("First implementation left uncommitted changes");
        const finding = await input.probe({
          worktree: worktree.worktreePath,
          head,
          grader: input.protectedGrader,
        });
        if (
          git(worktree.worktreePath, "rev-parse", "HEAD") !== head ||
          git(worktree.worktreePath, "status", "--porcelain")
        )
          throw new Error(
            "Protected first-iteration check changed the candidate",
          );
        if (finding.status === "passed") return first;
        if (
          finding.status !== "implementation-failure" ||
          !finding.reason ||
          !finding.evidence.length
        )
          throw new Error(
            `Independent check did not authorize another implementation: ${finding.reason}`,
          );
        const sessionId = first.iterations.at(-1)?.sessionId;
        activeAssignment = fallbackAssignment;
        const taskPrompt = sessionId
          ? ""
          : (runOptions.prompt ??
            (runOptions.promptFile
              ? await readFile(runOptions.promptFile, "utf8")
              : ""));
        if (!sessionId && !taskPrompt)
          throw new Error("Diagnostic handoff needs the original task prompt");
        const diagnostic = `${taskPrompt ? `Original task: ${taskPrompt}\n` : ""}Task ${options.selected[0]!.reference}. Verified source ${head}. Independent check: ${finding.reason}. Evidence: ${finding.evidence.join(", ")}. One implementation iteration remains.`;
        const actionPath = join(options.directory, "benchmark-action.json");
        const action = await open(actionPath, "wx", 0o600);
        try {
          await action.writeFile(
            JSON.stringify({
              slotId: slot.id,
              head,
              sessionId: sessionId ?? null,
              model: fallback.model,
              effort: fallback.effort,
              finding,
              diagnostic,
            }),
          );
          await action.sync();
        } finally {
          await action.close();
        }
        const second = await worktree.run({
          ...runOptions,
          maxIterations: 1,
          agent: selectedAgent,
          ...(sessionId ? { resumeSession: sessionId } : {}),
          prompt: diagnostic,
          promptFile: undefined,
        });
        return {
          ...second,
          iterations: [...first.iterations, ...second.iterations],
          commits: [...first.commits, ...second.commits],
        };
      },
    };
    const wrappedOptions = {
      ...options,
      worktrees: {
        ...options.worktrees,
        [options.selected[0]!.id]: wrappedWorktree,
      },
      policy: {
        ...options.policy,
        roles: {
          ...options.policy.roles,
          implementation: { ...activeAssignment, agent: selectedAgent },
        },
      },
    };
    const frozenLedger: BenchmarkLedger = {
      ...ledger,
      accountResolution: ledger.accountResolution ?? input.accountResolution,
      windowDurationMs: ledger.windowDurationMs ?? input.windowDurationMs,
      fixtureConditions: {
        ...ledger.fixtureConditions,
        [slot.fixture]: input.conditionsHash,
      },
    };
    await save(input.directory, frozenLedger);
    // The existing controller owns catalog checks, account guards, role reservations and the shared four-hour budget.
    let snapshot: WorkflowSnapshot | undefined;
    let failure: string | undefined;
    try {
      snapshot = input.resume
        ? await resumeDurableWorkflow(wrappedOptions)
        : await runDurableWorkflow(wrappedOptions);
    } catch (error) {
      failure = String(error);
      try {
        snapshot = await workflowStatus(options.directory);
      } catch {
        /* no state was published */
      }
    }
    const actual = snapshot?.usage?.requested.implementation;
    const after = snapshot?.usage?.latest;
    const before =
      snapshot?.usage?.accountHistory[1]?.reading ??
      snapshot?.usage?.accountHistory[0]?.reading;
    const comparable = Boolean(
      input.settled &&
      snapshot?.usage &&
      !snapshot.usage.resetContinuations.length &&
      before &&
      after,
    );
    const cost: Record<string, BenchmarkCost> = {};
    if (comparable)
      for (const [name, resolution] of Object.entries(
        input.accountResolution,
      )) {
        const a = before!.windows[name];
        const b = after!.windows[name];
        if (
          !a ||
          !b ||
          a.resetsAt !== b.resetsAt ||
          !Number.isFinite(resolution) ||
          resolution <= 0 ||
          b.usedPercent < a.usedPercent
        )
          continue;
        const delta = b.usedPercent - a.usedPercent;
        cost[name] = {
          lower: Math.max(0, delta - resolution),
          upper: delta + resolution,
          durationMs: input.windowDurationMs[name]!,
          before: before!,
          after: after!,
        };
      }
    const accepted =
      snapshot?.tasks[options.selected[0]!.id]?.status === "accepted" &&
      input.reviewPassed &&
      !input.falseAcceptance;
    const sessionIds = Object.values(snapshot?.sessions ?? {}).flatMap(
      (items) => items.map((item) => item.id),
    );
    const priorSessionIds = new Set(
      ledger.evaluations
        .filter((item) => item.slotId !== slot.id)
        .flatMap((item) => item.sessionIds),
    );
    const isolatedSessions =
      sessionIds.length > 0 &&
      sessionIds.every((id) => !priorSessionIds.has(id));
    const reason =
      failure ??
      snapshot?.tasks[options.selected[0]!.id]?.reason ??
      snapshot?.failure ??
      (input.falseAcceptance
        ? "Protected grading found false acceptance"
        : !input.reviewPassed
          ? "Required review did not pass"
          : !isolatedSessions
            ? "Provider session identity is missing or reused"
            : undefined);
    const result: BenchmarkEvaluation = {
      slotId: slot.id,
      invocationId: options.invocationId,
      fixture: input.fixture,
      worktree: worktree.worktreePath,
      sessionIds,
      requested: `${configured.model}/${configured.effort}/default`,
      effective: `${input.effective.model}/${input.effective.effort}/${input.effective.serviceTier} (${input.effective.source})${slot.arm === "adaptive" ? `; fallback ${input.fallbackEffective!.model}/${input.fallbackEffective!.effort}/${input.fallbackEffective!.serviceTier} (${input.fallbackEffective!.source})` : ""}`,
      status: accepted && isolatedSessions ? "accepted" : "incomplete",
      firstIterationSuccess:
        accepted &&
        isolatedSessions &&
        snapshot?.usage?.remaining[options.selected[0]!.id]?.implementation ===
          1,
      reviewPassed: input.reviewPassed,
      falseAcceptance: Boolean(input.falseAcceptance),
      cost:
        comparable &&
        Object.keys(cost).length === Object.keys(before!.windows).length
          ? cost
          : null,
      usage: snapshot?.usage ?? null,
      ...(prior?.reason
        ? { interruptions: [...(prior.interruptions ?? []), prior.reason] }
        : {}),
      ...(reason ? { reason } : {}),
    };
    await save(input.directory, {
      ...frozenLedger,
      evaluations: input.resume
        ? [...ledger.evaluations.slice(0, -1), result]
        : [...ledger.evaluations, result],
    });
    return result;
  });

const resultsFor = (
  ledger: BenchmarkLedger,
  split: Fixture["split"],
  arm: BenchmarkArm,
): BenchmarkEvaluation[] =>
  ledger.evaluations.filter((result) => {
    const slot = benchmarkSlots.find((item) => item.id === result.slotId);
    return slot?.split === split && slot.arm === arm;
  });
const comparableUpper = (
  candidate: BenchmarkEvaluation[],
  reference: BenchmarkEvaluation[],
): number[] | null => {
  const names = Object.keys(reference[0]?.cost ?? {});
  if (
    !names.length ||
    candidate.length !== reference.length ||
    [...candidate, ...reference].some(
      (result) =>
        !result.cost || Object.keys(result.cost).join() !== names.join(),
    )
  )
    return null;
  return names.map((name) => {
    const upper = candidate.reduce(
      (sum, item) => sum + item.cost![name]!.upper,
      0,
    );
    const lower = reference.reduce(
      (sum, item) => sum + item.cost![name]!.lower,
      0,
    );
    return lower > 0 ? upper / lower : Infinity;
  });
};
const savingsEachRepetition = (
  candidate: BenchmarkEvaluation[],
  reference: BenchmarkEvaluation[],
): boolean => {
  const bySlot = (items: BenchmarkEvaluation[]) =>
    new Map(
      items.map((item) => {
        const slot = benchmarkSlots.find((entry) => entry.id === item.slotId)!;
        return [`${slot.fixture}/${slot.repetition}`, item];
      }),
    );
  const referenceBySlot = bySlot(reference);
  return candidate.every((item) => {
    const slot = benchmarkSlots.find((entry) => entry.id === item.slotId)!;
    const baseline = referenceBySlot.get(`${slot.fixture}/${slot.repetition}`);
    if (!item.cost || !baseline?.cost) return false;
    return Object.keys(item.cost).every(
      (name) =>
        baseline.cost?.[name] &&
        baseline.cost[name]!.lower > 0 &&
        item.cost![name]!.upper < baseline.cost[name]!.lower,
    );
  });
};
const costOrder = (
  a: BenchmarkEvaluation[],
  b: BenchmarkEvaluation[],
): number => {
  const windows = Object.keys(a[0]?.cost ?? {}).sort(
    (x, y) => a[0]!.cost![x]!.durationMs - a[0]!.cost![y]!.durationMs,
  );
  for (const name of windows) {
    const av = a.reduce(
      (sum, item) => sum + (item.cost?.[name]?.upper ?? Infinity),
      0,
    );
    const bv = b.reduce(
      (sum, item) => sum + (item.cost?.[name]?.upper ?? Infinity),
      0,
    );
    if (av !== bv) return av - bv;
  }
  return 0;
};

export const freezeBenchmarkPair = async (
  directory: string,
  policyId: string,
): Promise<BenchmarkPair | null> =>
  withBenchmarkLock(directory, async () => {
    const ledger = await readBenchmark(directory, policyId);
    if (!ledger.accountResolution || !ledger.windowDurationMs)
      throw new Error("Account measurement policy was not frozen");
    if (ledger.pair) return ledger.pair;
    if (ledger.promotion) return null;
    if (
      ledger.evaluations.some(
        (item) =>
          benchmarkSlots.find((slot) => slot.id === item.slotId)?.split ===
          "held-out",
      )
    )
      throw new Error("Held-out evidence was exposed before routing froze");
    const arms = pilotConfigurations.map((_, index) =>
      resultsFor(ledger, "development", index),
    );
    if (arms.some((items) => items.length !== 4))
      throw new Error(
        "All 28 fixed development evaluations must be attempted before routing freezes",
      );
    const qualified = arms.map((items) =>
      items.every(
        (item) =>
          item.status === "accepted" &&
          item.reviewPassed &&
          !item.falseAcceptance,
      ),
    );
    const reference = arms[5]!;
    let pair: BenchmarkPair | undefined;
    if (
      qualified[5] &&
      reference.every(
        (item) =>
          item.cost &&
          item.usage?.tokens.attributableTotal &&
          !item.usage.tokens.unknown.length,
      )
    ) {
      const eligible = arms
        .map((items, index) => index)
        .filter(
          (index) =>
            index !== 5 &&
            qualified[index] &&
            arms[index]!.every(
              (item) =>
                item.usage?.tokens.attributableTotal &&
                !item.usage.tokens.unknown.length,
            ) &&
            comparableUpper(arms[index]!, reference)?.every(
              (ratio) => ratio <= 0.8,
            ),
        );
      eligible.sort((a, b) => costOrder(arms[a]!, arms[b]!) || a - b);
      const start = eligible[0];
      if (start !== undefined) {
        const fallback = arms
          .map((_, index) => index)
          .filter(
            (index) =>
              index !== start &&
              qualified[index] &&
              arms[index]!.every(
                (item) =>
                  item.cost &&
                  item.usage?.tokens.attributableTotal &&
                  !item.usage.tokens.unknown.length,
              ),
          );
        fallback.sort(
          (a, b) =>
            arms[b]!.filter((item) => item.firstIterationSuccess).length -
              arms[a]!.filter((item) => item.firstIterationSuccess).length ||
            costOrder(arms[a]!, arms[b]!) ||
            (a === 5 ? -1 : b === 5 ? 1 : a - b),
        );
        if (fallback[0] !== undefined)
          pair = {
            start,
            fallback: fallback[0],
            rule: "independent-implementation-failure",
          };
      }
    }
    await save(
      directory,
      pair ? { ...ledger, pair } : { ...ledger, promotion: "fixed-policy" },
    );
    return pair ?? null;
  });

/** Only complete matched held-out evidence can admit the frozen policy. */
export const assessBenchmarkPromotion = async (
  directory: string,
  policyId: string,
): Promise<"admitted" | "fixed-policy"> =>
  withBenchmarkLock(directory, async () => {
    const ledger = await readBenchmark(directory, policyId);
    if (!ledger.accountResolution || !ledger.windowDurationMs)
      throw new Error("Account measurement policy was not frozen");
    if (ledger.promotion) return ledger.promotion;
    if (!ledger.pair) throw new Error("No frozen adaptive policy");
    const adaptive = resultsFor(ledger, "held-out", "adaptive");
    const reference = resultsFor(ledger, "held-out", 5);
    if (
      ledger.evaluations.length !== 64 ||
      adaptive.length !== 4 ||
      reference.length !== 4
    )
      throw new Error(
        "All 64 scheduled evaluations are required for promotion assessment",
      );
    const quality = adaptive.every(
      (item) =>
        item.status === "accepted" &&
        item.reviewPassed &&
        !item.falseAcceptance,
    );
    const completeCost = [...adaptive, ...reference].every(
      (item) =>
        item.usage?.tokens.attributableTotal &&
        !item.usage.tokens.unknown.length &&
        item.cost,
    );
    const savings =
      (comparableUpper(adaptive, reference)?.every((ratio) => ratio <= 0.8) ??
        false) &&
      savingsEachRepetition(adaptive, reference);
    const promotion =
      quality && completeCost && savings ? "admitted" : "fixed-policy";
    await save(directory, { ...ledger, promotion });
    return promotion;
  });
