import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { planTicketBenchmark, runTicketBenchmark } from "./ticketBenchmark.js";
import type { TicketBenchmarkOptions } from "./ticketBenchmark.js";
import type { LaunchContract } from "./benchmarkLaunch.js";
import {
  cancelBenchmark,
  readBenchmarkLog,
  readBenchmarkProgress,
  resumeTicketBenchmark,
  watchBenchmarkProgress,
} from "./benchmarkProgress.js";

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
else if (args[0] === 'inspect') { process.stderr.write('No such object'); process.exitCode = 1; }
else if (args.includes('--version')) process.stdout.write(args.includes('codex') ? 'codex test\\n' : process.version + '\\n');
else {
  const cwd = args[args.indexOf('-w') + 1];
  const command = args.at(-1);
  if (command.startsWith('codex exec')) {
    fs.writeFileSync(path.join(cwd, 'value.txt'), 'correct\\n');
    process.stdout.write(JSON.stringify({type:'turn.completed', usage:{input_tokens:20, cached_input_tokens:5, output_tokens:7}}) + '\\nprivate-token-sentinel\\n');
    const unicode = Buffer.from('привет\\n');
    process.stdout.write(unicode.subarray(0, 1));
    setTimeout(() => process.stdout.write(unicode.subarray(1)), 50);
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
  expect(stream).toContain("привет");
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
  frozenFiles: Readonly<
    Record<string, string | { text: string; mode: number }>
  > = {},
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
  for (const [path, value] of Object.entries(frozenFiles)) {
    const file =
      typeof value === "string" ? { text: value, mode: undefined } : value;
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), file.text, { mode: file.mode });
  }
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

it("publishes live progress and reconnects a passive observer without replaying execution", async () => {
  const { plan } = await fixture();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const running = runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command, onLine }) => {
        if (command.startsWith("codex exec")) {
          calls++;
          onLine?.(
            '{"type":"item.completed","item":{"type":"agent_message","text":"private worker narrative"}}',
          );
          onLine?.(
            '{"type":"turn.completed","usage":{"input_tokens":20,"cached_input_tokens":5,"output_tokens":7}}',
          );
          await waiting;
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  try {
    await vi.waitFor(async () => {
      const { snapshot } = await readBenchmarkProgress(plan.output);
      expect(snapshot.phase).toBe("implementation");
      expect(snapshot.counts).toMatchObject({
        scheduled: 2,
        attempted: 1,
        completed: 0,
        graded: 0,
        implementationCalls: 1,
        judgeCalls: 0,
      });
      expect(snapshot.lastImplementationEvent).toMatchObject({ kind: "usage" });
      expect(snapshot.attempts[0]?.usage?.outputTokens).toBe(7);
    });
    const first = await readBenchmarkProgress(plan.output);
    expect(JSON.stringify(first)).not.toContain("private worker narrative");
    expect(first.snapshot.owner?.pid).toBe(process.pid);
    expect(first.snapshot.lastImplementationEvent?.at).not.toBeNull();
    expect(
      await readBenchmarkLog(plan.output, first.snapshot.attempts[0]!.id),
    ).toContain("private worker narrative");
    const disconnect = new AbortController();
    const observer = watchBenchmarkProgress(plan.output, {
      after: first.cursor,
      signal: disconnect.signal,
    });
    let heartbeat = await observer.next();
    while (!heartbeat.value?.events.some((event) => event.kind === "heartbeat"))
      heartbeat = await observer.next();
    expect(heartbeat.value!.snapshot.controllerHeartbeat).not.toBe(
      first.snapshot.controllerHeartbeat,
    );
    expect(heartbeat.value!.snapshot.lastImplementationEvent?.at).toBe(
      first.snapshot.lastImplementationEvent?.at,
    );
    disconnect.abort();
    await observer.return(undefined);
    expect((await readBenchmarkProgress(plan.output)).snapshot.phase).toBe(
      "implementation",
    );
    // Dropping the observer performs no mutation or cancellation.
    finish();
    expect(await running).toMatchObject({
      status: "judge-pending",
      completed: 1,
    });
    const reconnected = await readBenchmarkProgress(plan.output, {
      after: first.cursor,
    });
    expect(
      reconnected.events.every((event) => event.sequence > first.cursor),
    ).toBe(true);
    expect(reconnected.snapshot.counts.completed).toBe(1);
    expect(reconnected.snapshot.counts.graded).toBe(0);
    expect(reconnected.snapshot.owner).toBeNull();
    const phases = [...first.events, ...reconnected.events]
      .filter((event) => event.kind === "phase-started")
      .map((event) => event.phase);
    expect(phases.indexOf("implementation")).toBeLessThan(
      phases.indexOf("checks"),
    );
    expect(phases.indexOf("checks")).toBeLessThan(
      phases.lastIndexOf("cleanup"),
    );
    expect(calls).toBe(1);
    expect(
      await readFile(
        join(plan.output, `${plan.slots[0]!.id}-implementation.jsonl`),
        "utf8",
      ),
    ).toContain("private worker narrative");
  } finally {
    finish();
    await running;
  }
});

