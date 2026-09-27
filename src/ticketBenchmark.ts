import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codex,
  type CodexOptions,
  type IterationUsage,
} from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import { defaultImageName, docker } from "./sandboxes/docker.js";

export const defaultTicketBenchmarkArms = [
  "gpt-6-sol:xhigh",
  "gpt-6-astra:medium",
  "gpt-6-luna:max",
] as const;

interface Ticket {
  readonly source: string;
  readonly title: string;
  readonly text: string;
  readonly sha256: string;
}

interface Arm {
  readonly model: string;
  readonly effort: NonNullable<CodexOptions["effort"]>;
}

interface Slot {
  readonly id: string;
  readonly ticket: number;
  readonly arm: number;
}

export interface TicketBenchmarkPlan {
  readonly version: 1;
  readonly id: string;
  readonly cwd: string;
  readonly runnerHash: string;
  readonly runnerCommit: string;
  readonly baseCommit: string;
  readonly tickets: readonly Ticket[];
  readonly arms: readonly Arm[];
  readonly slots: readonly Slot[];
  readonly image: string;
  readonly prepare: string | null;
  readonly check: string | null;
  readonly overallLimitMs: number;
  readonly invocationLimitMs: number;
  readonly output: string;
}

export interface TicketBenchmarkResult {
  readonly slotId: string;
  readonly status:
    "running" | "passed" | "failed" | "unverified" | "incomplete";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly branch?: string;
  readonly candidateHead?: string;
  readonly commits?: readonly string[];
  readonly checkExitCode?: number;
  readonly checkOutputSha256?: string;
  readonly usage?: IterationUsage | null;
}

interface Ledger {
  readonly planId: string;
  readonly startedAt: string;
  readonly results: readonly TicketBenchmarkResult[];
}

export interface TicketBenchmarkOptions {
  readonly cwd: string;
  readonly tickets?: readonly string[];
  readonly arms?: readonly string[];
  readonly base?: string;
  readonly image?: string;
  readonly prepare?: string;
  readonly check?: string;
  readonly output?: string;
  readonly maxMinutes?: number;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const command = (cwd: string, name: string, args: readonly string[]) =>
  execFileSync(name, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  }).trim();
const git = (cwd: string, ...args: string[]) => command(cwd, "git", args);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;
const atomicJson = async (path: string, value: unknown) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

const parseArms = (values: readonly string[]): Arm[] => {
  const arms = (values.length ? values : defaultTicketBenchmarkArms).map(
    (value) => {
      const [model, effort, extra] = value.split(":");
      if (!model || !effort || extra || !/^[a-z0-9-]+$/.test(model))
        throw new Error(
          `Invalid benchmark arm: ${value}; expected model:effort`,
        );
      if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
        throw new Error(`Unsupported reasoning effort: ${effort}`);
      return { model, effort: effort as Arm["effort"] };
    },
  );
  if (
    new Set(arms.map(({ model, effort }) => `${model}:${effort}`)).size !==
    arms.length
  )
    throw new Error("Benchmark arms must be distinct");
  return arms;
};

const githubIssue = (value: string) => {
  if (/^#?\d+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const readTicket = async (cwd: string, value: string): Promise<Ticket> => {
  if (githubIssue(value)) {
    const issue = JSON.parse(
      command(cwd, "gh", ["issue", "view", value, "--json", "title,body,url"]),
    ) as { title: string; body: string; url: string };
    const text = `${issue.title}\n\n${issue.body}`;
    if (!issue.title.trim() || !issue.body.trim())
      throw new Error(`GitHub issue has no usable ticket text: ${value}`);
    return {
      source: issue.url,
      title: issue.title,
      text,
      sha256: sha256(text),
    };
  }
  const path = resolve(cwd, value);
  const text = await readFile(path, "utf8");
  if (!text.trim()) throw new Error(`Ticket file is empty: ${path}`);
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path);
  const source = relative(cwd, path).startsWith("..")
    ? path
    : relative(cwd, path);
  return { source, title, text, sha256: sha256(text) };
};

