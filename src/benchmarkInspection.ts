import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { verifyBenchmarkCandidate } from "./benchmarkCandidate.js";
import type { readBenchmarkAssessments } from "./benchmarkJudge.js";
import type { ImplementationAttempt } from "./implementationBenchmark.js";
import type { TicketBenchmarkPlan } from "./ticketBenchmark.js";

export const inspectionSourceUrl = import.meta.url;
export const benchmarkReportGuide =
  "https://github.com/DenislavVelichkov/sandcastle/blob/dv8/main/docs/benchmark-reports.md";
export const judgeScoreBasis =
  "Judge specification adherence = 100 × earned weight / assessed applicable weight. Met earns full weight; partial earns the frozen partial-credit fraction; not met earns zero. Pending requirements stay in coverage and whole-rubric bounds. This is not a percentage of inspection boxes passed.";
type VerifiedAssessment = Awaited<
  ReturnType<typeof readBenchmarkAssessments>
>["assessments"][number];
type ArtifactState = "available" | "missing" | "changed" | "not-recorded";
export interface InspectionArtifact {
  id: string;
  label: string;
  path: string | null;
  state: ArtifactState;
  reason: string | null;
  sha256: string | null;
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Report-only verification. Never writes evidence or starts a runtime. */
const artifact = async (
  id: string,
  label: string,
  path: string | undefined,
  expectedHash?: string,
  bindingValid = true,
): Promise<InspectionArtifact> => {
  const result: InspectionArtifact = {
    id,
    label,
    path: path ?? null,
    sha256: expectedHash ?? null,
    state: "not-recorded",
    reason: "No retained artifact recorded",
  };
  if (!path) return result;
  if (!bindingValid)
    return {
      ...result,
      state: "changed",
      reason: "Artifact binding differs from this candidate",
    };
  try {
    const info = await lstat(path);
    if (id === "worktree" ? !info.isDirectory() : !info.isFile())
      return {
        ...result,
        state: "changed",
        reason: "Expected retained artifact type changed",
      };
    if (
      id !== "worktree" &&
      (!expectedHash || sha256(await readFile(path)) !== expectedHash)
    )
      return {
        ...result,
        state: "changed",
        reason: "Retained bytes do not match their recorded hash",
      };
    return { ...result, state: "available", reason: null };
  } catch (error) {
    return {
      ...result,
      state: "missing",
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "Retained artifact is missing"
          : "Retained artifact cannot be read",
    };
  }
};

export const benchmarkInspection = async (
  plan: TicketBenchmarkPlan,
  task: number,
  attempt: ImplementationAttempt | null,
  current: VerifiedAssessment | undefined,
) => {
  const grading = plan.launch!.grading;
  const visualRequired = grading.visualRequiredByTask[task - 1]!;
  const assessment = current?.assessment;
  const applicable = current?.applicable ?? false;
  const criteria = grading.rubric
    .filter((rule) => rule.task === undefined || rule.task === task)
    .map((rule) => {
      const applies =
        rule.applicability === "always" ||
        (rule.applicability === "visual" ? visualRequired : !visualRequired);
      const finding = assessment?.requirements.find(
        (item) => item.id === rule.id,
      );
      return {
        ...rule,
        applies,
        verdict: !applies
          ? "not_applicable"
          : applicable
            ? (finding?.verdict ?? "not_assessed")
            : "not_assessed",
        historicalVerdict: !applicable ? (finding?.verdict ?? null) : null,
        gaps: applies
          ? applicable && finding
            ? finding.gaps
            : rule.evidence
          : [],
      };
    });
  const counts = {
    total: criteria.length,
    applicable: criteria.filter((rule) => rule.applies).length,
    met: criteria.filter((rule) => rule.verdict === "met").length,
    partial: criteria.filter((rule) => rule.verdict === "partial").length,
    notMet: criteria.filter((rule) => rule.verdict === "not_met").length,
    pending: criteria.filter((rule) => rule.verdict === "not_assessed").length,
    notApplicable: criteria.filter((rule) => !rule.applies).length,
  };
  const state = !assessment
    ? "no-assessment"
    : !applicable
      ? "stale"
      : !counts.applicable
        ? "no-applicable-requirements"
        : counts.pending
          ? "pending"
          : counts.partial || counts.notMet
            ? "deviations"
            : "all-met";
  const summary =
    state === "stale"
      ? "Judge checklist stale; original findings retained"
      : state === "no-assessment"
        ? "Judge checklist unavailable; no assessment"
        : state === "no-applicable-requirements"
          ? "No applicable judge requirements"
          : state === "all-met"
            ? `All ${counts.applicable} applicable judge requirements met`
            : `${counts.met}/${counts.applicable} judge requirements met; ${counts.partial} partial, ${counts.notMet} not met, ${counts.pending} pending`;
  const candidate = attempt?.candidate;
  const evidenceId = attempt?.retryOf ? attempt.id : attempt?.slotId;
  const ordinaryRoot = evidenceId
    ? join(plan.output, "candidates", evidenceId)
    : null;
  const recordedRoot = candidate ? dirname(candidate.worktree) : null;
  // Interrupted-source recovery seals a new retained root without retrying the
  // implementation. Use its exact ledger path rather than inventing a slot path.
  const recovered =
    !!attempt &&
    !!recordedRoot &&
    dirname(recordedRoot) === join(plan.output, "candidates") &&
    basename(recordedRoot).startsWith(`${attempt.id}-recovered-`);
  const root = recovered ? recordedRoot : ordinaryRoot;
  let worktree = await artifact(
    "worktree",
    "Generated source worktree",
    candidate?.worktree,
    undefined,
    !candidate || candidate.worktree === join(root!, "worktree"),
  );
  if (candidate && worktree.state === "available" && !applicable) {
    try {
      await verifyBenchmarkCandidate(
        candidate,
        AbortSignal.timeout(plan.launch!.allowances.sealMs),
      );
    } catch {
      worktree = {
        ...worktree,
        state: "changed",
        reason: "Candidate source no longer matches its sealed identity",
      };
    }
  }
  const check = attempt?.check;
  const boundCheck =
    !!candidate &&
    check?.candidateHead === candidate.head &&
    check.candidateTree === candidate.tree &&
    check.frozenInputsSha256 ===
      createHash("sha256")
        .update(JSON.stringify(plan.launch!.checking))
        .digest("hex");
  const record = attempt?.judge.records?.find(
    (item) => item.id === assessment?.id,
  );
  const artifacts = [
    worktree,
    await artifact(
      "patch",
      "Candidate patch",
      candidate?.patch,
      candidate?.patchSha256,
      !candidate || candidate.patch === join(root!, "candidate.patch"),
    ),
    await artifact(
      "check",
      "Configured check log",
      check?.outputSha256 && evidenceId
        ? join(plan.output, `${evidenceId}-check.log`)
        : undefined,
      check?.outputSha256,
      boundCheck,
    ),
    await artifact(
      "assessment",
      "Sealed judge assessment",
      record?.path,
      record?.sha256,
      !record ||
        record.path ===
          join(plan.output, "assessments", `${assessment!.id}.json`),
    ),
    await artifact(
      "runtime-receipt",
      "Runtime evidence receipt",
      attempt?.project?.receipt?.path,
      attempt?.project?.receipt?.sha256,
    ),
    ...(visualRequired && !attempt?.project?.evidence.length
      ? [
          await artifact(
            "visual:missing",
            "Required runtime captures",
            undefined,
          ),
        ]
      : []),
    ...(await Promise.all(
      (attempt?.project?.evidence ?? []).map((file) =>
        artifact(
          `visual:${file.id}`,
          `Runtime evidence: ${file.id}`,
          file.path,
          file.sha256,
          !!candidate &&
            file.candidateHead === candidate.head &&
            file.candidateTree === candidate.tree &&
            file.sourceSha256 === candidate.sourceSha256 &&
            file.runtime?.adapter === plan.launch!.adapter.sha256 &&
            file.runtime.build === attempt?.project?.identity?.build &&
            file.runtime.profile === attempt?.project?.identity?.profile,
        ),
      ),
    )),
  ];
  const ids = (kind?: "code" | "check" | "visual") =>
    criteria
      .filter((rule) => !kind || (rule.applies && rule.evidence.includes(kind)))
      .map((rule) => rule.id);
  const steps = [
    {
      id: "criteria",
      title: "Read the frozen task and rubric",
      action: `Read task ${task}, "${plan.tickets[task - 1]!.title}", and every full requirement below. Confirm scope, weights, partial credit and evidence requirements before comparing arms.`,
      criterionIds: ids(),
      artifactIds: [],
    },
    {
      id: "code",
      title: "Inspect the generated source and patch",
      action:
        "Open this exact candidate's worktree and patch. Inspect the cited files and line ranges against the linked code requirements, including surrounding behavior.",
      criterionIds: ids("code"),
      artifactIds: ["worktree", "patch"],
    },
    {
      id: "checks",
      title: "Inspect the required check output",
      action: `Read the retained log for the frozen check: ${plan.check ?? "No configured check"}. Inspect failures and confirm the linked check requirements; a judge score cannot override a required failure.`,
      criterionIds: ids("check"),
      artifactIds: ["check"],
    },
    {
      id: "runtime",
      title: "Inspect applicable runtime evidence",
      action: visualRequired
        ? "Inspect the retained captures, receipt and frozen references against the linked visual requirements. Missing required evidence remains pending; regeneration does not restart the application."
        : "This frozen task does not require visual evidence. Inspect any supplied captures as context; do not create a visual requirement or waive other requirements.",
      criterionIds: ids("visual"),
      artifactIds: artifacts
        .filter(
          (item) =>
            item.id.startsWith("visual:") || item.id === "runtime-receipt",
        )
        .map((item) => item.id),
    },
    {
      id: "findings",
      title: "Review unresolved findings and limits",
      action:
        "Read partial, unmet and pending findings, evidence gaps and score coverage. Compare only this frozen task; inspect retries separately. Make any human or project acceptance decision through the project's own gates.",
      criterionIds: ids(),
      artifactIds: ["assessment"],
    },
  ];
  return {
    version: 1,
    humanReview: "not-recorded" as const,
    candidateId: assessment?.candidateId ?? null,
    visualRequired,
    checklist: {
      state,
      counts,
      summary: `${summary}; recorded required checks ${check?.status ?? "not-run"}; check log ${artifacts.find((item) => item.id === "check")!.state}`,
    },
    criteria,
    steps,
    artifacts,
  };
};
