import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  gradeHistoricalCase,
  prepareHistoricalDependencies,
} from "./issue-26-grader.mjs";

const source = resolve(import.meta.dirname, "..");
const owner = resolve(source, "../sandcastle-issue31-run-v1");
const installed = source;
const pkg = await import(pathToFileURL(join(installed, "dist/index.js")));
const { docker: dockerSandbox } = await import(
  pathToFileURL(join(installed, "dist/sandboxes/docker.js"))
);
const image = "sandcastle:issue26-pnpm";
const observerScript =
  "/home/dv8/Projects/codex-plugins/dv8-codex/custom/skills/quality/sandcastle-personal-setup/scripts";
const policyId = "issue31-fixed-v1";
const pilot = join(owner, "pilot");
const args = process.argv.slice(2);
const armValues = args.flatMap((value, index) =>
  value === "--arm" ? [args[index + 1]] : [],
);
assert.equal(
  args.length,
  armValues.length * 2,
  "Use repeated --arm model:effort arguments",
);
const arms = armValues.map((value) => {
  const [model, effort, extra] = value.split(":");
  assert(model && effort && !extra, `Invalid arm ${value}`);
  return { model, effort };
});
const plan = pkg.makeFixedBenchmarkPlan(arms);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const command = (name, args, cwd = source) =>
  execFileSync(name, args, { cwd, encoding: "utf8", timeout: 120_000 }).trim();
const git = (cwd, ...args) => command("git", args, cwd);
const docker = (...args) => command("docker", args);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const put = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const putStable = async (path, value) => {
  try {
    await put(path, value);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = await json(path);
    if (
      prior.focusPassed !== value.focusPassed ||
      prior.otherGatesPassed !== value.otherGatesPassed
    )
      throw new Error("Protected grade changed for the same candidate");
  }
};
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

await mkdir(owner, { recursive: true, mode: 0o700 });
const workerConfig = join(owner, "worker-config.toml");
if (!(await stat(workerConfig).catch(() => null)))
  await writeFile(
    workerConfig,
    await readFile("/home/dv8/.codex/config.toml"),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
const agentCopy = join(owner, "worker-agents");
if (!(await stat(agentCopy).catch(() => null)))
  await cp("/home/dv8/.codex/agents", agentCopy, { recursive: true });
const release = {
  version: (await json(join(source, "package.json"))).version,
  sourceCommit: git(source, "rev-parse", "HEAD"),
  distHash: hash(await readFile(join(source, "dist/index.js"))),
};
assert.equal(
  git(source, "status", "--porcelain"),
  "",
  "Freeze a clean committed release before starting the study",
);
const imageId = docker("image", "inspect", image, "--format", "{{.Id}}");
const workerCliVersion = docker(
  "run",
  "--rm",
  "--entrypoint",
  "codex",
  image,
  "--version",
);
const workerConfigHash = hash(await readFile(workerConfig));
const workerAgentsHash = hash(
  execFileSync("tar", ["-cf", "-", "."], { cwd: agentCopy }),
);
const observerHash = hash(
  await readFile(join(observerScript, "worker-observations.mjs")),
);
const workerDockerfileHash = hash(
  await readFile(join(source, "scripts/issue-26-worker.Dockerfile")),
);
const mounts = [
  {
    hostPath: "/home/dv8/.codex/auth.json",
    sandboxPath: "/home/agent/.codex-seed/auth.json",
    readonly: true,
  },
  {
    hostPath: workerConfig,
    sandboxPath: "/home/agent/.codex-seed/config.toml",
    readonly: true,
  },
  { hostPath: agentCopy, sandboxPath: "/home/agent/.codex/agents" },
  {
    hostPath:
      "/home/dv8/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime",
    sandboxPath:
      "/home/agent/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime",
    readonly: true,
  },
  {
    hostPath: "/home/dv8/.codex/.tmp/bundled-marketplaces/openai-bundled",
    sandboxPath: "/home/agent/.codex/.tmp/bundled-marketplaces/openai-bundled",
    readonly: true,
  },
  { hostPath: observerScript, sandboxPath: "/home/agent/obs", readonly: true },
];
const mountArgs = mounts.flatMap(({ hostPath, sandboxPath, readonly }) => [
  "-v",
  `${hostPath}:${sandboxPath}:${readonly ? "ro," : ""}z`,
]);
const observer = `sandcastle-issue31-observer-${process.pid}`;
let observerStarted = false;
const startObserver = () => {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    observer,
    "-e",
    "CODEX_HOME=/home/agent/.codex",
    "-e",
    "COREPACK_HOME=/home/agent/.corepack",
    ...mountArgs,
    image,
  );
  observerStarted = true;
  docker(
    "exec",
    observer,
    "sh",
    "-lc",
    "for i in $(seq 1 50); do test -s /home/agent/.codex/auth.json && exit 0; sleep 0.1; done; exit 1",
  );
};
const worker = (kind) =>
  JSON.parse(
    docker(
      "exec",
      observer,
      "node",
      "/home/agent/obs/worker-observations.mjs",
      kind,
    ),
  );