const discoverTicket = (cwd: string): string => {
  const files = git(
    cwd,
    "ls-files",
    "--",
    "tickets",
    "docs/tickets",
    ".sandcastle/tickets",
  )
    .split("\n")
    .filter((name) => /\.(md|txt)$/i.test(name))
    .sort();
  if (files.length) return files[0]!;
  let issues: { number: number; url: string }[];
  try {
    issues = JSON.parse(
      command(cwd, "gh", [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "Sandcastle",
        "--limit",
        "100",
        "--json",
        "number,url",
      ]),
    ) as { number: number; url: string }[];
  } catch {
    throw new Error(
      "No local ticket found and GitHub issue discovery failed; pass --ticket",
    );
  }
  if (!issues.length)
    throw new Error("No eligible project ticket found; pass --ticket");
  return issues.sort((a, b) => a.number - b.number)[0]!.url;
};

export const planTicketBenchmark = async (
  options: TicketBenchmarkOptions,
): Promise<TicketBenchmarkPlan> => {
  const cwd = resolve(options.cwd);
  const runnerCommit = git(cwd, "rev-parse", "HEAD");
  const baseCommit = git(
    cwd,
    "rev-parse",
    "--verify",
    `${options.base ?? "HEAD"}^{commit}`,
  );
  const inputs = options.tickets?.length
    ? options.tickets
    : [discoverTicket(cwd)];
  const tickets = await Promise.all(
    inputs.map((value) => readTicket(cwd, value)),
  );
  if (new Set(tickets.map((ticket) => ticket.source)).size !== tickets.length)
    throw new Error("Benchmark tickets must be distinct");
  const arms = parseArms(options.arms ?? []);
  const maxMinutes = options.maxMinutes ?? 60;
  if (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1)
    throw new Error("--max-minutes must be a positive integer");
  const slots = tickets.flatMap((_, ticket) =>
    arms.map((_, arm) => ({
      id: `ticket-${ticket + 1}-arm-${arm + 1}`,
      ticket,
      arm,
    })),
  );
  const frozen = {
    version: 1 as const,
    cwd,
    runnerHash: sha256(await readFile(fileURLToPath(import.meta.url), "utf8")),
    runnerCommit,
    baseCommit,
    tickets,
    arms,
    slots,
    image: options.image ?? defaultImageName(cwd),
    prepare: options.prepare ?? null,
    check: options.check ?? null,
    overallLimitMs: maxMinutes * 60_000,
    invocationLimitMs: 15 * 60_000,
  };
  const id = sha256(JSON.stringify(frozen));
  const output = resolve(
    options.output ??
      join(cwd, "..", `${basename(cwd)}-benchmark-${id.slice(0, 12)}`),
  );
  const withinProject = relative(cwd, output);
  if (
    withinProject !== ".." &&
    !withinProject.startsWith(`..${sep}`) &&
    !isAbsolute(withinProject)
  )
    throw new Error("Benchmark evidence directory must be outside the project");
  return {
    ...frozen,
    id,
    output,
  };
};

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#39;" })[character]!,
  );
const csv = (value: unknown) =>
  `"${String(value ?? "")
    .replace(/^[\s]*[=+\-@]/, "'$&")
    .replaceAll('"', '""')}"`;

