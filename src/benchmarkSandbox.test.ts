import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probeBenchmarkReadOnlySandbox } from "./benchmarkSandbox.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(["passed", "command-failed", "write-allowed", "read-failed"])(
  "requires successful reading and denied modification, %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "readonly-probe-"));
    roots.push(root);
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin", "codex"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify(args));
const file = args.at(-1);
if (${JSON.stringify(mode)} === 'command-failed') process.exit(1);
process.stdout.write(${JSON.stringify(mode)} === 'read-failed' ? 'wrong output' : fs.readFileSync(file));
if (${JSON.stringify(mode)} === 'write-allowed') fs.appendFileSync(file, 'mutation');
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH}`);
    const result = await probeBenchmarkReadOnlySandbox();
    expect(result.ready).toBe(mode === "passed");
    const args = JSON.parse(await readFile(join(root, "args.json"), "utf8"));
    expect(args.slice(0, 4)).toEqual([
      "sandbox",
      "-c",
      'sandbox_mode="read-only"',
      "--",
    ]);
    expect(args).toContain(
      'cat "$1" || exit 1; if printf mutation >> "$1" 2>/dev/null; then exit 2; fi',
    );
    await expect(readFile(args.at(-1))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
