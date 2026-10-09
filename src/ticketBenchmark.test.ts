import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  invocationBudgetMs,
  planTicketBenchmark,
  runTicketBenchmark,
} from "./ticketBenchmark.js";
import type { WorkerRequest, WorkerObservation } from "./benchmarkWorker.js";

const disposable: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    disposable
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("distinguishes missing issues from inaccessible GitHub sources through the real CLI boundary", async () => {
  const { repo } = await project();
  const tools = join(repo, "tools");
  await mkdir(tools);
  await writeFile(
    join(tools, "gh"),
    `#!/usr/bin/env node
const endpoint = process.argv.slice(2).at(-1);
if (endpoint === 'repos/example/project') process.stdout.write('{}');
else if (endpoint.endsWith('/issues/2')) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exitCode = 1; }
else if (endpoint.endsWith('/issues/3')) { process.stderr.write('secret-sentinel authentication (HTTP 401)'); process.exitCode = 1; }
else if (endpoint.endsWith('/issues/4')) { process.stderr.write('network unavailable'); process.exitCode = 1; }
else if (endpoint.endsWith('/issues/5')) { process.stderr.write('permission denied (HTTP 403)'); process.exitCode = 1; }
else if (endpoint.endsWith('/comments') || endpoint.endsWith('/blocked_by')) process.stdout.write('[[]]');
else process.stdout.write(JSON.stringify({title:'Frozen API task', body:'Exact body', html_url:'https://github.com/example/project/issues/1', state:'open'}));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${tools}:${process.env.PATH}`);
  const options = {
    cwd: repo,
    repository: "example/project",
    prompt: "Fallback",
  };
  expect(
    (await planTicketBenchmark({ ...options, tickets: ["1"] })).tickets[0]
      ?.text,
  ).toBe("Frozen API task\n\nExact body");
  expect(
    (await planTicketBenchmark({ ...options, tickets: ["2"] })).tickets[0]
      ?.text,
  ).toBe("Fallback");
  for (const number of ["3", "4", "5"])
    await expect(
      planTicketBenchmark({ ...options, tickets: [number] }),
    ).rejects.toThrow("resolution failed");
  await expect(
    planTicketBenchmark({ ...options, tickets: ["tools"] }),
  ).rejects.toThrow("resolution failed");
  await writeFile(
    join(tools, "gh"),
    "#!/bin/sh\nprintf 'gh: Not Found (HTTP 404)' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  await expect(
    planTicketBenchmark({ ...options, tickets: ["2"] }),
  ).rejects.toThrow("repository example/project is inaccessible");
});
const project = async () => {
  const repo = await mkdtemp(join(tmpdir(), "benchmark-launch-"));
  disposable.push(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Benchmark test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(
    join(repo, "task.md"),
    "# Task\n\n## Acceptance criteria\n- [ ] Keep chunks contiguous.\n",
  );
  await writeFile(join(repo, "AGENTS.md"), "Use pnpm.\n");
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-m", "Base");
  return { repo, git };
};

it("freezes issue comments and open prerequisites, and falls back only for a missing issue", async () => {
  const { repo } = await project();
  const issue = {
    title: "Selected issue",
    body: "## Acceptance criteria\n- [ ] Keep streaming.\n\n## Blocked by\n- #93\n",
    url: "https://github.com/example/project/issues/94",
    state: "OPEN" as const,
    comments: [
      {
        author: "owner",
        createdAt: "2026-10-05T00:00:00Z",
        body: "Keep this exact amendment.",
      },
    ],
  };
  const dependencies = {
    resolveIssue: async (_repository: string, number: number) =>
      number === 94
        ? issue
        : number === 93
          ? {
              ...issue,
              body: "Required preparation",
              url: "https://github.com/example/project/issues/93",
              comments: [],
            }
          : null,
  };
  const plan = await planTicketBenchmark(
    { cwd: repo, repository: "example/project", tickets: ["94"] },
    dependencies,
  );
  expect(plan.tickets[0]?.text).toContain("Keep this exact amendment.");
  expect(plan.launch?.prerequisites).toMatchObject([
    {
      source: "https://github.com/example/project/issues/93",
      state: "blocked",
    },
  ]);
  expect(plan.readiness?.blockers.join(" ")).toContain("prerequisite");
  const missing = await planTicketBenchmark(
    {
      cwd: repo,
      repository: "example/project",
      tickets: ["95"],
      prompt: "Exact fallback",
    },
    dependencies,
  );
  expect(missing.tickets[0]).toMatchObject({
    text: "Exact fallback",
    missingSource: "95",
  });
  await expect(
    planTicketBenchmark(
      {
        cwd: repo,
        repository: "example/project",
        tickets: ["94"],
        prompt: "Do not use this",
      },
      {
        resolveIssue: async () => {
          throw new Error("Authentication failure");
        },
      },
    ),
  ).rejects.toThrow("Authentication failure");
  await expect(
    planTicketBenchmark(
      {
        cwd: repo,
        repository: "example/project",
        tickets: ["https://github.com/another/repo/issues/94"],
      },
      dependencies,
    ),
  ).rejects.toThrow("differs");
});

const worker = (request: WorkerRequest): WorkerObservation => ({
  imageDigest: `sha256:${"a".repeat(64)}`,
  codexVersion: "codex-cli test",
  nodeVersion: "v22.0.0",
  configSha256: createHash("sha256").update(request.config).digest("hex"),
  authenticated: true,
  usageAvailable: true,
  models: [
    {
      model: "gpt-6-astra",
      supportedReasoningEfforts: ["medium", "high", "xhigh", "max"].map(
        (reasoningEffort) => ({ reasoningEffort }),
      ),
    },
    {
      model: "gpt-6.1-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
    },
  ],
  tools: Object.fromEntries(
    request.capabilities.tools.map((tool) => [tool, `/usr/bin/${tool}`]),
  ),
  freeBytes: 2_147_483_648,
  freeInodes: 100_000,
  gradingReady: true,
  readOnlySandbox: { ready: true, detail: null },
  environments: Object.fromEntries(
    request.capabilities.environments.map((environment) => [
      environment.name,
      true,
    ]),
  ),
});

it("checks the actual worker catalog for both roles and preserves execution gaps", async () => {
  const { repo } = await project();
  const options = {
    cwd: repo,
    tickets: ["task.md"],
    check: "pnpm test",
    preflight: true,
  };
  const plan = await planTicketBenchmark(options, {
    inspectWorker: async (request) => worker(request),
  });
  expect(plan.readiness).toMatchObject({
    mode: "preflight",
    workerStatus: "ready",
    status: "blocked",
    executionReady: false,
  });
  expect(plan.launch?.modelCatalog).toHaveLength(2);
  expect(plan.readiness?.executionBlockers.join(" ")).toContain(
    "requires mapped checkCases",
  );
  expect(plan.launch?.identities.judge).toMatchObject({
    requested: "gpt-6.1-sol:xhigh",
    observed: null,
  });
  const unsupportedJudge = await planTicketBenchmark(
    { ...options, judge: "gpt-6.1-sol:high" },
    { inspectWorker: async (request) => worker(request) },
  );
  expect(unsupportedJudge.readiness?.blockers.join(" ")).toContain(
    "gpt-6.1-sol/high",
  );
  const unsupportedArm = await planTicketBenchmark(
    { ...options, arms: ["gpt-6.2-sol:max"] },
    { inspectWorker: async (request) => worker(request) },
  );
  expect(unsupportedArm.readiness?.blockers.join(" ")).toContain(
    "gpt-6.2-sol/max",
  );
});

it("accepts catalog-advertised effort values without a fixed host allowlist", async () => {
  const { repo } = await project();
  const plan = await planTicketBenchmark(
    {
      cwd: repo,
      prompt: "Task",
      arms: ["gpt-6.1-sol:ultra"],
      preflight: true,
      check: "true",
    },
    {
      inspectWorker: async (request) => ({
        ...worker(request),
        models: [
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "ultra" },
              { reasoningEffort: "xhigh" },
            ],
          },
        ],
      }),
    },
  );
  expect(plan.arms[0]?.effort).toBe("ultra");
  expect(plan.readiness?.workerStatus).toBe("ready");
});

