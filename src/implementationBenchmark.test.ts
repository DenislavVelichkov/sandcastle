import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { planTicketBenchmark, runTicketBenchmark } from "./ticketBenchmark.js";
import type { TicketBenchmarkOptions } from "./ticketBenchmark.js";
import type { LaunchContract } from "./benchmarkLaunch.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("connects the real Docker executor to protected checks without mounting host Git or exporting credentials", async () => {
  const { repo, plan } = await fixture();
  const tools = join(dirname(plan.output), "tools");
  const auth = join(tools, "auth");
  await mkdir(auth, { recursive: true });
  await writeFile(
    join(auth, "auth.json"),
    JSON.stringify({ tokens: { access_token: "private-token-sentinel" } }),
  );
  const log = join(tools, "docker-calls.jsonl");
  await writeFile(
    join(tools, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'run') process.stdout.write('owned-container');
else if (args[0] === 'rm') process.exitCode = 0;
else if (args.includes('--version')) process.stdout.write(args.includes('codex') ? 'codex test\\n' : process.version + '\\n');
else {
  const cwd = args[args.indexOf('-w') + 1];
  const command = args.at(-1);
  if (command.startsWith('codex exec')) {
    fs.writeFileSync(path.join(cwd, 'value.txt'), 'correct\\n');
    process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:20, cached_input_tokens:5, output_tokens:7}}) + '\\nprivate-token-sentinel\\n');
  } else {
    const checked = spawnSync('sh', ['-c', command], {cwd, encoding:'utf8'});
    process.stdout.write(checked.stdout || '');
    process.stderr.write(checked.stderr || '');
    process.exitCode = checked.status;
  }
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${tools}:${process.env.PATH}`);
  vi.stubEnv("CODEX_HOME", auth);
  expect(await runTicketBenchmark(plan, undefined, 1)).toMatchObject({
    status: "judge-pending",
    completed: 1,
  });
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  for (const args of calls.filter((args) => args[0] === "run")) {
    expect(args.filter((arg) => arg === "-v")).toHaveLength(1);
    expect(args.join(" ")).not.toContain(repo);
    expect(args).toContain(plan.launch!.worker.observation!.imageDigest);
    expect(args).toContain("--pids-limit");
  }
  expect(calls.filter((args) => args[0] === "rm")).toHaveLength(2);
  const stream = await readFile(
    join(plan.output, `${plan.slots[0]!.id}-implementation.jsonl`),
    "utf8",
  );
  expect(stream).not.toContain("private-token-sentinel");
  expect(stream).toContain("[redacted]");
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const fixture = async (
  options: Partial<TicketBenchmarkOptions> = {},
  contract?: Partial<LaunchContract>,
) => {
  const root = await mkdtemp(join(tmpdir(), "private-benchmark-"));
  roots.push(root);
  const repo = join(root, "project");
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "task.md"), "Implement the value.\n");
  await writeFile(join(repo, "value.txt"), "base\n");
  await writeFile(
    join(repo, "check.sh"),
    'test "$(cat value.txt)" = correct\n',
  );
  await writeFile(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  if (contract)
    await writeFile(
      join(repo, "launch.json"),
      JSON.stringify({ version: 1, ...contract }),
    );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Frozen base");
  if (contract?.controls?.knownGood) {
    git(repo, "checkout", "-b", "correct");
    await writeFile(join(repo, "value.txt"), "correct\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Known correction");
    git(repo, "checkout", "main");
  }
  const plan = await planTicketBenchmark(
    {
      cwd: repo,
      tickets: ["task.md"],
      arms: ["gpt-6-astra:medium", "gpt-6-astra:high"],
      check: "sh check.sh",
      output: join(root, "evidence"),
      preflight: true,
      contract: contract ? "launch.json" : undefined,
      ...options,
    },
    {
      inspectWorker: async (request) => ({
        imageDigest: `sha256:${"a".repeat(64)}`,
        codexVersion: "codex test",
        nodeVersion: process.version,
        configSha256: createHash("sha256").update(request.config).digest("hex"),
        authenticated: true,
        usageAvailable: true,
        models: [
          {
            model: "gpt-6-astra",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
          },
          {
            model: "gpt-6.1-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
          },
        ],
        tools: Object.fromEntries(
          request.capabilities.tools.map((tool) => [tool, `/bin/${tool}`]),
        ),
        freeBytes: 2 ** 32,
        freeInodes: 100_000,
        gradingReady: true,
        environments: {},
      }),
    },
  );
  return { repo, plan };
};

it("runs isolated same-base arms beside a dirty host and retains uncommitted candidates for judging", async () => {
  const { repo, plan } = await fixture();
  await writeFile(join(repo, "value.txt"), "host draft\n");
  await writeFile(join(repo, "untracked.txt"), "host only\n");
  const before = git(repo, "show-ref");
  const implementationPaths: string[] = [];
  let otherArmCommit: string | undefined;
  const stopped: string[] = [];
  const result = await runTicketBenchmark(plan, undefined, Infinity, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) {
          implementationPaths.push(request.worktree);
          expect(git(request.worktree, "rev-parse", "HEAD")).toBe(
            plan.baseCommit,
          );
          expect(
            await readFile(join(request.worktree, "value.txt"), "utf8"),
          ).toBe("base\n");
          expect(git(request.worktree, "remote")).toBe("");
          expect(
            git(request.worktree, "rev-parse", "--git-common-dir"),
          ).not.toContain(join(repo, ".git"));
          if (otherArmCommit)
            expect(() =>
              git(request.worktree, "cat-file", "-e", otherArmCommit!),
            ).toThrow();
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
          await writeFile(
            join(request.worktree, "new.txt"),
            "untracked candidate\n",
          );
          await mkdir(join(request.worktree, "node_modules"));
          await writeFile(
            join(request.worktree, "node_modules", "large"),
            "disposable\n",
          );
          if (implementationPaths.length === 1) {
            git(request.worktree, "add", "value.txt");
            git(request.worktree, "commit", "-m", "First arm private solution");
            otherArmCommit = git(request.worktree, "rev-parse", "HEAD");
          }
          return {
            stdout:
              '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":7}}\n',
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "check passed", stderr: "", exitCode: 0 };
      },
      stop: async () => {
        stopped.push(request.worktree);
      },
    }),
  });
  expect(result).toMatchObject({ status: "judge-pending", completed: 2 });
  expect(new Set(implementationPaths).size).toBe(2);
  expect(stopped).toHaveLength(4);
  expect(git(repo, "show-ref")).toBe(before);
  expect(await readFile(join(repo, "value.txt"), "utf8")).toBe("host draft\n");
  expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe(
    "host only\n",
  );
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  for (const attempt of ledger.attempts) {
    expect(attempt.status).toBe("judge-pending");
    expect(attempt.check.status).toBe("passed");
    expect(attempt.implementation.usage).toMatchObject({
      inputTokens: 15,
      cacheReadInputTokens: 5,
      outputTokens: 7,
    });
    expect(
      await readFile(join(attempt.candidate.worktree, "new.txt"), "utf8"),
    ).toBe("untracked candidate\n");
    expect(git(attempt.candidate.worktree, "status", "--porcelain")).toBe("");
    await expect(
      readFile(join(attempt.candidate.worktree, "node_modules", "large")),
    ).rejects.toThrow();
  }
});

it("keeps scope violations inspectable without treating passing checks as acceptance", async () => {
  const { plan } = await fixture({}, { allowedEdits: ["value.txt"] });
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) {
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
          await writeFile(
            join(request.worktree, "unauthorized.txt"),
            "outside scope\n",
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  const report = JSON.parse(
    await readFile(join(plan.output, "report.json"), "utf8"),
  );
  expect(report).toMatchObject({
    evaluated: 0,
    projectAcceptance: "not assessed",
  });
  expect(report.attempts[0]).toMatchObject({
    status: "scope-violation",
    check: { status: "passed" },
    judge: { status: "pending" },
  });
});

it("records missing checks and blocked environments without implementation calls", async () => {
  for (const scenario of [
    "missing-checks",
    "environment-unavailable",
  ] as const) {
    const { plan } =
      scenario === "missing-checks"
        ? await fixture({ check: undefined })
        : await fixture({}, { minimumFreeBytes: 2 ** 50 });
    const result = await runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async () => {
        throw new Error("Must not invoke");
      },
    });
    expect(result).toMatchObject({ status: scenario, completed: 0 });
    const ledger = JSON.parse(
      await readFile(join(plan.output, "execution.json"), "utf8"),
    );
    expect(ledger.budget.implementationCalls).toBe(0);
  }
});

it("blocks measurement when a declared known-bad control passes the protected checker", async () => {
  const { plan } = await fixture(
    { maxMinutes: 90 },
    { controls: { knownBad: "HEAD" } },
  );
  let modelCalls = 0;
  const result = await runTicketBenchmark(plan, undefined, Infinity, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) modelCalls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  expect(result).toMatchObject({ status: "control-failed", completed: 0 });
  expect(modelCalls).toBe(0);
});

it("exercises frozen bad/good controls before a single implementation and keeps a judge call reserved", async () => {
  const { plan } = await fixture(
    { maxMinutes: 90 },
    { controls: { knownBad: "HEAD", knownGood: "correct" }, maxCalls: 2 },
  );
  let implementations = 0;
  const result = await runTicketBenchmark(plan, undefined, Infinity, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) {
          implementations++;
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
          return { stdout: "done", stderr: "", exitCode: 0 };
        }
        try {
          return {
            stdout: execFileSync("sh", ["check.sh"], {
              cwd: request.worktree,
              encoding: "utf8",
            }),
            stderr: "",
            exitCode: 0,
          };
        } catch {
          return { stdout: "wrong value", stderr: "", exitCode: 1 };
        }
      },
      stop: async () => {},
    }),
  });
  expect(implementations).toBe(1);
  expect(result).toMatchObject({ status: "budget-exhausted", completed: 1 });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(
    ledger.controls.results.map(
      (control: { exitCode: number }) => control.exitCode,
    ),
  ).toEqual([1, 0]);
  expect(ledger.budget).toMatchObject({
    implementationCalls: 1,
    judgeReservedCalls: 1,
    judgeReservedMs: 600_000,
  });
  expect(ledger.unrun).toEqual([plan.slots[1]!.id]);
});

it.each([
  ["worker-failed", true],
  ["no-candidate", false],
  ["timed-out", true],
  ["cancelled", true],
  ["environment-unavailable", true],
] as const)(
  "retains the distinct %s outcome and its applicable partial candidate",
  async (outcome, hasCandidate) => {
    const { plan } = await fixture();
    const cancellation = new AbortController();
    let time = Date.now();
    const stopped: string[] = [];
    await runTicketBenchmark(plan, undefined, 1, {
      signal: cancellation.signal,
      now: () => time,
      createRuntime: async (request) => {
        if (request.role === "checks" && outcome === "environment-unavailable")
          throw new Error("Required checker runtime unavailable");
        return {
          id: request.worktree,
          exec: async ({ command, onLine }) => {
            if (command.startsWith("codex exec")) {
              if (outcome === "no-candidate")
                await rm(request.worktree, { recursive: true, force: true });
              else
                await writeFile(
                  join(request.worktree, "value.txt"),
                  "partial\n",
                );
              onLine?.(
                '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}',
              );
              if (outcome === "timed-out") time += 16 * 60_000;
              if (outcome === "cancelled") cancellation.abort();
              return {
                stdout: "",
                stderr: "",
                exitCode: outcome === "worker-failed" ? 3 : 0,
              };
            }
            return { stdout: "", stderr: "wrong", exitCode: 1 };
          },
          stop: async () => {
            stopped.push(request.worktree);
          },
        };
      },
    });
    const ledger = JSON.parse(
      await readFile(join(plan.output, "execution.json"), "utf8"),
    );
    const attempt = ledger.attempts[0];
    expect(attempt.status).toBe(outcome);
    expect(Boolean(attempt.candidate)).toBe(hasCandidate);
    expect(attempt.cleanup.status).toBe("passed");
    expect(stopped.length).toBeGreaterThan(0);
    expect(ledger.budget.implementationCalls).toBe(1);
    if (hasCandidate)
      expect(
        await readFile(join(attempt.candidate.worktree, "value.txt"), "utf8"),
      ).toBe("partial\n");
  },
);

it("records failed owned cleanup, stops admission and refuses to overwrite an existing attempt", async () => {
  const { plan } = await fixture();
  let invocations = 0;
  const result = await runTicketBenchmark(plan, undefined, Infinity, {
    createRuntime: async (request) => ({
      id: "owned-container-needing-stop",
      exec: async () => {
        invocations++;
        await writeFile(join(request.worktree, "value.txt"), "partial\n");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {
        throw new Error("stop failed");
      },
    }),
  });
  expect(result.status).toBe("cleanup-failed");
  expect(invocations).toBe(1);
  const before = await readFile(join(plan.output, "execution.json"), "utf8");
  expect(JSON.parse(before).attempts[0].cleanup.resources).toContain(
    "owned-container-needing-stop",
  );
  await expect(runTicketBenchmark(plan)).rejects.toThrow("durable recovery");
  expect(await readFile(join(plan.output, "execution.json"), "utf8")).toBe(
    before,
  );
});

it("checks and retains an unchanged but inspectable candidate instead of inferring failure from no commits", async () => {
  const { plan } = await fixture();
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async () => ({
        stdout: "",
        stderr: "",
        exitCode: request.role === "implementation" ? 0 : 1,
      }),
      stop: async () => {},
    }),
  });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.attempts[0]).toMatchObject({
    status: "check-failed",
    check: { status: "failed" },
    candidate: { head: plan.baseCommit },
    judge: { status: "pending" },
  });
});

it("retains available session identities and reports a substituted model without hiding the candidate", async () => {
  const { plan } = await fixture();
  const bytes =
    '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"high","service_tier":"default"}}\n';
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) {
          const sessions = join(request.root, "home", ".codex", "sessions");
          await mkdir(sessions, { recursive: true });
          await writeFile(join(sessions, "rollout-test.jsonl"), bytes);
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.attempts[0]).toMatchObject({
    status: "identity-mismatch",
    check: { status: "passed" },
    judge: { status: "pending" },
  });
  expect(
    await readFile(ledger.attempts[0].implementation.sessions[0].path, "utf8"),
  ).toBe(bytes);
});

it("retains unrun slots when the remaining allowance cannot cover implementation and judging", async () => {
  const { plan } = await fixture({ maxMinutes: 30 });
  let calls = 0;
  const result = await runTicketBenchmark(plan, undefined, Infinity, {
    createRuntime: async () => {
      calls++;
      throw new Error("Must not admit");
    },
  });
  expect(result).toMatchObject({ status: "budget-exhausted", completed: 0 });
  expect(calls).toBe(0);
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.unrun).toEqual(plan.slots.map((slot) => slot.id));
  expect(ledger.budget.judgeReservedMs).toBe(0);
});

it("grades sealed code with the frozen check script even when the worker replaces it", async () => {
  const { plan } = await fixture();
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec")) {
          await writeFile(join(request.worktree, "value.txt"), "wrong\n");
          await writeFile(join(request.worktree, "check.sh"), "exit 0\n");
          return { stdout: "I completed the ticket", stderr: "", exitCode: 0 };
        }
        expect(await readFile(join(request.worktree, "check.sh"), "utf8")).toBe(
          'test "$(cat value.txt)" = correct\n',
        );
        return { stdout: "incorrect value", stderr: "", exitCode: 1 };
      },
      stop: async () => {},
    }),
  });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.attempts[0].status).toBe("check-failed");
  expect(ledger.attempts[0].check.status).toBe("failed");
  expect(
    await readFile(
      join(ledger.attempts[0].candidate.worktree, "check.sh"),
      "utf8",
    ),
  ).toBe("exit 0\n");
});
