import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const directoryFor = (root: string): string =>
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "sandcastle",
    "installations",
    createHash("sha256").update(realpathSync(root)).digest("hex"),
  );

/** Host-only state shared by managed updates and new-run admission. */
export const workflowInstallationDirectory = directoryFor;

export const withWorkflowInstallationLock = async <T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> => {
  const directory = directoryFor(root);
  const lock = join(directory, "installation.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Installation is locked; inspect the owner before retrying",
      );
    throw error;
  }
  const token = randomUUID();
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, token }),
      {
        mode: 0o600,
      },
    );
    return await action();
  } finally {
    const owner = JSON.parse(
      await readFile(join(lock, "owner.json"), "utf8"),
    ) as {
      token: string;
    };
    if (owner.token !== token)
      throw new Error(
        "Installation lock ownership changed; preserved for inspection",
      );
    await rm(lock, { recursive: true });
  }
};

export const inspectWorkflowInstallation = async (
  root: string,
): Promise<{ root: string; runs: readonly string[] }> => {
  const canonical = realpathSync(root);
  const path = join(directoryFor(root), "runs.json");
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      root: string;
      runs: string[];
    };
    if (
      record.version !== 1 ||
      record.root !== canonical ||
      !Array.isArray(record.runs) ||
      record.runs.some((run) => typeof run !== "string" || !run.startsWith("/"))
    )
      throw new Error("Invalid installation run inventory");
    return { root: canonical, runs: record.runs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { root: canonical, runs: [] };
    throw error;
  }
};

const writeInventory = async (root: string, runs: readonly string[]) => {
  const path = join(directoryFor(root), "runs.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${randomUUID()}`;
  const file = await open(staged, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, root: realpathSync(root), runs }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(staged, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

/** Register before admission; a missing state then blocks updates after a crash. */
export const registerWorkflowRun = async (
  root: string,
  run: string,
): Promise<boolean> => {
  if (!run.startsWith("/"))
    throw new Error("Workflow state directory must be absolute");
  try {
    await stat(join(directoryFor(root), "activation-block.json"));
    throw new Error(
      "Installation update requires recovery before new-run admission",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const inventory = await inspectWorkflowInstallation(root);
  if (inventory.runs.includes(run)) return false;
  await writeInventory(root, [...inventory.runs, run]);
  return true;
};

export const unregisterWorkflowRun = async (
  root: string,
  run: string,
): Promise<void> => {
  const inventory = await inspectWorkflowInstallation(root);
  await writeInventory(
    root,
    inventory.runs.filter((item) => item !== run),
  );
};
