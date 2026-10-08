/** Bubblewrap supplies the command boundary inside the private Docker worker. */
export const benchmarkDockerSecurityOptions = [
  "seccomp=unconfined",
  "label=disable",
] as const;

/** Serialized into the disposable worker. No model or credential access. */
export const probeBenchmarkReadOnlySandbox = async () => {
  const { execFileSync } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { writeFile, readFile, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const file = join(process.cwd(), `.sandcastle-readonly-${randomUUID()}`);
  const expected = "sandcastle readonly candidate\n";
  try {
    await writeFile(file, expected, { flag: "wx", mode: 0o600 });
    const output = execFileSync(
      "timeout",
      [
        "20s",
        "codex",
        "sandbox",
        "-c",
        'sandbox_mode="read-only"',
        "--",
        "sh",
        "-c",
        'cat "$1" || exit 1; if printf mutation >> "$1" 2>/dev/null; then exit 2; fi',
        "sh",
        file,
      ],
      {
        encoding: "utf8",
        timeout: 22_000,
        maxBuffer: 16_384,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ready =
      output === expected && (await readFile(file, "utf8")) === expected;
    return {
      ready,
      detail: ready
        ? null
        : "Read-only sandbox did not read the candidate and deny its modification",
    };
  } catch {
    return {
      ready: false,
      detail:
        "Codex read-only sandbox command failed; verify Bubblewrap, kernel namespaces and the frozen Docker security profile",
    };
  } finally {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};
