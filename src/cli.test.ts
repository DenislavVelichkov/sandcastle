import { exec, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchmarkRuntimeRequest } from "./implementationBenchmark.js";

const benchmarkDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    benchmarkDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).not.toMatch(/^\s*- run(?:\s|$)/m);
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("shows generic ticket and model options", async () => {
    const { stdout } = await runCli("benchmark --help", process.cwd());
    expect(stdout).toContain("--ticket");
    expect(stdout).toContain("--arm");
    expect(stdout).toContain("--dry-run");
    for (const option of [
      "--project",
      "--repository",
      "--judge",
      "--prompt",
      "--contract",
      "--preflight",
    ])
      expect(stdout).toContain(option);
  });

  it("exposes durable status, cancellation and unchanged-plan resume through the built entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-progress-"));
    benchmarkDirectories.push(root);
    const project = join(root, "project");
    const output = join(root, "evidence");
    await mkdir(project);
    await initRepo(project);
    await writeFile(join(project, "check.sh"), "exit 0\n");
    await commitFile(
      project,
      "task.md",
      "# Preserve durable progress\n",
      "Frozen task",
    );
    await execAsync("git add check.sh && git commit -m check", {
      cwd: project,
    });
    const built = (await import(
      join(import.meta.dirname, "..", "dist", "index.js")
    )) as typeof import("./index.js");
    const plan = await built.planTicketBenchmark(
      {
        cwd: project,
        tickets: ["task.md"],
        arms: ["gpt-6-astra:high"],
        check: "sh check.sh",
        output,
        preflight: true,
      },
      {
        inspectWorker: async (request) => ({
          imageDigest: `sha256:${"a".repeat(64)}`,
          codexVersion: "controlled",
          nodeVersion: process.version,
          configSha256: createHash("sha256")
            .update(request.config)
            .digest("hex"),
          authenticated: true,
          usageAvailable: true,
          models: [
            {
              model: "gpt-6-astra",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
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
          freeInodes: 100000,
          gradingReady: true,
          readOnlySandbox: { ready: true, detail: null },
          environments: {},
        }),
      },
    );
    let calls = 0;
    const safety = new AbortController();
    const running = built.runTicketBenchmark(plan, undefined, 1, {
      signal: safety.signal,
      createRuntime: async (request: BenchmarkRuntimeRequest) => ({
        id: request.id,
        exec: async ({ signal, onLine }) => {
          calls++;
          onLine?.(
            '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}',
          );
          return new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        stop: async () => {},
      }),
    });
    const command = promisify(execFile);
    try {
      await vi.waitFor(async () => {
        expect(
          (await built.readBenchmarkProgress(output)).snapshot.counts
            .implementationCalls,
        ).toBe(1);
      });
      const { stdout } = await command(process.execPath, [
        cliPath,
        "benchmark-status",
        "--directory",
        output,
      ]);
      const status = JSON.parse(stdout);
      expect(status.snapshot.phase).toBe("implementation");
      expect(status.snapshot.counts.graded).toBe(0);
      const observer = spawn(
        process.execPath,
        [cliPath, "benchmark-status", "--directory", output, "--watch"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let observations = "";
      observer.stdout.on("data", (chunk) => {
        observations += chunk;
      });
      const disconnected = new Promise<void>((resolve) =>
        observer.once("close", () => resolve()),
      );
      try {
        await vi.waitFor(
          () => {
            expect(observations).toContain(status.snapshot.runId);
          },
          { timeout: 3000 },
        );
        observer.kill("SIGINT");
        await disconnected;
        expect(
          (await built.readBenchmarkProgress(output)).snapshot.owner?.token,
        ).toBe(status.snapshot.owner.token);
        expect(calls).toBe(1);
      } finally {
        if (observer.exitCode === null) observer.kill("SIGKILL");
        await disconnected;
      }
      const cancelled = await command(process.execPath, [
        cliPath,
        "benchmark-cancel",
        "--directory",
        output,
        "--reason",
        "Built CLI stop",
      ]);
      expect(JSON.parse(cancelled.stdout).reason).toBe("Built CLI stop");
      expect(await running).toMatchObject({
        status: "cancelled",
        completed: 1,
      });
      const tools = join(root, "tools");
      await mkdir(tools);
      await writeFile(
        join(tools, "docker"),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rm') process.exitCode = 0;
else if (args[0] === 'inspect') { process.stderr.write('No such object'); process.exitCode = 1; }
else { process.stderr.write('Controlled judge runtime unavailable'); process.exitCode = 1; }
`,
        { mode: 0o755 },
      );
      const resumed = await command(
        process.execPath,
        [cliPath, "benchmark-resume", "--directory", output],
        { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` } },
      ).then(
        () => {
          throw new Error(
            "Incomplete assessment must return a failing exit code",
          );
        },
        (error) => {
          expect(error.code).toBe(1);
          return error;
        },
      );
      expect(JSON.parse(resumed.stdout)).toMatchObject({
        status: "assessment-incomplete",
        completed: 1,
      });
      const cursorRead = await command(process.execPath, [
        cliPath,
        "benchmark-status",
        "--directory",
        output,
        "--after",
        String(status.cursor),
      ]);
      expect(
        JSON.parse(cursorRead.stdout).events.every(
          (event: { sequence: number }) => event.sequence > status.cursor,
        ),
      ).toBe(true);
      expect(calls).toBe(1);
    } finally {
      safety.abort();
      await running;
    }
    for (const name of [
      "benchmark-status",
      "benchmark-cancel",
      "benchmark-resume",
    ]) {
      const help = (await command(process.execPath, [cliPath, name, "--help"]))
        .stdout;
      expect(help).toContain("--directory");
      if (name === "benchmark-resume") {
        expect(help).toContain("--rejudge-assessment");
        expect(help).toContain("--reason");
      }
      if (name === "benchmark-status") expect(help).toContain("judge");
    }
  }, 10000);

  it("plans any number of explicit arms without model calls", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-benchmark-"));
    benchmarkDirectories.push(hostDir);
    await initRepo(hostDir);
    await commitFile(
      hostDir,
      "ticket.md",
      "# Fix streaming\n\nKeep chunks contiguous.\n",
      "ticket",
    );
    const arms = [
      "gpt-6.1-sol:high",
      "gpt-6-luna:max",
      "gpt-6-sol:xhigh",
      "gpt-6-astra:medium",
      "gpt-6-astra:max",
      "gpt-6-sol:high",
    ];
    const { stdout } = await runCli(
      `benchmark --ticket ticket.md --dry-run ${arms.map((arm) => `--arm ${arm}`).join(" ")}`,
      hostDir,
    );
    for (const arm of arms) {
      const [model, effort] = arm.split(":");
      expect(stdout).toContain(`"model": "${model}"`);
      expect(stdout).toContain(`"effort": "${effort}"`);
    }
    expect(stdout).toContain('"slots": [');
  });

  it("plans a selected project and explicit fallback from another directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "cli-benchmark-project-"));
    benchmarkDirectories.push(project);
    await initRepo(project);
    await commitFile(project, "task.md", "# Exact project task\n", "Base");
    const { stdout } = await runCli(
      `benchmark --project '${project}' --ticket task.md --judge gpt-6.1-sol:ExtraHigh --dry-run`,
      process.cwd(),
    );
    const plan = JSON.parse(stdout);
    expect(plan.cwd).toBe(project);
    expect(plan.judge).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "xhigh",
      requested: "gpt-6.1-sol:ExtraHigh",
    });
    expect(plan.arms).toHaveLength(4);
    expect(plan.readiness).toMatchObject({
      mode: "scheduling",
      executionReady: false,
    });
    const fallback = await runCli(
      `benchmark --project '${project}' --ticket missing.md --prompt 'Explicit fallback' --dry-run`,
      process.cwd(),
    );
    expect(JSON.parse(fallback.stdout).tickets[0]).toMatchObject({
      text: "Explicit fallback",
      missingSource: "missing.md",
    });
    await expect(
      runCli(`benchmark --project '${project}' --dry-run`, process.cwd()),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("--ticket or --prompt"),
    });
    await expect(
      runCli(
        `benchmark --project '${project}' --prompt Task --dry-run --preflight`,
        process.cwd(),
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("Choose --dry-run"),
    });
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).toContain("podman");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    try {
      await runCli("build-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      // Command should fail since build-image is no longer a top-level command
      expect(err).toBeDefined();
    }
  });

  it("old top-level remove-image command no longer works", async () => {
    try {
      await runCli("remove-image", process.cwd());
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      expect(err).toBeDefined();
    }
  });

  it("--help shows podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("podman");
    expect(stdout).toContain("podman build-image");
    expect(stdout).toContain("podman remove-image");
  });

  it("podman --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("podman --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("podman build-image --help shows --containerfile and --image-name flags", async () => {
    const { stdout } = await runCli("podman build-image --help", process.cwd());
    expect(stdout).toContain("--containerfile");
    expect(stdout).toContain("--image-name");
  });

  it("podman build-image errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("podman build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).toContain("beads");
      expect(output).toContain("custom");
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker beads --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker custom ignores --build-image and scaffolds without trying to build", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    // --build-image is meaningless for the custom tracker (Dockerfile is
    // deliberately broken until configured) and must be silently ignored
    // rather than fail-fast or attempt a build.
    const { stdout } = await runCli(
      "init --agent claude-code --template blank --sandbox docker --issue-tracker custom --build-image true",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".sandcastle"));
    expect(entries).toContain("SETUP_ISSUE_TRACKER.md");
  });
});
