import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { IterationUsage } from "./AgentProvider.js";
import type { FrozenLaunch } from "./benchmarkLaunch.js";

export const reportCostsSourceUrl = import.meta.url;

const rate = z.number().finite().nonnegative();
const apiBand = z
  .object({
    upToInputTokens: z.number().int().positive().nullable(),
    input: rate,
    cachedInput: rate,
    cacheWriteInput: rate,
    output: rate,
  })
  .strict();
const modelRates = z
  .object({
    api: z.array(apiBand).min(1).optional(),
    codexStandard: z
      .object({ input: rate, cachedInput: rate, output: rate })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const bands = value.api;
    if (
      bands &&
      (bands.at(-1)!.upToInputTokens !== null ||
        bands.some(
          (band, index) =>
            index < bands.length - 1 &&
            (band.upToInputTokens === null ||
              (index > 0 &&
                band.upToInputTokens! <= bands[index - 1]!.upToInputTokens!)),
        ))
    )
      context.addIssue({
        code: "custom",
        message:
          "API bands require ascending bounds and a final unbounded band",
      });
  });
const cardSchema = z
  .object({
    source: z.string().min(1),
    date: z.iso.date(),
    inputs: z
      .object({
        version: z.literal(1),
        serviceTier: z.literal("default"),
        unit: z.literal("per-million-tokens"),
        models: z.record(z.string().min(1), modelRates),
      })
      .strict(),
  })
  .strict();
const counters = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const rawCounters = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export interface ReportCostEstimate {
  status: "estimate" | "range" | "unavailable";
  lower: number | null;
  upper: number | null;
  assumptions: string[];
}
const unavailable = (reason: string): ReportCostEstimate => ({
  status: "unavailable",
  lower: null,
  upper: null,
  assumptions: [reason],
});
const estimate = (
  lower: number,
  upper: number,
  assumptions: string[],
): ReportCostEstimate =>
  Number.isFinite(lower) && Number.isFinite(upper)
    ? {
        status: lower === upper ? "estimate" : "range",
        lower,
        upper,
        assumptions,
      }
    : unavailable("Token valuation exceeds finite numeric capacity");

/** Unknown components make the full estimate unavailable, never zero. */
export const sumReportCosts = (
  values: readonly ReportCostEstimate[],
): ReportCostEstimate => {
  if (!values.length)
    return unavailable("No recorded calls in this cost scope");
  if (values.some((value) => value.lower === null || value.upper === null))
    return unavailable(
      [...new Set(values.flatMap((value) => value.assumptions))].join("; "),
    );
  return estimate(
    values.reduce((sum, value) => sum + value.lower!, 0),
    values.reduce((sum, value) => sum + value.upper!, 0),
    [...new Set(values.flatMap((value) => value.assumptions))],
  );
};

