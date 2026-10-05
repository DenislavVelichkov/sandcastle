import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BenchmarkEvidenceReference } from "./benchmarkJudge.js";
import type { ReportCostEstimate } from "./benchmarkReportCosts.js";
import type { ImplementationBenchmarkReport } from "./implementationBenchmarkReport.js";

export const reportHtmlSourceUrl = import.meta.url;
const escape = (value: unknown) =>
  String(value ?? "Unknown").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const embedded = (value: string) =>
  value.replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
type Row = ImplementationBenchmarkReport["rows"][number];
type Unit = "api" | "codexStandard";
type Scope = "implementation" | "full";
const units: Unit[] = ["api", "codexStandard"];
const scopes: Scope[] = ["implementation", "full"];
const colors = [
  "#8ce8bd",
  "#f6c778",
  "#93c3ff",
  "#fcaaa1",
  "#d9bbfa",
  "#d8e5dd",
];
const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const money = (value: number, unit: Unit) =>
  unit === "api" ? `$${number(value)}` : `${number(value)} credits`;
const tickLabel = (value: number, unit: Unit) => {
  const text =
    value > 0 && value < 0.001
      ? value.toExponential(1)
      : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return unit === "api" ? `$${text}` : text;
};
const costText = (cost: ReportCostEstimate, unit: Unit) =>
  cost.lower === null || cost.upper === null
    ? "Unavailable"
    : cost.lower === cost.upper
      ? money(cost.lower, unit)
      : `${money(cost.lower, unit)} to ${money(cost.upper, unit)}`;
const ms = (value: number | null) =>
  value === null
    ? "Unknown"
    : value < 1000
      ? `${Math.round(value)} ms`
      : value < 60000
        ? `${(value / 1000).toFixed(1)} s`
        : `${(value / 60000).toFixed(1)} min`;
const views = (row: Row) =>
  scopes
    .flatMap((scope) =>
      units.map(
        (unit) =>
          `<span data-cost-view="${scope}:${unit}"${scope === "full" && unit === "api" ? "" : " hidden"}>${escape(costText(row.costs[scope][unit], unit))}</span>`,
      ),
    )
    .join("");
const artifactLink = (path: string, label: string) =>
  `<a href="${escape(pathToFileURL(path).href)}">${escape(label)}</a>`;
