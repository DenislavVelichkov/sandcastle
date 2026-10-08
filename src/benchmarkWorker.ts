import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ModelCatalogPage } from "./workflowUsage.js";
import type { FrozenLaunch } from "./benchmarkLaunch.js";
import { probeBenchmarkReadOnlySandbox } from "./benchmarkSandbox.js";

const execute = promisify(execFile);
export interface WorkerRequest {
  readonly cwd: string;
  readonly baseCommit: string;
  readonly image: string;
  readonly config: string;
  readonly prepare: string | null;
  readonly check: string | null;
  readonly adapter: { readonly id: string; readonly readiness: string } | null;
  readonly capabilities: FrozenLaunch["capabilities"];
  readonly securityOptions: readonly string[];
}
export interface WorkerObservation {
  readonly imageDigest: string;
  readonly codexVersion: string;
  readonly nodeVersion: string;
  readonly configSha256: string;
  readonly authenticated: boolean;
  readonly usageAvailable: boolean | null;
  readonly models: ModelCatalogPage["data"];
  readonly tools: Readonly<Record<string, string | null>>;
  readonly freeBytes: number;
  readonly freeInodes: number | null;
  readonly gradingReady: boolean;
  readonly readOnlySandbox: {
    readonly ready: boolean;
    readonly detail: string | null;
  };
  readonly environments: Readonly<Record<string, boolean>>;
}

export class WorkerReadinessError extends Error {}
export const workerObservationSchema = z
  .object({
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    codexVersion: z.string(),
    nodeVersion: z.string().min(1),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authenticated: z.boolean(),
    usageAvailable: z.boolean().nullable(),
    models: z.array(
      z
        .object({
          model: z.string().min(1),
          supportedReasoningEfforts: z.array(
            z.object({ reasoningEffort: z.string().min(1) }).strict(),
          ),
        })
        .strict(),
    ),
    tools: z.record(z.string(), z.string().nullable()),
    freeBytes: z.number().finite().nonnegative(),
    freeInodes: z.number().finite().nonnegative().nullable(),
    gradingReady: z.boolean(),
    readOnlySandbox: z
      .object({ ready: z.boolean(), detail: z.string().nullable() })
      .strict(),
    environments: z.record(z.string(), z.boolean()),
  })
  .strict();

