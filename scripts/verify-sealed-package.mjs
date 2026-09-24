import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const receiptArgument = process.argv.slice(2).filter((arg) => arg !== "--")[0];
if (!receiptArgument) throw new Error("Pass the sealed archive receipt path");
const receiptPath = resolve(receiptArgument);
const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
const archive = resolve(dirname(receiptPath), receipt.archive);
const sha256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
if (sha256 !== receipt.sha256) throw new Error("Archive checksum mismatch");
const packed = (path) =>
  JSON.parse(
    execFileSync("tar", ["-xOzf", archive, `package/${path}`], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
const manifest = packed("package.json");
const metadata = packed("dist/workflow-release.json");
if (
  manifest.name !== "@ai-hero/sandcastle" ||
  manifest.version !== receipt.version ||
  manifest.repository?.url !==
    "https://github.com/DenislavVelichkov/sandcastle" ||
  JSON.stringify(metadata) !==
    JSON.stringify({
      name: receipt.name,
      version: receipt.version,
      source: receipt.source,
      sourceCommit: receipt.sourceCommit,
      contracts: receipt.contracts,
    })
)
  throw new Error("Archive identity or contract metadata mismatch");
const consumer = await mkdtemp(join(tmpdir(), "sandcastle-consumer-"));
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: consumer,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  }).trim();
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "sealed-consumer-check",
        private: true,
        type: "module",
        dependencies: { "@ai-hero/sandcastle": `file:${archive}` },
        devDependencies: { typescript: "6.0.3" },
      },
      null,
      2,
    ),
  );
  run("pnpm", ["install", "--ignore-scripts"]);
  const probe = `import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pkg from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
const entry = fileURLToPath(import.meta.resolve('@ai-hero/sandcastle'));
const installed = dirname(dirname(entry));
const metadata = JSON.parse(readFileSync(join(installed, 'dist/workflow-release.json')));
if (!entry.startsWith(process.cwd() + '/node_modules/') || metadata.sourceCommit !== ${JSON.stringify(receipt.sourceCommit)} || metadata.version !== ${JSON.stringify(receipt.version)}) throw Error('Resolved stale or foreign package');
for (const name of ['inspectWorkflow', 'runDurableWorkflow', 'resumeDurableWorkflow', 'workflowStatus', 'respondWorkflow', 'checkpointStopWorkflow', 'integrateWorkflowTask']) if (typeof pkg[name] !== 'function') throw Error('Missing public export ' + name);
if (typeof docker !== 'function') throw Error('Missing sandbox export');
console.log(JSON.stringify({entry, metadata}));`;
  await writeFile(join(consumer, "probe.mjs"), probe);
  const observed = JSON.parse(run("node", ["probe.mjs"]));
  run("pnpm", ["exec", "sandcastle", "--help"]);
  await writeFile(
    join(consumer, "probe.ts"),
    `import { inspectWorkflow, type DurableWorkflowOptions, type WorkflowProject } from '@ai-hero/sandcastle';\nconst project: WorkflowProject | undefined = undefined;\nconst options: DurableWorkflowOptions | undefined = undefined;\nvoid [inspectWorkflow, project, options];\n`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["probe.ts"],
    }),
  );
  run("pnpm", ["exec", "tsc", "--noEmit"]);
  console.log(
    JSON.stringify({
      status: "verified",
      archive,
      sha256,
      consumerEntry: observed.entry,
      sourceCommit: receipt.sourceCommit,
    }),
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
