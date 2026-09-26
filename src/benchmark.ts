import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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

export interface FixedBenchmarkPlan {
  /** Discriminator for the explicit-arm study. */
  readonly kind: "fixed";
  /** Requested implementation arms in frozen launch order. */
  readonly arms: readonly { readonly model: string; readonly effort: string }[];
  /** Index of the explicit Sol High reference arm. */
  readonly reference: number;
  /** Sequential development and held-out evaluation order. */
  readonly slots: readonly BenchmarkSlot[];
  /** Shared active-time ceiling. */
  readonly overallLimitMs: number;
  /** Allowed account-window rise from the guard baseline. */
  readonly accountRiseLimitPercentPoints: number;
  /** Standard Codex credits per million tokens, frozen with this protocol. */
  readonly rates: Readonly<
    Record<
      string,
      {
        readonly input: number;
        readonly cachedInput: number;
        readonly output: number;
      }
    >
  >;
  /** Published source of the frozen Standard rates. */
  readonly rateSource: string;
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
  readonly status: "accepted" | "failed" | "incomplete";
  readonly technicalPassed?: boolean | null;
  readonly projectAccepted?: boolean | null;
  readonly taskStatus?: string | null;
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
  readonly preflight: {
    readonly base: BenchmarkPreflight;
    readonly correction: BenchmarkPreflight;
  };
}
export interface BenchmarkPreflight {
  readonly focusPassed: boolean;
  readonly otherGatesPassed: boolean;
  readonly evidence: readonly string[];
}
export interface BenchmarkProbe {
  readonly status:
    | "passed"
    | "implementation-failure"
    | "review-failure"
    | "environment-failure";
  readonly reason: string;
  readonly evidence: readonly string[];
}
const fixedRequiredRoles = [
  "standards-review-preview",
  "specification-review-preview",
  "implementation-rework",
  "standards-review",
  "specification-review",
] as const;
export interface BenchmarkPair {
  readonly start: number;
  readonly fallback: number;
  readonly rule: "independent-implementation-failure";
}
export type BenchmarkTaskClass =
  | "independently-gradable-regression"
  | "independently-gradable-bounded-feature";
