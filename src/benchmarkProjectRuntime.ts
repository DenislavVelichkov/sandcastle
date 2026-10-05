import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";
import type { Candidate } from "./benchmarkCandidate.js";
import { verifyBenchmarkCandidate } from "./benchmarkCandidate.js";
import type { BenchmarkEvidenceReference } from "./benchmarkJudge.js";
import type { BenchmarkResource } from "./benchmarkProgress.js";
import type { ExecResult } from "./SandboxProvider.js";
import type { TicketBenchmarkPlan } from "./ticketBenchmark.js";

const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export interface BenchmarkProjectContext {
  readonly runId: string;
  readonly attemptId: string;
  readonly worktree: string;
  readonly checkWorktree: string;
  readonly candidate: Candidate;
  readonly root: string;
  readonly evidence: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly task: string;
  readonly references: readonly {
    path: string;
    sha256: string;
    base64: string;
  }[];
  readonly prepare: string | null;
  readonly check: string;
  readonly signal: AbortSignal;
  readonly remainingMs: number;
}
export interface BenchmarkProjectIdentity {
  readonly kind: "browser" | "native";
  readonly build: string;
  readonly profile: string;
  readonly device: string;
  readonly ports: readonly number[];
  readonly services: readonly string[];
  readonly architecture?: string;
  readonly renderer?: string;
}
export interface BenchmarkVisualCapture {
  readonly id: string;
  /** A regular file relative to the private evidence directory. */
  readonly path: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly observation: string;
}
/** Trusted, self-contained ESM module frozen from the project's base commit. */
export interface BenchmarkProjectAdapter {
  prepare(context: BenchmarkProjectContext): Promise<BenchmarkProjectIdentity>;
  check(context: BenchmarkProjectContext): Promise<ExecResult>;
  capture(
    context: BenchmarkProjectContext,
  ): Promise<readonly BenchmarkVisualCapture[]>;
  /** Read-only live inspection of the owned candidate application. */
  inspect(
    context: BenchmarkProjectContext,
  ): Promise<{ build: string; observation: string }>;
  /** Also handles partial startup and repeated recovery without a live session. */
  stop(context: BenchmarkProjectContext): Promise<void>;
  verifyStopped(context: BenchmarkProjectContext): Promise<boolean>;
}
export interface BenchmarkProjectEvidence {
  status: "preparing" | "ready" | "unavailable" | "stopped" | "cleanup-failed";
  adapterSha256: string;
  identity?: BenchmarkProjectIdentity;
  evidence: BenchmarkEvidenceReference[];
  receipt?: { path: string; sha256: string };
  failure?: string;
}

const identitySchema = z
  .object({
    kind: z.enum(["browser", "native"]),
    build: z.string().min(1),
    profile: z.string().min(1),
    device: z.string().min(1),
    ports: z.array(z.number().int().min(1).max(65535)),
    services: z.array(z.string().min(1)),
    architecture: z.string().min(1).optional(),
    renderer: z.string().min(1).optional(),
  })
  .strict();
const capturesSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        path: z.string().min(1),
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        observation: z.string().min(1).max(64000),
      })
      .strict(),
  )
  .max(32);