// Serialized into the private worker. Only this allowlisted result is exported.
const observeWorker = async (
  request: WorkerRequest,
  sandboxProbe: typeof probeBenchmarkReadOnlySandbox,
) => {
  const { execFileSync, spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { mkdirSync, copyFileSync, writeFileSync, readFileSync, statfsSync } =
    await import("node:fs");
  const { createInterface } = await import("node:readline");
  const privateHome = "/tmp/sandcastle-codex";
  mkdirSync(privateHome, { mode: 0o700, recursive: true });
  copyFileSync("/tmp/sandcastle-seed/auth.json", `${privateHome}/auth.json`);
  writeFileSync(`${privateHome}/config.toml`, request.config, { mode: 0o600 });
  process.env.CODEX_HOME = privateHome;
  process.env.OPENAI_API_KEY = "";
  process.env.OPENAI_KEY = "";
  const succeeds = (command: string, seconds: number) => {
    try {
      execFileSync("timeout", [`${seconds}s`, "sh", "-lc", command], {
        stdio: "ignore",
        timeout: (seconds + 2) * 1_000,
      });
      return true;
    } catch {
      return false;
    }
  };
  const prepared = !request.prepare || succeeds(request.prepare, 60);
  const readOnlySandbox = await sandboxProbe();
  const tools: Record<string, string | null> = {};
  for (const tool of request.capabilities.tools) {
    try {
      tools[tool] =
        execFileSync("sh", ["-lc", `command -v ${tool}`], {
          encoding: "utf8",
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    } catch {
      tools[tool] = null;
    }
  }
  let codexVersion = "";
  try {
    codexVersion = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Report unavailable. */
  }
  const models: ModelCatalogPage["data"][number][] = [];
  let authenticated = false;
  let usageAvailable: boolean | null = null;
  if (tools.codex) {
    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let sequence = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: () => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const call = pending.get(message.id);
        if (call) {
          pending.delete(message.id);
          clearTimeout(call.timer);
          message.error ? call.reject() : call.resolve(message.result);
        }
      } catch {
        /* Non-protocol output is never exported. */
      }
    });
    const failPending = () => {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject();
      }
      pending.clear();
    };
    child.on("error", failPending);
    child.on("exit", failPending);
    const rpc = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Worker RPC timeout"));
        }, 20_000);
        pending.set(id, {
          resolve,
          reject: () => reject(new Error("Worker RPC failed")),
          timer,
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    try {
      await rpc("initialize", {
        clientInfo: { name: "sandcastle-benchmark-readiness", version: "1" },
        capabilities: {},
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
      );
      const account = await rpc("account/read", { refreshToken: true });
      // A credential file alone is insufficient. This authenticates with the
      // subscription service without inference or exporting account details.
      const limits = await rpc("account/rateLimits/read", {});
      authenticated =
        account.account?.type === "chatgpt" && !!limits.rateLimits;
      const snapshots = Object.values(
        limits.rateLimitsByLimitId ?? { legacy: limits.rateLimits },
      ) as {
        primary?: { usedPercent: number } | null;
        secondary?: { usedPercent: number } | null;
        spendControlReached?: boolean | null;
      }[];
      const windows = snapshots
        .flatMap((snapshot) => [snapshot.primary, snapshot.secondary])
        .filter((window) => window != null);
      usageAvailable =
        limits.ordinaryUsageAllowed === false ||
        snapshots.some((snapshot) => snapshot.spendControlReached === true) ||
        windows.some(
          (window) =>
            !Number.isFinite(window.usedPercent) || window.usedPercent >= 100,
        )
          ? false
          : limits.ordinaryUsageAllowed === true || windows.length > 0
            ? true
            : null;
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = await rpc("model/list", {
          cursor,
          limit: 100,
          includeHidden: true,
        });
        if (!Array.isArray(page.data))
          throw new Error("Invalid worker catalog");
        // Drop account details and any catalog metadata unrelated to capabilities.
        for (const item of page.data)
          models.push({
            model: item.model,
            supportedReasoningEfforts: item.supportedReasoningEfforts.map(
              (choice: { reasoningEffort: string }) => ({
                reasoningEffort: choice.reasoningEffort,
              }),
            ),
          });
        cursor = page.nextCursor ?? null;
        if (cursor && cursors.has(cursor))
          throw new Error("Repeated model-list cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch {
      models.length = 0;
    } finally {
      failPending();
      lines.close();
      child.kill("SIGKILL");
    }
  }
  const gradingReady =
    prepared &&
    !!request.check &&
    succeeds(request.adapter?.readiness ?? request.check, 60);
  const environments: Record<string, boolean> = {};
  for (const environment of request.capabilities.environments)
    environments[environment.name] =
      prepared && succeeds(environment.probe, 30);
  const capacity = statfsSync(process.cwd());
  process.stdout.write(
    JSON.stringify({
      codexVersion,
      nodeVersion: process.version,
      configSha256: createHash("sha256")
        .update(readFileSync(`${privateHome}/config.toml`))
        .digest("hex"),
      authenticated,
      usageAvailable,
      models,
      tools,
      freeBytes: capacity.bavail * capacity.bsize,
      freeInodes: capacity.files === 0 ? null : capacity.ffree,
      gradingReady,
      readOnlySandbox,
      environments,
    }),
  );
};

/** No inference, host worktree mutation, or credential export. All resources are disposable. */
export const inspectBenchmarkWorker = async (
  request: WorkerRequest,
): Promise<WorkerObservation> => {
  let imageDigest: string;
  try {
    imageDigest = (
      await execute(
        "docker",
        ["image", "inspect", request.image, "--format", "{{.Id}}"],
        { timeout: 20_000 },
      )
    ).stdout.trim();
  } catch {
    throw new WorkerReadinessError(
      "Selected Docker worker image is unavailable; build it or supply --image",
    );
  }
  const root = await mkdtemp(
    join(dirname(request.cwd), ".sandcastle-readiness-"),
  );
  const container = `sandcastle-readiness-${randomUUID()}`;
  try {
    const auth = join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "auth.json",
    );
    try {
      await readFile(auth);
      await cp(auth, join(root, "auth.json"));
    } catch {
      throw new WorkerReadinessError(
        "Codex subscription authentication is unavailable; sign in before --preflight",
      );
    }
    const workspace = join(root, "workspace");
    await execute(
      "git",
      [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        request.cwd,
        workspace,
      ],
      { timeout: 60_000 },
    );
    await execute("git", ["checkout", "--detach", request.baseCommit], {
      cwd: workspace,
      timeout: 60_000,
    });
    await writeFile(
      join(root, "probe.cjs"),
      `const sandboxProbe = ${probeBenchmarkReadOnlySandbox.toString()};\n(${observeWorker.toString()})(${JSON.stringify(request)}, sandboxProbe).catch(() => { process.exitCode = 1; });\n`,
      { mode: 0o600 },
    );
    const observed = await execute(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        container,
        ...request.securityOptions.flatMap((option) => [
          "--security-opt",
          option,
        ]),
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--entrypoint",
        "node",
        "-e",
        "CODEX_HOME=/tmp/sandcastle-codex",
        "-e",
        "OPENAI_API_KEY=",
        "-e",
        "OPENAI_KEY=",
        "-v",
        `${join(root, "auth.json")}:/tmp/sandcastle-seed/auth.json:ro,z`,
        "-v",
        `${join(root, "probe.cjs")}:/tmp/sandcastle-probe.cjs:ro,z`,
        "-v",
        `${workspace}:/home/agent/workspace:z`,
        "-w",
        "/home/agent/workspace",
        imageDigest,
        "/tmp/sandcastle-probe.cjs",
      ],
      { timeout: 240_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { imageDigest, ...JSON.parse(observed.stdout) };
  } catch (error) {
    if (error instanceof WorkerReadinessError) throw error;
    throw new WorkerReadinessError(
      "Isolated worker readiness probe failed; verify Node, Codex app-server, and the selected image's runtime tools",
    );
  } finally {
    let cleanupFailed = false;
    try {
      await execute("docker", ["rm", "-f", container], { timeout: 20_000 });
    } catch (error) {
      cleanupFailed = !/No such container/i.test(
        String((error as { stderr?: unknown }).stderr ?? ""),
      );
    }
    await rm(root, { recursive: true, force: true });
    if (cleanupFailed)
      throw new WorkerReadinessError(
        `Readiness cleanup failed; remove owned Docker container ${container} before retrying`,
      );
  }
};