const readAccount = async () => worker("account");
const listModels = async (cursor) =>
  cursor ? { data: [] } : { data: worker("models") };
const runtimeIdentity = hash(
  JSON.stringify({
    release,
    imageId,
    codex: workerCliVersion,
    workerConfigHash,
    workerAgentsHash,
    observerHash,
    workerDockerfileHash,
    mounts: mounts.map((item) => item.sandboxPath),
  }),
);
const sandbox = dockerSandbox({
  imageName: image,
  mounts,
  env: {
    CODEX_HOME: "/home/agent/.codex",
    COREPACK_HOME: "/home/agent/.corepack",
  },
});
const assignment = (model, effort, name) => ({
  agent: pkg.codex(model, {
    effort,
    serviceTier: "default",
    sessionStorage: { hostSessionsDir: join(owner, "sessions", name) },
  }),
  sandbox,
});
const reviewRoles = ["standards-review", "specification-review"];
const configurations = arms.map(({ model, effort }) => [model, effort]);
const fixturePrompt = (fixture) =>
  `Implement this bounded Sandcastle task: ${fixture.focus}. Change only the relevant source and tests. Use pnpm for every install and project check; do not add lockfile or workspace metadata. Run the project checks, commit the result, and finish. Do not read outside this answer-free repository.`;