it.each(["setup", "implementation", "checks"] as const)(
  "persists cancellation during %s and stops owned work before releasing ownership",
  async (stage) => {
    const { plan } = await fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopOnAbort = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const stopped: string[] = [];
    const running = runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async (request) => {
        const { snapshot } = await readBenchmarkProgress(plan.output);
        expect(
          snapshot.resources.some(
            (resource) =>
              resource.id === request.id && resource.status === "owned",
          ),
        ).toBe(true);
        if (stage === "setup" && request.role === "implementation") {
          entered();
          return stopOnAbort(request.signal);
        }
        return {
          id: request.worktree,
          exec: async ({ command, signal, onLine }) => {
            if (command.startsWith("codex exec")) {
              await writeFile(join(request.worktree, "value.txt"), "partial\n");
              onLine?.(
                '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}',
              );
            }
            if (
              (stage === "implementation" &&
                command.startsWith("codex exec")) ||
              (stage === "checks" && request.role === "checks")
            ) {
              entered();
              return stopOnAbort(signal);
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          stop: async () => {
            stopped.push(request.worktree);
          },
        };
      },
    });
    await Promise.race([
      ready,
      running.then(() => {
        throw new Error("Execution stopped before the cancellation scenario");
      }),
    ]);
    await cancelBenchmark(plan.output, "Requested deterministic stop");
    expect(await running).toMatchObject({ status: "cancelled", completed: 1 });
    const { snapshot, events } = await readBenchmarkProgress(plan.output);
    expect(snapshot.cancellation?.reason).toBe("Requested deterministic stop");
    expect(snapshot.owner).toBeNull();
    expect(snapshot.resources.length).toBeGreaterThan(0);
    expect(
      snapshot.resources.every((resource) => resource.status === "released"),
    ).toBe(true);
    expect(
      events.some((event) => event.kind === "cancellation-requested"),
    ).toBe(true);
    if (stage !== "setup") {
      expect(stopped.length).toBeGreaterThan(0);
      expect(snapshot.attempts[0]?.usage?.outputTokens).toBe(3);
    }
  },
);

