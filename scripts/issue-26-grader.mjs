import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This file must stay outside every answer-free benchmark worktree.
const cases = {
  "stream-log": {
    base: "c505d4964ce6806211259e8bff9ad1d8c319a9ef",
    reference: "badf657b5dc81a71c141d8cd736a67804c6a86ff",
    test: "src/Display.test.ts",
    focus: "starts a following line entry|does not insert an extra newline",
  },
  "output-retry": {
    base: "2867118a575faa697b000be87d429900804786cf",
    reference: "9f3f6d5c5f2527d5e1d8349f80eec2d36e797540",
    test: "src/run.test.ts",
    focus: "output.maxRetries",
  },
  "merge-to-head": {
    base: "2867118a575faa697b000be87d429900804786cf",
    reference: "f7879c5ca6853c6afa79cb836d918de8de64db03",
    test: "src/createWorktree.test.ts",
    focus: "merge-to-head: agent commits|merge-to-head: two sequential",
  },
  "sandbox-handle": {
    base: "f1aa0809d097db0d5c674e13c9ac3374ba2a629b",
    reference: "0f577a42fdbfe49111b8e00694399ee0c9ddd559",
    test: "src/createSandbox.test.ts",
    focus: "sandbox.exec\\(\\)",
  },
};

const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    passed: result.status === 0,
    output:
      `${result.error?.message ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`.slice(
        -4000,
      ),
  };
};

export async function prepareHistoricalDependencies(candidate) {
  const lock = join(candidate, "pnpm-lock.yaml");
  const workspace = join(candidate, "pnpm-workspace.yaml");
  if (
    (await stat(lock).catch(() => null)) ||
    (await stat(workspace).catch(() => null))
  )
    return {
      passed: false,
      output: "Candidate already contains pnpm metadata",
    };
  try {
    const imported = run("pnpm", ["import"], candidate);
    if (!imported.passed) return imported;
    return run(
      "pnpm",
      [
        "install",
        "--frozen-lockfile",
        "--shamefully-hoist",
        "--ignore-scripts",
      ],
      candidate,
    );
  } finally {
    await rm(lock, { force: true });
    await rm(workspace, { force: true });
  }
}

export async function gradeHistoricalCase(source, fixtureId, candidate) {
  const selected = cases[fixtureId];
  if (!selected) throw new Error(`Unknown benchmark case: ${fixtureId}`);
  const basePackage = JSON.parse(
    execFileSync("git", ["show", `${selected.base}:package.json`], {
      cwd: source,
    }),
  );
  const candidatePackage = JSON.parse(
    await readFile(join(candidate, "package.json")),
  );
  for (const name of ["test", "typecheck", "build"])
    if (candidatePackage.scripts?.[name] !== basePackage.scripts?.[name])
      return {
        focusPassed: false,
        otherGatesPassed: false,
        environmentFailure: false,
        evidence: [`Candidate changed the ${name} check`],
      };
  const original = await readFile(join(candidate, selected.test));
  const reference = execFileSync(
    "git",
    ["show", `${selected.reference}:${selected.test}`],
    {
      cwd: source,
    },
  );
  const shadow = await mkdtemp(
    join(tmpdir(), `sandcastle-${fixtureId}-grade-`),
  );
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
      cwd: candidate,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", shadow], { input: archive });
    const pending = execFileSync("git", ["diff", "--binary", "HEAD"], {
      cwd: candidate,
    });
    if (pending.length)
      execFileSync("git", ["apply", "--binary", "-"], {
        cwd: shadow,
        input: pending,
      });
    await writeFile(join(shadow, selected.test), reference);
    const install = await prepareHistoricalDependencies(candidate);
    if (!install.passed)
      return {
        focusPassed: false,
        otherGatesPassed: false,
        environmentFailure: true,
        evidence: [install.output],
      };
    await symlink(
      join(candidate, "node_modules"),
      join(shadow, "node_modules"),
      "dir",
    );
    const focus = run(
      "pnpm",
      [
        "--config.verify-deps-before-run=false",
        "exec",
        "vitest",
        "run",
        selected.test,
        "-t",
        selected.focus,
      ],
      shadow,
    );
    const typecheck = run(
      "pnpm",
      ["--config.verify-deps-before-run=false", "run", "typecheck"],
      candidate,
    );
    const build = typecheck.passed
      ? run(
          "pnpm",
          ["--config.verify-deps-before-run=false", "run", "build"],
          candidate,
        )
      : { passed: false, output: "Typecheck failed" };
    const ordinary = build.passed
      ? run(
          "pnpm",
          ["--config.verify-deps-before-run=false", "test"],
          candidate,
        )
      : { passed: false, output: "Build failed" };
    const evidence = {
      fixtureId,
      candidate: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: candidate,
        encoding: "utf8",
      }).trim(),
      protectedTestSha256: createHash("sha256").update(reference).digest("hex"),
      candidateTestSha256: createHash("sha256").update(original).digest("hex"),
      focus,
      install,
      ordinary,
      typecheck,
      build,
    };
    return {
      focusPassed: focus.passed,
      otherGatesPassed: ordinary.passed && typecheck.passed,
      environmentFailure: false,
      evidence: [JSON.stringify(evidence)],
    };
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}
