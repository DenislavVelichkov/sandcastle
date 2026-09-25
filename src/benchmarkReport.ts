import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  benchmarkFixtures,
  benchmarkSlots,
  readBenchmark,
  type BenchmarkEvaluation,
  type BenchmarkLedger,
} from "./benchmark.js";
import type { PilotBudgetState } from "./pilotBudget.js";
import { pilotConfigurations } from "./workflowUsage.js";

const names = [
  "Luna Max",
  "Astra Medium",
  "Astra High",
  "Astra Max",
  "Sol Medium",
  "Sol High",
  "Sol xHigh",
  "Adaptive",
];
const reference = 5;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const escapeHtml = (value: unknown) =>
  String(value ?? "Unknown").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const plain = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? "Unknown"
    : String(value);
const count = (
  items: readonly BenchmarkEvaluation[],
  test: (item: BenchmarkEvaluation) => boolean,
) => items.filter(test).length;
const formatMs = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "Unknown"
    : `${(value / 60_000).toFixed(1)} min`;
const csv = (value: unknown) =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;

export interface BenchmarkReportRow {
  readonly slotId: string;
  readonly split: string;
  readonly configuration: string;
  readonly fixture: string;
  readonly repetition: number;
  readonly status: string;
  readonly technicalPassed: boolean | null;
  readonly projectAccepted: boolean | null;
  readonly firstIterationSuccess: boolean;
  readonly reviewPassed: boolean;
  readonly falseAcceptance: boolean;
  readonly taskStatus: string | null;
  readonly reason: string | null;
  readonly activeMs: number | null;
  readonly humanWaitingMs: null;
  readonly tokenCoverage: string;
  readonly verifiedTokens: number | null;
  readonly window: string;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly beforeUsedPercent: number | null;
  readonly afterUsedPercent: number | null;
  readonly resetsAt: number | null;
  readonly costStatus: string;
}

const rowsFor = (ledger: BenchmarkLedger): BenchmarkReportRow[] =>
  ledger.evaluations.flatMap((item) => {
    const slot = benchmarkSlots.find((entry) => entry.id === item.slotId);
    if (!slot)
      throw new Error(`Unknown benchmark slot in ledger: ${item.slotId}`);
    const total = item.usage?.tokens?.attributableTotal;
    const tokenCoverage = !item.usage
      ? "Unavailable"
      : item.usage.tokens.unknown.length || !total
        ? `Incomplete: ${item.usage.tokens.unknown.join(", ") || "attributable total missing"}`
        : "Complete";
    const verifiedTokens = total
      ? total.inputTokens +
        total.cacheCreationInputTokens +
        total.cacheReadInputTokens +
        total.outputTokens
      : null;
    const activeMs = item.usage?.taskMs
      ? (Object.values(item.usage.taskMs)[0] ?? null)
      : null;
    const windows = Object.keys(ledger.accountResolution ?? item.cost ?? {});
    const costStatus = item.cost
      ? "Observed interval"
      : item.usage?.resetContinuations?.length
        ? "Reset or changed window"
        : "Unknown or incomparable";
    return (windows.length ? windows : ["Unspecified"]).map((window) => {
      const cost = item.cost?.[window];
      return {
        slotId: item.slotId,
        split: slot.split,
        configuration: names[slot.arm === "adaptive" ? 7 : slot.arm]!,
        fixture: slot.fixture,
        repetition: slot.repetition,
        status: item.status,
        technicalPassed: item.technicalPassed ?? null,
        projectAccepted: item.projectAccepted ?? null,
        firstIterationSuccess: item.firstIterationSuccess,
        reviewPassed: item.reviewPassed,
        falseAcceptance: item.falseAcceptance,
        taskStatus: item.taskStatus ?? null,
        reason: item.reason ?? null,
        activeMs,
        humanWaitingMs: null,
        tokenCoverage,
        verifiedTokens,
        window,
        lower: cost?.lower ?? null,
        upper: cost?.upper ?? null,
        beforeUsedPercent: cost?.before.windows[window]?.usedPercent ?? null,
        afterUsedPercent: cost?.after.windows[window]?.usedPercent ?? null,
        resetsAt: cost?.after.windows[window]?.resetsAt ?? null,
        costStatus: cost
          ? cost.lower === 0
            ? "Observed interval; zero/coarse lower bound"
            : costStatus
          : costStatus,
      };
    });
  });

