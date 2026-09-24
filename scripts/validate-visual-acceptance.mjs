#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const states = [
  "planned",
  "design_selected",
  "implemented",
  "compared",
  "approval_requested",
  "member_accepted",
  "baseline_promoted",
];
const shaPattern = /^sha256:[a-f0-9]{64}$/u;
const isIsoTimestamp = (value) => {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return (
    !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === value
  );
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const candidateSetSha256 = (candidates) =>
  sha256(
    [...candidates]
      .map(
        ({ locale, scenario, sha256: digest, viewport }) =>
          `${locale}\0${viewport}\0${scenario}\0${digest}`,
      )
      .sort()
      .join("\n"),
  );

const evidenceKey = ({ locale, scenario, viewport }) =>
  `${locale}|${viewport}|${scenario}`;

const resolveRepositoryFile = (root, filePath, label, errors) => {
  if (typeof filePath !== "string" || filePath.length === 0) {
    errors.push(`${label}.path must be a non-empty repository-relative path`);
    return null;
  }
  if (isAbsolute(filePath)) {
    errors.push(`${label}.path must be repository-relative`);
    return null;
  }
  const absolute = resolve(root, filePath);
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    errors.push(`${label}.path escapes the repository root`);
    return null;
  }
  return absolute;
};

const validateFile = (root, file, label, errors) => {
  if (!isRecord(file)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const absolute = resolveRepositoryFile(root, file.path, label, errors);
  if (!shaPattern.test(file.sha256 ?? "")) {
    errors.push(`${label}.sha256 must be a lowercase sha256 digest`);
  }
  if (!absolute) return;
  if (!existsSync(absolute)) {
    errors.push(`${label}.path does not exist: ${file.path}`);
    return;
  }
  const actual = sha256(readFileSync(absolute));
  if (file.sha256 !== actual) {
    errors.push(`${label}.sha256 is ${file.sha256}; file is ${actual}`);
  }
};

const validateEvidence = (root, evidence, label, errors) => {
  validateFile(root, evidence, label, errors);
  if (!isRecord(evidence)) return;
  if (typeof evidence.locale !== "string" || evidence.locale.length === 0)
    errors.push(`${label}.locale must be non-empty`);
  if (!/^[1-9][0-9]*x[1-9][0-9]*$/u.test(evidence.viewport ?? ""))
    errors.push(`${label}.viewport must use WIDTHxHEIGHT`);
  if (typeof evidence.scenario !== "string" || evidence.scenario.length === 0)
    errors.push(`${label}.scenario must be non-empty`);
};

const validateEvidenceSet = (root, evidence, label, errors) => {
  if (!Array.isArray(evidence)) {
    errors.push(`${label} must be an array`);
    return new Map();
  }
  const keyed = new Map();
  evidence.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    validateEvidence(root, entry, entryLabel, errors);
    if (!isRecord(entry)) return;
    const key = evidenceKey(entry);
    if (keyed.has(key)) errors.push(`${label} repeats ${key}`);
    keyed.set(key, entry);
  });
  return keyed;
};

const requireMatchingKeys = (expected, actual, label, errors) => {
  for (const key of expected.keys()) {
    if (!actual.has(key)) errors.push(`${label} is missing ${key}`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) errors.push(`${label} has unexpected ${key}`);
  }
};

const validateStringArray = (value, label, errors) => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    errors.push(`${label} must contain unique non-empty strings`);
  }
};

const validateApproval = (approval, candidates, deviations, label, errors) => {
  if (!isRecord(approval)) {
    errors.push(`${label}.approval must record explicit human approval`);
    return;
  }
  for (const field of ["approvedBy", "approvedAt", "source"]) {
    if (typeof approval[field] !== "string" || approval[field].length === 0)
      errors.push(`${label}.approval.${field} must be non-empty`);
  }
  if (!isIsoTimestamp(approval.approvedAt))
    errors.push(`${label}.approval.approvedAt must be an ISO timestamp`);
  const expected = candidateSetSha256(candidates);
  if (approval.candidateSetSha256 !== expected) {
    errors.push(
      `${label}.approval.candidateSetSha256 is ${approval.candidateSetSha256}; expected ${expected}`,
    );
  }
  if (deviations.some((deviation) => deviation.approved !== true))
    errors.push(`${label} has an unapproved deviation`);
};

