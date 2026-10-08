import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  BenchmarkRuntime,
  BenchmarkRuntimeRequest,
} from "./implementationBenchmark.js";
import type { ExecResult } from "./SandboxProvider.js";
import type { BenchmarkResource } from "./benchmarkProgress.js";

const docker = (
  args: string[],
  signal: AbortSignal,
  stdin?: string,
  onLine?: (line: string) => void,
): Promise<ExecResult> =>
  new Promise((accept, reject) => {
    const child = spawn("docker", args, {
      signal,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let pending = "";
    let overflow = false;
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        try {
          onLine?.(line);
        } catch (error) {
          child.kill("SIGKILL");
          reject(error);
          return;
        }
      }
      if (stdout.length > 32 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        if (pending) onLine?.(pending);
      } catch (error) {
        reject(error);
        return;
      }
      if (signal.aborted) reject(signal.reason);
      else if (overflow)
        reject(
          new Error("Worker output exceeded the bounded capture allowance"),
        );
      else accept({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    }
  });

/** Use only authentication from the exact owned runtime, including refreshed tokens. */
export const benchmarkCredentialRedactor = (
  authPaths: string | readonly string[],
) => {
  const secrets = new Set<string>();
  const collect = (value: unknown, key = ""): void => {
    if (
      typeof value === "string" &&
      (value.length >= 8 || (value && /token|key|secret|password/i.test(key)))
    )
      secrets.add(value);
    else if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) collect(item, name);
  };
  return (text: string) => {
    for (const authPath of typeof authPaths === "string"
      ? [authPaths]
      : authPaths) {
      try {
        collect(JSON.parse(readFileSync(authPath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Owned credential redaction could not be verified");
      }
    }
    return [...secrets].reduce(
      (value, secret) => value.replaceAll(secret, "[redacted]"),
      text,
    );
  };
};

/** Each runtime mounts only its own private Git, worktree and writable home. */
export const createBenchmarkRuntime = async (
  request: BenchmarkRuntimeRequest,
): Promise<BenchmarkRuntime> => {
  const name = request.id;
  const home = join(request.root, "home");
  const codexHome = join(home, ".codex");
  const privateAuth = join(
    dirname(request.root),
    "controller-auth",
    "auth.json",
  );
  const redact = benchmarkCredentialRedactor([
    privateAuth,
    join(codexHome, "auth.json"),
  ]);
  const stop = async (signal: AbortSignal) => {
    const result = await docker(["rm", "-f", name], signal);
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr))
      throw new Error(`Owned container cleanup failed: ${name}`);
    await verifyRemoved(name, signal);
  };
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(codexHome, "config.toml"),
      request.plan.launch!.worker.config,
      { mode: 0o600 },
    );
    if (request.role === "implementation" || request.role === "judge") {
      const auth = await readFile(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      );
      JSON.parse(auth.toString());
      // This seed is outside the worker mount and survives abrupt controller loss.
      await mkdir(dirname(privateAuth), { recursive: true, mode: 0o700 });
      await writeFile(privateAuth, auth, { mode: 0o600 });
      await writeFile(join(codexHome, "auth.json"), auth, { mode: 0o600 });
      redact("");
    }
    const started = await docker(
      [
        "run",
        "-d",
        "--init",
        "--name",
        name,
        ...(request.plan.launch!.worker.securityOptions ?? []).flatMap(
          (option) => ["--security-opt", option],
        ),
        "--label",
        `sandcastle.benchmark.run=${request.runId}`,
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--pids-limit",
        "512",
        "-e",
        `HOME=${home}`,
        "-e",
        `CODEX_HOME=${codexHome}`,
        "-e",
        "OPENAI_API_KEY=",
        "-e",
        "OPENAI_KEY=",
        "-v",
        `${request.root}:${request.root}:z`,
        ...(["implementation", "judge"].includes(request.role)
          ? [
              "-v",
              `${join(request.root, "instructions")}:${join(request.root, "instructions")}:ro,z`,
            ]
          : []),
        ...(request.role === "judge"
          ? [
              "-v",
              `${request.worktree}:${request.worktree}:ro,z`,
              "-v",
              `${join(request.root, "storage.git")}:${join(request.root, "storage.git")}:ro,z`,
              "-v",
              `${join(request.root, "references")}:${join(request.root, "references")}:ro,z`,
            ]
          : []),
        "-w",
        request.worktree,
        "--entrypoint",
        "sh",
        request.plan.launch!.worker.observation!.imageDigest,
        "-c",
        "exec sleep infinity",
      ],
      request.signal,
    );
    if (started.exitCode !== 0)
      throw new Error("Private Docker runtime could not start");
    const observed = request.plan.launch!.worker.observation!;
    const codexVersion = await docker(
      ["exec", name, "codex", "--version"],
      request.signal,
    );
    const nodeVersion = await docker(
      ["exec", name, "node", "--version"],
      request.signal,
    );
    if (
      codexVersion.exitCode !== 0 ||
      nodeVersion.exitCode !== 0 ||
      codexVersion.stdout.trim() !== observed.codexVersion ||
      nodeVersion.stdout.trim() !== observed.nodeVersion
    )
      throw new Error("Private worker runtime identity changed");
    return {
      id: name,
      redact,
      stop,
      exec: ({ command, stdin, signal, onLine }) =>
        docker(
          [
            "exec",
            ...(stdin === undefined ? [] : ["-i"]),
            "-w",
            request.worktree,
            name,
            "sh",
            "-lc",
            command,
          ],
          signal,
          stdin,
          onLine,
        ),
    };
  } catch {
    try {
      await stop(
        AbortSignal.timeout(request.plan.launch!.allowances.cleanupMs),
      );
    } catch {
      throw Object.assign(
        new Error(
          "Private runtime unavailable; owned container cleanup failed",
        ),
        { resources: [name] },
      );
    }
    throw new Error(
      "Private Docker runtime unavailable; verify the frozen image, authentication and owned resource capacity",
    );
  }
};

const verifyRemoved = async (name: string, signal: AbortSignal) => {
  const observed = await docker(["inspect", name], signal);
  if (
    observed.exitCode === 0 ||
    !/No such (?:object|container)/i.test(observed.stderr)
  )
    throw new Error(`Owned container removal could not be verified: ${name}`);
};

/** Recovery may stop only the exact container labelled for this retained run. */
export const reconcileBenchmarkDocker = async (
  resource: BenchmarkResource,
  runId: string,
  signal: AbortSignal,
): Promise<void> => {
  const name = resource.id;
  if (
    resource.kind !== "docker" ||
    !/^sandcastle-benchmark-[a-f0-9-]+$/.test(name)
  )
    throw new Error(
      "Unknown benchmark runtime requires its original recovery adapter",
    );
  const observed = await docker(["inspect", name], signal);
  if (observed.exitCode !== 0) {
    if (/No such (?:object|container)/i.test(observed.stderr)) return;
    throw new Error("Owned Docker resources could not be inspected");
  }
  const containers = JSON.parse(observed.stdout) as {
    Config?: { Labels?: Record<string, string> };
  }[];
  if (
    containers.length !== 1 ||
    containers[0]?.Config?.Labels?.["sandcastle.benchmark.run"] !== runId
  )
    throw new Error(
      "Retained container ownership does not match this benchmark",
    );
  const removed = await docker(["rm", "-f", name], signal);
  if (removed.exitCode !== 0)
    throw new Error("Owned container recovery failed");
  await verifyRemoved(name, signal);
};
