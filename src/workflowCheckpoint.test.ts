import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWorktree } from "./createWorktree.js";
import {
  captureWorkflowCheckpoint,
  restoreWorkflowCheckpoint,
  verifyWorkflowCheckpoint,
} from "./workflowCheckpoint.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("captures edits, deletions, untracked and required ignored files without overwriting later dirty work", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-checkpoint-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, ".gitignore"), "proof.txt\n");
  await writeFile(join(root, "edit.txt"), "base\n");
  await writeFile(join(root, "delete.txt"), "base\n");
  git(root, "add", ".gitignore", "edit.txt", "delete.txt");
  git(root, "commit", "-m", "base");
  const worktree = await createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "checkpoint" },
  });
  const directory = join(root, "state");
  const path = worktree.worktreePath;
  try {
    await writeFile(join(path, "edit.txt"), "saved edit\n");
    await rm(join(path, "delete.txt"));
    await writeFile(join(path, "new.txt"), "untracked\n");
    await writeFile(join(path, "proof.txt"), "ignored proof\n");
    const receipt = await captureWorkflowCheckpoint(
      directory,
      { a: worktree },
      { a: ["proof.txt"] },
      [],
    );
    await verifyWorkflowCheckpoint(directory, receipt);
    await writeFile(join(path, "edit.txt"), "later edit\n");
    await expect(
      restoreWorkflowCheckpoint(
        directory,
        receipt,
        { a: worktree },
        { a: ["proof.txt"] },
      ),
    ).rejects.toThrow("dirty worktree");
    git(path, "reset", "--hard", "HEAD");
    git(path, "clean", "-fd");
    await writeFile(join(path, "proof.txt"), "intervening ignored work\n");
    await expect(
      restoreWorkflowCheckpoint(
        directory,
        receipt,
        { a: worktree },
        { a: ["proof.txt"] },
      ),
    ).rejects.toThrow("changed ignored artifact");
    await rm(join(path, "proof.txt"));
    await restoreWorkflowCheckpoint(
      directory,
      receipt,
      { a: worktree },
      { a: ["proof.txt"] },
    );
    expect(await readFile(join(path, "edit.txt"), "utf8")).toBe("saved edit\n");
    expect(await readFile(join(path, "new.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(join(path, "proof.txt"), "utf8")).toBe(
      "ignored proof\n",
    );
    await expect(readFile(join(path, "delete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await restoreWorkflowCheckpoint(
      directory,
      receipt,
      { a: worktree },
      { a: ["proof.txt"] },
    );
    const manifest = JSON.parse(
      await readFile(
        join(directory, "checkpoints", receipt.id, "manifest.json"),
        "utf8",
      ),
    ) as { worktrees: { a: { files: { sha256?: string }[] } } };
    const sha256 = manifest.worktrees.a.files.find(
      (file) => file.sha256,
    )?.sha256;
    await writeFile(
      join(directory, "checkpoints", receipt.id, "blobs", sha256!),
      "corrupt\n",
    );
    await expect(verifyWorkflowCheckpoint(directory, receipt)).rejects.toThrow(
      "blob changed",
    );
  } finally {
    await worktree.close();
    await rm(root, { recursive: true, force: true });
  }
});