const evidenceLink = (row: Row, evidence: BenchmarkEvidenceReference) => {
  if (!row.applicable || !row.assessment)
    return `<span>${escape(evidence.id)} · applicability unavailable</span>`;
  const path =
    evidence.kind === "code"
      ? join(row.assessment.candidate.worktree, evidence.path)
      : evidence.path;
  return `${artifactLink(path, `${evidence.kind}: ${evidence.id}`)}<span class="sub mono">SHA-256 ${escape(evidence.sha256)}${evidence.runtime ? ` · ${escape(evidence.runtime.profile)} · build ${escape(evidence.runtime.build)}` : ""}</span>`;
};
const rowDetails = (row: Row) => {
  const assessment = row.assessment;
  const assumptions = [
    ...new Set(
      [
        row.costs.implementation.api,
        row.costs.implementation.codexStandard,
        row.costs.judge.api,
        row.costs.judge.codexStandard,
      ].flatMap((cost) => cost.assumptions),
    ),
  ];
  return `<h3>${escape(`${row.model}:${row.effort}`)}</h3><p>${escape(row.title)}</p>
    <dl class="facts"><div><dt>Judged candidate</dt><dd class="mono">${escape(assessment?.candidateId ?? "No judged candidate")}<span class="sub">${escape(row.candidate?.head ?? "Candidate unavailable")}</span></dd></div>
    <div><dt>Frozen rubric</dt><dd class="mono">${escape(row.rubricSha256)}</dd></div>
    <div><dt>Specification adherence</dt><dd>${row.score === null ? "Not assessed or no longer applicable" : `${number(row.score)}/100 · ${row.assessmentStatus === "complete" ? "complete" : "partial assessment"}`}</dd></div>
    <div><dt>Evidence coverage</dt><dd>${row.coverage === null ? "Unknown" : `${number(row.coverage * 100)}% of applicable rubric weight`}${row.scoreRange ? `<span class="sub">Whole-rubric range ${row.scoreRange.map(number).join(" to ")}/100</span>` : ""}</dd></div>
    <div><dt>Independent samples</dt><dd>${row.sampleCount}${row.retryOf ? " · linked retry, not another independent sample" : " · one scheduled task/arm"}</dd></div>
    <div><dt>Judge verdict</dt><dd>${escape(row.assessmentStatus)}${row.applicabilityReason ? `<span class="sub">${escape(row.applicabilityReason)}</span>` : ""}<span class="sub">${escape(row.reason ?? assessment?.deviations.join("; ") ?? "No explanation recorded")}</span></dd></div>
    <div><dt>Evaluation judge</dt><dd>${escape(assessment ? `${assessment.judge.model}:${assessment.judge.effort}` : "No assessment")}<span class="sub">${escape(assessment?.judge.observed ? JSON.stringify(assessment.judge.observed) : "Observed identity unavailable")}</span></dd></div>
    <div><dt>Configured checks</dt><dd>${escape(row.check)}<span class="sub">Mandatory check result: ${escape(row.mandatoryChecks)}</span></dd></div>
    <div><dt>Project / human acceptance</dt><dd>Not assessed. Project reviews and human acceptance are separate gates.</dd></div>
    <div><dt>Duration</dt><dd>Implementation ${ms(row.implementationMs)} · judge ${ms(row.judgeMs)} · end-to-end ${ms(row.endToEndMs)}</dd></div>
    <div><dt>Selected cost estimate</dt><dd>${views(row)}</dd></div></dl>
    <h4>Requirement findings</h4>${assessment?.requirements.length ? `<ol class="requirements">${assessment.requirements.map((requirement) => `<li><strong>${escape(requirement.id)} · ${escape(requirement.verdict)}</strong><p>${escape(requirement.observation)}</p><p>${escape(requirement.explanation)}</p>${requirement.gaps.length ? `<p class="warning">Missing evidence: ${escape(requirement.gaps.join(", "))}</p>` : ""}<ul>${requirement.evidence.map((evidence) => `<li>${evidenceLink(row, evidence)}</li>`).join("")}</ul></li>`).join("")}</ol>` : "<p>No requirement findings recorded.</p>"}
    ${assessment?.disclosures.length ? `<h4>Disclosures</h4><ul>${assessment.disclosures.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>` : ""}
    <h4>Cost basis and assumptions</h4><ul>${assumptions.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>`;
};

const chart = (
  report: ImplementationBenchmarkReport,
  task: number,
  scope: Scope,
  unit: Unit,
) => {
  const selected = report.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.task === task);
  const plotted = selected.filter(
    ({ row }) =>
      row.score !== null &&
      row.costs[scope][unit].lower !== null &&
      row.costs[scope][unit].upper !== null,
  );
  const maximum =
    Math.max(0, ...plotted.map(({ row }) => row.costs[scope][unit].upper!)) *
      1.18 || 1;
  const x = (value: number) => 76 + (value / maximum) * 682;
  const y = (value: number) => 356 - (value / 100) * 296;
  const grid = [0, 25, 50, 75, 100]
    .map(
      (value) =>
        `<line x1="76" y1="${y(value)}" x2="758" y2="${y(value)}" class="grid"/><text x="62" y="${y(value) + 5}" text-anchor="end">${value}</text>`,
    )
    .join("");
  const ticks = [0, 1, 2, 3, 4]
    .map(
      (index) =>
        `<text x="${x((maximum * index) / 4)}" y="386" text-anchor="middle">${escape(tickLabel((maximum * index) / 4, unit))}</text>`,
    )
    .join("");
  const points = plotted
    .map(({ row, index }, position) => {
      const cost = row.costs[scope][unit];
      const cx = x((cost.lower! + cost.upper!) / 2),
        cy = y(row.score!);
      const arm = report.plan.slots.find((slot) => slot.id === row.slotId)!.arm;
      const color = colors[arm % colors.length]!;
      const label = `${row.model}:${row.effort}${row.retryOf ? " · retry" : ""}`;
      const accessible = `${label}, candidate ${row.assessment?.candidateId}, specification adherence ${number(row.score!)}/100, evidence coverage ${number(row.coverage! * 100)}%, ${row.sampleCount} independent sample, ${costText(cost, unit)} ${cost.status}. Open requirement findings.`;
      const labelY =
        cy < 100
          ? cy + 26 + (position % 3) * 18
          : cy - 18 - (position % 3) * 18;
      return `<g class="point" role="button" tabindex="0" data-point="${index}" aria-label="${escape(accessible)}"><title>${escape(accessible)}</title><line x1="${x(cost.lower!)}" y1="${cy}" x2="${x(cost.upper!)}" y2="${cy}" stroke="${color}" stroke-width="2"/>${row.coverage! < 1 && row.scoreRange ? `<line x1="${cx}" y1="${y(row.scoreRange[0])}" x2="${cx}" y2="${y(row.scoreRange[1])}" stroke="${color}" stroke-dasharray="4 4"/>` : ""}<circle cx="${cx}" cy="${cy}" r="18" fill="transparent"/><circle class="dot" cx="${cx}" cy="${cy}" r="7" fill="${row.coverage === 1 ? color : "#111916"}" stroke="${color}" stroke-width="3"/><text x="${cx}" y="${labelY}" style="fill:${color}" text-anchor="${cx > 600 ? "end" : "start"}">${escape(label)}</text></g>`;
    })
    .join("");
  const missing = selected.filter(
    ({ row }) => !plotted.some((point) => point.row === row),
  );
  return `<div class="chart-view" data-graph="${scope}:${unit}" data-task="${task}"${task === 1 && scope === "full" && unit === "api" ? "" : " hidden"}><div class="plot-scroll" role="region" aria-label="Cost and specification adherence plot" tabindex="0"><svg viewBox="0 0 840 442" role="group" aria-label="Task ${task}: specification adherence against ${unit === "api" ? "API-equivalent dollars" : "Codex Standard credit equivalents"}"><text x="76" y="28" class="axis-title">Specification adherence</text>${grid}${ticks}<text x="416" y="428" text-anchor="middle" class="axis-title">${unit === "api" ? "API-equivalent dollars · estimate" : "Codex Standard credits · token equivalent"}</text>${points}${!plotted.length ? '<text x="416" y="212" text-anchor="middle" class="empty">No points with both a current grade and an available cost</text>' : ""}</svg></div>
    <p class="sub">${plotted.length}/${selected.length} retained rows plotted. Range markers show the cost midpoint with horizontal bounds; partial grades use hollow markers and whole-rubric bounds. Select a point or its evidence row.</p>
    ${missing.length ? `<div class="missing"><strong>Not plotted</strong><ul>${missing.map(({ row, index }) => `<li><a href="#candidate-${index}" data-open-row="${index}">${escape(`${row.model}:${row.effort}`)}</a> · ${escape(row.status)} · ${row.score === null ? "grade unavailable or stale" : "cost unavailable"}</li>`).join("")}</ul></div>` : ""}</div>`;
};

