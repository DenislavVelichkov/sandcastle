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
  expect(plan.launch?.grading.prompt).toContain("required-stream");
  await writeFile(
    join(repo, "launch.json"),
    JSON.stringify({ ...config, rubric: [...config.rubric, ...config.rubric] }),
  );
  await expect(planTicketBenchmark(options)).rejects.toThrow("criterion IDs");
  await expect(
    planTicketBenchmark({ cwd: repo, prompt: "Task", maxNewSlots: 0 }),
  ).rejects.toThrow("max-new-slots");
});

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
      status: "unchecked",
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