const badge = (label: string, kind: "good" | "warn" | "neutral" = "neutral") =>
  `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
const status = (value: boolean | null) =>
  value === null
    ? badge("Unknown")
    : value
      ? badge("Passed", "good")
      : badge("Did not pass", "warn");

const htmlFor = (
  ledger: BenchmarkLedger,
  budget: PilotBudgetState | null,
  manifest: Record<string, unknown> | null,
  ledgerHash: string,
  rows: readonly BenchmarkReportRow[],
) => {
  const bySlot = new Map(ledger.evaluations.map((item) => [item.slotId, item]));
  const armRows = names
    .map((name, index) => {
      const slots = benchmarkSlots.filter(
        (slot) => slot.arm === (index === 7 ? "adaptive" : index),
      );
      const dev = slots.filter((slot) => slot.split === "development");
      const held = slots.filter((slot) => slot.split === "held-out");
      const cells = (selected: typeof slots) => {
        const attempted = selected
          .map((slot) => bySlot.get(slot.id))
          .filter((item) => item !== undefined);
        const accepted = count(attempted, (item) => item.status === "accepted");
        const first = count(attempted, (item) => item.firstIterationSuccess);
        const technical = count(
          attempted,
          (item) => item.technicalPassed === true,
        );
        const width = selected.length
          ? Math.round((accepted / selected.length) * 100)
          : 0;
        return `<td><span class="metric">${accepted}/${selected.length}</span><span class="sub">${attempted.length} attempted · ${technical} technical · ${first} first pass</span><span class="track"><span style="width:${width}%"></span></span></td>`;
      };
      return `<tr><th scope="row">${escapeHtml(name)}${index === reference ? ` ${badge("Reference")}` : ""}${index === 7 ? ` ${badge("Frozen route")}` : ""}<span class="sub">${index === 7 ? "Selected start → fallback" : `${pilotConfigurations[index]!.model} / ${pilotConfigurations[index]!.effort}`}</span></th>${cells(dev)}${cells(held)}</tr>`;
    })
    .join("");

  const windowNames = Object.keys(ledger.accountResolution ?? {});
  const usageRows = names
    .flatMap((name) =>
      ["development", "held-out"].flatMap((split) =>
        windowNames.map((window) => {
          const selected = rows.filter(
            (row) =>
              row.configuration === name &&
              row.split === split &&
              row.window === window,
          );
          const measured = selected.filter(
            (row) => row.lower !== null && row.upper !== null,
          );
          const lower = measured.reduce((sum, row) => sum + row.lower!, 0);
          const upper = measured.reduce((sum, row) => sum + row.upper!, 0);
          const complete = measured.length === 4;
          return `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(split)}</td><td>${escapeHtml(window)}</td><td>${measured.length ? `${lower.toFixed(2)}–${upper.toFixed(2)} pp` : "Unknown"}</td><td>${badge(complete ? "Complete" : `Partial ${measured.length}/4`, complete ? "good" : "warn")}</td></tr>`;
        }),
      ),
    )
    .join("");
  const exceptions = ledger.evaluations.filter(
    (item) =>
      item.status !== "accepted" ||
      item.reason ||
      item.falseAcceptance ||
      !item.reviewPassed,
  );
  const pair = ledger.pair;
  const reportReservation = ledger.activities?.at(-1);
  const activeAtReportStart =
    budget?.activeMs === undefined
      ? null
      : reportReservation?.outcome === "reserved" &&
          reportReservation.label === "benchmark-report"
        ? budget.activeMs - reportReservation.reservedMs
        : budget.activeMs;
  const recommendation =
    ledger.promotion === "admitted" && pair
      ? `The held-out assessment admitted ${names[pair.start]} as the starting configuration and ${names[pair.fallback]} after an independently checked implementation failure. Owner activation remains separate.`
      : ledger.promotion === "fixed-policy"
        ? "The recorded assessment retains fixed Sol High. The evidence did not meet the adaptive admission rule."
        : "Keep fixed Sol High while the pilot or promotion assessment is incomplete.";
  const manifestEntries = manifest ? Object.entries(manifest) : [];
  const evidence = ledger.evaluations
    .map((item) => {
      const slot = benchmarkSlots.find((entry) => entry.id === item.slotId)!;
      return `<details><summary><strong>${escapeHtml(names[slot.arm === "adaptive" ? 7 : slot.arm])}</strong><span>${escapeHtml(slot.split)} · ${escapeHtml(slot.fixture)} · repetition ${slot.repetition}</span>${badge(item.status, item.status === "accepted" ? "good" : "warn")}</summary><dl class="facts"><div><dt>Technical check</dt><dd>${status(item.technicalPassed ?? null)}</dd></div><div><dt>Project acceptance</dt><dd>${status(item.projectAccepted ?? null)}</dd></div><div><dt>First iteration</dt><dd>${status(item.firstIterationSuccess)}</dd></div><div><dt>Review</dt><dd>${status(item.reviewPassed)}</dd></div><div><dt>Active evaluation time</dt><dd>${escapeHtml(formatMs(item.usage?.taskMs ? Object.values(item.usage.taskMs)[0] : null))}</dd></div><div><dt>Human waiting</dt><dd>Not measured in ledger</dd></div><div><dt>Account cost</dt><dd>${escapeHtml([...new Set(rows.filter((row) => row.slotId === item.slotId).map((row) => row.costStatus))].join(", "))}</dd></div><div><dt>Token coverage</dt><dd>${escapeHtml(rows.find((row) => row.slotId === item.slotId)?.tokenCoverage)}</dd></div></dl><p>${escapeHtml(item.reason ?? "No recorded exception")}</p><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></details>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sandcastle benchmark report</title>
