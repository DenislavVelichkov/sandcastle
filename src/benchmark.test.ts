import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { codex, createWorktree } from "./index.js";
import {
  admitBenchmarkPolicy,
  assessBenchmarkPromotion,
  benchmarkFixtures,
  benchmarkProtocolHash,
  benchmarkSlots,
  exportFixtureTree,
  freezeBenchmarkPair,
  readBenchmark,
  runBenchmarkEvaluation,
  type BenchmarkEvaluation,
} from "./benchmark.js";
import { beginPilotInvocation, settlePilotInvocation } from "./pilotBudget.js";
import type { AccountObservation } from "./workflowUsage.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const advanceUntil = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 600 && !done(); i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
};
const now = Date.now();
const reading: AccountObservation = {
  accountId: "synthetic-account",
  observedAt: now,
  denied: false,
  windows: {
    short: { usedPercent: 20, resetsAt: now + 5 * 60 * 60_000 },
    weekly: { usedPercent: 25, resetsAt: now + 7 * 24 * 60 * 60_000 },
  },
};
const cost = (lower: number, upper: number) => ({
  short: {
    lower,
    upper,
    durationMs: 5 * 60 * 60_000,
    before: reading,
    after: reading,
  },
  weekly: {
    lower,
    upper,
    durationMs: 7 * 24 * 60 * 60_000,
    before: reading,
    after: reading,
  },
});
const result = (
  slot: (typeof benchmarkSlots)[number],
  amount: number,
): BenchmarkEvaluation => ({
  slotId: slot.id,
  invocationId: slot.id,
  worktree: `synthetic-${slot.id}`,
  sessionIds: [`session-${slot.id}`],
  fixture: {
    fixtureId: slot.fixture,
    base: benchmarkFixtures.find((item) => item.id === slot.fixture)!.base,
    reference: benchmarkFixtures.find((item) => item.id === slot.fixture)!
      .reference,
    exportHead: "synthetic",
    tree: "synthetic",
    preflight: {
      base: {
        focusPassed: false,
        otherGatesPassed: true,
        evidence: ["base defect reproduced"],
      },
      correction: {
        focusPassed: true,
        otherGatesPassed: true,
        evidence: ["known correction and other gates passed"],
      },
    },
  },
  requested: String(slot.arm),
  effective: String(slot.arm),
  status: "accepted",
  firstIterationSuccess: slot.arm === 5,
  reviewPassed: true,
  falseAcceptance: false,
  cost: cost(amount, amount),
  usage: {
    tokens: {
      attributableTotal: {
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
      },
      unknown: [],
    },
  } as unknown as BenchmarkEvaluation["usage"],
});

