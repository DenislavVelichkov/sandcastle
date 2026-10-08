import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmarkInspection,
  benchmarkReportGuide,
  inspectionSourceUrl,
  judgeScoreBasis,
} from "./benchmarkInspection.js";
import {
  assertBenchmarkReportDestination,
  destinationSourceUrl,
} from "./benchmarkReportDestination.js";
import {
  compareBenchmarkCandidates,
  judgeProtocolId,
  readBenchmarkAssessments,
} from "./benchmarkJudge.js";
import {
  reportCallCost,
  sumReportCosts,
  reportCostsSourceUrl,
} from "./benchmarkReportCosts.js";
import {
  implementationReportHtml,
  reportHtmlSourceUrl,
} from "./implementationBenchmarkReportHtml.js";

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const csvCell = (value: unknown) => {
  const text =
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value ?? "");
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** Passive regeneration uses the established assessor, never a worker or runtime. */
const readReport = async (input: {
  directory: string;
  outputDirectory: string;
}) => {
  if (!isAbsolute(input.directory) || !input.outputDirectory)
    throw new Error(
      "Report requires an absolute evidence directory and an output directory",
    );
  const manifestPath = join(input.directory, "manifest.json");
  const executionPath = join(input.directory, "execution.json");
  const manifestBytes = await readFile(manifestPath);
  const ledgerBytes = await readFile(executionPath);
  const { plan, execution, assessments } = await readBenchmarkAssessments(
    input.directory,
  );
  if (execution.version !== 2)
    throw new Error("Report requires a version-two implementation ledger");
  const emptyCost = () => ({
    api: sumReportCosts([]),
    codexStandard: sumReportCosts([]),
  });
  type CostPair = ReturnType<typeof emptyCost>;
  type CallCost = Awaited<ReturnType<typeof reportCallCost>>;
  const calls: (CallCost & {
    attemptId: string;
    assessmentId: string | null;
  })[] = [];
  const costsByAttempt = new Map<
    string,
    { implementation: CallCost | CostPair; judge: CostPair; full: CostPair }
  >();
  for (const attempt of execution.attempts) {
    const slot = plan.slots.find((item) => item.id === attempt.slotId);
    if (!slot) throw new Error("Execution contains an unknown benchmark slot");
    const implementation = attempt.implementation
      ? await reportCallCost({
          role: "implementation",
          model: plan.arms[slot.arm]!.model,
          observed: attempt.implementation.observed,
          usage: attempt.implementation.usage,
          stream: join(
            plan.output,
            `${attempt.retryOf ? attempt.id : attempt.slotId}-implementation.jsonl`,
          ),
          streamSha256: attempt.implementation.streamSha256,
          rateCard: plan.launch!.rateCard,
        })
      : null;
    if (implementation)
      calls.push({
        attemptId: attempt.id,
        assessmentId: null,
        ...implementation,
      });
    const judges = [];
    for (const assessment of attempt.judge.assessments ?? []) {
      const cost = await reportCallCost({
        role: "judge",
        model: assessment.judge.model,
        observed: assessment.judge.observed,
        usage: assessment.usage,
        stream: assessment.provenance.stream,
        streamSha256: assessment.provenance.streamSha256,
        rateCard: plan.launch!.rateCard,
      });
      judges.push(cost);
      calls.push({
        attemptId: attempt.id,
        assessmentId: assessment.id,
        ...cost,
      });
    }
    const judge = {
      api: sumReportCosts(judges.map((item) => item.api)),
      codexStandard: sumReportCosts(judges.map((item) => item.codexStandard)),
    };
    const worker = implementation ?? emptyCost();
    costsByAttempt.set(attempt.id, {
      implementation: worker,
      judge,
      full: {
        api: sumReportCosts([worker.api, judge.api]),
        codexStandard: sumReportCosts([
          worker.codexStandard,
          judge.codexStandard,
        ]),
      },
    });
  }
  const totals = (role: "implementation" | "judge") => {
    const selected = calls.filter((call) => call.role === role);
    const missing = Math.max(
      0,
      execution.budget[
        role === "implementation" ? "implementationCalls" : "judgeCalls"
      ] - selected.length,
    );
    return {
      calls: selected.length,
      missingCalls: missing,
      knownRecorded: {
        api: sumReportCosts(
          selected
            .filter((call) => call.api.lower !== null)
            .map((call) => call.api),
        ),
        codexStandard: sumReportCosts(
          selected
            .filter((call) => call.codexStandard.lower !== null)
            .map((call) => call.codexStandard),
        ),
      },
      api: sumReportCosts([
        ...selected.map((call) => call.api),
        ...(missing ? [sumReportCosts([])] : []),
      ]),
      codexStandard: sumReportCosts([
        ...selected.map((call) => call.codexStandard),
        ...(missing ? [sumReportCosts([])] : []),
      ]),
    };
  };
  const implementationTotal = totals("implementation");
  const judgeTotal = totals("judge");
  const rows = await Promise.all(
    plan.slots.flatMap((slot) => {
      const arm = plan.arms[slot.arm]!;
      const attempts = execution.attempts.filter(
        (attempt) => attempt.slotId === slot.id,
      );
      return (attempts.length ? attempts : [null]).map(async (attempt) => {
        const current = assessments.find(
          (item) =>
            item.attemptId === attempt?.id &&
            item.assessment.id === attempt?.judge.assessments?.at(-1)?.id,
        );
        const assessment = current?.assessment ?? null;
        const inspection = await benchmarkInspection(
          plan,
          slot.ticket + 1,
          attempt,
          current,
        );
        return {
          slotId: slot.id,
          attemptId: attempt?.id ?? null,
          retryOf: attempt?.retryOf ?? null,
          model: arm.model,
          effort: arm.effort,
          task: slot.ticket + 1,
          title: plan.tickets[slot.ticket]!.title,
          taskSha256: plan.tickets[slot.ticket]!.sha256,
          status: attempt?.status ?? "unrun",
          sampleCount: attempt && !attempt.retryOf ? 1 : 0,
          candidate: attempt?.candidate ?? null,
          candidateId: inspection.candidateId,
          judgeChecklistStatus: inspection.checklist.summary,
          inspection,
          rubricSha256: plan.launch!.grading.rubricSha256,
          assessmentId: assessment?.id ?? null,
          assessmentStatus:
            assessment?.status ?? attempt?.judge.status ?? "unrun",
          applicable: current?.applicable ?? false,
          applicabilityReason: current?.reason ?? null,
          score: current?.applicable ? assessment!.score.value : null,
          coverage: current?.applicable ? assessment!.score.coverage : null,
          scoreRange: current?.applicable ? assessment!.score.range : null,
          check: attempt?.check?.status ?? "not-run",
          mandatoryChecks:
            assessment?.mandatoryChecks ?? attempt?.check?.status ?? "not-run",
          projectAcceptance: "not_assessed" as const,
          reason: attempt?.reason ?? assessment?.failure ?? null,
          assessment,
          phases: attempt?.phases ?? [],
          implementationMs:
            attempt?.phases.find((phase) => phase.name === "implementation")
              ?.elapsedMs ?? null,
          judgeMs:
            attempt?.phases
              .filter((phase) => phase.name.startsWith("judge-"))
              .reduce((sum, phase) => sum + phase.elapsedMs, 0) ?? null,
          endToEndMs: attempt?.settledAt
            ? Math.max(
                0,
                Date.parse(attempt.settledAt) - Date.parse(attempt.startedAt),
              )
            : null,
          measuredPhaseMs: attempt
            ? attempt.phases.reduce((sum, phase) => sum + phase.elapsedMs, 0)
            : null,
          costs: attempt
            ? costsByAttempt.get(attempt.id)!
            : {
                implementation: emptyCost(),
                judge: emptyCost(),
                full: emptyCost(),
              },
        };
      });
    }),
  );
  const originals = rows.filter((row) => !row.retryOf);
  const evaluated = originals.filter(
    (row) => row.applicable && row.assessmentStatus === "complete",
  ).length;
  const counts = {
    planned: plan.slots.length,
    attempted: new Set(execution.attempts.map((attempt) => attempt.slotId))
      .size,
    completed: new Set(
      execution.attempts
        .filter(
          (attempt) =>
            !attempt.retryOf && attempt.implementation?.exitCode != null,
        )
        .map((attempt) => attempt.slotId),
    ).size,
    graded: evaluated,
    blocked: originals.filter((row) =>
      /blocked|unavailable|missing-checks/.test(row.status),
    ).length,
    incomplete: originals.filter(
      (row) =>
        row.status !== "unrun" &&
        (!row.applicable || row.assessmentStatus !== "complete"),
    ).length,
    unrun: rows.filter((row) => row.status === "unrun").length,
    attempts: execution.attempts.length,
    retries: execution.attempts.filter((attempt) => attempt.retryOf).length,
  };
  const report = {
    version: 1,
    inspectionGuide: benchmarkReportGuide,
    scoreBasis: judgeScoreBasis,
    evidenceDirectory: plan.output,
    status: execution.status,
    evaluated,
    judge: plan.judge,
    projectAcceptance: "not assessed",
    scheduled: plan.slots.length,
    attempted: counts.attempted,
    unrun: execution.unrun,
    controls: execution.controls,
    budget: execution.budget,
    cleanup: execution.cleanup,
    attempts: execution.attempts,
    comparison: compareBenchmarkCandidates(plan, assessments),
    assessmentApplicability: assessments.map((item) => ({
      id: item.assessment.id,
      applicable: item.applicable,
      reason: item.reason,
    })),
    counts,
    rows,
    plan,
    durationBasis:
      "End-to-end is elapsed time from attempt start through recorded settlement after judging and owned cleanup. Older ledgers without a settlement timestamp remain unknown; measured phase totals are retained separately. Waiting duration is not separately measured.",
    costs: {
      calculationVersion: "normalized-codex-standard-and-api-ranges-v1",
      rateCard: plan.launch!.rateCard,
      rateCardSha256: plan.launch!.rateCard
        ? hash(JSON.stringify(plan.launch!.rateCard))
        : null,
      calls,
      totals: {
        implementation: implementationTotal,
        judge: judgeTotal,
        full: {
          api: sumReportCosts([implementationTotal.api, judgeTotal.api]),
          codexStandard: sumReportCosts([
            implementationTotal.codexStandard,
            judgeTotal.codexStandard,
          ]),
        },
      },
      otherReviewGrading: {
        status: "not-recorded",
        reason:
          "Other model review/grading usage is not recorded in this execution ledger",
      },
      observer: {
        status: "not-recorded",
        reason:
          "Observer usage is outside this execution ledger and remains unknown",
      },
    },
    identities: {
      manifestSha256: hash(manifestBytes),
      ledgerSha256: hash(ledgerBytes),
      planId: plan.id,
      runId: execution.runId,
      grader: judgeProtocolId(plan),
      assessments: execution.attempts.flatMap(
        (attempt) => attempt.judge.records ?? [],
      ),
      generator: {
        version: "implementation-report-v2-inspection",
        sha256: hash(
          Buffer.concat(
            await Promise.all(
              [
                import.meta.url,
                reportCostsSourceUrl,
                reportHtmlSourceUrl,
                inspectionSourceUrl,
                destinationSourceUrl,
              ].map((url) => readFile(fileURLToPath(url))),
            ),
          ),
        ),
      },
    },
  };
  if (
    !manifestBytes.equals(await readFile(manifestPath)) ||
    !ledgerBytes.equals(await readFile(executionPath))
  )
    throw new Error(
      "Retained report inputs changed during regeneration; retry after the controller settles",
    );
  return report;
};

