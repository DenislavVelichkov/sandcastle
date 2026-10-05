import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BenchmarkRuntime,
  BenchmarkRuntimeRequest,
} from "./implementationBenchmark.js";
import type { ExecResult } from "./SandboxProvider.js";

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
      for (const line of lines) onLine?.(line);
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
      if (pending) onLine?.(pending);
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

/** Each runtime mounts only its own private Git, worktree and writable home. */
export const createBenchmarkRuntime = async (
  request: BenchmarkRuntimeRequest,
): Promise<BenchmarkRuntime> => {
  const name = `sandcastle-benchmark-${randomUUID()}`;
  const home = join(request.root, "home");
  const codexHome = join(home, ".codex");
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
  const redact = (text: string) => {
    try {
      collect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")));
    } catch {
      /* A check runtime has no authentication file. */
    }
    return [...secrets].reduce(
      (value, secret) => value.replaceAll(secret, "[redacted]"),
      text,
    );
  };
  const stop = async (signal: AbortSignal) => {
    const result = await docker(["rm", "-f", name], signal);
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr))
      throw new Error(`Owned container cleanup failed: ${name}`);
  };
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(codexHome, "config.toml"),
      request.plan.launch!.worker.config,
      { mode: 0o600 },
    );
    if (request.role === "implementation") {
      const auth = await readFile(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      );
      collect(JSON.parse(auth.toString()));
      await writeFile(join(codexHome, "auth.json"), auth, { mode: 0o600 });
    }
    const started = await docker(
      [
        "run",
        "-d",
        "--init",
        "--name",
        name,
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