it("requires local prerequisite status metadata rather than a quoted completion example", async () => {
  const { repo } = await project();
  await writeFile(
    join(repo, "prerequisite.md"),
    "# Pending prerequisite\n\nExample:\n```yaml\nstatus: closed\n```\n",
  );
  await writeFile(
    join(repo, "launch.json"),
    JSON.stringify({ version: 1, prerequisites: ["prerequisite.md"] }),
  );
  const options = { cwd: repo, prompt: "Task", contract: "launch.json" };
  expect(
    (await planTicketBenchmark(options)).launch?.prerequisites[0]?.state,
  ).toBe("unknown");
  await writeFile(
    join(repo, "prerequisite.md"),
    "---\nstatus: completed\n---\n# Completed prerequisite\n",
  );
  expect(
    (await planTicketBenchmark(options)).launch?.prerequisites[0]?.state,
  ).toBe("satisfied");
});

it("reports environment, authentication, capacity, grading and dependency blockers without credential exports", async () => {
  const { repo } = await project();
  await writeFile(
    join(repo, "launch.json"),
    JSON.stringify({
      version: 1,
      environments: [{ name: "browser", probe: "test -x /usr/bin/chromium" }],
      prerequisites: ["missing-prerequisite.md"],
    }),
  );
  const plan = await planTicketBenchmark(
    {
      cwd: repo,
      tickets: ["task.md"],
      contract: "launch.json",
      preflight: true,
      check: "pnpm test",
    },
    {
      inspectWorker: async (request) => ({
        ...worker(request),
        authenticated: false,
        usageAvailable: false,
        freeBytes: 1,
        freeInodes: 1,
        gradingReady: false,
        readOnlySandbox: { ready: false, detail: "Read-only command failed" },
        tools: { codex: "/usr/bin/codex" },
        environments: { browser: false },
      }),
    },
  );
  for (const blocker of [
    "worker-authentication",
    "worker-usage-capacity",
    "worker-capacity",
    "grading-readiness",
    "worker-read-only-sandbox",
    "environment:browser",
    "tool:pnpm",
    "prerequisite",
  ])
    expect(plan.readiness?.blockers.join(" ")).toContain(blocker);
  const unsafe = await planTicketBenchmark(
    { cwd: repo, prompt: "Task", preflight: true },
    {
      inspectWorker: async (request) => ({
        ...worker(request),
        secret: "credential-must-not-escape",
      }),
    },
  );
  expect(JSON.stringify(unsafe)).not.toContain("credential-must-not-escape");
  expect(unsafe.launch?.worker.observation).toBeNull();
});