async function freezeManifest() {
  const models = worker("models");
  for (const [model, effort] of configurations)
    assert(
      models.some(
        (item) =>
          item.model === model &&
          item.supportedReasoningEfforts.some(
            (entry) => entry.reasoningEffort === effort,
          ),
      ),
      `Worker lacks ${model}/${effort}`,
    );
  const account = worker("account");
  assert.equal(account.denied, false);
  assert(
    Object.values(account.windows).every((window) => window.usedPercent < 80),
  );
  const grader = await readFile(join(source, "scripts/issue-26-grader.mjs"));
  const prompts = Object.fromEntries(
    pkg.benchmarkFixtures.map((fixture) => [
      fixture.id,
      hash(fixturePrompt(fixture)),
    ]),
  );
  const protectedTests = Object.fromEntries(
    pkg.benchmarkFixtures.map((fixture) => {
      const path =
        fixture.id === "stream-log"
          ? "src/Display.test.ts"
          : fixture.id === "output-retry"
            ? "src/run.test.ts"
            : fixture.id === "merge-to-head"
              ? "src/createWorktree.test.ts"
              : "src/createSandbox.test.ts";
      return [
        fixture.id,
        hash(
          execFileSync("git", ["show", `${fixture.reference}:${path}`], {
            cwd: source,
          }),
        ),
      ];
    }),
  );
  const manifest = {
    schemaVersion: 1,
    protocolHash: pkg.fixedBenchmarkProtocolHash(plan),
    installedPackage: {
      name: "@ai-hero/sandcastle",
      version: release.version,
      sourceCommit: release.sourceCommit,
      distHash: release.distHash,
    },
    sourceCommit: release.sourceCommit,
    historicalCases: pkg.benchmarkFixtures.map(
      ({ id, split, kind, base, reference }) => ({
        id,
        split,
        kind,
        base,
        reference,
      }),
    ),
    configurations: configurations.map(([model, effort]) => ({
      model,
      effort,
      serviceTier: "default",
    })),
    slotOrder: plan.slots.map(({ id, fixture, split, repetition, arm }) => ({
      id,
      fixture,
      split,
      repetition,
      arm,
    })),
    workerCliVersion,
    workerImageDigest: imageId,
    workerConfigHash,
    workerAgentsHash,
    observerHash,
    workerDockerfileHash,
    runtimeIdentity,
    accountId: account.accountId,
    quietAccountWindow:
      "One sequential worker evaluation at a time; other account activity cannot be excluded by this host",
    fixturePromptHashes: prompts,
    toolVersions: {
      hostNode: command("node", ["--version"]),
      workerNode: docker(
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "--version",
      ),
      hostPnpm: command("pnpm", ["--version"]),
      workerPnpm: docker(
        "run",
        "--rm",
        "--entrypoint",
        "pnpm",
        image,
        "--version",
      ),
      hostGit: command("git", ["--version"]),
    },
    cachePolicy:
      "Shared host pnpm download cache; fresh worktree, dependencies and Codex session per evaluation",
    dependencyPolicy:
      "Import each frozen historical package lock with pnpm, install from the derived lock with hoisting and scripts disabled, then remove derived metadata from the answer-free tree",
    nonImplementationRoleConfigurations: Object.fromEntries(
      reviewRoles.map((role) => [
        role,
        {
          model: "gpt-6-sol",
          effort: "high",
          serviceTier: "default",
          calls: 1,
        },
      ]),
    ),
    projectGateHashes: Object.fromEntries(
      pkg.benchmarkFixtures.map((fixture) => [fixture.id, hash(grader)]),
    ),
    protectedGraderHashes: { runner: hash(grader), ...protectedTests },
    hostEntrySha256: hash(await readFile(import.meta.filename)),
    accountReadingResolution: Object.fromEntries(
      Object.keys(account.windows).map((name) => [name, 1]),
    ),
    accountWindowDurationMs: Object.fromEntries(
      Object.keys(account.windows).map((name) => [
        name,
        name === "primary" ? 7 * 24 * 60 * 60_000 : 5 * 60 * 60_000,
      ]),
    ),
    reservations: {
      activeMs: plan.overallLimitMs,
      conservativeWallClockMs: plan.overallLimitMs,
      measurementMs: 15 * 60_000,
      measurementCalls: 6,
      evaluationMs: 30 * 60_000,
      invocationMs: 15 * 60_000,
      evaluations: plan.slots.length,
      roles: reviewRoles,
    },
    creditRates: plan.rates,
    creditRateSource: plan.rateSource,
    accountRiseLimitPercentPoints: plan.accountRiseLimitPercentPoints,
  };
  const path = join(owner, "manifest.json");
  await put(path, manifest);
  return {
    path,
    sha256: hash(await readFile(path)),
    accountId: account.accountId,
  };
}

async function frozenManifest() {
  const manifest = await json(join(owner, "manifest.json"));
  assert.equal(manifest.protocolHash, pkg.fixedBenchmarkProtocolHash(plan));
  assert.equal(manifest.runtimeIdentity, runtimeIdentity);
  assert.equal(manifest.workerImageDigest, imageId);
  assert.equal(manifest.workerConfigHash, workerConfigHash);
  assert.equal(manifest.workerAgentsHash, workerAgentsHash);
  assert.equal(manifest.observerHash, observerHash);
  assert.equal(manifest.workerDockerfileHash, workerDockerfileHash);
  assert.equal(manifest.installedPackage.version, release.version);
  assert.equal(manifest.installedPackage.sourceCommit, release.sourceCommit);
  assert.equal(manifest.installedPackage.distHash, release.distHash);
  assert.equal(
    manifest.hostEntrySha256,
    hash(await readFile(import.meta.filename)),
  );
  assert.equal(
    manifest.protectedGraderHashes.runner,
    hash(await readFile(join(source, "scripts/issue-26-grader.mjs"))),
  );
  if (observerStarted)
    assert.equal(worker("account").accountId, manifest.accountId);
  return manifest;
}

