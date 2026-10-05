import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { TicketBenchmarkPlan } from "./ticketBenchmark.js";
const execute = promisify(execFile);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const gitEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const runGit = async (cwd: string, args: string[], signal?: AbortSignal) => {
  signal?.throwIfAborted();
  return (
    await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: gitEnv,
      signal,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
};
const ignoredPaths = (
  cwd: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string[]> => {
  if (!paths.length) return Promise.resolve([]);
  return new Promise((accept, reject) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin", "-z"],
      { cwd, env: gitEnv, signal, timeout: 60_000 },
      (error, stdout) => {
        if (error && error.code !== 1) reject(error);
        else accept(stdout.split("\0").filter(Boolean));
      },
    );
    child.stdin!.on("error", () => {});
    child.stdin!.end(`${paths.join("\0")}\0`);
  });
};
export interface Candidate {
  worktree: string;
  baseCommit: string;
  head: string;
  tree: string;
  patchSha256: string;
  patch: string;
  changedFiles: string[];
}
export const privateWorktree = async (
  root: string,
  source: string,
  commit: string,
  signal?: AbortSignal,
) => {
  const git = async (cwd: string, ...args: string[]) =>
    (await runGit(cwd, args, signal)).trimEnd();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const storage = join(root, "storage.git");
  await git(root, "init", "--bare", storage);
  await git(storage, "fetch", "--no-tags", "--", source, commit);
  const worktree = join(root, "worktree");
  await git(storage, "worktree", "add", "--detach", worktree, commit);
  await git(storage, "config", "user.name", "Sandcastle benchmark");
  await git(storage, "config", "user.email", "benchmark@localhost");
  return { storage, worktree };
};
export const workspaceFiles = async (
  root: string,
  directory = "",
  includeDirectory: (path: string) => Promise<boolean> = async () => true,
  signal?: AbortSignal,
): Promise<string[]> => {
  signal?.throwIfAborted();
  const groups = await Promise.all(
    (await readdir(join(root, directory), { withFileTypes: true }))
      .filter((entry) => entry.name !== ".git")
      .map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? (await includeDirectory(path))
            ? workspaceFiles(root, path, includeDirectory, signal)
            : []
          : [path];
      }),
  );
  return groups.flat().sort();
};

export const seal = async (
  plan: TicketBenchmarkPlan,
  slotId: string,
  workspace: string,
  protectedStorage: string,
  redact: (text: string) => string,
  signal: AbortSignal,
): Promise<Candidate | undefined> => {
  try {
    const source = await lstat(workspace);
    if (!source.isDirectory())
      throw new Error("Candidate worktree is unavailable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const git = async (cwd: string, ...args: string[]) =>
    (await runGit(cwd, args, signal)).trimEnd();
  const candidateRoot = join(plan.output, "candidates", slotId);
  const { worktree } = await privateWorktree(
    candidateRoot,
    protectedStorage,
    plan.baseCommit,
    signal,
  );
  const tracked = (await git(worktree, "ls-files", "-z"))
    .split("\0")
    .filter(Boolean);
  const files = await workspaceFiles(
    workspace,
    "",
    async (directory) =>
      tracked.some((path) => path.startsWith(`${directory}/`)) ||
      !(await ignoredPaths(worktree, [`${directory}/`], signal)).length,
    signal,
  );
  const ignored = await ignoredPaths(
    worktree,
    files.filter((path) => !tracked.includes(path)),
    signal,
  );
  for (const path of tracked)
    await rm(join(worktree, path), { force: true, recursive: true });
  for (const path of files.filter((path) => !ignored.includes(path))) {
    signal.throwIfAborted();
    const source = join(workspace, path);
    const target = join(worktree, path);
    await mkdir(dirname(target), { recursive: true });
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const link = await readlink(source);
      const destination = relative(workspace, resolve(dirname(source), link));
      if (
        isAbsolute(link) ||
        destination === ".." ||
        destination.startsWith("../") ||
        destination.split("/").includes(".git")
      )
        throw new Error("Candidate symlink escapes its worktree");
      await symlink(link, target);
    } else if (info.isFile()) {
      const bytes = await readFile(source);
      if (redact(bytes.toString()) !== bytes.toString())
        throw new Error("Candidate contains credential material");
      await cp(source, target);
    } else throw new Error("Unsupported candidate file");
  }
  await git(worktree, "add", "--all", "--force");
  const tree = await git(worktree, "write-tree");
  if (
    tree !==
    (await git(protectedStorage, "rev-parse", `${plan.baseCommit}^{tree}`))
  )
    await git(worktree, "commit", "-m", "Sealed implementation candidate");
  const head = await git(worktree, "rev-parse", "HEAD");
  const patch = join(candidateRoot, "candidate.patch");
  const bytes = await runGit(
    worktree,
    ["diff", "--binary", plan.baseCommit, head],
    signal,
  );
  await writeFile(patch, bytes, { mode: 0o600 });
  return {
    worktree,
    baseCommit: plan.baseCommit,
    head,
    tree,
    patch,
    patchSha256: hash(bytes),
    changedFiles: (
      await git(worktree, "diff", "--name-only", "-z", plan.baseCommit, head)
    )
      .split("\0")
      .filter(Boolean),
  };
};