const inside = (parent: string, path: string) => {
  const value = relative(parent, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
};
const load = async (
  plan: TicketBenchmarkPlan,
  root: string,
): Promise<BenchmarkProjectAdapter> => {
  const module = plan.launch!.adapter.module;
  if (!module || hash(module.text) !== module.sha256)
    throw new Error("Frozen project adapter bytes changed or are unavailable");
  // Data URLs allow Node builtins but no relative imports from a live checkout.
  const adapter = await import(
    `data:text/javascript;base64,${Buffer.from(module.text).toString("base64")}#${encodeURIComponent(root)}`
  );
  for (const name of [
    "prepare",
    "check",
    "capture",
    "inspect",
    "stop",
    "verifyStopped",
  ])
    if (typeof adapter[name] !== "function")
      throw new Error(`Project adapter is missing ${name}`);
  return adapter as BenchmarkProjectAdapter;
};

export const createBenchmarkProjectRuntime = async (input: {
  plan: TicketBenchmarkPlan;
  runId: string;
  attemptId: string;
  slotId: string;
  candidate: Candidate;
  checkWorktree: string;
  own: (resource: BenchmarkResource) => Promise<BenchmarkResource>;
  publish: () => Promise<void>;
}) => {
  const { plan, candidate } = input;
  const name = `project-${input.attemptId}-${randomUUID()}`;
  const root = join(plan.output, "runtime", name);
  const evidence = join(plan.output, "visuals", name);
  const report: BenchmarkProjectEvidence = {
    status: "preparing",
    adapterSha256: plan.launch!.adapter.sha256,
    evidence: [],
  };
  // Intent is durable before importing or calling any project-owned code.
  const resource = await input.own({
    id: root,
    kind: "project-runtime",
    attemptId: input.attemptId,
    adapterSha256: report.adapterSha256,
    status: "owned",
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const base = {
    runId: input.runId,
    attemptId: input.attemptId,
    candidate,
    root,
    evidence,
    worktree: candidate.worktree,
    checkWorktree: input.checkWorktree,
    config: plan.launch!.adapter.config ?? {},
    task: plan.tickets[
      plan.slots.find((slot) => slot.id === input.slotId)!.ticket
    ]!.text,
    references: plan.launch!.grading.references.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      base64: file.base64 ?? Buffer.from(file.text).toString("base64"),
    })),
    prepare: plan.prepare,
    check: plan.check!,
  };
  const bytes = JSON.stringify(base);
  await writeFile(join(root, "context.json"), bytes, { mode: 0o400 });
  resource.contextSha256 = hash(bytes);
  await input.publish();
  let adapter: BenchmarkProjectAdapter | undefined;
  const context = (
    signal: AbortSignal,
    remainingMs: number,
  ): BenchmarkProjectContext => ({ ...base, signal, remainingMs });
  const reference = (
    id: string,
    path: string,
    sha256: string,
  ): BenchmarkEvidenceReference => ({
    id,
    kind: "visual",
    path,
    sha256,
    candidateHead: candidate.head,
    candidateTree: candidate.tree,
    sourceSha256: candidate.sourceSha256,
    runtime: {
      build: report.identity!.build,
      adapter: report.adapterSha256,
      profile: report.identity!.profile,
    },
  });
  const receipt = async () => {
    const path = join(evidence, "runtime.json");
    const bytes = `${JSON.stringify({ version: 1, runId: base.runId, attemptId: base.attemptId, worktree: base.worktree, candidateHead: candidate.head, candidateTree: candidate.tree, sourceSha256: candidate.sourceSha256, adapterSha256: report.adapterSha256, identity: report.identity, evidence: report.evidence }, null, 2)}\n`;
    await writeFile(path, bytes, { mode: 0o600 });
    report.receipt = { path, sha256: hash(bytes) };
  };
  const verify = async (signal: AbortSignal) => {
    await verifyBenchmarkCandidate(candidate, signal);
    if (!report.identity) throw new Error("Project runtime is not ready");
    for (const file of report.evidence)
      if (hash(await readFile(file.path, { signal })) !== file.sha256)
        throw new Error("Candidate visual evidence changed");
  };
  return {
    resource,
    report,
    prepare: async (signal: AbortSignal, remainingMs: number) => {
      adapter = await load(plan, root);
      await verifyBenchmarkCandidate(candidate, signal);
      report.identity = identitySchema.parse(
        await adapter.prepare(context(signal, remainingMs)),
      );
      signal.throwIfAborted();
      await verifyBenchmarkCandidate(candidate, signal);
      report.status = "ready";
      await receipt();
    },
    check: async (signal: AbortSignal, remainingMs: number) => {
      await verify(signal);
      const output = await adapter!.check(context(signal, remainingMs));
      const result = z
        .object({
          stdout: z.string(),
          stderr: z.string(),
          exitCode: z.number().int(),
        })
        .strict()
        .parse(output);
      await verify(signal);
      return result;
    },
    capture: async (signal: AbortSignal, remainingMs: number) => {
      await verify(signal);
      const captures = capturesSchema.parse(
        await adapter!.capture(context(signal, remainingMs)),
      );
      if (new Set(captures.map((item) => item.id)).size !== captures.length)
        throw new Error("Visual evidence IDs must be distinct");
      let size = 0;
      for (const item of captures) {
        const path = resolve(evidence, item.path);
        const stat = await lstat(path);
        if (
          isAbsolute(item.path) ||
          !inside(evidence, path) ||
          !stat.isFile() ||
          !inside(evidence, await realpath(path))
        )
          throw new Error(
            "Visual capture escaped its private evidence directory",
          );
        if (size + stat.size > 48 * 1024 * 1024)
          throw new Error(
            "Visual capture exceeds the bounded evidence allowance",
          );
        const bytes = await readFile(path, { signal });
        size += bytes.length;
        const image =
          item.mediaType === "image/png"
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : item.mediaType === "image/jpeg"
              ? bytes[0] === 255 && bytes[1] === 216
              : bytes.toString("ascii", 0, 4) === "RIFF" &&
                bytes.toString("ascii", 8, 12) === "WEBP";
        if (!image || size > 48 * 1024 * 1024)
          throw new Error(
            "Visual capture is invalid or exceeds the bounded evidence allowance",
          );
        report.evidence.push({
          ...reference(item.id, path, hash(bytes)),
          observation: item.observation,
        });
      }
      await verify(signal);
      await receipt();
    },
    inspect: async (signal: AbortSignal, remainingMs: number) => {
      await verify(signal);
      const result = z
        .object({
          build: z.string().min(1),
          observation: z.string().min(1).max(64000),
        })
        .strict()
        .parse(await adapter!.inspect(context(signal, remainingMs)));
      if (result.build !== report.identity!.build)
        throw new Error(
          "Live application build differs from the frozen runtime",
        );
      await verify(signal);
      const id = `live-inspection-${report.evidence.filter((item) => item.id.startsWith("live-inspection-")).length + 1}`;
      const path = join(evidence, `${id}.json`);
      const bytes = JSON.stringify(result);
      await writeFile(path, bytes, { mode: 0o600 });
      report.evidence.push(reference(id, path, hash(bytes)));
      await receipt();
      return { ...result, evidenceId: id };
    },
    verify,
    stop: async (signal: AbortSignal, remainingMs: number) => {
      try {
        adapter ??= await load(plan, root);
        await adapter.stop(context(signal, remainingMs));
        if (
          (await adapter.verifyStopped(context(signal, remainingMs))) !== true
        )
          throw new Error("Project runtime stop was not verified");
        signal.throwIfAborted();
        report.status = "stopped";
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        report.status = "cleanup-failed";
        resource.status = "cleanup-failed";
        throw error;
      }
    },
  };
};
export type OwnedBenchmarkProjectRuntime = Awaited<
  ReturnType<typeof createBenchmarkProjectRuntime>
