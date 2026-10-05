import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("launches and recovers fixture benchmarks through an unrelated installed consumer", async () => {
  const output = await mkdtemp(join(tmpdir(), "installed-benchmark-proof-"));
  try {
    await promisify(execFile)(
      process.execPath,
      ["scripts/prove-installed-benchmark.mjs", output],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
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
      cleanup: "passed",
    });
    expect(await readdir(output)).not.toContain("disposable");
    expect(await readFile(join(output, "report.html"), "utf8")).toContain(
      "fixture",
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);