const validateApprovalRequest = (request, candidates, label, errors) => {
  if (!isRecord(request)) {
    errors.push(`${label}.approvalRequest must record the user-visible request`);
    return;
  }
  for (const field of ["requestedAt", "source"]) {
    if (typeof request[field] !== "string" || request[field].length === 0)
      errors.push(`${label}.approvalRequest.${field} must be non-empty`);
  }
  if (!isIsoTimestamp(request.requestedAt))
    errors.push(`${label}.approvalRequest.requestedAt must be an ISO timestamp`);
  const expected = candidateSetSha256(candidates);
  if (request.candidateSetSha256 !== expected) {
    errors.push(
      `${label}.approvalRequest.candidateSetSha256 is ${request.candidateSetSha256}; expected ${expected}`,
    );
  }
};

const validateSurface = (root, surface, index, errors) => {
  const label = `surfaces[${index}]`;
  if (!isRecord(surface)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  for (const field of ["id", "route", "selection"]) {
    if (typeof surface[field] !== "string" || surface[field].length === 0)
      errors.push(`${label}.${field} must be non-empty`);
  }
  validateStringArray(surface.requiredRegions, `${label}.requiredRegions`, errors);
  if (Array.isArray(surface.requiredRegions) && surface.requiredRegions.length === 0)
    errors.push(`${label}.requiredRegions must not be empty`);
  validateStringArray(
    surface.requiredInteractions,
    `${label}.requiredInteractions`,
    errors,
  );
  const stateIndex = states.indexOf(surface.state);
  if (stateIndex === -1) errors.push(`${label}.state is invalid: ${surface.state}`);

  const references = validateEvidenceSet(
    root,
    surface.references,
    `${label}.references`,
    errors,
  );
  const candidates = validateEvidenceSet(
    root,
    surface.candidates,
    `${label}.candidates`,
    errors,
  );
  const baselines = validateEvidenceSet(
    root,
    surface.baselines,
    `${label}.baselines`,
    errors,
  );

  if (stateIndex >= states.indexOf("design_selected") && references.size === 0)
    errors.push(`${label} needs at least one frozen reference`);

  if (stateIndex >= states.indexOf("compared")) {
    requireMatchingKeys(references, candidates, `${label}.candidates`, errors);
    validateFile(root, surface.comparison, `${label}.comparison`, errors);
  } else if (surface.comparison !== null) {
    errors.push(`${label}.comparison must be null before compared`);
  }

  if (!Array.isArray(surface.deviations)) {
    errors.push(`${label}.deviations must be an array`);
  } else {
    surface.deviations.forEach((deviation, deviationIndex) => {
      if (
        !isRecord(deviation) ||
        typeof deviation.description !== "string" ||
        deviation.description.length === 0 ||
        typeof deviation.approved !== "boolean"
      ) {
        errors.push(`${label}.deviations[${deviationIndex}] is invalid`);
      }
    });
  }

  if (stateIndex >= states.indexOf("approval_requested")) {
    validateApprovalRequest(
      surface.approvalRequest,
      [...candidates.values()],
      label,
      errors,
    );
  } else if (surface.approvalRequest != null) {
    errors.push(`${label}.approvalRequest must be null before approval_requested`);
  }

  if (stateIndex >= states.indexOf("member_accepted")) {
    validateApproval(
      surface.approval,
      [...candidates.values()],
      Array.isArray(surface.deviations) ? surface.deviations : [],
      label,
      errors,
    );
  } else if (surface.approval !== null) {
    errors.push(`${label}.approval must be null before member_accepted`);
  }

  if (stateIndex >= states.indexOf("baseline_promoted")) {
    requireMatchingKeys(references, baselines, `${label}.baselines`, errors);
    for (const [key, baseline] of baselines) {
      const candidate = candidates.get(key);
      if (candidate && baseline.sha256 !== candidate.sha256)
        errors.push(`${label}.baselines ${key} differs from the accepted candidate`);
    }
  } else if (baselines.size > 0) {
    errors.push(`${label}.baselines must be empty before baseline_promoted`);
  }

  return { id: surface.id, stateIndex };
};

export function validateManifest(
  manifest,
  { requireComplete = false, root = process.cwd() } = {},
) {
  const errors = [];
  if (!isRecord(manifest)) return { errors: ["manifest must be an object"] };
  if (manifest.version !== 1) errors.push("version must be 1");
  if (typeof manifest.initiative !== "string" || manifest.initiative.length === 0)
    errors.push("initiative must be non-empty");
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length === 0) {
    errors.push("surfaces must contain at least one surface");
    return { errors };
  }

  const seenIds = new Set();
  const validated = manifest.surfaces
    .map((surface, index) => validateSurface(root, surface, index, errors))
    .filter(Boolean);
  for (const surface of validated) {
    if (seenIds.has(surface.id)) errors.push(`surface id is duplicated: ${surface.id}`);
    seenIds.add(surface.id);
  }

  const total = manifest.surfaces.length;
  const countAt = (state) =>
    validated.filter((surface) => surface.stateIndex >= states.indexOf(state)).length;
  const progress = {
    total,
    implemented: countAt("implemented"),
    compared: countAt("compared"),
    approvalRequested: countAt("approval_requested"),
    memberAccepted: countAt("member_accepted"),
    baselinePromoted: countAt("baseline_promoted"),
  };
  if (requireComplete && progress.baselinePromoted !== total)
    errors.push(
      `completion requires ${total}/${total} baseline_promoted; found ${progress.baselinePromoted}/${total}`,
    );
  return { errors, progress };
}

