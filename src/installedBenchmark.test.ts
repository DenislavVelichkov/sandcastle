import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

it("launches and recovers fixture benchmarks through an unrelated installed consumer", async () => {
  const output = await mkdtemp(join(tmpdir(), "installed-benchmark-proof-"));
  // Own the whole fixture group so a timeout cannot strand CLI/worker children.
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(stop, 110_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child = spawn(
        process.execPath,
        ["scripts/prove-installed-benchmark.mjs", output],
        { detached: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-2 * 1024 * 1024);
      });
      child.once("error", reject);
      child.once("close", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Installed fixture exited ${code ?? signal}: ${stderr}`,
              ),
            ),
      );
    });
    const proof = JSON.parse(
      await readFile(join(output, "proof.json"), "utf8"),
    );
    expect(proof).toMatchObject({
      dataKind: "fixture",
      installed: { entry: "dist/main.js" },
      routes: { local: true, github: true, prompt: true, fallback: true },
      defaults: { arms: 4, judge: "gpt-6.1-sol:xhigh" },
      isolation: true,
      checks: "passed",
      judging: "complete",
      recovery: { observerReconnected: true, implementationReplayed: false },
      usageRetained: true,
      offlineRegeneration: true,
      cleanup: "resources-stopped",
    });
    expect(
      JSON.parse(await readFile(join(output, "cleanup.json"), "utf8")),
    ).toMatchObject({ status: "passed" });
    expect(await readdir(output)).not.toContain("disposable");
    expect(await readFile(join(output, "report.html"), "utf8")).toContain(
      "fixture",
    );
  } finally {
    clearTimeout(timer);
    stop();
    for (let tries = 0; child?.pid; tries++) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (tries === 100)
        throw new Error(
          `Owned fixture group ${child.pid} is still present; retain ${output}`,
        );
      await delay(25);
    }
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);