it("resumes only unrun slots with the original plan, identities, call counts and allowance", async () => {
  const { plan } = await fixture();
  let calls = 0;
  const dependencies = {
    createRuntime: async (
      request: import("./implementationBenchmark.js").BenchmarkRuntimeRequest,
    ) => ({
      id: request.id,
      exec: async ({ command }: { command: string }) => {
        if (command.startsWith("codex exec")) {
          calls++;
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  };
  await runTicketBenchmark(plan, undefined, 1, dependencies);
  const first = await readBenchmarkProgress(plan.output);
  const manifest = await readFile(join(plan.output, "manifest.json"), "utf8");
  expect(
    await resumeTicketBenchmark(plan.output, { maxNewSlots: 1 }, dependencies),
  ).toMatchObject({ completed: 2, status: "judge-pending" });
  const second = await readBenchmarkProgress(plan.output, {
    after: first.cursor,
  });
  expect(second.snapshot.runId).toBe(first.snapshot.runId);
  expect(second.snapshot.startedAt).toBe(first.snapshot.startedAt);
  expect(second.snapshot.attempts[0]?.id).toBe(first.snapshot.attempts[0]?.id);
  expect(second.snapshot.counts).toMatchObject({
    scheduled: 2,
    attempted: 2,
    attempts: 2,
    implementationCalls: 2,
    retries: 0,
    judgeCalls: 0,
  });
  expect(second.snapshot.allowance.remainingMs).toBeLessThan(
    first.snapshot.allowance.remainingMs,
  );
  expect(second.events.every((event) => event.sequence > first.cursor)).toBe(
    true,
  );
  expect(await readFile(join(plan.output, "manifest.json"), "utf8")).toBe(
    manifest,
  );
  await resumeTicketBenchmark(plan.output, {}, dependencies);
  expect(calls).toBe(2);
});

it.each(["interrupted", "cancelled", "unresponsive-recovery"] as const)(
  "recovers a killed controller with %s work without replaying completed calls",
  async (scenario) => {
    const { plan: original } = await fixture({}, { maxCalls: 6 });
    const { id: _id, ...frozenPlan } = {
      ...original,
      launch: {
        ...original.launch!,
        allowances: { ...original.launch!.allowances, cleanupMs: 500 },
      },
    };
    const { output: _output, ...hashed } = frozenPlan;
    const plan = {
      ...frozenPlan,
      id: createHash("sha256").update(JSON.stringify(hashed)).digest("hex"),
    };
    const root = dirname(plan.output);
    const frozen = join(root, "frozen-plan.json");
    await writeFile(frozen, JSON.stringify(plan));
    const script = join(root, "controller.mts");
    await writeFile(
      script,
      `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTicketBenchmark } from ${JSON.stringify(join(process.cwd(), "src/ticketBenchmark.ts"))};
const plan = JSON.parse(await readFile(${JSON.stringify(frozen)}, 'utf8'));
let calls = 0;
await runTicketBenchmark(plan, undefined, Infinity, {
  createRuntime: async (request) => ({
    id: request.id,
    exec: async ({command, onLine}) => {
      if (command.startsWith('codex exec')) {
        calls++;
        await writeFile(join(request.worktree, 'value.txt'), 'partial\\n');
        onLine?.('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}');
        if (calls === 2) await new Promise(() => {});
      }
      return {stdout:'', stderr:'', exitCode:0};
    },
    stop: async () => {},
  }),
});
`,
    );
    const child = spawn("pnpm", ["exec", "tsx", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    let ownerPid: number | undefined;
    try {
      await vi.waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(errors);
          const { snapshot } = await readBenchmarkProgress(plan.output);
          expect(snapshot.counts.implementationCalls).toBe(2);
          expect(snapshot.attempts[1]?.usage?.outputTokens).toBe(3);
          ownerPid = snapshot.owner!.pid;
        },
        { timeout: 4000 },
      );
      await expect(resumeTicketBenchmark(plan.output)).rejects.toThrow(
        "owner is still running",
      );
      process.kill(ownerPid!, "SIGKILL");
      await exited;
      const before = await readBenchmarkProgress(plan.output);
      if (scenario === "cancelled") {
        await cancelBenchmark(
          plan.output,
          "Cancellation retained after controller loss",
        );
        expect(
          (await readBenchmarkProgress(plan.output)).pendingCancellation
            ?.reason,
        ).toBe("Cancellation retained after controller loss");
      }
      await writeFile(
        join(plan.output, "benchmark.lock", "owner.json"),
        JSON.stringify({
          ...before.snapshot.owner,
          pid: process.pid,
          start: "retired-process-start",
        }),
      );
      await mkdir(join(plan.output, "benchmark-recovery.lock"));
      await writeFile(
        join(plan.output, "benchmark-recovery.lock", "owner.json"),
        JSON.stringify(before.snapshot.owner),
      );
      // A snapshot can lag a committed journal record and a crash can tear its last write.
      await writeFile(join(plan.output, "status.json"), '{"obsolete":true}');
      await appendFile(join(plan.output, "events.jsonl"), '{"torn":');
      let calls = 0;
      if (scenario === "unresponsive-recovery") {
        await expect(
          resumeTicketBenchmark(
            plan.output,
            {},
            {
              recoverResource: async () => new Promise(() => {}),
              createRuntime: async () => {
                calls++;
                throw new Error("Must not dispatch");
              },
            },
          ),
        ).rejects.toThrow("bounded allowance");
        expect(
          (await readBenchmarkProgress(plan.output)).snapshot.recoveryOwner
            ?.pid,
        ).toBe(process.pid);
        await expect(resumeTicketBenchmark(plan.output)).rejects.toThrow(
          "running recovery owner",
        );
        expect(calls).toBe(0);
        return;
      }
      await expect(
        resumeTicketBenchmark(
          plan.output,
          {},
          {
            recoverResource: async () => {
              throw new Error("Owned resource is still active");
            },
            createRuntime: async () => {
              calls++;
              throw new Error("Must not dispatch");
            },
          },
        ),
      ).rejects.toThrow("resource is still active");
      expect(calls).toBe(0);
      const reconciled: string[] = [];
      expect(
        await resumeTicketBenchmark(
          plan.output,
          {},
          {
            recoverResource: async (resource) => {
              reconciled.push(resource.id);
            },
            createRuntime: async () => {
              calls++;
              throw new Error("Must not replay");
            },
          },
        ),
      ).toMatchObject({ completed: 2, status: "judge-pending" });
      const after = await readBenchmarkProgress(plan.output, {
        after: before.cursor,
      });
      expect(reconciled.length).toBeGreaterThan(0);
      expect(after.snapshot.attempts[0]?.status).toBe("judge-pending");
      expect(after.snapshot.attempts[1]?.status).toBe(scenario);
      if (scenario === "cancelled")
        expect(after.snapshot.cancellation?.reason).toBe(
          "Cancellation retained after controller loss",
        );
      expect(after.snapshot.attempts[1]?.usage?.outputTokens).toBe(3);
      const partial = after.snapshot.attempts[1]!.evidence.find((path) =>
        path.endsWith("worktree"),
      );
      expect(partial).toBeDefined();
      expect(await readFile(join(partial!, "value.txt"), "utf8")).toBe(
        "partial\n",
      );
      expect(after.snapshot.counts).toMatchObject({
        implementationCalls: 2,
        completed: 1,
        attempts: 2,
      });
      expect(after.snapshot.owner).toBeNull();
      expect(calls).toBe(0);
      expect(after.events[0]?.sequence).toBe(before.cursor + 1);
    } finally {
      if (child.exitCode === null) {
        if (ownerPid) {
          try {
            process.kill(ownerPid, "SIGKILL");
          } catch {}
        }
        child.kill("SIGKILL");
      }
      await exited;
    }
  },
  8000,
);

it("links an explicit retry to the interrupted attempt without replacing evidence or counting another repetition", async () => {
  const { plan } = await fixture();
  const cancellation = new AbortController();
  await runTicketBenchmark(plan, undefined, 1, {
    signal: cancellation.signal,
    createRuntime: async (request) => ({
      id: request.id,
      exec: async ({ onLine }) => {
        await writeFile(join(request.worktree, "value.txt"), "partial\n");
        onLine?.(
          '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}',
        );
        cancellation.abort("Interrupted first implementation");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  const first = await readBenchmarkProgress(plan.output);
  const original = first.snapshot.attempts[0]!;
  const originalEvidence = await readFile(
    join(plan.output, `${plan.slots[0]!.id}-implementation.jsonl`),
    "utf8",
  );
  await resumeTicketBenchmark(
    plan.output,
    { retryAttemptId: original.id, maxNewSlots: 1 },
    {
      createRuntime: async (request) => ({
        id: request.id,
        exec: async () => {
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        stop: async () => {},
      }),
    },
  );
  const { snapshot } = await readBenchmarkProgress(plan.output);
  expect(snapshot.attempts).toHaveLength(2);
  expect(snapshot.attempts[1]).toMatchObject({
    id: `${plan.slots[0]!.id}-attempt-2`,
    retryOf: original.id,
    slotId: original.slotId,
    status: "judge-pending",
    check: "passed",
  });
  expect(snapshot.counts).toMatchObject({
    scheduled: 2,
    attempted: 1,
    completed: 0,
    retries: 1,
    attempts: 2,
    implementationCalls: 2,
  });
  expect(snapshot.unrun).toEqual([plan.slots[1]!.id]);
  expect(
    await readFile(
      join(plan.output, `${plan.slots[0]!.id}-implementation.jsonl`),
      "utf8",
    ),
  ).toBe(originalEvidence);
  expect(
    await readFile(
      join(
        original.evidence.find((path) => path.endsWith("worktree"))!,
        "value.txt",
      ),
      "utf8",
    ),
  ).toBe("partial\n");
  await expect(
    resumeTicketBenchmark(plan.output, { retryAttemptId: original.id }),
  ).rejects.toThrow("already retried");
});

it("rejects changed frozen inputs before recovery and does not reset exhausted calls or time", async () => {
  const { plan } = await fixture({}, { maxCalls: 2 });
  let calls = 0;
  const dependencies = {
    createRuntime: async (
      request: import("./implementationBenchmark.js").BenchmarkRuntimeRequest,
    ) => ({
      id: request.id,
      exec: async ({ command }: { command: string }) => {
        if (command.startsWith("codex exec")) calls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  };
  await runTicketBenchmark(plan, undefined, 1, dependencies);
  const manifestPath = join(plan.output, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({ ...plan, check: "different check" }),
  );
  await expect(
    resumeTicketBenchmark(plan.output, {}, dependencies),
  ).rejects.toThrow("Frozen implementation plan changed");
  expect(calls).toBe(1);
  await writeFile(manifestPath, manifest);
  expect(
    await resumeTicketBenchmark(plan.output, {}, dependencies),
  ).toMatchObject({ status: "budget-exhausted", completed: 1 });
  const first = await readBenchmarkProgress(plan.output);
  expect(first.snapshot.counts.implementationCalls).toBe(1);
  expect(first.snapshot.allowance.remainingCalls).toBe(0);
  expect(first.snapshot.unrun).toEqual([plan.slots[1]!.id]);
  await resumeTicketBenchmark(
    plan.output,
    {},
    {
      ...dependencies,
      now: () => Date.parse(first.snapshot.startedAt) + plan.overallLimitMs + 1,
    },
  );
  expect(
    (await readBenchmarkProgress(plan.output)).snapshot.allowance.remainingMs,
  ).toBe(0);
  await resumeTicketBenchmark(
    plan.output,
    {},
    { ...dependencies, now: () => Date.parse(first.snapshot.startedAt) + 1 },
  );
  expect(
    (await readBenchmarkProgress(plan.output)).snapshot.allowance.remainingMs,
  ).toBe(0);
  expect(calls).toBe(1);
});

it("bounds an unresponsive operation and retains ownership when its stop cannot be verified", async () => {
  const { plan: original } = await fixture();
  const { id: _id, ...frozen } = {
    ...original,
    launch: {
      ...original.launch!,
      allowances: { ...original.launch!.allowances, cleanupMs: 30 },
    },
  };
  const { output: _output, ...hashed } = frozen;
  const plan = {
    ...frozen,
    id: createHash("sha256").update(JSON.stringify(hashed)).digest("hex"),
  };
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.id,
      exec: async () => {
        entered();
        return new Promise(() => {});
      },
      stop: async () => new Promise(() => {}),
    }),
  });
  await Promise.race([
    ready,
    running.then(() => {
      throw new Error("Did not reach the unresponsive invocation");
    }),
  ]);
  await cancelBenchmark(plan.output, "Stop unresponsive operation");
  expect(await running).toMatchObject({ status: "cleanup-failed" });
  const { snapshot } = await readBenchmarkProgress(plan.output);
  expect(snapshot.owner).not.toBeNull();
  expect(
    snapshot.resources.some((resource) => resource.status === "cleanup-failed"),
  ).toBe(true);
  expect(snapshot.cancellation?.reason).toBe("Stop unresponsive operation");
  await expect(resumeTicketBenchmark(plan.output)).rejects.toThrow(
    "owner is still running",
  );
});

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
      createHash("sha256")
        .update(
          await readFile(
            join(plan.output, `${attempt.slotId}-implementation.jsonl`),
          ),
        )
        .digest("hex"),
    ).toBe(attempt.implementation.streamSha256);
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
  let checkCalls = 0;
  const dependencies = {
    createRuntime: async (
      request: import("./implementationBenchmark.js").BenchmarkRuntimeRequest,
    ) => ({
      id: request.worktree,
      exec: async ({ command }: { command: string }) => {
        if (command.startsWith("codex exec")) modelCalls++;
        else checkCalls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  };
  const result = await runTicketBenchmark(
    plan,
    undefined,
    Infinity,
    dependencies,
  );
  expect(result).toMatchObject({ status: "control-failed", completed: 0 });
  expect(
    await resumeTicketBenchmark(plan.output, {}, dependencies),
  ).toMatchObject({ status: "control-failed", completed: 0 });
  expect(checkCalls).toBe(1);
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

it("preserves pre-existing historical evidence in a selected output directory", async () => {
  const { plan } = await fixture();
  await mkdir(plan.output);
  const bytes = '{ "historical": true, "receipt": "byte-bound" }';
  await writeFile(join(plan.output, "manifest.json"), bytes);
  let calls = 0;
  await expect(
    runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async () => {
        calls++;
        throw new Error("Must not start beside retained evidence");
      },
    }),
  ).rejects.toThrow("not empty");
  expect(calls).toBe(0);
  expect(await readFile(join(plan.output, "manifest.json"), "utf8")).toBe(
    bytes,
  );
  await expect(readFile(join(plan.output, "execution.json"))).rejects.toThrow();
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

it("holds final protected-base cleanup before admitting an otherwise exactly funded attempt", async () => {
  const { plan } = await fixture({ maxMinutes: 42 });
  const instant = Date.now();
  let calls = 0;
  const result = await runTicketBenchmark(plan, undefined, 1, {
    now: () => instant,
    createRuntime: async (request) => {
      calls++;
      return {
        id: request.worktree,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        stop: async () => {},
      };
    },
  });
  expect(result).toMatchObject({ status: "budget-exhausted", completed: 0 });
  expect(calls).toBe(0);
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

it("transfers exact candidate bytes despite worker Git attributes", async () => {
  for (const bytes of ["correct\n", "correct\r\n"]) {
    const { plan } = await fixture();
    await runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async (request) => ({
        id: request.worktree,
        exec: async ({ command }) => {
          if (command.startsWith("codex exec")) {
            await writeFile(join(request.worktree, "value.txt"), bytes);
            await writeFile(
              join(request.worktree, ".gitattributes"),
              "*.txt text eol=crlf\n",
            );
          } else
            expect(
              await readFile(join(request.worktree, "value.txt"), "utf8"),
            ).toBe(bytes);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        stop: async () => {},
      }),
    });
    const ledger = JSON.parse(
      await readFile(join(plan.output, "execution.json"), "utf8"),
    );
    const attempt = ledger.attempts[0];
    expect(attempt.check.status).toBe("passed");
    expect(
      execFileSync("git", ["show", `${attempt.candidate.head}:value.txt`], {
        cwd: attempt.candidate.worktree,
        encoding: "utf8",
      }),
    ).toBe(bytes);
  }
});

it.each(["preparation", "checks"] as const)(
  "rejects grading inputs changed during %s without exporting a passing check",
  async (phase) => {
    const { plan } = await fixture({ prepare: "prepare-fixture" });
    await runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async (request) => ({
        id: request.worktree,
        exec: async ({ command }) => {
          if (command.startsWith("codex exec"))
            await writeFile(join(request.worktree, "value.txt"), "wrong\n");
          if (
            request.role === "checks" &&
            command ===
              (phase === "preparation" ? "prepare-fixture" : plan.check)
          )
            await writeFile(join(request.worktree, "check.sh"), "exit 0\n");
          return { stdout: "claimed pass", stderr: "", exitCode: 0 };
        },
        stop: async () => {},
      }),
    });
    const ledger = JSON.parse(
      await readFile(join(plan.output, "execution.json"), "utf8"),
    );
    expect(ledger.attempts[0]).toMatchObject({
      status: "environment-unavailable",
      check: { status: "unavailable" },
      judge: { status: "pending" },
      cleanup: { status: "passed" },
    });
    expect(ledger.attempts[0].reason).toContain(
      "Protected grading inputs changed",
    );
  },
);

it("keeps disposable checker installations and build output outside source applicability", async () => {
  const { plan } = await fixture({ prepare: "prepare-fixture" });
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec"))
          await writeFile(join(request.worktree, "value.txt"), "correct\n");
        if (request.role === "checks" && command === "prepare-fixture")
          for (const directory of ["node_modules", "dist"]) {
            await mkdir(join(request.worktree, directory));
            await writeFile(
              join(request.worktree, directory, "artifact"),
              "disposable\n",
            );
          }
        return { stdout: "passed", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.attempts[0]).toMatchObject({
    status: "judge-pending",
    check: { status: "passed" },
    cleanup: { status: "passed" },
  });
});

it("freezes and restores Unicode grading paths as actual Git paths", async () => {
  const path = "tests/проверка\t.sh";
  const { plan } = await fixture({}, undefined, {
    [path]: { text: "frozen grader\n", mode: 0o755 },
  });
  expect(plan.launch!.checking.files).toContainEqual(
    expect.objectContaining({ path, text: "frozen grader\n", mode: "100755" }),
  );
  await runTicketBenchmark(plan, undefined, 1, {
    createRuntime: async (request) => ({
      id: request.worktree,
      exec: async ({ command }) => {
        if (command.startsWith("codex exec"))
          await writeFile(join(request.worktree, path), "worker replacement\n");
        else {
          expect(await readFile(join(request.worktree, path), "utf8")).toBe(
            "frozen grader\n",
          );
          expect((await lstat(join(request.worktree, path))).mode & 0o100).toBe(
            0o100,
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stop: async () => {},
    }),
  });
  const ledger = JSON.parse(
    await readFile(join(plan.output, "execution.json"), "utf8"),
  );
  expect(ledger.attempts[0].check.status).toBe("passed");
});

it.each(["preparation", "checks"] as const)(
  "invalidates a check when %s replaces the candidate's source bytes",
  async (phase) => {
    const { plan } = await fixture({ prepare: "prepare-fixture" });
    await runTicketBenchmark(plan, undefined, 1, {
      createRuntime: async (request) => ({
        id: request.worktree,
        exec: async ({ command }) => {
          if (command.startsWith("codex exec"))
            await writeFile(join(request.worktree, "value.txt"), "wrong\n");
          if (
            request.role === "checks" &&
            command ===
              (phase === "preparation" ? "prepare-fixture" : plan.check)
          )
            await writeFile(join(request.worktree, "value.txt"), "correct\n");
          return { stdout: "claimed pass", stderr: "", exitCode: 0 };
        },
        stop: async () => {},
      }),
    });
    const ledger = JSON.parse(
      await readFile(join(plan.output, "execution.json"), "utf8"),
    );
    const attempt = ledger.attempts[0];
    expect(attempt).toMatchObject({
      status: "environment-unavailable",
      check: { status: "unavailable" },
      judge: { status: "pending" },
    });
    expect(attempt.reason).toContain("Checked candidate changed");
    expect(
      await readFile(join(attempt.candidate.worktree, "value.txt"), "utf8"),
    ).toBe("wrong\n");
  },
);