const writeReport = async (plan: TicketBenchmarkPlan, ledger: Ledger) => {
  const bySlot = new Map(
    ledger.results.map((result) => [result.slotId, result]),
  );
  const rows = plan.slots.map((slot) => {
    const result = bySlot.get(slot.id);
    const arm = plan.arms[slot.arm]!;
    return {
      slotId: slot.id,
      ticket: plan.tickets[slot.ticket]!.source,
      model: arm.model,
      effort: arm.effort,
      status: result?.status ?? "unrun",
      durationMs: result?.durationMs ?? null,
      inputTokens: result?.usage?.inputTokens ?? null,
      cachedInputTokens: result?.usage?.cacheReadInputTokens ?? null,
      outputTokens: result?.usage?.outputTokens ?? null,
      tokenCoverage: result?.usage ? "captured" : result ? "unknown" : "unrun",
      checkExitCode: result?.checkExitCode ?? null,
      candidateHead: result?.candidateHead ?? null,
      reason: result?.reason ?? null,
    };
  });
  const status = rows.some(
    (row) => row.status === "incomplete" || row.status === "running",
  )
    ? "incomplete"
    : rows.some((row) => row.status === "unrun")
      ? "in-progress"
      : "complete";
  const report = { plan, startedAt: ledger.startedAt, status, rows };
  await atomicJson(join(plan.output, "report.json"), report);
  const columns = Object.keys(rows[0]!);
  await writeFile(
    join(plan.output, "evaluations.csv"),
    `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csv(row[column as keyof typeof row])).join(",")).join("\n")}\n`,
  );
  await writeFile(
    join(plan.output, "report.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandcastle ticket benchmark</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left}th{background:#eee}</style></head><body><h1>Ticket benchmark</h1><p>Status: ${escapeHtml(status)}. ${rows.filter((row) => row.status !== "unrun").length}/${rows.length} slots attempted. A passing check establishes only the configured check; no model routing or subscription-savings decision is made.</p><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column as keyof typeof row])}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`,
  );
};

const liveSlot = async (
  plan: TicketBenchmarkPlan,
  slot: Slot,
  remainingMs: number,
): Promise<
  Omit<
    TicketBenchmarkResult,
    "slotId" | "startedAt" | "finishedAt" | "durationMs"
  >
> => {
  const arm = plan.arms[slot.arm]!;
  const ticket = plan.tickets[slot.ticket]!;
  const branch = `codex/benchmark-${plan.id.slice(0, 8)}-${sha256(plan.output).slice(0, 6)}-${slot.id}`;
  if (git(plan.cwd, "branch", "--list", branch))
    throw new Error(`Benchmark branch already exists: ${branch}`);
  const auth = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "auth.json",
  );
  const authBytes = await readFile(auth); // Fail before model work if subscription authentication is unavailable.
  const authSeedDir = await mkdtemp(join(plan.output, ".auth-"));
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    const authSeed = join(authSeedDir, "auth.json");
    await writeFile(authSeed, authBytes, { mode: 0o600 });
    const provider = docker({
      imageName: plan.image,
      mounts: [
        {
          hostPath: authSeed,
          sandboxPath: "/home/agent/.codex-seed/auth.json",
          readonly: true,
        },
      ],
      env: {
        CODEX_HOME: "/home/agent/.codex",
        OPENAI_API_KEY: "",
        OPENAI_KEY: "",
      },
    });
    const setup = [
      {
        command:
          "mkdir -p /home/agent/.codex && cp /home/agent/.codex-seed/auth.json /home/agent/.codex/auth.json && chmod 600 /home/agent/.codex/auth.json && printf '[features]\\nmulti_agent = false\\n' > /home/agent/.codex/config.toml",
      },
      ...(plan.prepare
        ? [{ command: `timeout 300s sh -lc ${quote(plan.prepare)}` }]
        : []),
    ];
    await mkdir(join(plan.output, "logs"), { recursive: true });
    sandbox = await createSandbox({
      cwd: plan.cwd,
      branch,
      baseBranch: plan.baseCommit,
      sandbox: provider,
      hooks: { sandbox: { onSandboxReady: setup } },
    });
    const prompt = `Implement this ticket in the repository. Follow AGENTS.md and project conventions. Run focused checks, commit your work, and finish within one agent invocation. Do not delegate or invoke another AI agent. Do not alter benchmark files or use a different task.\n\nTicket: ${ticket.source}\n${ticket.text}`;
    const result = await sandbox.run({
      agent: codex(arm.model, {
        effort: arm.effort,
        serviceTier: "default",
        sessionStorage: {
          hostSessionsDir: join(plan.output, "sessions", slot.id),
        },
      }),
      prompt,
      maxIterations: 1,
      logging: {
        type: "file",
        path: join(plan.output, "logs", `${slot.id}.log`),
      },
      signal: AbortSignal.timeout(
        Math.min(plan.invocationLimitMs, remainingMs),
      ),
    });
    const candidateHead = git(sandbox.worktreePath, "rev-parse", "HEAD");
    let checkExitCode: number | undefined;
    let checkOutputSha256: string | undefined;
    if (plan.check) {
      const checked = await sandbox.exec(
        `timeout 300s sh -lc ${quote(plan.check)}`,
      );
      checkExitCode = checked.exitCode;
      const checkOutput = `${checked.stdout}\n${checked.stderr}`;
      await writeFile(
        join(plan.output, "logs", `${slot.id}-check.log`),
        checkOutput,
      );
      checkOutputSha256 = sha256(checkOutput);
    }
    const commits = result.commits.map((item) => item.sha);
    const status =
      !commits.length || (checkExitCode !== undefined && checkExitCode !== 0)
        ? "failed"
        : plan.check
          ? "passed"
          : "unverified";
    return {
      status,
      branch,
      candidateHead,
      commits,
      checkExitCode,
      checkOutputSha256,
      usage: result.iterations[0]?.usage ?? null,
      ...(status === "failed"
        ? {
            reason: !commits.length
              ? "No commit produced"
              : `Check exited ${checkExitCode}`,
          }
        : {}),
    };
  } finally {
    try {
      await sandbox?.close();
    } finally {
      await rm(authSeedDir, { recursive: true, force: true });
    }
  }
};

