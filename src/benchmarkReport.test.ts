import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  benchmarkFixtures,
  benchmarkProtocolHash,
  benchmarkSlots,
  type BenchmarkEvaluation,
  type BenchmarkLedger,
} from "./benchmark.js";
import { writeBenchmarkReport } from "./benchmarkReport.js";

const observation = {
  accountId: "synthetic-account",
  observedAt: 1,
  denied: false,
  windows: { short: { usedPercent: 20, resetsAt: 100_000 } },
};
const evaluation = (
  slot: (typeof benchmarkSlots)[number],
): BenchmarkEvaluation => {
  const fixture = benchmarkFixtures.find((item) => item.id === slot.fixture)!;
  return {
    slotId: slot.id,
    invocationId: slot.id,
    fixture: {
      fixtureId: fixture.id,
      base: fixture.base,
      reference: fixture.reference,
      exportHead: "synthetic-export",
      tree: "synthetic-tree",
      preflight: {
        base: {
          focusPassed: false,
          otherGatesPassed: true,
          evidence: ["base defect"],
        },
        correction: {
          focusPassed: true,
          otherGatesPassed: true,
          evidence: ["correction passes"],
        },
      },
    },
    worktree: `synthetic-${slot.id}`,
    sessionIds: [`session-${slot.id}`],
    requested: "synthetic",
    effective: "synthetic",
    status: "accepted",
    technicalPassed: true,
    projectAccepted: true,
    taskStatus: "accepted",
    firstIterationSuccess: true,
    reviewPassed: true,
    falseAcceptance: false,
    cost: {
      short: {
        lower: 1,
        upper: 2,
        durationMs: 5 * 60 * 60_000,
        before: observation,
        after: observation,
      },
    },
    usage: {
      taskMs: { [slot.id]: 60_000 },
      tokens: {
        attributableTotal: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2,
        },
        unknown: [],
      },
    } as unknown as BenchmarkEvaluation["usage"],
  };
};

it("renders complete and partial ledgers with exports matching the displayed evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "benchmark-report-"));
  const outputDirectory = join(directory, "report");
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.stringify({
    protocolHash: benchmarkProtocolHash,
    workerCliVersion: "synthetic-cli",
    installedPackage: "synthetic-package",
  });
  const hostConditionsHash = createHash("sha256")
    .update(manifest)
    .digest("hex");
  const base: BenchmarkLedger = {
    version: 1,
    protocolHash: benchmarkProtocolHash,
    policyId: "synthetic-policy",
    hostConditionsHash,
    accountResolution: { short: 0.1 },
    windowDurationMs: { short: 5 * 60 * 60_000 },
    evaluations: benchmarkSlots.map(evaluation),
    pair: { start: 0, fallback: 5, rule: "independent-implementation-failure" },
    promotion: "admitted",
  };
  try {
    await writeFile(manifestPath, manifest);
    await writeFile(join(directory, "benchmark.json"), JSON.stringify(base));
    const files = await writeBenchmarkReport({
      directory,
      policyId: base.policyId,
      outputDirectory,
      manifestPath,
    });
    const html = await readFile(files.html, "utf8");
    const json = JSON.parse(await readFile(files.json, "utf8")) as {
      ledger: BenchmarkLedger;
      rows: { slotId: string; window: string; lower: number }[];
    };
    const csv = await readFile(files.csv, "utf8");
    expect(json.ledger.evaluations).toHaveLength(64);
    expect(json.rows).toHaveLength(64);
    expect(csv.trim().split("\n")).toHaveLength(json.rows.length + 1);
    expect(csv).toContain(`"${json.rows[0]!.slotId}"`);
    expect(csv).toContain(`"${json.rows[0]!.window}"`);
    expect(html).toContain("Adaptive route admitted");
    expect(html).toContain("64/64");
    expect(html).not.toContain("Astra xHigh");
    expect(html).toContain("Sol xHigh");
    expect(html).toContain("Development and held-out");
    expect(html).toContain("4.00–8.00 pp");
    expect(html).toContain("synthetic-cli");

    const partial: BenchmarkLedger = {
      ...base,
      evaluations: [
        {
          ...evaluation(benchmarkSlots[0]!),
          status: "incomplete",
          technicalPassed: false,
          projectAccepted: false,
          taskStatus: "blocked",
          firstIterationSuccess: false,
          cost: null,
          usage: null,
          reason: 'blocked <script>alert("x")</script>, reset',
        },
      ],
      pair: undefined,
      promotion: "fixed-policy",
    };
    await writeFile(join(directory, "benchmark.json"), JSON.stringify(partial));
    const partialFiles = await writeBenchmarkReport({
      directory,
      policyId: base.policyId,
      outputDirectory,
      manifestPath,
    });
    const partialHtml = await readFile(partialFiles.html, "utf8");
    const partialJson = JSON.parse(
      await readFile(partialFiles.json, "utf8"),
    ) as { rows: { lower: number | null; costStatus: string }[] };
    const partialCsv = await readFile(partialFiles.csv, "utf8");
    expect(partialHtml).toContain("Fixed policy retained");
    expect(partialHtml).toContain("1/64");
    expect(partialHtml).toContain("Unknown or incomparable");
    expect(partialHtml).toContain("&lt;script&gt;");
    expect(partialHtml).not.toContain("<script>alert");
    expect(partialJson.rows[0]!.lower).toBeNull();
    expect(partialCsv).toContain(
      '"blocked <script>alert(""x"")</script>, reset"',
    );
    expect(partialCsv).toContain('"Unknown or incomparable"');
    await writeFile(manifestPath, manifest + "\n");
    await expect(
      writeBenchmarkReport({
        directory,
        policyId: base.policyId,
        outputDirectory,
        manifestPath,
      }),
    ).rejects.toThrow(/manifest differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