async function reviewEvidence(directory, taskId, head) {
  const records = await Promise.all(
    (await readdir(join(directory, "sessions"))).map((name) =>
      json(join(directory, "sessions", name)),
    ),
  );
  const evidence = [];
  for (const role of reviewRoles) {
    const session = records.find(
      (item) => item.taskId === taskId && item.role === role,
    );
    if (!session?.path)
      return { passed: false, evidence, reason: `Missing ${role} session` };
    const bytes = await readFile(session.path);
    const messages = bytes
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter(
        (item) =>
          item.type === "response_item" &&
          item.payload?.type === "message" &&
          item.payload.role === "assistant",
      )
      .flatMap((item) => item.payload.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text);
    if (!messages.at(-1)?.trim().endsWith("REVIEW: PASS"))
      return { passed: false, evidence, reason: `${role} did not pass` };
    evidence.push(`${role}:${session.id}:${hash(bytes)}:${head}`);
  }
  return { passed: true, evidence };
}

function makeProject(root, directory, task, grade, recordReview = () => {}) {
  const reservation = join(directory, "reservation.json");
  return {
    root,
    capabilities: ["checks", "review", "recovery"],
    getTask: async (id) => (id === task.id ? task : undefined),
    reserve: async (request) => {
      const id = `reservation-${task.id}`;
      if (request.resumeId) assert.equal(request.resumeId, id);
      else await put(reservation, { id, request, retained: true });
      return {
        id,
        retain: async () =>
          writeFile(
            reservation,
            JSON.stringify({ id, request, retained: true }) + "\n",
          ),
        release: async () =>
          writeFile(
            reservation,
            JSON.stringify({ id, request, retained: false }) + "\n",
          ),
      };
    },
    prompt: (_task, role) =>
      role === "implementation"
        ? task.prompt
        : `Read-only ${role} of the candidate for ${task.reference}. Task instructions: ${task.prompt} Check correctness and existing repository standards. Do not edit files. End with REVIEW: PASS or REVIEW: FAIL: <reason>.`,
    check: async (candidate) => {
      recordReview(false);
      if (reviewRoles.some((role) => !candidate.completedRoles.includes(role)))
        return {
          status: "failed",
          evidence: [],
          reason: "Both reviews are required",
        };
      const review = await reviewEvidence(directory, task.id, candidate.head);
      if (review.reason?.startsWith("Missing "))
        throw new Error(review.reason);
      if (!review.passed)
        return { status: "failed", evidence: [], reason: review.reason };
      recordReview(true);
      const graded = await grade(candidate);
      const path = join(directory, `grade-${candidate.head}.json`);
      await putStable(path, graded);
      if (graded.environmentFailure)
        throw new Error("Protected grading environment failed");
      return graded.focusPassed && graded.otherGatesPassed
        ? { status: "passed", evidence: [path, ...review.evidence] }
        : {
            status: "failed",
            evidence: [path, ...review.evidence],
            reason: "Protected grading failed",
          };
    },
    accept: async (_candidate, check) =>
      check.status === "passed"
        ? { status: "accepted", evidence: check.evidence }
        : { status: "blocked", evidence: check.evidence, reason: check.reason },
    validateHumanRequest: async () => false,
  };
}

async function recoverReservation(directory, taskId, id) {
  const retained = await json(join(directory, "reservation.json"));
  assert.equal(id, `reservation-${taskId}`);
  assert.equal(retained.id, id);
  assert.equal(retained.retained, true);
}

