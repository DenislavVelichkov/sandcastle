import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  benchmarkFixtures,
  benchmarkProtocolHash,
  benchmarkSlots,
  fixedBenchmarkProtocolHash,
  makeFixedBenchmarkPlan,
  type BenchmarkEvaluation,
  type BenchmarkLedger,
} from "./benchmark.js";
import { writeBenchmarkReport } from "./benchmarkReport.js";

it("reports the explicit 40-slot fixed study with verified credits and separate account movement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixed-report-"));
  const plan = makeFixedBenchmarkPlan([
    { model: "gpt-6-luna", effort: "max" },
    { model: "gpt-6-sol", effort: "xhigh" },
    { model: "gpt-6-astra", effort: "medium" },
    { model: "gpt-6-astra", effort: "max" },
    { model: "gpt-6-sol", effort: "high" },
  ]);
  const now = Date.now();
  const baseline = {
    ...observation,
    observedAt: now,
    windows: { weekly: { usedPercent: 20, resetsAt: now + 604_800_000 } },
  };
  const latest = {
    ...baseline,
    windows: { weekly: { ...baseline.windows.weekly, usedPercent: 22 } },
  };
  const ledger: BenchmarkLedger = {
    version: 1,
    protocolHash: fixedBenchmarkProtocolHash(plan),
    policyId: "fixed-report",
    plan,
    accountResolution: { weekly: 1 },
    windowDurationMs: { weekly: 604_800_000 },
    evaluations: plan.slots.map((slot) => ({
      ...evaluation(slot),
      usage: {
        taskMs: { [slot.id]: 60_000 },
        tokens: {
          attributableTotal: {
            inputTokens: 1_000_000,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
          unknown: [],
          deltas: {
            implementation: {
              inputTokens: 1_000_000,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              outputTokens: 0,
            },
          },
          invocations: {
            implementation: {
              role: "implementation",
              coverageComplete: true,
              counterIds: ["implementation"],
            },
          },
        },
      } as unknown as BenchmarkEvaluation["usage"],
    })),
    fixedSelection: { arm: 0, reason: "Development selection" },
    fixedDisposition: "qualified",
  };
  try {
    await writeFile(join(directory, "benchmark.json"), JSON.stringify(ledger));
    await writeFile(
      join(directory, "budget.json"),
      JSON.stringify({
        policyId: ledger.policyId,
        activeMs: 3_600_000,
        baseline,
        latest,
      }),
    );
    const files = await writeBenchmarkReport({
      directory,
      policyId: ledger.policyId,
      outputDirectory: join(directory, "report"),
    });
    const html = await readFile(files.html, "utf8");
    const json = JSON.parse(await readFile(files.json, "utf8"));
    expect(html).toContain("40/40");
    expect(html).toContain("Fixed challenger qualified");
    expect(html).toContain("gpt-6-astra:max");
    expect(html).toContain("percentage points per active hour");
    expect(json.rows).toHaveLength(40);
    expect(json.rows[0].standardCredits).toBe(2.5);

    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({
        ...ledger,
        evaluations: ledger.evaluations.slice(0, 1),
        fixedSelection: undefined,
        fixedDisposition: undefined,
      }),
    );
    const partial = await writeBenchmarkReport({
      directory,
      policyId: ledger.policyId,
      outputDirectory: join(directory, "report"),
    });
    const partialJson = JSON.parse(await readFile(partial.json, "utf8"));
    expect(partialJson.rows).toHaveLength(40);
    expect(partialJson.rows[1]).toMatchObject({ status: "unrun" });
    expect(await readFile(partial.html, "utf8")).toContain("Unrun slots (39)");
    expect(
      (await readFile(partial.csv, "utf8")).trim().split("\n"),
    ).toHaveLength(41);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
      manifestStatus: string;
      rows: { slotId: string; window: string; lower: number }[];
    };
    const csv = await readFile(files.csv, "utf8");
    expect(json.ledger.evaluations).toHaveLength(64);
    expect(json.manifestStatus).toBe("matched");
    expect(json.rows).toHaveLength(64);
    expect(csv.trim().split("\n")).toHaveLength(json.rows.length + 1);
    expect(csv).toContain(`"${json.rows[0]!.slotId}"`);
    expect(csv).toContain(`"${json.rows[0]!.window}"`);
    expect(html).toContain("Adaptive route admitted");
    expect(html).toContain("Eligible for explicit owner activation.");
    expect(html).toContain("64/64");
    expect(html).not.toContain("Astra xHigh");
    expect(html).toContain("Sol xHigh");
    expect(html).toContain("Development and held-out");
    expect(html).toContain("4.00–8.00 pp");
    expect(html).toContain("synthetic-cli");

    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...base, promotion: "fixed-policy" }),
    );
    const fixedFiles = await writeBenchmarkReport({
      directory,
      policyId: base.policyId,
      outputDirectory,
      manifestPath,
    });
    const fixedHtml = await readFile(fixedFiles.html, "utf8");
    expect(fixedHtml).toContain("Fixed policy retained");
    expect(fixedHtml).toContain("Not active; keep fixed Sol High.");

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
          reason: '=HYPERLINK("x"), <script>alert("x")</script>',
        },
        {
          ...evaluation(benchmarkSlots[1]!),
          status: "incomplete",
          firstIterationSuccess: false,
          cost: {
            short: {
              lower: 0,
              upper: 1,
              durationMs: 5 * 60 * 60_000,
              before: observation,
              after: observation,
            },
          },
          reason: "coarse account window",
        },
        {
          ...evaluation(benchmarkSlots[2]!),
          status: "incomplete",
          firstIterationSuccess: false,
          cost: null,
          reason: "confounded account window",
        },
        {
          ...evaluation(benchmarkSlots[3]!),
          status: "incomplete",
          firstIterationSuccess: false,
          cost: null,
          reason: "capped by time limit",
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
    ) as {
      rows: {
        slotId: string;
        status: string;
        lower: number | null;
        costStatus: string;
      }[];
    };
    const partialCsv = await readFile(partialFiles.csv, "utf8");
    expect(partialHtml).toContain("Fixed policy retained");
    expect(partialHtml).toContain("4/64");
    expect(partialHtml).toContain("Unknown or incomparable");
    expect(partialHtml).toContain("zero/coarse lower bound");
    expect(partialHtml).toContain("confounded account window");
    expect(partialHtml).toContain("capped by time limit");
    expect(partialHtml).toContain("&lt;script&gt;");
    expect(partialHtml).not.toContain("<script>alert");
    expect(partialJson.rows[0]!.lower).toBeNull();
    expect(partialJson.rows).toHaveLength(64);
    expect(partialJson.rows[4]).toMatchObject({
      slotId: benchmarkSlots[4]!.id,
      status: "unrun",
      lower: null,
      costStatus: "Unrun",
    });
    expect(partialHtml).toContain("Unrun slots (60)");
    expect(partialCsv.trim().split("\n")).toHaveLength(65);
    expect(partialCsv).toContain(
      '"\'=HYPERLINK(""x""), <script>alert(""x"")</script>"',
    );
    expect(partialCsv).toContain('"Unknown or incomparable"');
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({ ...partial, evaluations: [] }),
    );
    const emptyFiles = await writeBenchmarkReport({
      directory,
      policyId: base.policyId,
      outputDirectory,
      manifestPath,
    });
    expect(await readFile(emptyFiles.html, "utf8")).toContain(
      "No evaluations recorded yet.",
    );
    expect(await readFile(emptyFiles.html, "utf8")).toContain(
      "Unrun slots (64)",
    );
    expect(
      (await readFile(emptyFiles.csv, "utf8")).trim().split("\n"),
    ).toHaveLength(65);
    await writeFile(
      join(directory, "benchmark.json"),
      JSON.stringify({
        ...partial,
        evaluations: [],
        hostConditionsHash: undefined,
      }),
    );
    const unverifiedFiles = await writeBenchmarkReport({
      directory,
      policyId: base.policyId,
      outputDirectory,
      manifestPath,
    });
    expect(await readFile(unverifiedFiles.html, "utf8")).toContain(
      "Supplied; no frozen host conditions hash is recorded",
    );
    await writeFile(manifestPath, "null");
    await expect(
      writeBenchmarkReport({
        directory,
        policyId: base.policyId,
        outputDirectory,
        manifestPath,
      }),
    ).rejects.toThrow(/manifest must be a JSON object/);
    await writeFile(join(directory, "benchmark.json"), JSON.stringify(partial));
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