>;

export const recoverBenchmarkProjectRuntime = async (
  plan: TicketBenchmarkPlan,
  resource: BenchmarkResource,
  runId: string,
  signal: AbortSignal,
) => {
  if (
    resource.adapterSha256 !== plan.launch!.adapter.sha256 ||
    !resource.contextSha256 ||
    !inside(join(plan.output, "runtime"), resource.id) ||
    !inside(join(plan.output, "runtime"), await realpath(resource.id))
  )
    throw new Error(
      "Owned project runtime recovery identity is unavailable or changed",
    );
  const bytes = await readFile(join(resource.id, "context.json"), { signal });
  if (hash(bytes) !== resource.contextSha256)
    throw new Error("Owned project runtime recovery context changed");
  const base = JSON.parse(bytes.toString()) as Omit<
    BenchmarkProjectContext,
    "signal" | "remainingMs"
  >;
  if (
    base.runId !== runId ||
    base.attemptId !== resource.attemptId ||
    base.root !== resource.id
  )
    throw new Error("Project runtime belongs to another attempt");
  const adapter = await load(plan, resource.id);
  const context = {
    ...base,
    signal,
    remainingMs: plan.launch!.allowances.cleanupMs,
  };
  await adapter.stop(context);
  if ((await adapter.verifyStopped(context)) !== true)
    throw new Error("Recovered project runtime stop was not verified");
  signal.throwIfAborted();
  await rm(resource.id, { recursive: true, force: true });
};

/** The judge can observe the owned runtime without device-control or write authority. */
export const serveBenchmarkProjectInspection = async (
  runtime: OwnedBenchmarkProjectRuntime,
  socket: string,
  signal: AbortSignal,
  remaining: () => number,
) => {
  const cancellation = new AbortController();
  const operationSignal = AbortSignal.any([signal, cancellation.signal]);
  let queue = Promise.resolve();
  let failure: unknown;
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/inspect") {
      response.writeHead(404).end();
      return;
    }
    if (++requests > 32) {
      response.writeHead(429).end("Live inspection allowance exhausted");
      return;
    }
    queue = queue.then(async () => {
      try {
        operationSignal.throwIfAborted();
        const result = await runtime.inspect(operationSignal, remaining());
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(result));
      } catch (error) {
        failure = error;
        response.writeHead(503).end("Owned candidate inspection unavailable");
      }
    });
  });
  const directory = await open(dirname(socket), "r");
  const bindPath =
    process.platform === "linux"
      ? `/proc/self/fd/${directory.fd}/${basename(socket)}`
      : socket;
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(bindPath, accept);
    });
  } catch (error) {
    await directory.close();
    throw error;
  }
  await chmod(socket, 0o600);
  return {
    close: async () => {
      cancellation.abort(new Error("Judge inspection closed"));
      server.closeAllConnections();
      await new Promise<void>((accept, reject) =>
        server.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : accept(),
        ),
      );
      await queue;
      await directory.close();
      if (failure) throw failure;
    },
  };
};