async function calibration() {
  const root = join(owner, "calibration");
  const directory = join(owner, "calibration-state");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "result.txt"), "broken\n", { flag: "wx" });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Sandcastle pilot");
  git(root, "config", "user.email", "pilot@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "Calibration base");
  const worktree = await pkg.createWorktree({
    cwd: root,
    branchStrategy: { type: "branch", branch: "calibration" },
  });
  const task = {
    id: "calibration",
    reference: "result.txt",
    state: "ready",
    dependencies: [],
    scope: ["result.txt"],
    requiredRoles: reviewRoles,
    requiredCapabilities: ["checks", "review", "recovery"],
    prompt:
      "Replace result.txt with the single line ready. On the first turn, write the file, then sleep for 120 seconds before committing so the host can checkpoint the live session. After resuming, commit the change. Do not read files outside this repository.",
  };
  const project = makeProject(root, directory, task, async () => ({
    focusPassed:
      (await readFile(join(worktree.worktreePath, "result.txt"), "utf8")) ===
      "ready\n",
    otherGatesPassed: true,
    evidence: ["result.txt must equal ready\\n"],
  }));
  const selected = assignment("gpt-6-sol", "high", "calibration");
  const options = {
    directory,
    projectId: "issue31-calibration",
    invocationId: "issue31-calibration",
    runtimeIdentity,
    project,
    recoverReservation: (id) => recoverReservation(directory, task.id, id),
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: { [task.id]: worktree },
    requiredIgnoredArtifacts: { [task.id]: [] },
    policy: {
      iterations: 2,
      roles: {
        implementation: selected,
        "standards-review": selected,
        "specification-review": selected,
      },
    },
    usage: {
      policyId,
      activity: "measurement",
      pilot: {
        id: "issue31-fixed-v1",
        directory: pilot,
        overallLimitMs: plan.overallLimitMs,
        evaluationLimit: plan.slots.length,
        accountRiseLimitPercentPoints: plan.accountRiseLimitPercentPoints,
      },
      readAccount,
      listModels,
    },
  };
  const accounting = await json(join(owner, "accounting.json"));
  await put(join(owner, "calibration-preparation.json"), {
    startedAt: accounting.startedAt,
    endedAt: Date.now(),
    activeMs: Date.now() - accounting.startedAt,
  });
  const started = pkg.runDurableWorkflow(options).then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  let changed = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    await wait(500);
    changed =
      (await readFile(join(worktree.worktreePath, "result.txt"), "utf8")) !==
      "broken\n";
    if (changed) break;
  }
  if (changed) await pkg.checkpointStopWorkflow(directory);
  const outcome = await started;
  if (outcome.error) throw new Error(outcome.error);
  const first = outcome.value;
  if (
    !changed ||
    first.lifecycle !== "stopped" ||
    !first.checkpoint ||
    first.sourceRestoration !== "verified" ||
    first.sessionRestoration !== "verified" ||
    !first.sessions?.[task.id]?.some(
      (session) => session.role === "implementation",
    )
  )
    return {
      status: "failed",
      reason: "Calibration did not reach a verified live checkpoint",
      first,
    };
  const resumed = await pkg.resumeDurableWorkflow(options);
  const usage = resumed.usage;
  const success =
    resumed.tasks[task.id]?.status === "accepted" &&
    usage?.requested?.implementation?.model === "gpt-6-sol" &&
    usage.requested.implementation.effort === "high" &&
    usage.invocations <= 6 &&
    usage.activeMs < 15 * 60_000 &&
    usage.tokens.unknown.length === 1 &&
    usage.tokens.unknown[0] === "calibration/implementation/1" &&
    usage.tokens.invocations[usage.tokens.unknown[0]]?.outcome === "failed" &&
    Object.keys(usage.tokens.invocations).length >= 3 &&
    Object.entries(usage.tokens.invocations).every(
      ([id, invocation]) =>
        id === usage.tokens.unknown[0] || invocation.coverageComplete,
    ) &&
    Object.keys(usage.tokens.deltas).length > 0 &&
    usage.tokens.attributableTotal === null &&
    reviewRoles.every((role) =>
      resumed.sessions?.[task.id]?.some((session) => session.role === role),
    );
  return {
    status: success ? "passed" : "failed",
    reason: success ? null : "Calibration did not pass project acceptance",
    first,
    resumed,
  };
}

async function preflight() {
  await frozenManifest();
  const calibrationResult = await json(join(owner, "calibration-result.json"));
  assert.equal(
    calibrationResult.status,
    "passed",
    "Measurement calibration did not pass",
  );
  const receipts = await pkg.withBenchmarkActivity(
    pilot,
    policyId,
    "historical-fixture-preflight",
    60 * 60_000,
    async () => {
      const values = {};
      await mkdir(join(owner, "fixtures"), { recursive: true, mode: 0o700 });
      for (const fixture of pkg.benchmarkFixtures)
        values[fixture.id] = await pkg.exportBenchmarkFixture({
          source,
          fixtureId: fixture.id,
          directory: join(owner, "fixtures", fixture.id),
          grade: (path) => gradeHistoricalCase(source, fixture.id, path),
        });
      return values;
    },
  );
  await put(join(owner, "fixtures.json"), receipts);
  return receipts;
}