export type ImplementationBenchmarkReport = Awaited<
  ReturnType<typeof readReport>
>;

export const writeImplementationBenchmarkReport = async (input: {
  directory: string;
  outputDirectory: string;
}) => {
  const report = await readReport(input);
  await assertBenchmarkReportDestination(
    input.directory,
    input.outputDirectory,
    report.attempts,
  );
  const rows = report.rows;
  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const bindings = {
    manifestSha256: report.identities.manifestSha256,
    ledgerSha256: report.identities.ledgerSha256,
    planId: report.identities.planId,
    runId: report.identities.runId,
    graderProtocol: report.identities.grader,
    generatorVersion: report.identities.generator.version,
    generatorSha256: report.identities.generator.sha256,
  };
  const csvRows = rows.map((row) => ({ ...row, ...bindings }));
  const fields = Object.keys(csvRows[0] ?? { slotId: null, ...bindings });
  const csvText =
    [
      fields.map(csvCell).join(","),
      ...csvRows.map((row) =>
        fields
          .map((field) => csvCell(row[field as keyof typeof row]))
          .join(","),
      ),
    ].join("\n") + "\n";
  const htmlText = implementationReportHtml(report, jsonText, csvText);
  const output = resolve(input.outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const write = async (name: string, bytes: string) => {
    const path = join(output, name);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return path;
  };
  return {
    json: await write("report.json", jsonText),
    csv: await write("evaluations.csv", csvText),
    html: await write("report.html", htmlText),
  };
};