export const runTicketBenchmark = async (
  plan: TicketBenchmarkPlan,
  executeSlot: typeof liveSlot = liveSlot,
  maxNewSlots = Infinity,
): Promise<{ output: string; status: string; completed: number }> => {
  if (
    maxNewSlots !== Infinity &&
    (!Number.isSafeInteger(maxNewSlots) || maxNewSlots < 1)
  )
    throw new Error("--max-new-slots must be a positive integer");
  if (
    sha256(await readFile(fileURLToPath(import.meta.url), "utf8")) !==
    plan.runnerHash
  )
    throw new Error("Benchmark runner changed after planning");
  if (git(plan.cwd, "status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "Commit or remove worktree changes before running a benchmark",
    );
  if (git(plan.cwd, "rev-parse", "HEAD") !== plan.runnerCommit)
    throw new Error("Runner commit changed after planning");
  await mkdir(plan.output, { recursive: true, mode: 0o700 });
  const lockPath = join(plan.output, "benchmark.lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(`${process.pid}\n`);
    const manifestPath = join(plan.output, "manifest.json");
    let manifest: TicketBenchmarkPlan;
    try {
      manifest = await json<TicketBenchmarkPlan>(manifestPath);
      if (
        manifest.id !== plan.id ||
        JSON.stringify(manifest) !== JSON.stringify(plan)
      )
        throw new Error(
          "Frozen benchmark plan changed; use its original arguments",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = plan;
      await writeFile(manifestPath, `${JSON.stringify(plan, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const ledgerPath = join(plan.output, "ledger.json");
    let ledger: Ledger;
    try {
      ledger = await json<Ledger>(ledgerPath);
      if (
        ledger.planId !== plan.id ||
        ledger.results.some(
          (result, index) => result.slotId !== plan.slots[index]?.id,
        )
      )
        throw new Error(
          "Benchmark ledger does not match the frozen slot order",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ledger = {
        planId: plan.id,
        startedAt: new Date().toISOString(),
        results: [],
      };
      await atomicJson(ledgerPath, ledger);
    }
    await writeReport(plan, ledger);
    if (
      ledger.results.some(
        (result) =>
          result.status === "running" || result.status === "incomplete",
      )
    )
      throw new Error(
        "An interrupted slot is retained; inspect it before any further model work",
      );
    for (const slot of plan.slots.slice(
      ledger.results.length,
      ledger.results.length + maxNewSlots,
    )) {
      const remainingMs =
        plan.overallLimitMs - (Date.now() - Date.parse(ledger.startedAt));
      if (remainingMs <= 0) break;
      const startedAt = new Date().toISOString();
      ledger = {
        ...ledger,
        results: [
          ...ledger.results,
          { slotId: slot.id, status: "running", startedAt },
        ],
      };
      await atomicJson(ledgerPath, ledger);
      await writeReport(plan, ledger);
      let outcome: Omit<
        TicketBenchmarkResult,
        "slotId" | "startedAt" | "finishedAt" | "durationMs"
      >;
      try {
        outcome = await executeSlot(plan, slot, remainingMs);
      } catch (error) {
        outcome = { status: "incomplete", reason: String(error) };
      }
      const finishedAt = new Date().toISOString();
      const result = {
        slotId: slot.id,
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        ...outcome,
      } satisfies TicketBenchmarkResult;
      ledger = { ...ledger, results: [...ledger.results.slice(0, -1), result] };
      await atomicJson(ledgerPath, ledger);
      await writeReport(plan, ledger);
      if (result.status === "incomplete") break;
    }
    const report = await json<{ status: string }>(
      join(plan.output, "report.json"),
    );
    return {
      output: plan.output,
      status: report.status,
      completed: ledger.results.length,
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
};