const interactions = String.raw`(() => {
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const selected = () => document.querySelector('[name="cost-scope"]:checked').value + ':' + document.querySelector('[name="cost-unit"]:checked').value;
  const update = () => {
    const view = selected();
    const task = document.querySelector('#task-choice').value;
    all('[data-graph]').forEach((node) => node.hidden = node.dataset.graph !== view || node.dataset.task !== task);
    all('[data-cost-view]').forEach((node) => node.hidden = node.dataset.costView !== view);
    document.querySelector('#cost-basis').textContent = view.startsWith('full:') ? 'Implementation + all recorded judge calls. Full required evaluation cost.' : 'Implementation only. Required judge cost is excluded from this view.';
  };
  const show = (index) => {
    const target = document.querySelector('#point-detail');
    target.replaceChildren(document.querySelector('#detail-' + index).content.cloneNode(true));
    update();
  };
  all('[data-point]').forEach((node) => {
    node.addEventListener('pointerenter', () => show(node.dataset.point));
    node.addEventListener('focus', () => show(node.dataset.point));
    node.addEventListener('click', () => show(node.dataset.point));
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(node.dataset.point); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const points = Array.from(node.closest('svg').querySelectorAll('[data-point]'));
        const next = (points.indexOf(node) + (event.key === 'ArrowRight' ? 1 : -1) + points.length) % points.length;
        points[next].focus();
      }
    });
  });
  all('[data-open-row]').forEach((node) => node.addEventListener('click', () => { document.querySelector('#candidate-' + node.dataset.openRow).open = true; }));
  all('[name="cost-unit"], [name="cost-scope"], #task-choice').forEach((node) => node.addEventListener('change', update));
  all('[data-export]').forEach((node) => node.addEventListener('click', () => {
    const csv = node.dataset.export === 'csv';
    const content = csv ? JSON.parse(document.querySelector('#csv-data').textContent) : JSON.stringify(JSON.parse(document.querySelector('#report-data').textContent), null, 2) + '\n';
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([content], {type:csv ? 'text/csv;charset=utf-8' : 'application/json'}));
    link.href = url; link.download = csv ? 'evaluations.csv' : 'report.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  update();
})();`;