const formatProgress = ({
  approvalRequested,
  baselinePromoted,
  compared,
  implemented,
  memberAccepted,
  total,
}) =>
  [
    `Implemented: ${implemented}/${total}`,
    `Compared: ${compared}/${total}`,
    `Approval requested: ${approvalRequested}/${total}`,
    `Member accepted: ${memberAccepted}/${total}`,
    `Baseline promoted: ${baselinePromoted}/${total}`,
  ].join("\n");

export const formatApprovalRequest = (surface, { root = process.cwd() } = {}) => {
  const comparison = resolve(root, surface.comparison.path);
  const deviations = surface.deviations.length
    ? surface.deviations.map(({ description }) => description).join("; ")
    : "None";
  return [
    `Approval required: ${surface.id}: ${surface.selection}`,
    `Comparison: [Open comparison](<${comparison}>)`,
    `Candidate set: ${surface.approvalRequest.candidateSetSha256}`,
    `Deviations: ${deviations}`,
    "",
    "Do you approve this exact production candidate?",
    'Reply "Approve" or "Reject".',
  ].join("\n");
};

async function main() {
  const args = process.argv.slice(2);
  const requireComplete = args.includes("--require-complete");
  const printRequestArgument = args.find((argument) =>
    argument.startsWith("--print-request="),
  );
  const printRequest = printRequestArgument?.slice("--print-request=".length);
  const manifestPath = args.find((argument) => !argument.startsWith("--"));
  if (!manifestPath) {
    console.error(
      "Usage: validate-visual-acceptance.mjs <manifest.json> [--require-complete] [--print-request=SURFACE_ID]",
    );
    process.exitCode = 2;
    return;
  }
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const result = validateManifest(manifest, { requireComplete });
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  if (printRequestArgument !== undefined) {
    if (!printRequest) {
      console.error("- --print-request requires a surface id");
      process.exitCode = 2;
      return;
    }
    const surface = manifest.surfaces.find(({ id }) => id === printRequest);
    if (!surface || surface.state !== "approval_requested") {
      console.error(`- ${printRequest} is not awaiting approval`);
      process.exitCode = 1;
      return;
    }
    console.log(formatApprovalRequest(surface));
    return;
  }
  if (result.progress) console.log(formatProgress(result.progress));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