it("binds frozen identity to task, rubric, judge, dependencies and base instructions", async () => {
  const { repo, git } = await project();
  const options = { cwd: repo, tickets: ["task.md"] };
  const first = await planTicketBenchmark(options);
  expect((await planTicketBenchmark(options)).id).toBe(first.id);
  expect(first.runnerCommit).not.toBe(first.baseCommit);
  expect(first.launch?.rateCardStatus).toBe("unknown");
  expect(first.launch?.grading.rubric).toMatchObject([
    {
      id: "task-1-criterion-1",
      requirement: "Keep chunks contiguous.",
      weight: 1,
      partialCredit: 0.5,
      applicability: "always",
    },
  ]);
  expect(
    (await planTicketBenchmark({ ...options, judge: "gpt-6-astra:high" })).id,
  ).not.toBe(first.id);
  await writeFile(
    join(repo, "task.md"),
    "# Task\n\n## Acceptance criteria\n- [ ] Preserve every chunk.\n  Include the final chunk after completion.\n- [ ] Keep order.\n",
  );
  expect(
    (await planTicketBenchmark(options)).launch?.grading.rubric[0]?.requirement,
  ).toBe("Preserve every chunk.\n  Include the final chunk after completion.");
  await writeFile(join(repo, "task.md"), "# A different exact task\n");
  expect((await planTicketBenchmark(options)).id).not.toBe(first.id);
  await writeFile(join(repo, "AGENTS.md"), "A later instruction\n");
  await writeFile(join(repo, "pnpm-lock.yaml"), "Changed dependencies\n");
  git("add", ".");
  git("commit", "-m", "Changed project");
  const oldBase = await planTicketBenchmark({
    ...options,
    base: first.baseCommit,
  });
  expect(oldBase.launch?.instructions[0]?.text).toBe("Use pnpm.\n");
  expect(oldBase.launch?.dependencies[0]?.text).toBe(
    "lockfileVersion: '9.0'\n",
  );
  const current = await planTicketBenchmark(options);
  expect(current.launch?.dependencies[0]?.text).toBe("Changed dependencies\n");
});