<style>
:root{color-scheme:light;--ink:#17252b;--muted:#4b6268;--paper:#f6f3ec;--panel:#fffdf9;--line:#c9d2ce;--accent:#087c72;--good:#075e52;--warn:#954a17;--focus:#a14808}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 "Source Sans 3","Segoe UI",sans-serif}main{max-width:1200px;margin:auto;padding:32px 24px 80px}header{border-bottom:4px solid var(--ink);padding:0 0 28px;margin-bottom:34px}.eyebrow{font:700 .8rem/1.2 "Consolas",monospace;text-transform:uppercase;letter-spacing:.13em;color:var(--accent)}h1,h2,h3{font-family:Georgia,serif;line-height:1.1}h1{font-size:clamp(2.5rem,6vw,5.5rem);letter-spacing:-.045em;margin:.3em 0}h2{font-size:clamp(1.8rem,3vw,2.6rem);margin:0 0 16px}h3{font-size:1.25rem}.lead{max-width:75ch;font-size:1.15rem}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,section{background:var(--panel);border:1px solid var(--line)}.card{padding:18px}.card b{display:block;font:700 2rem/1 Georgia,serif;margin:8px 0}.card span,.sub,small{color:var(--muted)}section{padding:26px;margin:24px 0}p{max-width:85ch}.badge{display:inline-block;border:1px solid var(--line);padding:2px 8px;border-radius:99px;font:700 .72rem/1.4 "Consolas",monospace;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap}.badge.good{background:#e0f2ea;color:var(--good);border-color:#9bc9b5}.badge.warn{background:#fff0df;color:var(--warn);border-color:#dfb184}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:650px}th,td{text-align:left;vertical-align:top;padding:14px 12px;border-bottom:1px solid var(--line)}thead th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}tbody th{font-weight:700}.sub{display:block;font-size:.8rem;font-weight:400}.metric{font:700 1.35rem/1.2 Georgia,serif}.track{display:block;height:6px;background:#e3e9e5;margin-top:8px}.track span{display:block;height:100%;background:var(--accent)}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.facts div{border-top:1px solid var(--line);padding-top:8px;min-width:0}dt{font-size:.8rem;color:var(--muted)}dd{margin:3px 0;overflow-wrap:anywhere}details{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer;display:flex;align-items:center;gap:12px;flex-wrap:wrap}summary span:nth-child(2){color:var(--muted);flex:1}details pre{max-height:360px;overflow:auto;background:#edf1ee;padding:16px;font-size:.75rem;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#075e74;text-decoration-thickness:2px;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.notice{border-left:4px solid var(--accent);padding-left:18px}.warning{border-left-color:var(--warn)}.mono{font-family:"Consolas",monospace;overflow-wrap:anywhere}ul{padding-left:22px}@media(max-width:760px){main{padding:20px 14px 50px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}section{padding:18px}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:440px){.grid,.facts{grid-template-columns:1fr}summary{align-items:flex-start}}
</style></head><body><main>
<header><p class="eyebrow">Sandcastle / controlled comparison</p><h1>Benchmark evidence</h1><p class="lead">A local record of seven fixed configurations and the frozen adaptive route. All figures below come from the retained ledger; this report does not run an evaluation or grant project acceptance.</p><p><a href="report.json">Download JSON evidence</a> · <a href="evaluations.csv">Download CSV rows</a></p></header>
<div class="grid"><div class="card"><span>Evaluations recorded</span><b>${ledger.evaluations.length}/64</b><small>${64 - ledger.evaluations.length} scheduled slots remain</small></div><div class="card"><span>Accepted</span><b>${count(ledger.evaluations, (item) => item.status === "accepted")}</b><small>Includes review and isolated session checks</small></div><div class="card"><span>First iteration</span><b>${count(ledger.evaluations, (item) => item.firstIterationSuccess)}</b><small>Across recorded evaluations</small></div><div class="card"><span>Pilot active time</span><b>${escapeHtml(formatMs(activeAtReportStart))}</b><small>At report start; report generation is charged afterward</small></div></div>
<section><p class="eyebrow">Executive summary</p><h2>${escapeHtml(ledger.promotion === "admitted" ? "Adaptive route admitted" : ledger.promotion === "fixed-policy" ? "Fixed policy retained" : "Evidence still accumulating")}</h2><p class="lead notice ${ledger.promotion === "fixed-policy" ? "warning" : ""}">${escapeHtml(recommendation)}</p><p>${pair ? `Frozen rule: start with <strong>${escapeHtml(names[pair.start])}</strong>; use <strong>${escapeHtml(names[pair.fallback])}</strong> only after an actionable independent implementation failure.` : "No adaptive pair is frozen in this ledger."} ${ledger.promotion ? "This is the ledger's recorded assessment, not a report-side decision." : "No promotion result has been recorded."}</p><p>Qualification requires four accepted development evaluations for each eligible configuration, a qualifying Sol High reference, complete attributable token coverage and at least 20% conservative savings in every comparable account window. Held-out admission additionally requires all matched adaptive outcomes and same-direction savings in both repetitions. Unknown or coarse measurements cannot establish savings.</p></section>
<section><p class="eyebrow">Outcome by configuration</p><h2>Development and held-out</h2><p>Bars show accepted evaluations out of scheduled evaluations. Adaptive development results are shown as evidence only; the frozen pair is selected before held-out results.</p><div class="table-wrap"><table><thead><tr><th scope="col">Configuration</th><th scope="col">Development</th><th scope="col">Held-out</th></tr></thead><tbody>${armRows}</tbody></table></div></section>
<section><p class="eyebrow">Subscription account windows</p><h2>Observed usage intervals</h2><p>Ranges are sums of retained lower and upper percentage-point bounds, not credits, dollars or token estimates. Partial rows cannot establish comparative savings. Window readings and reset times appear in each evaluation and in the exports.</p>${windowNames.length ? `<div class="table-wrap"><table><thead><tr><th>Configuration</th><th>Split</th><th>Window</th><th>Observed range</th><th>Coverage</th></tr></thead><tbody>${usageRows}</tbody></table></div>` : `<p>${badge("Unknown", "warn")} No account windows were declared in the ledger.</p>`}<p class="sub">Declared reading resolution: ${escapeHtml(JSON.stringify(ledger.accountResolution ?? null))}. Window durations (ms): ${escapeHtml(JSON.stringify(ledger.windowDurationMs ?? null))}.</p></section>
<section><p class="eyebrow">Unresolved outcomes</p><h2>Rejected, failed, capped or blocked</h2>${exceptions.length ? `<ul>${exceptions.map((item) => `<li><strong>${escapeHtml(item.slotId)}</strong>: ${escapeHtml(item.reason ?? (item.status === "incomplete" ? "Incomplete; no reason recorded" : "Review or protected acceptance failed"))}${item.usage?.stopReason ? ` · guard: ${escapeHtml(item.usage.stopReason)}` : ""}</li>`).join("")}</ul>` : "<p>No recorded exceptions. Unattempted slots are not successes.</p>"}<p>Human waiting duration is not measured by the benchmark ledger. Active evaluation time and raw provider coverage are shown per evaluation; pilot active time includes shared measurement and host activities when the budget is available.</p></section>
<section><p class="eyebrow">Reproducibility</p><h2>Artifacts and conditions</h2><dl class="facts"><div><dt>Policy</dt><dd>${escapeHtml(ledger.policyId)}</dd></div><div><dt>Protocol SHA-256</dt><dd class="mono">${escapeHtml(ledger.protocolHash)}</dd></div><div><dt>Ledger SHA-256</dt><dd class="mono">${escapeHtml(ledgerHash)}</dd></div><div><dt>Host conditions SHA-256</dt><dd class="mono">${escapeHtml(plain(ledger.hostConditionsHash))}</dd></div><div><dt>Pilot runtime</dt><dd class="mono">${escapeHtml(plain(budget?.runtimeIdentity))}</dd></div><div><dt>Fixture conditions</dt><dd class="mono">${escapeHtml(JSON.stringify(ledger.fixtureConditions ?? null))}</dd></div></dl><h3>Historical case identities</h3><ul>${benchmarkFixtures.map((fixture) => `<li><strong>${escapeHtml(fixture.id)}</strong> (${escapeHtml(fixture.split)}): base <span class="mono">${fixture.base}</span>, reference <span class="mono">${fixture.reference}</span>. ${escapeHtml(fixture.focus)}</li>`).join("")}</ul><h3>Host manifest</h3>${manifest ? `<dl class="facts">${manifestEntries.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd class="mono">${escapeHtml(plain(typeof value === "object" ? JSON.stringify(value) : value))}</dd></div>`).join("")}</dl>` : "<p>Not supplied. Exact worker, artifact and environment identities are unavailable for this report.</p>"}<p>Limitations: source observations are the ledger's account readings, counter paths and protected preflight records. Missing, overlapping, delayed, reset or confounded measurements remain uncertain. A synthetic fixture does not establish live savings. The report does not recalculate qualification or promotion.</p></section>
<section><p class="eyebrow">Audit trail</p><h2>Evaluation evidence</h2><p>Open a row to inspect its recorded candidate, sessions, preflight, review, account readings, token sources and reason. ${ledger.evaluations.length} of 64 slots have records.</p>${evidence || "<p>No evaluations recorded yet.</p>"}</section>
</main></body></html>`;
};

