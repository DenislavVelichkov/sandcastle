// Pack/install a candidate and prove its ordinary CLI using external fixture responses.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] && resolve(process.argv[2]);
const runtime = process.argv[3];
assert(
  output && (!runtime || ["browser", "android", "both"].includes(runtime)),
  "Usage: pnpm exec node scripts/prove-installed-benchmark.mjs /absolute/empty-output [browser|android|both]",
);
const runtimes =
  runtime === "both" ? ["browser", "android"] : runtime ? [runtime] : [];
await mkdir(output, { recursive: true, mode: 0o700 });
assert.equal(
  (await readdir(output)).length,
  0,
  "Preserve existing proof; choose an empty output directory",
);
const disposable = join(output, "disposable");
const consumer = join(disposable, "consumer");
const project = join(disposable, "project");
const tools = join(disposable, "tools");
const auth = join(disposable, "auth");
const archive = join(disposable, "candidate.tgz");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, data) =>
  writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const children = new Set();
let proof = { dataKind: "fixture", measurements: false, cleanup: "unverified" };
let verified = false;
let env;
let cli;
const run = (name, args, options = {}) =>
  exec(name, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options });
const invoke = (args) => run(cli, args, { cwd: consumer, env });
const plan = async (args) =>
  JSON.parse(
    (await invoke(["benchmark", "--project", project, ...args, "--dry-run"]))
      .stdout,
  );