it.each([undefined, null])(
  "freezes no individual implementation deadline for %s",
  async (implementationMinutes) => {
    const { repo } = await project();
    await writeFile(
      join(repo, "launch.json"),
      JSON.stringify({ version: 1, implementationMinutes }),
    );
    const plan = await planTicketBenchmark({
      cwd: repo,
      tickets: ["task.md"],
      contract: "launch.json",
    });
    expect(plan.launch!.allowances.implementationMs).toBeNull();
    expect(plan.invocationLimitMs).toBeNull();
    expect(invocationBudgetMs(100_000, null, 10_000)).toBe(90_000);
  },
);

it("freezes linked governing references and separate phase allowances", async () => {
  const { repo, git } = await project();
  await mkdir(join(repo, "docs"));
  await writeFile(
    join(repo, "AGENTS.md"),
    "Read [policy](<docs/review policy.md>) and [literal](docs/100%.md).\n",
  );
  await writeFile(
    join(repo, "docs", "review policy.md"),
    "Frozen review boundary. [More](more.md#checks)\n",
  );
  await writeFile(
    join(repo, "docs", "more.md"),
    "Frozen checks. [Policy](review%20policy.md)\n",
  );
  await writeFile(join(repo, "docs", "100%.md"), "Literal path.\n");
  git("add", ".");
  git("commit", "-m", "Linked instructions");
  await writeFile(
    join(repo, "launch.json"),
    JSON.stringify({
      version: 1,
      implementationMinutes: 24,
      checksMinutes: 8,
      controls: { knownBad: "HEAD", knownGood: "HEAD" },
    }),
  );
  const plan = await planTicketBenchmark({
    cwd: repo,
    tickets: ["task.md"],
    contract: "launch.json",
  });
  expect(plan.launch?.instructions.map((file) => file.path)).toEqual([
    "AGENTS.md",
    "docs/review policy.md",
    "docs/100%.md",
    "docs/more.md",
  ]);
  expect(plan.launch?.grading.prompt).not.toContain("Frozen review boundary");
  expect(plan.launch?.allowances).toMatchObject({
    implementationMs: 24 * 60_000,
    checksMs: 8 * 60_000,
    controlsMs: 2 * 14 * 60_000,
  });
  await writeFile(join(repo, "docs", "more.md"), "Uncommitted policy edit");
  expect(
    (
      await planTicketBenchmark({ cwd: repo, tickets: ["task.md"] })
    ).launch?.instructions.at(-1)?.text,
  ).toContain("Frozen checks");
});

it("uses the selected project and explicit prompt fallback without backlog discovery", async () => {
  const { repo } = await project();
  const plan = await planTicketBenchmark({
    cwd: process.cwd(),
    project: repo,
    tickets: ["task.md"],
    arms: ["gpt-6.1-sol:ExtraHigh"],
    judge: "gpt-6-astra:high",
  });
  expect(plan.cwd).toBe(repo);
  expect(plan.arms).toEqual([
    {
      model: "gpt-6.1-sol",
      effort: "xhigh",
      requested: "gpt-6.1-sol:ExtraHigh",
    },
  ]);
  expect(plan.judge).toMatchObject({ model: "gpt-6-astra", effort: "high" });
  expect(plan.launch?.instructions[0]).toMatchObject({
    path: "AGENTS.md",
    text: "Use pnpm.\n",
  });
  await expect(planTicketBenchmark({ cwd: repo })).rejects.toThrow(
    "--ticket or --prompt",
  );
  const fallback = await planTicketBenchmark({
    cwd: repo,
    tickets: ["absent.md"],
    prompt: "Implement this exact fallback.",
  });
  expect(fallback.tickets[0]).toMatchObject({
    text: "Implement this exact fallback.",
    missingSource: "absent.md",
  });
  await expect(
    planTicketBenchmark({ cwd: repo, tickets: ["*.md"] }),
  ).rejects.toThrow("select an exact");
  await expect(
    planTicketBenchmark({
      cwd: repo,
      arms: ["gpt-6.1-sol:xhigh", "gpt-6.1-sol:extra-high"],
      prompt: "Task",
    }),
  ).rejects.toThrow("distinct");
});