async function runNext() {
  await frozenManifest();
  const accounting = await json(join(owner, "accounting.json"));
  if (Date.now() - accounting.startedAt >= plan.overallLimitMs)
    throw new Error("The conservative twelve-hour study clock has expired");
  const manifestPath = join(owner, "manifest.json");
  const manifest = await json(manifestPath);
  const conditionsHash = hash(await readFile(manifestPath));
  const receipts = await json(join(owner, "fixtures.json"));
  const ledger = await pkg.readBenchmark(pilot, policyId);
  if (ledger.evaluations.some((item) => item.status === "incomplete"))
    throw new Error("An incomplete evaluation retains recovery ownership");
  const slot = ledger.plan.slots[ledger.evaluations.length];
  if (!slot) throw new Error("No remaining benchmark slot");
  if (slot.split === "held-out" && !ledger.fixedSelection)
    await pkg.freezeFixedBenchmarkSelection(pilot, policyId);
  const [model, effort] = configurations[slot.arm];
  const fixture = pkg.benchmarkFixtures.find(
    (item) => item.id === slot.fixture,
  );
  const root = join(owner, "runs", slot.id);
  const state = join(owner, "states", slot.id);
  const worktree = await pkg.withBenchmarkActivity(
    pilot,
    policyId,
    `prepare-${slot.id}`,
    5 * 60_000,
    async () => {
      await mkdir(join(owner, "runs"), { recursive: true, mode: 0o700 });
      git(
        owner,
        "clone",
        "--no-hardlinks",
        join(owner, "fixtures", slot.fixture),
        root,
      );
      git(root, "remote", "remove", "origin");
      return pkg.createWorktree({
        cwd: root,
        branchStrategy: { type: "branch", branch: slot.id },
      });
    },
  );
  await pkg.withBenchmarkActivity(
    pilot,
    policyId,
    `dependencies-${slot.id}`,
    5 * 60_000,
    async () => {
      const installed = await prepareHistoricalDependencies(
        worktree.worktreePath,
      );
      if (!installed.passed)
        throw new Error(`Historical pnpm install failed: ${installed.output}`);
    },
  );
  const task = {
    id: slot.fixture,
    reference: `fixture:${slot.fixture}`,
    state: "ready",
    dependencies: [],
    scope: ["src"],
    requiredRoles: reviewRoles,
    requiredCapabilities: ["checks", "review", "recovery"],
    prompt: fixturePrompt(fixture),
  };
  let reviewPassed = false;
  const project = makeProject(
    root,
    state,
    task,
    () => gradeHistoricalCase(source, slot.fixture, worktree.worktreePath),
    (passed) => {
      reviewPassed = passed;
    },
  );
  const implementation = assignment(model, effort, slot.id);
  const review = assignment("gpt-6-sol", "high", slot.id);
  const options = {
    directory: state,
    projectId: `issue31-${slot.fixture}`,
    invocationId: slot.id,
    runtimeIdentity,
    project,
    recoverReservation: (id) => recoverReservation(state, task.id, id),
    selected: [{ id: task.id, reference: task.reference }],
    worktrees: { [task.id]: worktree },
    requiredIgnoredArtifacts: { [task.id]: [] },
    policy: {
      iterations: 2,
      roles: {
        implementation,
        "standards-review": review,
        "specification-review": review,
      },
    },
    usage: {
      policyId,
      activity: "pilot",
      pilot: {
        id: "issue31-fixed-v1",
        directory: pilot,
        overallLimitMs: plan.overallLimitMs,
        evaluationLimit: plan.slots.length,
        accountRiseLimitPercentPoints: plan.accountRiseLimitPercentPoints,
      },
      readAccount,
      listModels,
    },
  };
  const effective = {
    model,
    effort,
    serviceTier: "default",
    source:
      "worker catalog and explicit Codex command; response identity unverified",
  };
  const result = await pkg.runBenchmarkEvaluation({
    directory: pilot,
    slotId: slot.id,
    options,
    protectedGrader: join(source, "scripts/issue-26-grader.mjs"),
    fixture: receipts[slot.fixture],
    conditionsHash,
    accountResolution: manifest.accountReadingResolution,
    windowDurationMs: manifest.accountWindowDurationMs,
    // Delayed readings are recorded, but shared-account activity cannot establish comparable cost.
    settled: false,
    get reviewPassed() {
      return reviewPassed;
    },
    effective,
    probe: async ({ worktree: path }) => {
      const checked = await gradeHistoricalCase(source, slot.fixture, path);
      return {
        status: checked.environmentFailure
          ? "environment-failure"
          : checked.focusPassed && checked.otherGatesPassed
            ? "passed"
            : "implementation-failure",
        reason:
          checked.focusPassed && checked.otherGatesPassed
            ? "Protected case passed"
            : "Protected case did not pass",
        evidence: checked.evidence,
      };
    },
  });
  return {
    slot: slot.id,
    status: result.status,
    reason: result.reason ?? null,
  };
}