it("exports a synthetic base without correction history and preflights both states", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchmark-export-"));
  const source = join(root, "source");
  const exported = join(root, "exported");
  await mkdir(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.com");
  await writeFile(join(source, "result.txt"), "bug\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  await writeFile(join(source, "result.txt"), "fixed\n");
  git(source, "commit", "-am", "correction");
  const reference = git(source, "rev-parse", "HEAD");
  let checks = 0;
  try {
    const receipt = await exportFixtureTree(
      {
        source,
        directory: exported,
        grade: async (path) => {
          checks++;
          const focusPassed =
            (await readFile(join(path, "result.txt"), "utf8")) === "fixed\n";
          return {
            focusPassed,
            otherGatesPassed: true,
            evidence: [
              focusPassed ? "correction passed" : "base defect reproduced",
            ],
          };
        },
      },
      { fixtureId: "stream-log", base, reference },
    );
    expect(checks).toBe(2);
    expect(receipt.preflight.base.focusPassed).toBe(false);
    expect(receipt.preflight.correction.focusPassed).toBe(true);
    expect(receipt.tree).toBe(git(source, "rev-parse", `${base}^{tree}`));
    expect(git(exported, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await readFile(join(exported, "result.txt"), "utf8")).toBe("bug\n");
    expect(git(exported, "status", "--porcelain")).toBe("");
    await expect(
      exportFixtureTree(
        {
          source,
          directory: join(root, "failed-other-gate"),
          grade: async () => ({
            focusPassed: false,
            otherGatesPassed: false,
            evidence: ["typecheck failed"],
          }),
        },
        { fixtureId: "stream-log", base, reference },
      ),
    ).rejects.toThrow(/base failed protected preflight/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("freezes the 28-case development decision before held-out evidence and rejects incomplete promotion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-ledger-"));
  try {
    expect(benchmarkFixtures.map((item) => item.split)).toEqual([
      "development",
      "development",
      "held-out",
      "held-out",
    ]);
    expect(benchmarkSlots).toHaveLength(64);
    expect(
      benchmarkSlots.filter(
        (item) => item.split === "development" && item.arm !== "adaptive",
      ),
    ).toHaveLength(28);
    expect(
      benchmarkSlots.filter((item) => item.split === "held-out"),
    ).toHaveLength(32);
    const dev = benchmarkSlots.filter(
      (item) => item.split === "development" && item.arm !== "adaptive",
    );
    const evaluations = dev.map((slot) =>
      result(
        slot,
        slot.arm === 5 ? 10 : slot.arm === 0 || slot.arm === 1 ? 7 : 12,
      ),
    );
    const base = {
      version: 1,
      protocolHash: benchmarkProtocolHash,
      policyId: "bench",
      accountResolution: { short: 0.1, weekly: 0.1 },
      windowDurationMs: {
        short: 5 * 60 * 60_000,
        weekly: 7 * 24 * 60 * 60_000,
      },
      evaluations,
    };
    await writeFile(join(directory, "benchmark.json"), JSON.stringify(base));
    const pair = await freezeBenchmarkPair(directory, "bench");
    expect(pair).toEqual({
      start: 0,
      fallback: 5,
      rule: "independent-implementation-failure",
    });
    expect(await freezeBenchmarkPair(directory, "bench")).toEqual(pair);
    const zeroReference = evaluations.map((item) =>
      benchmarkSlots.find((slot) => slot.id === item.slotId)?.arm === 5
        ? { ...item, cost: cost(0, 0) }
        : item,
    );
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...base, evaluations: zeroReference }),
    );
    expect(await freezeBenchmarkPair(directory, "bench")).toBeNull();
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...base, pair, evaluations }),
    );
    await expect(assessBenchmarkPromotion(directory, "bench")).rejects.toThrow(
      /64 scheduled/,
    );
    const all = benchmarkSlots.map((slot) =>
      result(slot, slot.arm === 5 ? 10 : 7),
    );
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...base, pair, evaluations: all }),
    );
    expect(await assessBenchmarkPromotion(directory, "bench")).toBe("admitted");
    expect(
      await admitBenchmarkPolicy(
        directory,
        "bench",
        "independently-gradable-regression",
      ),
    ).toMatchObject({ version: 1, policyId: "bench", pair });
    await expect(
      admitBenchmarkPolicy(directory, "bench", "weakly-gradable" as never),
    ).rejects.toThrow(/does not admit/);
    const failed = all.map((item) =>
      item.slotId === "merge-to-head-2-adaptive"
        ? { ...item, cost: null }
        : item,
    );
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...base, pair, evaluations: failed }),
    );
    expect(await assessBenchmarkPromotion(directory, "bench")).toBe(
      "fixed-policy",
    );
    await expect(
      admitBenchmarkPolicy(
        directory,
        "bench",
        "independently-gradable-regression",
      ),
    ).rejects.toThrow(/does not admit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs the first synthetic slot through the installed controller and project gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchmark-entry-"));
  const pilot = join(root, "pilot");
  const grader = join(root, "protected-grader");
  await mkdir(grader);
  const makeFixture = async (name: string) => {
    const fixture = join(root, name);
    await mkdir(fixture);
    git(fixture, "init", "-b", "main");
    git(fixture, "config", "user.name", "Test");
    git(fixture, "config", "user.email", "test@example.com");
    await writeFile(join(fixture, "README.md"), "base\n");
    git(fixture, "add", ".");
    git(fixture, "commit", "-m", "answer-free base");
    return {
      fixture,
      worktree: await createWorktree({
        cwd: fixture,
        branchStrategy: { type: "branch", branch: name },
      }),
    };
  };
  const { fixture, worktree } = await makeFixture("fixture");
  const common = {
    policyId: "bench",
    pilot: { id: "pilot-one", directory: pilot },
    readAccount: async () => ({ ...reading, observedAt: Date.now() }),
    listModels: async () => ({
      data: [
        {
          model: "gpt-6-luna",
          supportedReasoningEfforts: [{ reasoningEffort: "max" }],
        },
        {
          model: "gpt-6-sol",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
    }),
  };
  const prepared = beginPilotInvocation(
    undefined,
    { ...common, activity: "measurement" },
    "calibration",
    "runtime",
    reading,
    [{ id: "calibration", requiredRoles: [] }],
    2,
    {
      implementation: {
        model: "gpt-6-luna",
        effort: "max",
        serviceTier: "default",
      },
    },
    now,
    now,
  );
  await mkdir(pilot);
  await writeFile(
    join(pilot, "budget.json"),
    JSON.stringify(
      settlePilotInvocation(
        prepared.budget,
        "calibration",
        prepared.usage,
        true,
      ),
    ),
  );
  const task = {
    id: "task",
    reference: "fixture:stream-log",
    state: "ready" as const,
    dependencies: [],
    scope: ["result.txt"],
    requiredRoles: ["review"],
    requiredCapabilities: [],
  };
  let checked = 0;
  let accepted = 0;
  let implementationCalls = 0;
  const models: string[] = [];
  const agent = codex("gpt-6-luna", { effort: "max", serviceTier: "default" });
  const receipt = (
    fixtureId: (typeof benchmarkFixtures)[number]["id"],
    path: string,
  ) => ({
    fixtureId,
    base: benchmarkFixtures.find((item) => item.id === fixtureId)!.base,
    reference: benchmarkFixtures.find((item) => item.id === fixtureId)!
      .reference,
    exportHead: git(path, "rev-parse", "HEAD"),
    tree: git(path, "rev-parse", "HEAD^{tree}"),
    preflight: result(benchmarkSlots[0]!, 1).fixture.preflight,
  });
  const options = {
    directory: join(root, "state"),
    projectId: "synthetic",
    invocationId: benchmarkSlots[0]!.id,
    runtimeIdentity: "runtime",
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: {
      task: {
        ...worktree,
        run: async (runOptions: Parameters<typeof worktree.run>[0]) => {
          const review = runOptions.prompt === "Review the synthetic case";
          if (!review) implementationCalls++;
          models.push(runOptions.agent.codexConfiguration?.model ?? "unknown");
          await runOptions.onIterationStart?.(1);
          if (!review) {
            await writeFile(
              join(worktree.worktreePath, "result.txt"),
              `fixed ${implementationCalls}\n`,
            );
            git(worktree.worktreePath, "add", "result.txt");
            git(worktree.worktreePath, "commit", "-m", "synthetic correction");
          }
          const iteration = {
            sessionId: review ? "synthetic-review" : "synthetic-session",
            sessionFilePath: join(
              root,
              review ? "review.jsonl" : "session.jsonl",
            ),
          };
          await writeFile(iteration.sessionFilePath, "{}\n");
          await runOptions.onSessionCaptured?.(iteration);
          await runOptions.onIterationComplete?.(1, iteration);
          return {
            iterations: [iteration],
            commits: review
              ? []
              : [{ sha: git(worktree.worktreePath, "rev-parse", "HEAD") }],
          } as never;
        },
      },
    },
    project: {
      root: fixture,
      capabilities: [],
      getTask: async () => task,
      reserve: async () => ({
        id: "reservation",
        retain: async () => {},
        release: async () => {},
      }),
      prompt: (_task: typeof task, role: string) =>
        role === "review"
          ? "Review the synthetic case"
          : "Fix the bounded synthetic case",
      check: async () => {
        checked++;
        return { status: "passed" as const, evidence: [] };
      },
      accept: async () => {
        accepted++;
        return { status: "accepted" as const, evidence: [] };
      },
      validateHumanRequest: async () => true,
    },
    policy: {
      iterations: 2,
      roles: {
        implementation: {
          agent,
          sandbox: { tag: "none" as const, create: async () => ({}) } as never,
        },
        review: {
          agent: codex("gpt-6-sol", { effort: "high", serviceTier: "default" }),
          sandbox: { tag: "none" as const, create: async () => ({}) } as never,
        },
      },
    },
    usage: { ...common, activity: "pilot" as const },
  };
  try {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await expect(
      runBenchmarkEvaluation({
        directory: pilot,
        slotId: benchmarkSlots[0]!.id,
        options,
        protectedGrader: grader,
        fixture: receipt("stream-log", worktree.worktreePath),
        conditionsHash: "synthetic-matched-conditions",
        accountResolution: { short: 0.1, weekly: 0.1 },
        windowDurationMs: {
          short: 5 * 60 * 60_000,
          weekly: 7 * 24 * 60 * 60_000,
        },
        settled: true,
        reviewPassed: true,
        effective: {
          model: "gpt-6-sol",
          effort: "high",
          serviceTier: "default",
          source: "rerouted worker",
        },
        probe: async () => ({
          status: "passed",
          reason: "passed",
          evidence: [grader],
        }),
      }),
    ).rejects.toThrow(/rerouted/);
    expect((await readBenchmark(pilot, "bench")).evaluations).toHaveLength(0);
    let finished = false;
    const promise = runBenchmarkEvaluation({
      directory: pilot,
      slotId: benchmarkSlots[0]!.id,
      options,
      protectedGrader: grader,
      fixture: receipt("stream-log", worktree.worktreePath),
      conditionsHash: "synthetic-matched-conditions",
      accountResolution: { short: 0.1, weekly: 0.1 },
      windowDurationMs: {
        short: 5 * 60 * 60_000,
        weekly: 7 * 24 * 60 * 60_000,
      },
      settled: true,
      probe: async () => ({
        status: "passed",
        reason: "synthetic check passed",
        evidence: [grader],
      }),
      reviewPassed: true,
      effective: {
        model: "gpt-6-luna",
        effort: "max",
        serviceTier: "default",
        source: "worker CLI config",
      },
    }).finally(() => {
      finished = true;
    });
    await advanceUntil(() => finished);
    const evaluation = await promise;
    expect(evaluation.status).toBe("accepted");
    expect(evaluation.firstIterationSuccess).toBe(true);
    expect(checked).toBe(1);
    expect(accepted).toBe(1);
    expect(models).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    expect((await readBenchmark(pilot, "bench")).evaluations).toHaveLength(1);
    expect((await readBenchmark(pilot, "bench")).hostConditionsHash).toBe(
      "synthetic-matched-conditions",
    );
    await expect(
      runBenchmarkEvaluation({
        directory: pilot,
        slotId: benchmarkSlots[0]!.id,
        options,
        protectedGrader: grader,
        fixture: receipt("stream-log", worktree.worktreePath),
        conditionsHash: "changed-environment",
        accountResolution: { short: 0.1, weekly: 0.1 },
        windowDurationMs: {
          short: 5 * 60 * 60_000,
          weekly: 7 * 24 * 60 * 60_000,
        },
        settled: true,
        reviewPassed: true,
        effective: {
          model: "gpt-6-luna",
          effort: "max",
          serviceTier: "default",
          source: "worker CLI config",
        },
        probe: async () => ({
          status: "passed",
          reason: "passed",
          evidence: [grader],
        }),
      }),
    ).rejects.toThrow(/Host benchmark conditions changed/);
    expect(
      JSON.parse(await readFile(join(pilot, "budget.json"), "utf8"))
        .evaluations,
    ).toBe(1);

    const adaptiveSlot = benchmarkSlots[56]!;
    const prior = JSON.parse(
      await readFile(join(pilot, "budget.json"), "utf8"),
    );
    await writeFile(
      join(pilot, "budget.json"),
      JSON.stringify({ ...prior, evaluations: 56 }),
    );
    await writeFile(
      join(pilot, "benchmark.json"),
      JSON.stringify({
        version: 1,
        protocolHash: benchmarkProtocolHash,
        policyId: "bench",
        pair: {
          start: 0,
          fallback: 5,
          rule: "independent-implementation-failure",
        },
        evaluations: benchmarkSlots
          .slice(0, 56)
          .map((slot) => result(slot, slot.arm === 5 ? 10 : 7)),
      }),
    );
    const { fixture: adaptiveFixture, worktree: adaptive } =
      await makeFixture("adaptive-fixture");
    let calls = 0;
    const adaptiveModels: string[] = [];
    try {
      const adaptiveOptions = {
        ...options,
        directory: join(root, "adaptive-state"),
        invocationId: adaptiveSlot.id,
        project: { ...options.project, root: adaptiveFixture },
        worktrees: {
          task: {
            ...adaptive,
            run: async (runOptions: Parameters<typeof adaptive.run>[0]) => {
              const review = runOptions.prompt === "Review the synthetic case";
              if (!review) calls++;
              adaptiveModels.push(
                runOptions.agent.codexConfiguration?.model ?? "unknown",
              );
              if (calls === 2 && !review)
                expect(runOptions.resumeSession).toBe("session-1");
              await runOptions.onIterationStart?.(1);
              if (!review) {
                await writeFile(
                  join(adaptive.worktreePath, "result.txt"),
                  `attempt ${calls}\n`,
                );
                git(adaptive.worktreePath, "add", "result.txt");
                git(adaptive.worktreePath, "commit", "-m", `attempt ${calls}`);
              }
              const iteration = {
                sessionId: review ? "adaptive-review" : `session-${calls}`,
                sessionFilePath: join(
                  root,
                  review ? "adaptive-review.jsonl" : `adaptive-${calls}.jsonl`,
                ),
              };
              await writeFile(iteration.sessionFilePath, "{}\n");
              await runOptions.onSessionCaptured?.(iteration);
              await runOptions.onIterationComplete?.(1, iteration);
              return {
                iterations: [iteration],
                commits: review
                  ? []
                  : [{ sha: git(adaptive.worktreePath, "rev-parse", "HEAD") }],
              } as never;
            },
          },
        },
        policy: {
          ...options.policy,
          implementationFallback: {
            agent: codex("gpt-6-sol", {
              effort: "high",
              serviceTier: "default",
            }),
            sandbox: options.policy.roles.implementation.sandbox,
          },
        },
        usage: {
          ...options.usage,
          listModels: async () => ({
            data: [
              {
                model: "gpt-6-luna",
                supportedReasoningEfforts: [{ reasoningEffort: "max" }],
              },
              {
                model: "gpt-6-sol",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
          }),
        },
      };
      let adaptiveFinished = false;
      const adaptivePromise = runBenchmarkEvaluation({
        directory: pilot,
        slotId: adaptiveSlot.id,
        options: adaptiveOptions,
        protectedGrader: grader,
        fixture: receipt("stream-log", adaptive.worktreePath),
        conditionsHash: "synthetic-matched-conditions",
        accountResolution: { short: 0.1, weekly: 0.1 },
        windowDurationMs: {
          short: 5 * 60 * 60_000,
          weekly: 7 * 24 * 60 * 60_000,
        },
        settled: true,
        reviewPassed: true,
        effective: {
          model: "gpt-6-luna",
          effort: "max",
          serviceTier: "default",
          source: "worker CLI config",
        },
        fallbackEffective: {
          model: "gpt-6-sol",
          effort: "high",
          serviceTier: "default",
          source: "worker CLI config",
        },
        probe: async () => ({
          status: "implementation-failure",
          reason: "independent assertion failed",
          evidence: [grader],
        }),
      }).finally(() => {
        adaptiveFinished = true;
      });
      await advanceUntil(() => adaptiveFinished);
      const adaptiveResult = await adaptivePromise;
      expect(adaptiveResult.status).toBe("accepted");
      expect(adaptiveResult.firstIterationSuccess).toBe(false);
      expect(adaptiveModels).toEqual(["gpt-6-luna", "gpt-6-sol", "gpt-6-sol"]);
      expect(
        JSON.parse(await readFile(join(pilot, "budget.json"), "utf8"))
          .evaluations,
      ).toBe(57);
    } finally {
      await adaptive.close();
    }
    const incompleteSlot = benchmarkSlots[57]!;
    const { fixture: incompleteFixture, worktree: incompleteWorktree } =
      await makeFixture("incomplete-fixture");
    try {
      const incompleteOptions = {
        ...options,
        directory: join(root, "incomplete-state"),
        invocationId: incompleteSlot.id,
        project: { ...options.project, root: incompleteFixture },
        worktrees: {
          task: {
            ...incompleteWorktree,
            run: async (
              runOptions: Parameters<typeof incompleteWorktree.run>[0],
            ) => {
              await runOptions.onIterationStart?.(1);
              await writeFile(
                join(incompleteWorktree.worktreePath, "result.txt"),
                "unfixed\n",
              );
              git(incompleteWorktree.worktreePath, "add", "result.txt");
              git(incompleteWorktree.worktreePath, "commit", "-m", "unfixed");
              const iteration = {
                sessionId: "incomplete-session",
                sessionFilePath: join(root, "incomplete.jsonl"),
              };
              await writeFile(iteration.sessionFilePath, "{}\n");
              await runOptions.onSessionCaptured?.(iteration);
              await runOptions.onIterationComplete?.(1, iteration);
              return {
                iterations: [iteration],
                commits: [
                  {
                    sha: git(
                      incompleteWorktree.worktreePath,
                      "rev-parse",
                      "HEAD",
                    ),
                  },
                ],
              } as never;
            },
          },
        },
        policy: {
          ...options.policy,
          implementationFallback: {
            agent: codex("gpt-6-sol", {
              effort: "high",
              serviceTier: "default",
            }),
            sandbox: options.policy.roles.implementation.sandbox,
          },
        },
      };
      let incompleteFinished = false;
      const incompletePromise = runBenchmarkEvaluation({
        directory: pilot,
        slotId: incompleteSlot.id,
        options: incompleteOptions,
        protectedGrader: grader,
        fixture: receipt("stream-log", incompleteWorktree.worktreePath),
        conditionsHash: "synthetic-matched-conditions",
        accountResolution: { short: 0.1, weekly: 0.1 },
        windowDurationMs: {
          short: 5 * 60 * 60_000,
          weekly: 7 * 24 * 60 * 60_000,
        },
        settled: false,
        reviewPassed: false,
        effective: {
          model: "gpt-6-luna",
          effort: "max",
          serviceTier: "default",
          source: "worker CLI config",
        },
        fallbackEffective: {
          model: "gpt-6-sol",
          effort: "high",
          serviceTier: "default",
          source: "worker CLI config",
        },
        probe: async () => ({
          status: "environment-failure",
          reason: "grader unavailable",
          evidence: [grader],
        }),
      }).finally(() => {
        incompleteFinished = true;
      });
      await advanceUntil(() => incompleteFinished);
      const incomplete = await incompletePromise;
      expect(incomplete.status).toBe("incomplete");
      expect(incomplete.reason).toMatch(/grader unavailable/);
      expect((await readBenchmark(pilot, "bench")).evaluations).toHaveLength(
        58,
      );
      await expect(
        runBenchmarkEvaluation({
          directory: pilot,
          slotId: benchmarkSlots[58]!.id,
          options: {
            ...incompleteOptions,
            invocationId: benchmarkSlots[58]!.id,
          },
          protectedGrader: grader,
          fixture: receipt("output-retry", incompleteWorktree.worktreePath),
          conditionsHash: "synthetic-matched-conditions",
          accountResolution: { short: 0.1, weekly: 0.1 },
          windowDurationMs: {
            short: 5 * 60 * 60_000,
            weekly: 7 * 24 * 60 * 60_000,
          },
          settled: false,
          reviewPassed: false,
          effective: {
            model: "gpt-6-luna",
            effort: "max",
            serviceTier: "default",
            source: "worker CLI config",
          },
          fallbackEffective: {
            model: "gpt-6-sol",
            effort: "high",
            serviceTier: "default",
            source: "worker CLI config",
          },
          probe: async () => ({
            status: "passed",
            reason: "passed",
            evidence: [grader],
          }),
        }),
      ).rejects.toThrow(/Recover or report/);
    } finally {
      await incompleteWorktree.close();
    }
  } finally {
    vi.useRealTimers();
    await worktree.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);