it("freezes explicit rubric rules and declared satisfied prerequisites before worker inspection", async () => {
  const { repo } = await project();
  const config = {
    version: 1,
    allowedEdits: ["src/**", ".changeset/**"],
    prerequisites: ["93"],
    rubric: [
      {
        id: "required-stream",
        requirement: "Keep the full stream",
        weight: 3,
        partialCredit: 0.25,
        applicability: "nonvisual",
        evidence: ["code", "check"],
      },
    ],
  };
  await writeFile(join(repo, "launch.json"), JSON.stringify(config));
  const options = {
    cwd: repo,
    repository: "example/project",
    tickets: ["task.md"],
    contract: "launch.json",
  };
  const plan = await planTicketBenchmark(options, {
    resolveIssue: async () => ({
      title: "Prerequisite",
      body: "Completed prerequisite",
      url: "https://github.com/example/project/issues/93",
      state: "CLOSED",
      comments: [],
    }),
  });
  expect(plan.launch?.prerequisites[0]?.state).toBe("satisfied");
  expect(plan.launch?.grading.rubric).toEqual(config.rubric);
  expect(plan.launch?.allowedEdits).toEqual(["src/**", ".changeset/**"]);
  expect(plan.launch?.grading.rubric[0]?.id).toBe("required-stream");
  await writeFile(
    join(repo, "launch.json"),
    JSON.stringify({ ...config, rubric: [...config.rubric, ...config.rubric] }),
  );
  await expect(planTicketBenchmark(options)).rejects.toThrow("criterion IDs");
  await expect(
    planTicketBenchmark({ cwd: repo, prompt: "Task", maxNewSlots: 0 }),
  ).rejects.toThrow("max-new-slots");
});

it.each([
  "missing-case",
  "unfrozen-file",
  "duplicate-case",
  "duplicate-mapping",
  "unsafe-id",
  "missing-controls",
])(
  "rejects or blocks a %s check contract before inference",
  async (failure) => {
    const { repo } = await project();
    const config: any = {
      version: 1,
      rubric: [
        {
          id: "runtime",
          requirement: "Run the required acceptance case",
          weight: 1,
          partialCredit: 0.5,
          applicability: "always",
          evidence: ["check"],
          checkCases: ["runtime"],
        },
      ],
      checkCases: [
        {
          id: "runtime",
          command: "pnpm test",
          files: ["AGENTS.md"],
          controls: { knownBad: "HEAD", knownGood: "HEAD" },
        },
      ],
    };
    if (failure === "missing-case") config.checkCases = [];
    if (failure === "unfrozen-file")
      config.checkCases[0].files = ["untracked.test.ts"];
    if (failure === "duplicate-case")
      config.checkCases.push(config.checkCases[0]);
    if (failure === "duplicate-mapping")
      config.rubric[0].checkCases.push("runtime");
    if (failure === "unsafe-id") config.checkCases[0].id = "../runtime";
    if (failure === "missing-controls") delete config.checkCases[0].controls;
    await writeFile(join(repo, "launch.json"), JSON.stringify(config));
    const inspectWorker = vi.fn(async (request: WorkerRequest) =>
      worker(request),
    );
    const planned = planTicketBenchmark(
      {
        cwd: repo,
        tickets: ["task.md"],
        contract: "launch.json",
        check: "pnpm test",
        preflight: true,
      },
      { inspectWorker },
    );
    if (failure === "missing-case") {
      const plan = await planned;
      expect(plan.readiness?.executionReady).toBe(false);
      expect(plan.readiness?.executionBlockers.join(" ")).toContain(
        "missing check case runtime",
      );
    } else {
      await expect(planned).rejects.toThrow();
      expect(inspectWorker).not.toHaveBeenCalled();
    }
  },
);