/** Render retained evidence only. Hosts charge this operation with withBenchmarkActivity during a pilot. */
export const writeBenchmarkReport = async (input: {
  directory: string;
  policyId: string;
  outputDirectory: string;
  manifestPath?: string;
}): Promise<{ html: string; json: string; csv: string }> => {
  if (!input.outputDirectory)
    throw new Error("Report output directory is required");
  const ledgerText = await readFile(
    join(input.directory, "benchmark.json"),
    "utf8",
  );
  const ledger = await readBenchmark(input.directory, input.policyId);
  let budget: PilotBudgetState | null = null;
  try {
    budget = JSON.parse(
      await readFile(join(input.directory, "budget.json"), "utf8"),
    ) as PilotBudgetState;
    if (budget.policyId !== input.policyId)
      throw new Error("Pilot budget policy identity changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let manifest: Record<string, unknown> | null = null;
  if (input.manifestPath) {
    const raw = await readFile(input.manifestPath, "utf8");
    if (ledger.hostConditionsHash && sha256(raw) !== ledger.hostConditionsHash)
      throw new Error("Host manifest differs from frozen benchmark conditions");
    manifest = JSON.parse(raw) as Record<string, unknown>;
    if (manifest.protocolHash && manifest.protocolHash !== ledger.protocolHash)
      throw new Error("Host manifest protocol identity changed");
  }
  const rows = rowsFor(ledger);
  const fields = Object.keys(
    rows[0] ?? {
      slotId: "",
      split: "",
      configuration: "",
      fixture: "",
      repetition: "",
      status: "",
      technicalPassed: "",
      projectAccepted: "",
      firstIterationSuccess: "",
      reviewPassed: "",
      falseAcceptance: "",
      taskStatus: "",
      reason: "",
      activeMs: "",
      humanWaitingMs: "",
      tokenCoverage: "",
      verifiedTokens: "",
      window: "",
      lower: "",
      upper: "",
      beforeUsedPercent: "",
      afterUsedPercent: "",
      resetsAt: "",
      costStatus: "",
    },
  ) as (keyof BenchmarkReportRow)[];
  const csvText =
    [
      fields.map(csv).join(","),
      ...rows.map((row) => fields.map((field) => csv(row[field])).join(",")),
    ].join("\n") + "\n";
  const jsonText =
    JSON.stringify(
      { ledger, budget, manifest, ledgerHash: sha256(ledgerText), rows },
      null,
      2,
    ) + "\n";
  const htmlText = htmlFor(ledger, budget, manifest, sha256(ledgerText), rows);
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const output = async (name: string, value: string) => {
    const path = join(outputDirectory, name);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, value, { mode: 0o600 });
    await rename(temp, path);
    return path;
  };
  const json = await output("report.json", jsonText);
  const csvPath = await output("evaluations.csv", csvText);
  const html = await output("report.html", htmlText);
  return { html, json, csv: csvPath };
};