export const reportCallCost = async (input: {
  role: "implementation" | "judge";
  model: string;
  observed:
    | readonly {
        model: string;
        effort: string | null;
        serviceTier: string | null;
      }[]
    | null;
  usage: IterationUsage | null;
  stream: string;
  streamSha256: string | null;
  rateCard: FrozenLaunch["rateCard"];
}) => {
  const card = cardSchema.safeParse(input.rateCard);
  let rawUsage: Record<string, unknown>[] = [];
  let provenanceReason: string | null = null;
  let streamHash: string | null = null;
  try {
    const bytes = await readFile(input.stream);
    streamHash = createHash("sha256").update(bytes).digest("hex");
    if (!input.streamSha256 || streamHash !== input.streamSha256)
      throw new Error("Raw usage provenance is missing or changed");
    rawUsage = bytes
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.type === "turn.completed" &&
            event.usage &&
            typeof event.usage === "object" &&
            !Array.isArray(event.usage)
            ? [event.usage as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    provenanceReason =
      error instanceof Error
        ? error.message
        : "Raw usage provenance unavailable";
  }
  const observations = input.observed ?? [];
  const models = [
    ...new Set(observations.map((observation) => observation.model)),
  ];
  const model = models.length === 1 ? models[0]! : input.model;
  const identityAssumptions = observations.length
    ? []
    : [
        "Observed model/service tier unavailable; valuation assumes the frozen requested model and Standard service tier",
      ];
  const rates =
    card.success && Object.hasOwn(card.data.inputs.models, model)
      ? card.data.inputs.models[model]
      : null;
  const usage = counters.safeParse(input.usage);
  const raw = rawCounters.safeParse(rawUsage.at(-1));
  let reason = provenanceReason;
  if (!reason && !usage.success)
    reason = "Normalized usage counters are unknown or invalid";
  if (!reason && !raw.success)
    reason =
      "Raw Codex usage counters are unavailable; normalized counters alone do not prove complete spending";
  if (
    !reason &&
    rawUsage.length > 1 &&
    new Set(rawUsage.map((value) => JSON.stringify(value))).size > 1
  )
    reason =
      "Multiple distinct turn totals cannot be reconciled with the retained single-call counters";
  if (
    !reason &&
    usage.success &&
    raw.success &&
    (raw.data.input_tokens - raw.data.cached_input_tokens !==
      usage.data.inputTokens ||
      raw.data.cached_input_tokens !== usage.data.cacheReadInputTokens ||
      raw.data.output_tokens !== usage.data.outputTokens)
  )
    reason = "Raw and normalized token counters disagree";
  if (
    !reason &&
    (models.length > 1 ||
      observations.some(
        (observation) =>
          observation.serviceTier !== null &&
          !["default", "standard"].includes(observation.serviceTier),
      ))
  )
    reason =
      "Observed model or service tier cannot use one frozen Standard rate";
  if (!reason && !rates)
    reason = "A valid dated model-specific frozen rate card is unavailable";
  let api = unavailable(reason ?? "API rates unavailable");
  let codexStandard = unavailable(reason ?? "Codex Standard rates unavailable");
  if (!reason && usage.success && raw.success && rates) {
    const normalized = usage.data;
    const pool = normalized.inputTokens + normalized.cacheCreationInputTokens;
    if (rates.codexStandard) {
      const credit = rates.codexStandard;
      const value =
        (pool * credit.input +
          normalized.cacheReadInputTokens * credit.cachedInput +
          normalized.outputTokens * credit.output) /
        1e6;
      codexStandard = estimate(value, value, [
        ...identityAssumptions,
        "Codex Standard token-derived credit equivalent; no separate cache-write charge; reasoning is included in output. This does not measure subscription consumption.",
      ]);
    }
    if (rates.api) {
      const writes = raw.data.cache_creation_input_tokens;
      if (writes !== undefined && writes > pool)
        api = unavailable(
          "Raw cache-write tokens exceed the uncached input pool",
        );
      else {
        const amounts = rates.api.flatMap((band) => {
          const inputValues =
            writes === undefined
              ? [pool * band.input, pool * band.cacheWriteInput]
              : [(pool - writes) * band.input + writes * band.cacheWriteInput];
          return inputValues.map(
            (value) =>
              (value +
                normalized.cacheReadInputTokens * band.cachedInput +
                normalized.outputTokens * band.output) /
              1e6,
          );
        });
        api = estimate(Math.min(...amounts), Math.max(...amounts), [
          ...identityAssumptions,
          ...(rates.api.length > 1
            ? [
                "Per-request context band is unknown; range spans every frozen API context band",
              ]
            : []),
          writes === undefined
            ? "API cache-write dimensions are missing; range spans no writes through all uncached input as writes"
            : "Recorded API cache-write tokens replace ordinary-input pricing for those tokens",
          "Normalized input already excludes cached tokens; reasoning is already included in output. API-equivalent estimate, not an actual bill.",
        ]);
      }
    }
  }
  return {
    role: input.role,
    model,
    requestedModel: input.model,
    observed: input.observed,
    usage: input.usage,
    rawUsage,
    provenance: {
      path: input.stream,
      sha256: streamHash,
      expectedSha256: input.streamSha256,
      verified: provenanceReason === null,
      reason: provenanceReason,
    },
    rateSource: card.success
      ? { source: card.data.source, date: card.data.date }
      : null,
    api,
    codexStandard,
  };
};
