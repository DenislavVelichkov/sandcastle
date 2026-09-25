import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  inspectWorkflowInstallation,
  registerWorkflowRun,
  withWorkflowInstallationLock,
  workflowInstallationDirectory,
} from "./workflowInstallation.js";

it("records run admission under the update lock and preserves an interrupted lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-installation-"));
  const state = workflowInstallationDirectory(root);
  try {
    await withWorkflowInstallationLock(root, async () => {
      await registerWorkflowRun(root, join(root, "host-state"));
      await expect(
        withWorkflowInstallationLock(root, async () => undefined),
      ).rejects.toThrow(/locked/);
    });
    expect((await inspectWorkflowInstallation(root)).runs).toEqual([
      join(root, "host-state"),
    ]);
    await withWorkflowInstallationLock(root, async () => undefined);
    await writeFile(join(state, "activation-block.json"), "{}");
    await expect(
      withWorkflowInstallationLock(root, () =>
        registerWorkflowRun(root, join(root, "next-run")),
      ),
    ).rejects.toThrow(/requires recovery/);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