const styles = `
:root{color-scheme:dark;--bg:#0e1311;--panel:#151d19;--line:#304038;--text:#eef6f1;--muted:#b2c1b8;--mint:#8ce8bd;--amber:#f6c778;--blue:#93c3ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,sans-serif}a{color:var(--mint);text-underline-offset:3px}button,input,select{font:inherit}button,select{color:var(--text);background:var(--panel);border:1px solid var(--line);padding:10px 14px;border-radius:5px}button{cursor:pointer}button:hover{border-color:var(--mint)}:focus-visible{outline:3px solid var(--amber);outline-offset:4px}[hidden]{display:none!important}
main{max-width:1480px;margin:auto;padding:38px 40px 70px}.masthead{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:22px}.brand,.eyebrow{font-size:12px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.brand{color:var(--mint)}.exports{display:flex;gap:10px}header{padding:42px 0 26px}h1{font:clamp(34px,4.7vw,62px)/1.06 Georgia,serif;letter-spacing:-.035em;margin:12px 0 20px;max-width:880px}h2{font-size:24px;font-weight:550;margin:8px 0 18px}h3{font-size:20px;margin:0 0 14px}h4{font-size:15px;margin:24px 0 12px}p{margin:10px 0}.intro{max-width:920px;color:var(--muted);font-size:17px}.sub{display:block;color:var(--muted);font-size:13px;margin-top:6px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(7,1fr);border:1px solid var(--line);margin:20px 0 34px}.metric{padding:18px 16px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric b{font-size:29px;font-weight:500;display:block}.metric span{font-size:13px;color:var(--muted)}.section{border-top:1px solid var(--line);padding:30px 0}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.judge-tag{border:1px solid var(--line);padding:10px 14px;font-size:13px;color:var(--muted);max-width:380px}.controls{display:flex;flex-wrap:wrap;gap:18px 32px;align-items:center;margin:18px 0 12px}fieldset{border:0;padding:0;margin:0}legend{font-size:12px;color:var(--muted);margin-bottom:8px}fieldset label{display:inline-flex;align-items:center;gap:6px;margin:0 16px 6px 0;min-height:32px}input{accent-color:var(--mint);width:16px;height:16px}label.task-label{font-size:12px;color:var(--muted)}select{display:block;max-width:100%;margin-top:6px}.chart-layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(300px,1fr);border:1px solid var(--line);margin-top:18px}.charts{min-width:0;padding:20px}.plot-scroll{overflow-x:auto}svg{display:block;width:100%;min-width:720px}svg text{font:14px ui-monospace,monospace;fill:var(--muted)}svg .axis-title{font:15px system-ui,sans-serif;fill:var(--text)}svg .grid{stroke:#304038;stroke-width:1}svg .point{cursor:pointer;outline:none}svg .point text{font:14px system-ui,sans-serif;fill:inherit}svg .point:focus-visible .dot,svg .point:hover .dot{stroke:var(--amber);stroke-width:5}svg .empty{font:14px system-ui,sans-serif}.detail-panel{padding:24px;border-left:1px solid var(--line);background:var(--panel);max-height:710px;overflow:auto}.facts{margin:12px 0;display:grid;grid-template-columns:1fr 1fr;gap:14px 20px}.facts dt{font-size:12px;color:var(--muted);margin-bottom:4px}.facts dd{margin:0;overflow-wrap:anywhere}.detail-panel .facts{grid-template-columns:1fr}.requirements{padding-left:22px}.requirements>li{margin:16px 0}.requirements p{font-size:14px}.requirements ul{padding-left:16px}.requirements li{overflow-wrap:anywhere}.warning{color:var(--amber)}.missing{font-size:13px;border-left:2px solid var(--amber);padding:10px 14px;margin-top:18px;background:var(--panel)}.missing ul{padding-left:20px}.comparison{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}.comparison>p{margin:0;border:1px solid var(--line);padding:12px 16px;font-size:14px}.table-scroll{overflow:auto;border:1px solid var(--line)}table{border-collapse:collapse;width:100%;min-width:780px;font-size:14px}th,td{padding:16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{font-weight:550;color:var(--muted);font-size:12px}tbody th{color:var(--text);font-size:14px}tbody tr:last-child>*{border-bottom:0}.bar{height:3px;background:var(--mint);display:block;margin-top:9px;min-width:1px;max-width:100%}.audit{border:1px solid var(--line);padding:0 20px;margin:12px 0}.audit summary{padding:18px 0;cursor:pointer;overflow-wrap:anywhere}.audit>div{padding-bottom:22px}.audit .facts{grid-template-columns:repeat(3,1fr)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;padding:16px;border:1px solid var(--line);font-size:12px}.cost-totals{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.cost-totals>div{border:1px solid var(--line);padding:18px}.cost-totals b{font-size:21px;font-weight:500;display:block}.footer{border-top:1px solid var(--line);padding-top:24px;color:var(--muted)}.skip{position:absolute;top:-100px;left:20px}.skip:focus{top:10px;background:var(--panel);padding:12px;z-index:2}
@media(max-width:1000px){.chart-layout{grid-template-columns:1fr}.detail-panel{border-left:0;border-top:1px solid var(--line);max-height:none}.detail-panel .facts{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(4,1fr)}.metric{border-bottom:1px solid var(--line)}.audit .facts{grid-template-columns:1fr 1fr}}
@media(max-width:600px){main{padding:22px 18px 40px}.masthead,.section-heading{flex-direction:column;align-items:flex-start}.exports{width:100%}.exports button{flex:1}.metrics{grid-template-columns:repeat(2,1fr)}.metric{padding:14px}.metric b{font-size:25px}.charts,.detail-panel{padding:16px}.facts,.detail-panel .facts,.audit .facts{grid-template-columns:1fr}.cost-totals{grid-template-columns:1fr}.judge-tag{max-width:100%}.controls{gap:12px}h1{font-size:39px}.audit{padding:0 14px}}
`;