export interface BenchmarkPolicyAdmission {
  readonly version: 1;
  readonly policyId: string;
  readonly protocolHash: string;
  readonly evidenceHash: string;
  readonly taskClass: BenchmarkTaskClass;
  readonly pair: BenchmarkPair;
}
export interface BenchmarkLedger {
  readonly version: 1;
  readonly protocolHash: string;
  readonly policyId: string;
  /** Fixed-study design; absent on the original adaptive ledger. */
  readonly plan?: FixedBenchmarkPlan;
  /** Development-only selection frozen before held-out work. */
  readonly fixedSelection?: {
    readonly arm: number | null;
    readonly reason: string;
  };
  /** Recorded held-out decision for the fixed study. */
  readonly fixedDisposition?: "qualified" | "retain-fixed";
  readonly hostConditionsHash?: string;
  readonly accountResolution?: Readonly<Record<string, number>>;
  readonly windowDurationMs?: Readonly<Record<string, number>>;
  readonly fixtureConditions?: Readonly<Record<string, string>>;
  readonly evaluations: readonly BenchmarkEvaluation[];
  readonly activities?: readonly {
    readonly label: string;
    readonly startedAt: number;
    readonly reservedMs: number;
    readonly actualMs?: number;
    readonly outcome: "reserved" | "complete" | "failed";
    readonly reason?: string;
  }[];
  readonly pair?: BenchmarkPair;
  readonly promotion?: "admitted" | "fixed-policy";
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Standard credit rates per million tokens frozen by the fixed protocol. */
export const standardCreditRates = {
  "gpt-6-astra": { input: 250, cachedInput: 25, output: 1250 },
  "gpt-6-sol": { input: 50, cachedInput: 5, output: 250 },
  "gpt-6-luna": { input: 2.5, cachedInput: 0.25, output: 12.5 },
} as const;
/** Validate explicit arms and create the counterbalanced fixed schedule. */
export const makeFixedBenchmarkPlan = (
  arms: readonly { readonly model: string; readonly effort: string }[],
): FixedBenchmarkPlan => {
  if (
    arms.length < 2 ||
    arms.length > 7 ||
    new Set(arms.map((arm) => `${arm.model}:${arm.effort}`)).size !==
      arms.length ||
    arms.some(
      (arm) =>
        !pilotConfigurations.some(
          (allowed) =>
            allowed.model === arm.model && allowed.effort === arm.effort,
        ),
    )
  )
    throw new Error(
      "Benchmark arms must be distinct supported model:effort pairs",
    );
  const reference = arms.findIndex(
    (arm) => arm.model === "gpt-6-sol" && arm.effort === "high",
  );
  if (reference < 0)
    throw new Error(
      "Fixed benchmark needs an explicit gpt-6-sol:high reference",
    );
  const slots = benchmarkFixtures.flatMap((fixture) =>
    ([1, 2] as const).flatMap((repetition) =>
      arms.map((_, index) => ({
        id: `${fixture.id}-${repetition}-${index}`,
        fixture: fixture.id,
        split: fixture.split,
        repetition,
        arm: repetition === 1 ? index : arms.length - 1 - index,
      })),
    ),
  );
  return {
    kind: "fixed",
    arms: arms.map((arm) => ({ model: arm.model, effort: arm.effort })),
    reference,
    slots: [
      ...slots.filter((slot) => slot.split === "development"),
      ...slots.filter((slot) => slot.split === "held-out"),
    ],
    overallLimitMs: 12 * 60 * 60_000,
    accountRiseLimitPercentPoints: 20,
    rates: standardCreditRates,
    rateSource: "https://learn.chatgpt.com/docs/pricing",
  };
};
/** Bind historical cases, schedule, arms and rates to one protocol identity. */
export const fixedBenchmarkProtocolHash = (plan: FixedBenchmarkPlan): string =>
  hash({ benchmarkFixtures, plan });
export const benchmarkProtocolHash = hash({
  benchmarkFixtures,
  benchmarkSlots,
  pilotConfigurations,
});
/** Create or verify a host-only fixed ledger before any model call. */
export const initializeFixedBenchmark = async (
  directory: string,
  policyId: string,
  arms: readonly { readonly model: string; readonly effort: string }[],
): Promise<BenchmarkLedger> =>
  withBenchmarkLock(directory, async () => {
    const plan = makeFixedBenchmarkPlan(arms);
    const protocolHash = fixedBenchmarkProtocolHash(plan);
    try {
      const prior = JSON.parse(
        await readFile(ledgerPath(directory), "utf8"),
      ) as BenchmarkLedger;
      if (
        prior.policyId !== policyId ||
        prior.protocolHash !== protocolHash ||
        hash(prior.plan) !== hash(plan)
      )
        throw new Error("Frozen fixed benchmark differs from requested arms");
      return prior;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const ledger: BenchmarkLedger = {
      version: 1,
      protocolHash,
      policyId,
      plan,
      evaluations: [],
    };
    await save(directory, ledger);
    return ledger;
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
  grade: (worktree: string) => Promise<BenchmarkPreflight>;
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
    grade: (worktree: string) => Promise<BenchmarkPreflight>;
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
  const makeBase = (path: string): void => {
    execFileSync("tar", ["-x", "-C", path], { input: archive });
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Sandcastle fixture");
    git(path, "config", "user.email", "fixture@example.invalid");
    git(path, "add", "-f", "-A");
    git(path, "commit", "-m", "Answer-free benchmark base");
  };
  makeBase(input.directory);
  const exportHead = git(input.directory, "rev-parse", "HEAD");
  const tree = git(input.source, "rev-parse", `${fixture.base}^{tree}`);
  if (git(input.directory, "rev-parse", "HEAD^{tree}") !== tree)
    throw new Error("Exported fixture differs from the historical base tree");
  const baseGrade = await input.grade(input.directory);
  if (
    baseGrade.focusPassed ||
    !baseGrade.otherGatesPassed ||
    !baseGrade.evidence.length
  )
    throw new Error("Historical base failed protected preflight");
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
  const correctionDir = await mkdtemp(
    join(dirname(input.directory), "benchmark-correction-"),
  );
  try {
    makeBase(correctionDir);
    const correctionHead = git(correctionDir, "rev-parse", "HEAD");
    execFileSync("git", ["apply", "--binary", "-"], {
      cwd: correctionDir,
      input: correction,
    });
    git(correctionDir, "add", "-A");
    const correctionTree = git(correctionDir, "write-tree");
    if (
      correctionTree !==
      git(input.source, "rev-parse", `${fixture.reference}^{tree}`)
    )
      throw new Error(
        "Known correction differs from its frozen reference tree",
      );
    const correctionGrade = await input.grade(correctionDir);
    if (
      !correctionGrade.focusPassed ||
      !correctionGrade.otherGatesPassed ||
      !correctionGrade.evidence.length ||
      git(correctionDir, "rev-parse", "HEAD") !== correctionHead ||
      git(correctionDir, "write-tree") !== correctionTree ||
      git(correctionDir, "diff", "--name-only") ||
      git(correctionDir, "ls-files", "--others", "--exclude-standard")
    )
      throw new Error("Historical correction failed protected preflight");
    if (
      git(input.directory, "status", "--porcelain") ||
      git(input.directory, "rev-list", "--count", "--all") !== "1"
    )
      throw new Error(
        "Exported fixture contains work or answer-bearing history",
      );
    return {
      fixtureId: fixture.fixtureId,
      base: fixture.base,
      reference: fixture.reference,
      exportHead,
      tree,
      preflight: { base: baseGrade, correction: correctionGrade },
    };
  } finally {
    await rm(correctionDir, { recursive: true, force: true });
  }
};

const save = async (
  directory: string,
  value: unknown,
  name = "benchmark.json",
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
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
  if (ledger.plan) {
    const expected = makeFixedBenchmarkPlan(ledger.plan.arms);
    if (
      ledger.plan.kind !== "fixed" ||
      ledger.plan.reference !== expected.reference ||
      hash(ledger.plan.slots) !== hash(expected.slots) ||
      ledger.plan.overallLimitMs !== expected.overallLimitMs ||
      ledger.plan.accountRiseLimitPercentPoints !==
        expected.accountRiseLimitPercentPoints ||
      !ledger.plan.rates ||
      ledger.plan.rateSource !== expected.rateSource ||
      hash(ledger.plan.rates) !== hash(expected.rates) ||
      Object.values(ledger.plan.rates).some(
        (rate) =>
          !Number.isFinite(rate.input) ||
          !Number.isFinite(rate.cachedInput) ||
          !Number.isFinite(rate.output) ||
          rate.input <= 0 ||
          rate.cachedInput <= 0 ||
          rate.output <= 0,
      )
    )
      throw new Error("Fixed benchmark plan is invalid");
  }
  if (
    ledger.version !== 1 ||
    ledger.protocolHash !==
      (ledger.plan
        ? fixedBenchmarkProtocolHash(ledger.plan)
        : benchmarkProtocolHash) ||
    ledger.policyId !== policyId
  )
    throw new Error("Benchmark protocol or policy identity changed");
  return ledger;
};

/** Charge host preparation, grading, supervision or reporting against the same pilot clock. */
export const withBenchmarkActivity = async <T>(
  directory: string,
  policyId: string,
  label: string,
  maxActiveMs: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> =>
  withBenchmarkLock(directory, async () => {
    if (
      typeof label !== "string" ||
      !label ||
      !Number.isSafeInteger(maxActiveMs) ||
      maxActiveMs <= 0
    )
      throw new Error(
        "Benchmark activity needs a label and finite reservation",
      );
    const pilotLock = join(directory, "execution.lock");
    await mkdir(pilotLock);
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
      await writeFile(
        join(pilotLock, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "",
        }),
        { flag: "wx", mode: 0o600 },
      );
      const budget = JSON.parse(
        await readFile(join(directory, "budget.json"), "utf8"),
      ) as PilotBudgetState;
      if (
        budget.version !== 2 ||
        budget.policyId !== policyId ||
        !Number.isSafeInteger(budget.activeMs) ||
        budget.activeMs < 0 ||
        budget.activeInvocationId ||
        !Object.values(budget.episodes).some(
          (episode) => episode.activity === "measurement" && episode.complete,
        ) ||
        budget.activeMs + maxActiveMs >
          (budget.limits?.overallMs ?? 4 * 60 * 60_000)
      )
        throw new Error(
          "Pilot activity cannot fit the shared active-time budget",
        );
      const ledger = await readBenchmark(directory, policyId);
      const startedAt = Date.now();
      const activity = { label, startedAt, reservedMs: maxActiveMs };
      await save(
        directory,
        { ...budget, activeMs: budget.activeMs + maxActiveMs },
        "budget.json",
      );
      await save(directory, {
        ...ledger,
        activities: [
          ...(ledger.activities ?? []),
          { ...activity, outcome: "reserved" },
        ],
      });
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Benchmark activity timed out")),
        maxActiveMs,
      );
      let value: T | undefined;
      let failure: unknown;
      try {
        value = await action(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timeout);
        const actualMs = Math.max(0, Date.now() - startedAt);
        await save(
          directory,
          { ...budget, activeMs: budget.activeMs + actualMs },
          "budget.json",
        );
        await save(directory, {
          ...ledger,
          activities: [
            ...(ledger.activities ?? []),
            {
              ...activity,
              actualMs,
              outcome: failure ? "failed" : "complete",
              ...(failure ? { reason: String(failure) } : {}),
            },
          ],
        });
      }
      if (failure) throw failure;
      return value as T;
    } finally {
      await rm(pilotLock, { recursive: true, force: true });
    }
  });

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
  /** Independent required-review findings for the first candidate. */
  reviewProbe?: (candidate: {
    readonly worktree: string;
    readonly head: string;
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
    const ledger = await readBenchmark(input.directory, usage.policyId);
    const slots = ledger.plan?.slots ?? benchmarkSlots;
    const arms = ledger.plan?.arms ?? pilotConfigurations;
    const slot = slots.find((item) => item.id === input.slotId);
    if (!slot) throw new Error("Unknown benchmark slot");
    if (
      ledger.plan &&
      (usage.pilot.overallLimitMs !== ledger.plan.overallLimitMs ||
        usage.pilot.evaluationLimit !== slots.length ||
        usage.pilot.accountRiseLimitPercentPoints !==
          ledger.plan.accountRiseLimitPercentPoints)
    )
      throw new Error("Pilot limits differ from the frozen benchmark plan");
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
      ledger.hostConditionsHash &&
      ledger.hostConditionsHash !== input.conditionsHash
    )
      throw new Error("Host benchmark conditions changed during benchmark");
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
    if (ledger.evaluations.length >= slots.length && !input.resume)
      throw new Error("Benchmark evaluation limit reached");
    if (
      (input.resume
        ? ledger.evaluations.at(-1)?.slotId
        : slots[ledger.evaluations.length]?.id) !== slot.id
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
    if (
      slot.split === "held-out" &&
      (ledger.plan
        ? ledger.fixedSelection === undefined
        : !ledger.pair && !ledger.promotion)
    )
      throw new Error("Freeze development selection before held-out outcomes");
    if (slot.arm === "adaptive" && !ledger.pair)
      throw new Error("Adaptive evaluation needs a frozen routing pair");
    if (slot.arm !== "adaptive" && slot.split === "development" && ledger.pair)
      throw new Error("Development configuration was frozen");
    if (options.policy.iterations !== 2 || options.selected.length !== 1)
      throw new Error(
        "Each evaluation needs one task and two reserved implementation iterations",
      );
    const task = await options.project.getTask(options.selected[0]!.id);
    if (!task || task.reference !== options.selected[0]!.reference)
      throw new Error("Selected benchmark task changed");
    if (
      ledger.plan &&
      (hash(task.requiredRoles) !== hash(fixedRequiredRoles) ||
        !input.reviewProbe ||
        options.policy.roles["implementation-rework"]?.sandbox !==
          options.policy.roles.implementation?.sandbox ||
        task.requiredRoles.some((role) => {
          const config = options.policy.roles[role]?.agent.codexConfiguration;
          const expectedRole =
            role === "implementation-rework"
              ? arms[slot.arm as number]
              : { model: "gpt-6-sol", effort: "high" };
          return (
            config?.model !== expectedRole?.model ||
            config?.effort !== expectedRole?.effort ||
            config?.serviceTier !== "default"
          );
        }))
    )
      throw new Error(
        "Fixed benchmark rework and reviews differ from the frozen role plan",
      );
    const prompts = await Promise.all(
      ["implementation", ...task.requiredRoles].map(async (role) => {
        const value = options.project.prompt(task, role);
        if (typeof value === "string") return [role, value];
        return [
          role,
          value.promptFile
            ? await readFile(
                resolve(options.project.root, value.promptFile),
                "utf8",
              )
            : value.prompt,
        ];
      }),
    );
    const actualConditions = hash({
      task: {
        reference: task.reference,
        scope: task.scope,
        requiredRoles: task.requiredRoles,
        requiredCapabilities: task.requiredCapabilities,
      },
      prompts,
      roles: task.requiredRoles.map((role) => ({
        role,
        configuration: options.policy.roles[role]?.agent.codexConfiguration,
        sandbox: options.policy.roles[role]?.sandbox.tag,
      })),
      hostConditions: input.conditionsHash,
    });
    if (
      ledger.fixtureConditions?.[slot.fixture] &&
      ledger.fixtureConditions[slot.fixture] !== actualConditions
    )
      throw new Error("Matched fixture conditions changed during benchmark");
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
      !input.fixture.preflight ||
      input.fixture.preflight.base.focusPassed ||
      !input.fixture.preflight.base.otherGatesPassed ||
      !input.fixture.preflight.base.evidence.length ||
      !input.fixture.preflight.correction.focusPassed ||
      !input.fixture.preflight.correction.otherGatesPassed ||
      !input.fixture.preflight.correction.evidence.length ||
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
      (!input.resume &&
        git(worktree.worktreePath, "rev-list", "--count", "--all") !== "1") ||
      (!input.resume && git(worktree.worktreePath, "remote")) ||
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
        : arms[slot.arm];
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
      fallbackConfig.serviceTier !== "default" ||
      fallbackAssignment.sandbox !==
        options.policy.roles.implementation?.sandbox ||
      fallbackAssignment.agent.name !==
        options.policy.roles.implementation?.agent.name ||
      hash(fallbackAssignment.agent.env ?? {}) !==
        hash(options.policy.roles.implementation?.agent.env ?? {})
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
    const fixedActionPath = join(options.directory, "benchmark-action.json");
    const emptyRoleResult = (): WorktreeRunResult => ({
      iterations: [],
      commits: [],
      stdout: "",
      branch: worktree.branch,
    });
    const fixedAction = async () => {
      try {
        return JSON.parse(await readFile(fixedActionPath, "utf8")) as {
          slotId: string;
          head: string;
          model: string;
          effort: string;
          finding: BenchmarkProbe;
          status: "pending" | "complete" | "terminal";
          sessionId?: string;
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const wrappedWorktree = {
      ...worktree,
      run: async (
        runOptions: Parameters<typeof worktree.run>[0],
      ): Promise<WorktreeRunResult> => {
        if (ledger.plan) {
          if (runOptions.agent === selectedAgent) {
            const first = await worktree.run({
              ...runOptions,
              maxIterations: 1,
            });
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
                "Protected first-candidate check changed the worktree",
              );
            if (finding.status === "environment-failure")
              throw new Error(finding.reason);
            if (finding.status === "review-failure")
              throw new Error("Protected check returned a review finding");
            if (finding.status === "implementation-failure") {
              if (!finding.reason || !finding.evidence.length)
                throw new Error("Protected finding lacks actionable evidence");
              await save(
                options.directory,
                {
                  slotId: slot.id,
                  head,
                  model: expected.model,
                  effort: expected.effort,
                  finding,
                  status: "pending",
                  ...(first.iterations.at(-1)?.sessionId
                    ? { sessionId: first.iterations.at(-1)!.sessionId }
                    : {}),
                },
                "benchmark-action.json",
              );
            }
            return first;
          }
          const role = fixedRequiredRoles.find(
            (name) => options.policy.roles[name]?.agent === runOptions.agent,
          );
          if (!role) throw new Error("Unknown fixed benchmark role");
          const action = await fixedAction();
          if (
            action &&
            (action.slotId !== slot.id ||
              action.model !== expected.model ||
              action.effort !== expected.effort)
          )
            throw new Error("Recorded fixed rework action changed");
          if (role.endsWith("-preview"))
            return action ? emptyRoleResult() : worktree.run(runOptions);
          if (role === "implementation-rework") {
            let selected = action;
            if (!selected) {
              const head = git(worktree.worktreePath, "rev-parse", "HEAD");
              const finding = await input.reviewProbe!({
                worktree: worktree.worktreePath,
                head,
              });
              if (
                git(worktree.worktreePath, "rev-parse", "HEAD") !== head ||
                git(worktree.worktreePath, "status", "--porcelain")
              )
                throw new Error("Required reviews changed the first candidate");
              if (finding.status === "passed") return emptyRoleResult();
              if (finding.status === "review-failure") {
                await save(
                  options.directory,
                  {
                    slotId: slot.id,
                    head,
                    model: expected.model,
                    effort: expected.effort,
                    finding,
                    status: "terminal",
                  },
                  "benchmark-action.json",
                );
                return emptyRoleResult();
              }
              if (
                finding.status !== "implementation-failure" ||
                !finding.reason ||
                !finding.evidence.length
              )
                throw new Error(
                  `Required-review evidence is incomplete: ${finding.reason}`,
                );
              selected = {
                slotId: slot.id,
                head,
                model: expected.model,
                effort: expected.effort,
                finding,
                status: "pending",
              };
              await save(options.directory, selected, "benchmark-action.json");
            }
            if (selected.status === "complete") return emptyRoleResult();
            const originalPrompt =
              prompts.find(([name]) => name === "implementation")?.[1] ?? "";
            const diagnostic = `Original task: ${originalPrompt}\nTask ${options.selected[0]!.reference}. Verified source ${selected.head}. Independent finding: ${selected.finding.reason}. Evidence: ${selected.finding.evidence.join(", ")}. One implementation attempt remains. Commit the correction.`;
            const second = await worktree.run({
              ...runOptions,
              maxIterations: 1,
              ...(selected.sessionId
                ? { resumeSession: selected.sessionId }
                : {}),
              prompt: diagnostic,
              promptFile: undefined,
            });
            if (git(worktree.worktreePath, "status", "--porcelain"))
              throw new Error("Second implementation left uncommitted changes");
            await save(
              options.directory,
              { ...selected, status: "complete" },
              "benchmark-action.json",
            );
            return second;
          }
          if (action?.status === "pending")
            throw new Error("Second implementation has not completed");
          return action?.status === "complete"
            ? worktree.run(runOptions)
            : emptyRoleResult();
        }
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
      hostConditionsHash: ledger.hostConditionsHash ?? input.conditionsHash,
      accountResolution: ledger.accountResolution ?? input.accountResolution,
      windowDurationMs: ledger.windowDurationMs ?? input.windowDurationMs,
      fixtureConditions: {
        ...ledger.fixtureConditions,
        [slot.fixture]: actualConditions,
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
      status:
        accepted && isolatedSessions
          ? "accepted"
          : isolatedSessions &&
              snapshot?.tasks[options.selected[0]!.id]?.status === "failed"
            ? "failed"
            : "incomplete",
      technicalPassed: snapshot?.checksPassed?.[options.selected[0]!.id]
        ? true
        : null,
      projectAccepted: snapshot?.tasks[options.selected[0]!.id]
        ? snapshot.tasks[options.selected[0]!.id]!.status === "accepted"
        : null,
      taskStatus: snapshot?.tasks[options.selected[0]!.id]?.status ?? null,
      firstIterationSuccess:
        accepted &&
        isolatedSessions &&
        snapshot?.usage?.remaining[options.selected[0]!.id]?.implementation ===
          1 &&
        (!ledger.plan ||
          snapshot?.usage?.remaining[options.selected[0]!.id]?.[
            "implementation-rework"
          ] === 1),
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

/** Price the verified role counters at the rates frozen in a fixed study. */
export const fixedBenchmarkCredits = (
  ledger: BenchmarkLedger,
  evaluation: BenchmarkEvaluation,
): number | null => {
  const plan = ledger.plan;
  const slot = plan?.slots.find((item) => item.id === evaluation.slotId);
  const tokens = evaluation.usage?.tokens;
  if (
    !plan ||
    !slot ||
    slot.arm === "adaptive" ||
    !tokens?.attributableTotal ||
    tokens.unknown.length ||
    !tokens.invocations
  )
    return null;
  const counterModels = new Map<string, string>();
  for (const invocation of Object.values(tokens.invocations)) {
    if (!invocation.coverageComplete || !invocation.counterIds.length)
      return null;
    if (
      ![
        "implementation",
        "implementation-rework",
        "standards-review-preview",
        "specification-review-preview",
        "standards-review",
        "specification-review",
      ].includes(invocation.role)
    )
      return null;
    const model = invocation.role.startsWith("implementation")
      ? plan.arms[slot.arm]?.model
      : "gpt-6-sol";
    if (!model || !plan.rates[model]) return null;
    for (const id of invocation.counterIds) {
      const prior = counterModels.get(id);
      if (prior && prior !== model) return null;
      counterModels.set(id, model);
    }
  }
  if (
    !counterModels.size ||
    counterModels.size !== Object.keys(tokens.deltas).length ||
    Object.keys(tokens.deltas).some((id) => !counterModels.has(id))
  )
    return null;
  let credits = 0;
  for (const [id, model] of counterModels) {
    const delta = tokens.deltas[id]!;
    const rate = plan.rates[model]!;
    credits +=
      ((delta.inputTokens + delta.cacheCreationInputTokens) * rate.input +
        delta.cacheReadInputTokens * rate.cachedInput +
        delta.outputTokens * rate.output) /
      1_000_000;
  }
  return Number.isFinite(credits) ? credits : null;
};

const fixedResults = (
  ledger: BenchmarkLedger,
  split: BenchmarkSlot["split"],
  arm: number,
): BenchmarkEvaluation[] => {
  const ids = new Set(
    ledger
      .plan!.slots.filter((slot) => slot.split === split && slot.arm === arm)
      .map((slot) => slot.id),
  );
  return ledger.evaluations.filter((evaluation) => ids.has(evaluation.slotId));
};

const fixedCandidateCredits = (
  ledger: BenchmarkLedger,
  split: BenchmarkSlot["split"],
  arm: number,
): number | null => {
  const plan = ledger.plan!;
  const candidate = fixedResults(ledger, split, arm);
  const reference = fixedResults(ledger, split, plan.reference);
  if (
    candidate.length !== 4 ||
    reference.length !== 4 ||
    [...candidate, ...reference].some(
      (item) =>
        item.status !== "accepted" ||
        item.technicalPassed !== true ||
        item.projectAccepted !== true ||
        !item.reviewPassed ||
        item.falseAcceptance ||
        fixedBenchmarkCredits(ledger, item) === null,
    )
  )
    return null;
  const total = (items: BenchmarkEvaluation[]) =>
    items.reduce((sum, item) => sum + fixedBenchmarkCredits(ledger, item)!, 0);
  const candidateCost = total(candidate);
  const referenceCost = total(reference);
  if (
    referenceCost <= 0 ||
    candidateCost > 0.8 * referenceCost ||
    ([1, 2] as const).some(
      (repetition) =>
        total(
          candidate.filter((item) =>
            plan.slots.some(
              (slot) =>
                slot.id === item.slotId && slot.repetition === repetition,
            ),
          ),
        ) >=
        total(
          reference.filter((item) =>
            plan.slots.some(
              (slot) =>
                slot.id === item.slotId && slot.repetition === repetition,
            ),
          ),
        ),
    )
  )
    return null;
  return candidateCost;
};

/** Freeze a fixed challenger from development results before held-out work. */
export const freezeFixedBenchmarkSelection = async (
  directory: string,
  policyId: string,
): Promise<BenchmarkLedger["fixedSelection"]> =>
  withBenchmarkLock(directory, async () => {
    const ledger = await readBenchmark(directory, policyId);
    if (!ledger.plan) throw new Error("Fixed benchmark plan is required");
    if (ledger.fixedSelection) return ledger.fixedSelection;
    const development = ledger.plan.slots.filter(
      (slot) => slot.split === "development",
    );
    if (
      ledger.evaluations.length !== development.length ||
      ledger.evaluations.some(
        (item) => !development.some((slot) => slot.id === item.slotId),
      )
    )
      throw new Error("Complete development slots before freezing selection");
    const qualified = ledger.plan.arms
      .map((_, arm) => ({
        arm,
        credits:
          arm === ledger.plan!.reference
            ? null
            : fixedCandidateCredits(ledger, "development", arm),
      }))
      .filter(
        (item): item is { arm: number; credits: number } =>
          item.credits !== null,
      )
      .sort((a, b) => a.credits - b.credits || a.arm - b.arm);
    const selection = qualified[0]
      ? {
          arm: qualified[0].arm,
          reason:
            "Lowest verified development credit cost among qualified fixed challengers",
        }
      : {
          arm: null,
          reason:
            "No development challenger met the frozen quality and 20% credit rule",
        };
    await save(directory, { ...ledger, fixedSelection: selection });
    return selection;
  });

/** Assess only the preselected fixed challenger against complete held-out evidence. */
export const assessFixedBenchmark = async (
  directory: string,
  policyId: string,
): Promise<"qualified" | "retain-fixed"> =>
  withBenchmarkLock(directory, async () => {
    const ledger = await readBenchmark(directory, policyId);
    if (!ledger.plan || !ledger.fixedSelection)
      throw new Error("Fixed benchmark selection is required");
    if (ledger.fixedDisposition) return ledger.fixedDisposition;
    if (ledger.evaluations.length !== ledger.plan.slots.length)
      throw new Error("All fixed slots are required for assessment");
    const qualified =
      ledger.fixedSelection.arm !== null &&
      fixedCandidateCredits(ledger, "held-out", ledger.fixedSelection.arm) !==
        null;
    const fixedDisposition = qualified ? "qualified" : "retain-fixed";
    await save(directory, { ...ledger, fixedDisposition });
    return fixedDisposition;
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

/** A versioned policy input for a separate owner-approved project update. */
export const admitBenchmarkPolicy = async (
  directory: string,
  policyId: string,
  taskClass: BenchmarkTaskClass,
): Promise<BenchmarkPolicyAdmission> => {
  const ledger = await readBenchmark(directory, policyId);
  if (
    ledger.promotion !== "admitted" ||
    !ledger.pair ||
    ![
      "independently-gradable-regression",
      "independently-gradable-bounded-feature",
    ].includes(taskClass)
  )
    throw new Error("Benchmark evidence does not admit this task class");
  return {
    version: 1,
    policyId,
    protocolHash: ledger.protocolHash,
    evidenceHash: hash(ledger.evaluations),
    taskClass,
    pair: ledger.pair,
  };
};
