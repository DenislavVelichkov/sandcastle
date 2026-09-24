import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Worktree } from "./createWorktree.js";

type FileEntry =
  | { path: string; kind: "missing" }
  | { path: string; kind: "link"; target: string }
  | { path: string; kind: "file"; sha256: string; mode: number };

export interface WorkflowCheckpoint {
  readonly id: string;
  readonly sha256: string;
}

interface Manifest {
  readonly version: 1;
  readonly worktrees: Record<
    string,
    {
      path: string;
      gitCommonDir: string;
      branch: string;
      head: string;
      files: FileEntry[];
    }
  >;
  readonly artifacts: { path: string; sha256: string }[];
}

const hash = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const validRelativePath = (path: string): boolean =>
  path.length > 0 &&
  path !== "." &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.split("/").some((part) => part === "" || part === "." || part === "..");

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const pathsFor = async (
  cwd: string,
  ignored: readonly string[],
): Promise<{ path: string; tracked: boolean }[]> => {
  const tracked = new Set(
    execFileSync("git", ["ls-files", "--cached", "-z"], { cwd })
      .toString()
      .split("\0")
      .filter(Boolean),
  );
  const included = new Set([
    ...tracked,
    ...execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd,
      },
    )
      .toString()
      .split("\0")
      .filter(Boolean),
  ]);
  const visit = async (path: string): Promise<void> => {
    if (!validRelativePath(path))
      throw new Error(`Invalid checkpoint path: ${path}`);
    let info;
    try {
      info = await lstat(join(cwd, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(join(cwd, path)))
        await visit(`${path}/${name}`);
    } else included.add(path);
  };
  for (const path of ignored) await visit(path);
  return [...included].sort().map((path) => {
    if (!validRelativePath(path))
      throw new Error(`Invalid checkpoint path: ${path}`);
    return { path, tracked: tracked.has(path) };
  });
};