const controls = (data = {}) => save(join(tools, "controls.json"), data);
const spawnCli = (args) => {
  const child = spawn(cli, args, {
    cwd: consumer,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      accept({ code, stdout, stderr });
    });
  });
  return { child, done, stdout: () => stdout };
};
const until = async (operation) => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await operation()) return;
    await delay(50);
  }
  throw new Error("Installed fixture did not reach the required state");
};
try {
  for (const path of [consumer, project, tools, auth])
    await mkdir(path, { recursive: true });
  await save(join(consumer, "package.json"), {
    name: "unrelated-benchmark-consumer",
    private: true,
    type: "module",
  });
  await run("pnpm", ["pack", "--out", archive], { cwd: source });
  await run("pnpm", ["add", "--offline", "--ignore-scripts", archive], {
    cwd: consumer,
  });
  const installed = await realpath(
    join(consumer, "node_modules/@ai-hero/sandcastle"),
  );
  assert(
    !installed.startsWith(source + "/"),
    "Consumer must use installed archive bytes",
  );
  const pkg = await read(join(installed, "package.json"));
  cli = join(consumer, "node_modules/.bin/sandcastle");
  const entry = pkg.bin.sandcastle;
  const entryBytes = await readFile(join(installed, entry));
  const help = (await run(cli, ["--help"], { cwd: consumer })).stdout;
  for (const command of [
    "benchmark",
    "benchmark-status",
    "benchmark-cancel",
    "benchmark-resume",
    "benchmark-report",
  ]) {
    assert(help.includes(command));
    await run(cli, [command, "--help"], { cwd: consumer });
  }
  proof.installed = {
    entry,
    entrySha256: hash(entryBytes),
    archiveSha256: hash(await readFile(archive)),
    version: pkg.version,
    commands: help,
  };
  for (const tool of ["gh", "docker"])
    await symlink(
      join(source, "scripts/fixtures/benchmark-tools.mjs"),
      join(tools, tool),
    );
  await save(join(auth, "auth.json"), {
    tokens: { access_token: "deterministic-fixture-secret" },
  });
  env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    CODEX_HOME: auth,
    SANDCASTLE_FIXTURE_ROOT: tools,
  };
  await controls();
  await writeFile(join(project, "value.txt"), "base\n");
  await writeFile(
    join(project, "task.md"),
    "# Deterministic installed task fixture\n\nSet value.txt to correct. Fixture data, not measured model quality.\n",
  );
  await writeFile(
    join(project, "check.sh"),
    'test "$(cat value.txt)" = correct\n',
  );
  await writeFile(join(project, ".gitignore"), "node_modules/\ndist/\n");
  await save(join(project, "launch.json"), {
    version: 1,
    allowedEdits: ["value.txt", "check.sh"],
    rubric: [
      {
        id: "value",
        requirement: "value.txt contains correct",
        weight: 1,
        partialCredit: 0.5,
        applicability: "nonvisual",
        evidence: ["code"],
      },
    ],
    adapter: { id: "fixture-code-v1", readiness: "true" },
    rateCard: {
      source: "Synthetic fixture rates, not official prices",
      date: "2026-10-05",
      inputs: {
        version: 1,
        serviceTier: "default",
        unit: "per-million-tokens",
        models: Object.fromEntries(
          ["gpt-6-astra", "gpt-6.1-sol"].map((model) => [
            model,
            {
              api: [
                {
                  upToInputTokens: null,
                  input: 2,
                  cachedInput: 0.2,
                  cacheWriteInput: 2.5,
                  output: 8,
                },
              ],
              codexStandard: { input: 50, cachedInput: 5, output: 200 },
            },
          ]),
        ),
      },
    },
  });
  const git = (...args) => run("git", args, { cwd: project });
  await git("init", "-b", "main");
  await git("config", "user.name", "Installed fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("add", ".");
  await git("commit", "-m", "Frozen consumer fixture");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(project, "value.txt"), "host working changes\n");
  await writeFile(
    join(project, "host-notes.txt"),
    "Preserve unrelated host notes\n",
  );
  const hostStatus = (await git("status", "--porcelain=v1")).stdout;
  const common = [
    "--base",
    base,
    "--contract",
    "launch.json",
    "--check",
    "sh check.sh",
    "--max-minutes",
    "60",
  ];
  const local = await plan(["--ticket", "task.md", ...common]);
  assert.deepEqual(
    local.arms.map(({ model, effort }) => `${model}:${effort}`),
    [
      "gpt-6-astra:medium",
      "gpt-6-astra:high",
      "gpt-6-astra:xhigh",
      "gpt-6-astra:max",
    ],
  );
  assert.equal(
    `${local.judge.model}:${local.judge.effort}`,
    "gpt-6.1-sol:xhigh",
  );
  const github = await plan([
    "--repository",
    "fixture/consumer",
    "--ticket",
    "7",
    ...common,
  ]);
  assert(github.tickets[0].text.includes("Frozen fixture comment"));
  const prompt = await plan(["--prompt", "Exact prompt fixture", ...common]);
  assert.equal(prompt.tickets[0].text, "Exact prompt fixture");
  const fallback = await plan([
    "--ticket",
    "missing.md",
    "--prompt",
    "Explicit fallback fixture",
    ...common,
  ]);
  assert.equal(fallback.tickets[0].missingSource, "missing.md");
  const absent = await plan([
    "--repository",
    "fixture/consumer",
    "--ticket",
    "404",
    "--prompt",
    "Confirmed missing issue fixture",
    ...common,
  ]);
  assert.equal(absent.tickets[0].text, "Confirmed missing issue fixture");
  const override = await plan([
    "--ticket",
    "task.md",
    "--arm",
    "gpt-6.1-sol:high",
    "--judge",
    "gpt-6-luna:max",
    ...common,
  ]);
  assert.deepEqual(
    override.arms.map(({ model, effort }) => `${model}:${effort}`),
    ["gpt-6.1-sol:high"],
  );
  assert.equal(override.judge.model, "gpt-6-luna");
  assert.deepEqual(
    local.arms,
    (
      await plan([
        "--ticket",
        "task.md",
        "--judge",
        "gpt-6-luna:max",
        ...common,
      ])
    ).arms,
  );
  for (const item of [local, github, prompt, fallback, absent, override]) {
    assert.equal(item.baseCommit, base);
    assert.equal(
      item.launch.grading.rubricSha256,
      local.launch.grading.rubricSha256,
    );
  }
  proof.routes = {
    local: true,
    github: true,
    prompt: true,
    fallback: true,
    absentIssue: true,
    overrides: true,
  };
  proof.defaults = { arms: 4, judge: "gpt-6.1-sol:xhigh" };
  await save(join(output, "plans.json"), {
    local,
    github,
    prompt,
    fallback,
    absent,
    override,
  });
  const launch = (directory, extra = []) =>
    invoke([
      "benchmark",
      "--project",
      project,
      "--ticket",
      "task.md",
      ...common,
      "--output",
      directory,
      ...extra,
    ]);
  const complete = join(output, "complete");
  const completion = (await launch(complete)).stdout;
  assert(completion.includes(`xdg-open '${join(complete, "report.html")}'`));
  assert(completion.includes(join(complete, "candidates")));
  assert(completion.includes("docs/benchmark-reports.md"));
  await writeFile(join(output, "completion.txt"), completion);
  const ledger = await read(join(complete, "execution.json"));
  assert.equal(ledger.status, "complete");
  assert.equal(ledger.attempts.length, 4);
  assert.equal(
    new Set(ledger.attempts.map((attempt) => attempt.candidate.worktree)).size,
    4,
  );
  for (const attempt of ledger.attempts) {
    assert.equal(attempt.check.status, "passed");
    assert.equal(attempt.judge.status, "complete");
    assert.equal(attempt.judge.assessments[0].requirements[0].verdict, "met");
    assert.equal(
      await readFile(join(attempt.candidate.worktree, "value.txt"), "utf8"),
      "correct\n",
    );
    assert(attempt.implementation.usage && attempt.judge.assessments[0].usage);
  }
  assert.equal(
    await readFile(join(project, "value.txt"), "utf8"),
    "host working changes\n",
  );
  assert.equal(
    await readFile(join(project, "host-notes.txt"), "utf8"),
    "Preserve unrelated host notes\n",
  );
  assert.equal((await git("status", "--porcelain=v1")).stdout, hostStatus);
  assert.equal((await git("rev-parse", "HEAD")).stdout.trim(), base);
  proof.isolation = true;
  proof.checks = "passed";
  proof.judging = "complete";
  const bad = join(output, "protected-check");
  await controls({ bad: true });
  await launch(bad, ["--arm", "gpt-6-astra:medium"]).catch((error) =>
    assert.equal(error.code, 1),
  );
  const badLedger = await read(join(bad, "execution.json"));
  assert.equal(badLedger.attempts[0].check.status, "failed");
  assert.equal(
    badLedger.attempts[0].judge.assessments[0].requirements[0].verdict,
    "not_met",
  );
  proof.protectedCheckRejectsWorkerWaiver = true;
  const cancelled = join(output, "cancelled");
  await controls({ hold: true, failStop: true });
  const active = spawnCli([
    "benchmark",
    "--project",
    project,
    "--ticket",
    "task.md",
    ...common,
    "--output",
    cancelled,
    "--arm",
    "gpt-6-astra:medium",
  ]);
  await until(async () =>
    (await readFile(join(tools, "model-calls.jsonl"), "utf8")).includes(
      join(cancelled, "runtime"),
    ),
  );
  const status = JSON.parse(
    (await invoke(["benchmark-status", "--directory", cancelled])).stdout,
  );
  const observer = spawnCli([
    "benchmark-status",
    "--directory",
    cancelled,
    "--watch",
  ]);
  await until(async () => observer.stdout().includes(status.snapshot.runId));
  observer.child.kill("SIGINT");
  await observer.done;
  const reconnected = JSON.parse(
    (
      await invoke([
        "benchmark-status",
        "--directory",
        cancelled,
        "--after",
        String(status.cursor),
      ])
    ).stdout,
  );
  assert.equal(reconnected.snapshot.owner.token, status.snapshot.owner.token);
  assert(reconnected.events.every((event) => event.sequence > status.cursor));
  await invoke([
    "benchmark-cancel",
    "--directory",
    cancelled,
    "--reason",
    "Installed fixture cancellation",
  ]);
  // A failed stop takes precedence over cancellation's usual exit code 130.
  assert.equal((await active.done).code, 1);
  const interrupted = await read(join(cancelled, "execution.json"));
  assert.equal(interrupted.cleanup.status, "failed");
  assert(
    interrupted.resources.some((resource) => resource.status !== "released"),
  );
  await controls();
  const resumed = await invoke(["benchmark-resume", "--directory", cancelled]);
  assert.equal(JSON.parse(resumed.stdout).status, "complete");
  assert(
    resumed.stderr.includes(`xdg-open '${join(cancelled, "report.html")}'`),
  );
  assert(resumed.stderr.includes(join(cancelled, "candidates")));
  assert(resumed.stderr.includes("docs/benchmark-reports.md"));
  await writeFile(join(output, "resume-instructions.txt"), resumed.stderr);
  const recovered = await read(join(cancelled, "execution.json"));
  assert.equal(recovered.budget.implementationCalls, 1);
  assert.equal(recovered.cleanup.status, "passed");
  assert(recovered.attempts[0].implementation.usage);
  const recoveredReport = await read(join(cancelled, "report.json"));
  assert(
    recoveredReport.rows[0].inspection.artifacts
      .filter((file) => ["worktree", "patch"].includes(file.id))
      .every((file) => file.state === "available"),
  );
  proof.recovery = {
    observerReconnected: true,
    implementationReplayed: false,
    failedCleanupRetained: true,
    recoveredCandidateLinks: true,
    jsonStdoutPreserved: true,
    completionInstructionsOnStderr: true,
  };
  proof.usageRetained = true;
  proof.runtimes = [];
  for (const runtime of runtimes) {
    const runtimeProject = join(disposable, `runtime-${runtime}`);
    await cp(
      join(installed, `dist/templates/benchmark-runtime-${runtime}`),
      runtimeProject,
      { recursive: true },
    );
    const contract = await read(join(runtimeProject, "launch.json"));
    if (runtime === "android")
      contract.adapter.config.sdk =
        process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    await save(join(runtimeProject, "launch.json"), contract);
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.name", "Runtime fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "."],
      ["commit", "-m", "Packaged runtime fixture"],
    ])
      await run("git", args, { cwd: runtimeProject });
    const directory = join(output, runtime);
    await run(
      cli,
      [
        "benchmark",
        "--project",
        runtimeProject,
        "--ticket",
        "task.md",
        "--contract",
        "launch.json",
        "--check",
        "sh check.sh",
        "--arm",
        "gpt-6-astra:medium",
        "--max-minutes",
        "60",
        "--output",
        directory,
      ],
      { cwd: consumer, env, timeout: 240_000 },
    );
    const result = await read(join(directory, "execution.json"));
    assert.equal(result.status, "complete");
    assert.equal(result.cleanup.status, "passed");
    assert.equal(result.attempts[0].judge.status, "complete");
    assert(result.attempts[0].project.evidence.length > 0);
    proof.runtimes.push({
      kind: runtime,
      identity: result.attempts[0].project.identity,
      evidence: result.attempts[0].project.evidence,
    });
  }
  const before = await readFile(join(tools, "calls.jsonl"));
  const manifest = await readFile(join(complete, "manifest.json"));
  const reportDirectory = join(output, "regenerated");
  const regeneration = await invoke([
    "benchmark-report",
    "--directory",
    complete,
    "--output",
    reportDirectory,
  ]);
  assert(regeneration.stdout.includes(join(reportDirectory, "report.html")));
  assert(regeneration.stdout.includes(join(complete, "candidates")));
  await writeFile(join(output, "regeneration.txt"), regeneration.stdout);
  for (const name of ["report.html", "report.json", "evaluations.csv"]) {
    assert.deepEqual(
      await readFile(join(complete, name)),
      await readFile(join(reportDirectory, name)),
    );
    await cp(join(reportDirectory, name), join(output, name));
  }
  assert.deepEqual(await readFile(join(tools, "calls.jsonl")), before);
  assert.deepEqual(await readFile(join(complete, "manifest.json")), manifest);
  const report = await read(join(reportDirectory, "report.json"));
  assert.equal(report.rows.length, 4);
  assert(
    report.rows.every(
      (row) =>
        row.score === 100 && row.coverage === 1 && row.check === "passed",
    ),
  );
  assert.equal(report.identities.manifestSha256, hash(manifest));
  assert.equal(
    report.identities.ledgerSha256,
    hash(await readFile(join(complete, "execution.json"))),
  );
  assert.equal(report.projectAcceptance, "not assessed");
  assert(report.rows.every((row) => row.inspection.steps.length === 5));
  assert(
    report.rows.every((row) => row.inspection.humanReview === "not-recorded"),
  );
  assert(
    report.rows.every((row) => row.candidateId === row.assessment.candidateId),
  );
  assert(
    report.rows.every((row) => row.inspection.checklist.state === "all-met"),
  );
  for (const row of report.rows)
    for (const artifact of row.inspection.artifacts.filter(
      (file) => file.state === "available",
    ))
      await readFile(
        artifact.id === "worktree"
          ? join(artifact.path, "value.txt")
          : artifact.path,
      );
  proof.humanInspection = {
    completionInstructions: true,
    frozenArtifactLinks: true,
    stepsPerCandidate: 5,
    humanReview: "not-recorded",
  };
  proof.offlineRegeneration = true;
  for (const directory of [
    complete,
    bad,
    cancelled,
    ...runtimes.map((kind) => join(output, kind)),
  ]) {
    const final = await read(join(directory, "execution.json"));
    assert.equal(final.cleanup.status, "passed");
    assert(final.resources.every((resource) => resource.status === "released"));
    assert.equal(
      (await readdir(join(directory, "runtime")).catch(() => [])).length,
      0,
    );
  }
  assert.equal(
    (await readdir(tools)).filter((name) =>
      name.startsWith("sandcastle-benchmark-"),
    ).length,
    0,
  );
  proof.cleanup = "resources-stopped";
  // Seal proof before removing the consumer, source projects, archive and fixture tools.
  await save(join(output, "proof.json"), proof);
  verified = true;
} finally {
  for (const child of children) child.kill("SIGTERM");
  if (children.size) await until(async () => children.size === 0);
  if (verified) {
    const receipt = {
      proofSha256: hash(await readFile(join(output, "proof.json"))),
      disposable,
    };
    try {
      await rm(disposable, { recursive: true, force: true });
      await save(join(output, "cleanup.json"), {
        ...receipt,
        status: "passed",
      });
    } catch (error) {
      await save(join(output, "cleanup.json"), {
        ...receipt,
        status: "failed",
        reason: String(error),
      });
      throw error;
    }
  } else
    await save(join(output, "failed-proof.json"), {
      ...proof,
      retained: disposable,
      reason: "Proof did not pass; retained ownership/evidence for inspection",
    });
}
console.log(
  JSON.stringify({
    proof: join(output, "proof.json"),
    dataKind: "fixture",
    cleanup: (await read(join(output, "cleanup.json"))).status,
  }),
);