let failure;
try {
  if (!(await stat(join(owner, "accounting.json")).catch(() => null)))
    await put(join(owner, "accounting.json"), {
      startedAt: Date.now(),
      policyId,
      pilot,
      limitMs: plan.overallLimitMs,
    });
  startObserver();
  const manifestPath = join(owner, "manifest.json");
  if (!(await stat(manifestPath).catch(() => null))) {
    await freezeManifest();
    console.log("Frozen host manifest and explicit arms");
  } else await frozenManifest();
  await pkg.initializeFixedBenchmark(pilot, policyId, arms);
  if (!(await stat(join(owner, "calibration-result.json")).catch(() => null))) {
    const result = await calibration().catch((error) => ({
      status: "failed",
      reason: String(error),
    }));
    await put(join(owner, "calibration-result.json"), result);
    console.log(
      JSON.stringify({
        phase: "calibration",
        status: result.status,
        reason: result.reason,
      }),
    );
  }
  assert.equal(
    (await json(join(owner, "calibration-result.json"))).status,
    "passed",
    "Calibration must pass before evaluations",
  );
  if (!(await stat(join(owner, "fixtures.json")).catch(() => null))) {
    await preflight();
    console.log("Protected historical preflight passed");
  }
  while (
    (await pkg.readBenchmark(pilot, policyId)).evaluations.length <
    plan.slots.length
  ) {
    const result = await runNext();
    console.log(JSON.stringify({ phase: "evaluation", ...result }));
    if (result.status === "incomplete")
      throw new Error(`Recover incomplete ${result.slot} before proceeding`);
  }
  const disposition = await pkg.assessFixedBenchmark(pilot, policyId);
  console.log(JSON.stringify({ phase: "assessment", disposition }));
} catch (error) {
  failure = error;
  console.error(`Study stopped: ${String(error)}`);
} finally {
  if (await stat(join(pilot, "benchmark.json")).catch(() => null)) {
    try {
      const report = await pkg.withBenchmarkActivity(
        pilot,
        policyId,
        "benchmark-report",
        5 * 60_000,
        () =>
          pkg.writeBenchmarkReport({
            directory: pilot,
            policyId,
            outputDirectory: join(owner, "report"),
            manifestPath: join(owner, "manifest.json"),
          }),
      );
      console.log(
        JSON.stringify({ phase: "report", ...report, metered: true }),
      );
    } catch (error) {
      const report = await pkg.writeBenchmarkReport({
        directory: pilot,
        policyId,
        outputDirectory: join(owner, "report"),
        manifestPath: join(owner, "manifest.json"),
      });
      console.log(
        JSON.stringify({
          phase: "report",
          ...report,
          metered: false,
          reason: String(error),
        }),
      );
    }
  }
  if (observerStarted) {
    try {
      docker("stop", observer);
    } catch (error) {
      console.error(`Observer cleanup: ${error}`);
    }
  }
}
if (failure) process.exitCode = 1;