const entryFor = async (
  cwd: string,
  path: string,
  tracked: boolean,
  blobs?: string,
): Promise<FileEntry> => {
  const absolute = join(cwd, path);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && tracked)
      return { path, kind: "missing" };
    throw error;
  }
  if (info.isSymbolicLink())
    return { path, kind: "link", target: await readlink(absolute) };
  if (!info.isFile()) throw new Error(`Unsupported checkpoint entry: ${path}`);
  const bytes = await readFile(absolute);
  const sha256 = hash(bytes);
  if (blobs) {
    const blob = join(blobs, sha256);
    try {
      const handle = await open(blob, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { path, kind: "file", sha256, mode: info.mode & 0o777 };
};

const checkpointPath = (directory: string, id: string): string =>
  join(directory, "checkpoints", id);

/** Capture and verify every source entry before publishing one immutable manifest. */
export const captureWorkflowCheckpoint = async (
  directory: string,
  worktrees: Readonly<Record<string, Worktree>>,
  ignored: Readonly<Record<string, readonly string[]>>,
  artifacts: readonly string[],
): Promise<WorkflowCheckpoint> => {
  const id = randomUUID();
  const parent = join(directory, "checkpoints");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `${id}.tmp`);
  const blobs = join(temporary, "blobs");
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  try {
    const manifest: Manifest = { version: 1, worktrees: {}, artifacts: [] };
    for (const [taskId, worktree] of Object.entries(worktrees)) {
      const cwd = worktree.worktreePath;
      if (git(cwd, "branch", "--show-current") !== worktree.branch)
        throw new Error(`Checkpoint branch changed for ${taskId}`);
      const head = git(cwd, "rev-parse", "HEAD");
      const paths = await pathsFor(cwd, ignored[taskId] ?? []);
      const files = await Promise.all(
        paths.map(({ path, tracked }) => entryFor(cwd, path, tracked, blobs)),
      );
      const second = await Promise.all(
        paths.map(({ path, tracked }) => entryFor(cwd, path, tracked)),
      );
      if (
        JSON.stringify(files) !== JSON.stringify(second) ||
        JSON.stringify(paths) !==
          JSON.stringify(await pathsFor(cwd, ignored[taskId] ?? [])) ||
        head !== git(cwd, "rev-parse", "HEAD")
      )
        throw new Error(`Checkpoint source changed during capture: ${taskId}`);
      manifest.worktrees[taskId] = {
        path: realpathSync(cwd),
        gitCommonDir: realpathSync(
          resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")),
        ),
        branch: worktree.branch,
        head,
        files,
      };
    }
    for (const path of [...new Set(artifacts)].sort()) {
      if (!isAbsolute(path))
        throw new Error(`Artifact path is not absolute: ${path}`);
      const bytes = await readFile(path);
      const sha256 = hash(bytes);
      const blob = join(blobs, sha256);
      try {
        const handle = await open(blob, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      manifest.artifacts.push({ path, sha256 });
    }
    const bytes = JSON.stringify(manifest);
    const handle = await open(join(temporary, "manifest.json"), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(blobs);
    await syncDirectory(temporary);
    await rename(temporary, checkpointPath(directory, id));
    await syncDirectory(parent);
    const receipt = { id, sha256: hash(bytes) };
    await verifyWorkflowCheckpoint(directory, receipt);
    return receipt;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
};

export const verifyWorkflowCheckpoint = async (
  directory: string,
  receipt: WorkflowCheckpoint,
): Promise<Manifest> => {
  const root = checkpointPath(directory, receipt.id);
  const bytes = await readFile(join(root, "manifest.json"));
  if (hash(bytes) !== receipt.sha256)
    throw new Error("Checkpoint manifest changed");
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (manifest.version !== 1) throw new Error("Unsupported checkpoint version");
  const hashes = new Set<string>();
  for (const worktree of Object.values(manifest.worktrees))
    for (const file of worktree.files)
      if (file.kind === "file") hashes.add(file.sha256);
  for (const artifact of manifest.artifacts) hashes.add(artifact.sha256);
  for (const sha256 of hashes)
    if (hash(await readFile(join(root, "blobs", sha256))) !== sha256)
      throw new Error(`Checkpoint blob changed: ${sha256}`);
  return manifest;
};

/** Never replace a dirty worktree unless its retained inventory already matches. */
export const restoreWorkflowCheckpoint = async (
  directory: string,
  receipt: WorkflowCheckpoint,
  worktrees: Readonly<Record<string, Worktree>>,
  ignored: Readonly<Record<string, readonly string[]>>,
): Promise<void> => {
  const manifest = await verifyWorkflowCheckpoint(directory, receipt);
  for (const [taskId, saved] of Object.entries(manifest.worktrees)) {
    const target = worktrees[taskId];
    if (!target || target.branch !== saved.branch)
      throw new Error(`Checkpoint worktree does not match ${taskId}`);
    const cwd = target.worktreePath;
    if (
      realpathSync(cwd) !== saved.path ||
      realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"))) !==
        saved.gitCommonDir ||
      git(cwd, "branch", "--show-current") !== saved.branch ||
      git(cwd, "rev-parse", "HEAD") !== saved.head
    )
      throw new Error(`Checkpoint Git identity changed for ${taskId}`);
    const currentPaths = await pathsFor(cwd, ignored[taskId] ?? []);
    const current = await Promise.all(
      currentPaths.map(({ path, tracked }) => entryFor(cwd, path, tracked)),
    );
    if (JSON.stringify(current) === JSON.stringify(saved.files)) continue;
    if (git(cwd, "status", "--porcelain", "--untracked-files=all"))
      throw new Error(`Refusing to overwrite dirty worktree for ${taskId}`);
    const savedByPath = new Map(saved.files.map((file) => [file.path, file]));
    for (const file of current) {
      if (
        (ignored[taskId] ?? []).some(
          (path) => file.path === path || file.path.startsWith(`${path}/`),
        )
      ) {
        const original = savedByPath.get(file.path);
        if (!original || JSON.stringify(original) !== JSON.stringify(file))
          throw new Error(
            `Refusing to overwrite changed ignored artifact: ${file.path}`,
          );
      }
    }
    for (const file of saved.files) {
      if (!validRelativePath(file.path))
        throw new Error(`Invalid checkpoint path: ${file.path}`);
      const path = resolve(cwd, file.path);
      if (relative(cwd, path).startsWith(".."))
        throw new Error(`Checkpoint path escapes worktree: ${file.path}`);
      let parent = cwd;
      for (const part of file.path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        try {
          if ((await lstat(parent)).isSymbolicLink())
            throw new Error(`Checkpoint parent is a symlink: ${file.path}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await mkdir(dirname(path), { recursive: true });
      if (file.kind === "missing") {
        await rm(path, { force: true });
      } else if (file.kind === "link") {
        await rm(path, { force: true });
        await symlink(file.target, path);
      } else {
        await rm(path, { force: true });
        await writeFile(
          path,
          await readFile(
            join(checkpointPath(directory, receipt.id), "blobs", file.sha256),
          ),
          { flag: "wx" },
        );
        await chmod(path, file.mode);
      }
    }
    const restoredPaths = await pathsFor(cwd, ignored[taskId] ?? []);
    const restored = await Promise.all(
      restoredPaths.map(({ path, tracked }) => entryFor(cwd, path, tracked)),
    );
    if (JSON.stringify(restored) !== JSON.stringify(saved.files))
      throw new Error(`Restored worktree failed verification: ${taskId}`);
  }
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(
      join(checkpointPath(directory, receipt.id), "blobs", artifact.sha256),
    );
    try {
      if (hash(await readFile(artifact.path)) === artifact.sha256) continue;
      throw new Error(
        `Refusing to overwrite changed artifact: ${artifact.path}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, bytes, { flag: "wx", mode: 0o600 });
  }
};