it.each(["unknown-task", "empty-task", "overflowing-total"] as const)(
  "rejects %s rubric contracts before declaring a plan ready",
  async (problem) => {
    const { repo } = await project();
    await writeFile(join(repo, "other.md"), "Another selected task\n");
    const row = {
      id: "behavior",
      requirement: "Keep the required behavior",
      weight: 1,
      partialCredit: 0.5,
      applicability: "always",
      evidence: ["code"],
    };
    const rubric =
      problem === "overflowing-total"
        ? [
            { ...row, weight: 1e308 },
            { ...row, id: "other", weight: 1e308 },
          ]
        : [{ ...row, task: problem === "unknown-task" ? 2 : 1 }];
    await writeFile(
      join(repo, "launch.json"),
      JSON.stringify({ version: 1, rubric }),
    );
    await expect(
      planTicketBenchmark({
        cwd: repo,
        tickets:
          problem === "empty-task" ? ["task.md", "other.md"] : ["task.md"],
        contract: "launch.json",
      }),
    ).rejects.toThrow(
      problem === "unknown-task"
        ? "Rubric task"
        : problem === "empty-task"
          ? "Every selected task"
          : "finite",
    );
  },
);

it("charges setup time against the remaining model-call budget", () => {
  expect(invocationBudgetMs(1_000, 900, 100)).toBe(900);
  expect(invocationBudgetMs(1_000, 900, 700)).toBe(300);
  expect(invocationBudgetMs(1_000, 900, 1_000)).toBe(0);
});

it("freezes explicit input and the four Astra arms with an independent judge", async () => {
  const root = await mkdtemp(join(tmpdir(), "ticket-benchmark-"));
  const repo = join(root, "repo");
  const output = join(root, "evidence");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  try {
    await mkdir(join(repo, "tickets"), { recursive: true });
    await writeFile(
      join(repo, "tickets", "stream.md"),
      "# Stream logging\n\nKeep chunks contiguous.\n",
    );
    git("init", "-b", "main");
    git("config", "user.name", "Benchmark test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "-m", "Base");

    const plan = await planTicketBenchmark({
      cwd: repo,
      tickets: ["tickets/stream.md"],
      output,
    });
    expect(plan.tickets.map((ticket) => ticket.source)).toEqual([
      "tickets/stream.md",
    ]);
    expect(plan.arms.map((arm) => `${arm.model}:${arm.effort}`)).toEqual([
      "gpt-6-astra:medium",
      "gpt-6-astra:high",
      "gpt-6-astra:xhigh",
      "gpt-6-astra:max",
    ]);
    expect(plan.judge).toMatchObject({ model: "gpt-6.1-sol", effort: "xhigh" });
    expect(plan.readiness).toMatchObject({
      mode: "scheduling",
      status: "blocked",
    });
    await expect(runTicketBenchmark(plan)).rejects.toThrow("execution");
    // The version-one runner remains available for retained historical plans.
    const legacyPlan = {
      ...plan,
      version: 1 as const,
      runnerCommit: plan.baseCommit,
      arms: plan.arms.slice(0, 3),
      slots: plan.slots.slice(0, 3),
    };
    let calls = 0;
    const execute = async () => {
      calls++;
      return {
        status: "passed" as const,
        candidateHead: `candidate-${calls}`,
        usage: null,
      };
    };
    expect(await runTicketBenchmark(legacyPlan, execute, 1)).toMatchObject({
      status: "in-progress",
      completed: 1,
    });
    expect(calls).toBe(1);
    expect(await runTicketBenchmark(legacyPlan, execute, 1)).toMatchObject({
      status: "in-progress",
      completed: 2,
    });
    expect(calls).toBe(2);
    expect(await runTicketBenchmark(legacyPlan, execute, 1)).toMatchObject({
      status: "complete",
      completed: 3,
    });
    expect(calls).toBe(3);
    expect(await runTicketBenchmark(legacyPlan, execute)).toMatchObject({
      status: "complete",
      completed: 3,
    });
    expect(calls).toBe(3);

    const report = JSON.parse(
      await readFile(join(output, "report.json"), "utf8"),
    );
    expect(report.rows.map((row: { status: string }) => row.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(
      (await readFile(join(output, "evaluations.csv"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(4);
    expect(await readFile(join(output, "report.html"), "utf8")).toContain(
      "3/3 slots attempted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
