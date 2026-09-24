import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  }).trim();
const status = run("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
if (status) throw new Error("Seal from a clean recorded source commit");
const sourceCommit = run("git", ["rev-parse", "HEAD"]);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
if (
  packageJson.sandcastleWorkflow?.source !== "DenislavVelichkov/sandcastle" ||
  !packageJson.version.includes("-dv8.")
)
  throw new Error("Maintained source and unique version are required");
run("pnpm", ["run", "build"]);
const metadata = {
  name: packageJson.name,
  version: packageJson.version,
  source: packageJson.sandcastleWorkflow.source,
  sourceCommit,
  contracts: {
    api: packageJson.sandcastleWorkflow.api,
    configuration: packageJson.sandcastleWorkflow.configuration,
    state: packageJson.sandcastleWorkflow.state,
  },
};
await writeFile(
  join(root, "dist", "workflow-release.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
const output = resolve(
  process.argv.slice(2).filter((arg) => arg !== "--")[0] ||
    join(root, "artifacts"),
);
await mkdir(output, { recursive: true });
const archive = join(output, `ai-hero-sandcastle-${packageJson.version}.tgz`);
run("pnpm", ["pack", "--out", archive]);
const sha256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
const receipt = { ...metadata, archive, sha256 };
await writeFile(
  archive + ".receipt.json",
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt));