export const implementationReportHtml = (
  report: ImplementationBenchmarkReport,
  jsonText: string,
  csvText: string,
) => {
  const maxTime = Math.max(
    1,
    ...report.rows.flatMap((row) => [
      row.implementationMs ?? 0,
      row.judgeMs ?? 0,
      row.endToEndMs ?? 0,
    ]),
  );
  const studyCosts = [
    {
      name: "Implementation",
      cost: report.costs.totals.implementation,
      known: report.costs.totals.implementation.knownRecorded,
    },
    {
      name: "Judge",
      cost: report.costs.totals.judge,
      known: report.costs.totals.judge.knownRecorded,
    },
    {
      name: "Full required evaluation",
      cost: report.costs.totals.full,
      known: null,
    },
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandcastle · Specification adherence and cost</title><style>${styles}</style></head><body><a class="skip" href="#evidence">Skip to candidate evidence</a><main>
  <div class="masthead"><div class="brand">Sandcastle / Benchmark report</div><div class="exports"><button type="button" data-export="json">Download JSON</button><button type="button" data-export="csv">Download CSV</button></div></div>
  <header><div class="eyebrow">Retained evidence · ${escape(report.status)}</div><h1>Specification adherence<br>and the cost to deliver it.</h1><p class="intro">Each point represents an implementation candidate assessed against a frozen task and rubric. Judge scores, configured checks, and project acceptance remain separate.</p><p class="sub">${report.evaluated} current complete assessments. ${report.counts.attempts} attempts, including ${report.counts.retries} linked retries. One attempt is not a general model ranking.</p></header>
  <div class="metrics">${(["planned", "attempted", "completed", "graded", "blocked", "incomplete", "unrun"] as const).map((key) => `<div class="metric"><span>${key[0]!.toUpperCase() + key.slice(1)}</span><b>${report.counts[key]}<span> / ${report.counts.planned}</span></b></div>`).join("")}</div>
  <p class="sub">Counts refer to original scheduled slots. Completed means implementation returned an exit code, including failures. Graded means a current complete original assessment. Blocked outcomes are also incomplete; categories can overlap. Retries do not increase independent samples.</p>
  <section class="section"><div class="section-heading"><div><div class="eyebrow">Candidate comparison</div><h2>Cost versus specification adherence</h2></div><div class="judge-tag">Evaluation judge<br><strong>${escape(`${report.judge!.model}:${report.judge!.effort}`)}</strong><span class="sub">Evaluation metadata, separate from implementation arms</span></div></div>
  <div class="controls"><fieldset><legend>Cost unit</legend><label><input type="radio" name="cost-unit" value="api" checked>API-equivalent dollars</label><label><input type="radio" name="cost-unit" value="codexStandard">Codex Standard credits</label></fieldset><fieldset><legend>Cost scope</legend><label><input type="radio" name="cost-scope" value="full" checked>Implementation + judge</label><label><input type="radio" name="cost-scope" value="implementation">Implementation only</label></fieldset><label class="task-label" for="task-choice">Frozen task<select id="task-choice">${report.plan.tickets.map((task, index) => `<option value="${index + 1}">${index + 1}. ${escape(task.title)}</option>`).join("")}</select></label></div>
  <p class="sub" id="cost-basis">Implementation + all recorded judge calls. Full required evaluation cost.</p>
  <div class="chart-layout"><div class="charts">${report.plan.tickets.flatMap((_task, index) => scopes.flatMap((scope) => units.map((unit) => chart(report, index + 1, scope, unit)))).join("")}</div><aside class="detail-panel" aria-label="Selected candidate details"><div class="eyebrow">Point details</div><div id="point-detail" aria-live="polite"><h3>Inspect a candidate</h3><p>Hover, click, or focus a point to read its findings. Use left and right arrow keys between points. Every candidate is also available in the evidence section below.</p><p class="sub">Missing grades and costs have no invented numeric points. Partial assessments retain their coverage and uncertainty.</p></div></aside></div>
  <div class="comparison">${report.comparison.map((comparison) => `<p><strong>Task ${comparison.ticket}: ${escape(comparison.status)}</strong><span class="sub">${escape(comparison.reason ?? comparison.winners.join(", "))}</span></p>`).join("")}</div></section>
  <section class="section"><div class="eyebrow">Recorded spending</div><h2>Study totals, including failed and interrupted work</h2><div class="cost-totals">${studyCosts.map(({ name, cost, known }) => `<div><span>${name}</span><b>${escape(costText(cost.api, "api"))}</b><span class="sub">${escape(costText(cost.codexStandard, "codexStandard"))}</span>${known && cost.api.status === "unavailable" ? `<p class="sub">Known recorded portion: ${escape(costText(known.api, "api"))}. Unknown remainder prevents a total.</p>` : ""}</div>`).join("")}</div><p class="sub">Frozen rate source: ${escape(report.costs.rateCard?.source ?? "Unavailable")} · date ${escape(report.costs.rateCard?.date ?? "Unknown")}. API dollars and token-derived credits are estimates, not subscription consumption or an actual bill. Other review/grading and observer usage are not recorded here and remain separate unknowns.</p></section>
  <section class="section"><div class="eyebrow">Checks and duration</div><h2>What finished, and how long it took</h2><p class="sub">${escape(report.durationBasis)}</p><div class="table-scroll" role="region" aria-label="Configured checks and duration table" tabindex="0"><table><thead><tr><th scope="col">Implementation arm / task</th><th scope="col">Configured check</th><th scope="col">Specification adherence</th><th scope="col">Implementation</th><th scope="col">Judge</th><th scope="col">End-to-end</th><th scope="col">Selected cost</th></tr></thead><tbody>${report.rows.map((row, index) => `<tr><th scope="row"><a href="#candidate-${index}" data-open-row="${index}">${escape(`${row.model}:${row.effort}`)}</a><span class="sub">Task ${row.task} · ${escape(row.status)}${row.retryOf ? " · retry" : ""}</span></th><td>${escape(row.check)}${row.check === "failed" ? '<span class="sub warning">Mandatory failure</span>' : ""}</td><td>${row.score === null ? "Unavailable" : `${number(row.score)}/100`}<span class="sub">${row.coverage === null ? "Coverage unknown" : `${number(row.coverage * 100)}% coverage`}</span></td>${[row.implementationMs, row.judgeMs, row.endToEndMs].map((time) => `<td>${ms(time)}${time === null ? "" : `<span class="bar" style="width:${Math.min(100, Math.max(0, (time / maxTime) * 100))}%"></span>`}</td>`).join("")}<td>${views(row)}</td></tr>`).join("")}</tbody></table></div><p class="sub">Project acceptance is not assessed. A positive judge score cannot override mandatory failures, required project reviews, or human acceptance.</p></section>
  <section class="section" id="evidence"><div class="eyebrow">Candidate evidence</div><h2>Findings behind every result</h2>${report.rows.map((row, index) => `<template id="detail-${index}">${rowDetails(row)}</template><details class="audit" id="candidate-${index}"><summary>${escape(`${row.model}:${row.effort}`)} · task ${row.task} · ${escape(row.status)} · ${row.score === null ? "grade unavailable" : `${number(row.score)}/100`}</summary><div>${rowDetails(row)}<h4>Retained record</h4><pre>${escape(JSON.stringify(row, null, 2))}</pre></div></details>`).join("")}</section>
  <section class="section"><div class="eyebrow">Reproducibility</div><h2>Frozen inputs and export identities</h2><dl class="facts">${Object.entries(
    {
      "Manifest SHA-256": report.identities.manifestSha256,
      "Ledger SHA-256": report.identities.ledgerSha256,
      Plan: report.identities.planId,
      "Grader protocol": report.identities.grader,
      Generator: `${report.identities.generator.version} / ${report.identities.generator.sha256}`,
      "Rate card SHA-256": report.costs.rateCardSha256,
    },
  )
    .map(
      ([name, value]) =>
        `<div><dt>${name}</dt><dd class="mono">${escape(value)}</dd></div>`,
    )
    .join(
      "",
    )}</dl><details><summary>Usage provenance and calculation inputs</summary><pre>${escape(JSON.stringify(report.costs, null, 2))}</pre></details><p class="sub">Regenerated locally from retained evidence. No model calls, external fonts, services, or adjacent JSON fetches. Assessment applicability is verified through the existing code/check/visual evidence contract. Historical pilot results retain their own identities.</p></section>
  <footer class="footer"><span class="mono">Run ${escape(report.identities.runId)}</span><noscript><p>Interactive controls and embedded downloads require JavaScript. Candidate findings and the default chart remain readable. The generated report.json and evaluations.csv contain the same evidence.</p></noscript></footer>
  </main><script type="application/json" id="report-data">${embedded(jsonText)}</script><script type="application/json" id="csv-data">${embedded(JSON.stringify(csvText))}</script><script>${interactions}</script></body></html>`;
};
