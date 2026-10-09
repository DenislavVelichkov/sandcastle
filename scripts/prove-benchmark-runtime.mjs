// Explicit opt-in runtime proof. Model/provider responses are controlled fixtures.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  planTicketBenchmark,
  runTicketBenchmark,
  readBenchmarkAssessments,
} from "../dist/index.js";

const exec = promisify(execFile);
const kind = process.argv[2];
const output = process.argv[3] && resolve(process.argv[3]);
if (!["android", "browser"].includes(kind) || !output)
  throw new Error(
    "Usage: pnpm exec node scripts/prove-benchmark-runtime.mjs android|browser /absolute/private-output",
  );
const project = join(output, "fixture-source");
await mkdir(output, { recursive: true, mode: 0o700 });
await cp(
  new URL(`../src/templates/benchmark-runtime-${kind}/`, import.meta.url),
  project,
  { recursive: true, errorOnExist: true, force: false },
);
const config = JSON.parse(await readFile(join(project, "launch.json"), "utf8"));
if (kind === "android")
  config.adapter.config.sdk =
    process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
await writeFile(
  join(project, "launch.json"),
  JSON.stringify(config, null, 2) + "\n",
);
const git = (...args) => exec("git", args, { cwd: project });
await git("init", "-b", "main");
await git("config", "user.name", "Runtime fixture");
await git("config", "user.email", "fixture@example.invalid");
await git("add", ".");
await git("commit", "-m", "Frozen runtime proof fixture");
await git("checkout", "-b", "benchmark-known-bad");
const candidateFile = kind === "browser" ? "index.html" : "MainActivity.java";
await writeFile(
  join(project, candidateFile),
  (await readFile(join(project, candidateFile), "utf8")).replaceAll(
    "Candidate ready",
    "Candidate missing",
  ),
);
await git("add", candidateFile);
await git("commit", "-m", "Broken visible-label calibration");
await git("checkout", "main");
const plan = await planTicketBenchmark(
  {
    cwd: project,
    tickets: ["task.md"],
    arms: ["gpt-6-astra:medium"],
    check: "sh check.sh",
    contract: "launch.json",
    output: join(output, "run"),
    preflight: true,
    maxMinutes: 60,
  },
  {
    // These observations substitute only the external worker boundary. This proof
    // establishes the real runtime path, not worker readiness or model quality.
    inspectWorker: async (request) => ({
      imageDigest: `sha256:${"a".repeat(64)}`,
      codexVersion: "controlled-provider-fixture",
      nodeVersion: process.version,
      configSha256: createHash("sha256").update(request.config).digest("hex"),
      authenticated: true,
      usageAvailable: true,
      models: [
        {
          model: "gpt-6-astra",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
        {
          model: "gpt-6.1-sol",
          supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
        },
      ],
      tools: Object.fromEntries(
        request.capabilities.tools.map((tool) => [tool, "controlled-fixture"]),
      ),
      freeBytes: 2 ** 40,
      freeInodes: 100000,
      gradingReady: true,
      environments: {},
    }),
  },
);
const result = await runTicketBenchmark(plan, undefined, 1, {
  createRuntime: async (request) => ({
    id: request.id,
    stop: async () => {},
    exec: async ({ command, stdin }) => {
      if (!command.startsWith("codex exec") || request.role !== "judge")
        return { stdout: "", stderr: "", exitCode: 0 };
      const socket = /Live inspection socket: (.+)/.exec(stdin)?.[1];
      if (!socket)
        throw new Error("Native closure requires live owned judge access");
      const { stdout } = await exec(
        "curl",
        [
          "--fail",
          "--silent",
          "--unix-socket",
          "inspection.sock",
          "http://localhost/inspect",
        ],
        { cwd: dirname(socket) },
      );
      const inspection = JSON.parse(stdout);
      if (!inspection.observation.includes("Candidate ready"))
        throw new Error(
          "Actual candidate runtime is missing the required label",
        );
      const candidateId = /Candidate identity: (candidate-[a-f0-9-]+)/.exec(
        stdin,
      )[1];
      const output = {
        candidateId,
        requirements: [
          {
            id: "visible-label",
            verdict: "met",
            observation:
              "The actual owned fixture shows Candidate ready in its native hierarchy or DOM.",
            explanation:
              "The protected live check and candidate-bound screen support this controlled fixture requirement.",
            evidence: [
              { kind: "check", id: "check-case:visible-label" },
              {
                kind: "visual",
                id: kind === "android" ? "native-screen" : "browser-screen",
              },
              { kind: "visual", id: inspection.evidenceId },
            ],
          },
        ],
        deviations: [],
        disclosures: [
          "Controlled provider/judge output is fixture data, not measured model quality.",
        ],
      };
      return {
        stdout:
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(output) },
          }) + "\n",
        stderr: "",
        exitCode: 0,
      };
    },
  }),
});
const saved = await readBenchmarkAssessments(plan.output);
const proof = {
  kind,
  scope: "Real owned runtime; controlled external model/provider responses",
  result: result.status,
  cleanup: saved.execution.cleanup,
  resources: saved.execution.resources,
  assessment: saved.assessments[0],
  runtime: saved.execution.attempts[0]?.project,
};
await writeFile(
  join(output, "proof.json"),
  JSON.stringify(proof, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      status: result.status,
      cleanup: proof.cleanup,
      runtime: proof.runtime?.identity,
      evidence: proof.runtime?.evidence,
      proof: join(output, "proof.json"),
    },
    null,
    2,
  ),
);
if (
  result.status !== "complete" ||
  proof.cleanup.status !== "passed" ||
  !proof.assessment?.applicable ||
  proof.resources.some((resource) => resource.status !== "released")
)
  process.exitCode = 1;
else {
  // Compact source/patch/evidence remains in run/candidates and run/visuals.
  await rm(project, { recursive: true, force: true });
}
