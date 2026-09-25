import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import {
  recoverNativeProofReservation,
  runNativeProof,
} from "./nativeProof.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-native-"));
  directories.push(root);
  const worktree = join(root, "project");
  const evidenceRoot = join(root, "evidence");
  const stateRoot = join(root, "host-state");
  await mkdir(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  await writeFile(join(worktree, "source.txt"), "candidate\n");
  execFileSync("git", ["-C", worktree, "add", "."]);
  execFileSync("git", [
    "-C",
    worktree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "candidate",
  ]);
  const candidateHead = execFileSync(
    "git",
    ["-C", worktree, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  return { worktree, evidenceRoot, stateRoot, candidateHead };
};

test("host reservation queues another project and validates owner evidence", async () => {
  const base = await fixture();
  const order: string[] = [];
  let allowFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    allowFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const request = (operationId: string) => ({
    ...base,
    operationId,
    timeoutMs: 2_000,
    run: async ({ evidenceDirectory }: { evidenceDirectory: string }) => {
      order.push(`start:${operationId}`);
      if (operationId === "first") {
        firstStarted();
        await firstGate;
      }
      const receipt = join(evidenceDirectory, "receipt.json");
      await writeFile(receipt, JSON.stringify({ operationId }));
      return receipt;
    },
    validate: async (_context: unknown, receipt: string) => {
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
        operationId,
      });
      order.push(`valid:${operationId}`);
      return { status: "passed" as const, evidence: [receipt] };
    },
    stopped: async () => true,
  });
  const first = runNativeProof(request("first"));
  await started;
  const second = runNativeProof(request("second"));
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(order).toEqual(["start:first"]);
  allowFirst();
  expect((await first).status).toBe("passed");
  expect((await second).status).toBe("passed");
  expect(order).toEqual([
    "start:first",
    "valid:first",
    "start:second",
    "valid:second",
  ]);
});

test("failed cleanup retains ownership until explicit recovery", async () => {
  const base = await fixture();
  await expect(
    runNativeProof({
      ...base,
      operationId: "failed",
      timeoutMs: 1_000,
      run: async ({ evidenceDirectory }) => {
        const receipt = join(evidenceDirectory, "receipt.json");
        await writeFile(receipt, "{}");
        return receipt;
      },
      validate: async (_context, receipt) => ({
        status: "passed",
        evidence: [receipt],
      }),
      stopped: async () => false,
    }),
  ).rejects.toThrow(/resources.*active/i);
  expect(
    await readdir(join(base.stateRoot, "sandcastle", "native-proof")),
  ).toContain("lock");
  await expect(
    recoverNativeProofReservation(base.stateRoot, async () => false),
  ).rejects.toThrow(/resources.*active/i);
  await recoverNativeProofReservation(base.stateRoot, async () => true);
  expect(
    await readdir(join(base.stateRoot, "sandcastle", "native-proof")),
  ).not.toContain("lock");
});

test("wrong candidate and cancelled queue never invoke the owner", async () => {
  const base = await fixture();
  let called = false;
  const controller = new AbortController();
  controller.abort();
  await expect(
    runNativeProof({
      ...base,
      candidateHead: "0".repeat(40),
      operationId: "wrong",
      timeoutMs: 1_000,
      signal: controller.signal,
      run: async () => {
        called = true;
        return "";
      },
      validate: async () => ({ status: "passed", evidence: [] }),
      stopped: async () => true,
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
});

test("failed capture retains the host reservation despite a stopped process", async () => {
  const base = await fixture();
  await expect(
    runNativeProof({
      ...base,
      operationId: "capture-failed",
      timeoutMs: 1_000,
      run: async () => {
        throw new Error("capture failed");
      },
      validate: async () => ({ status: "passed", evidence: [] }),
      stopped: async () => true,
    }),
  ).rejects.toThrow("capture failed");
  expect(
    await readdir(join(base.stateRoot, "sandcastle", "native-proof")),
  ).toContain("lock");
  await recoverNativeProofReservation(base.stateRoot, async () => true);
});
