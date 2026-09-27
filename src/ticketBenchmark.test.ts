import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { planTicketBenchmark, runTicketBenchmark } from "./ticketBenchmark.js";

it("discovers one ticket, runs each default arm once, and retains its report", async () => {
  const root = await mkdtemp(join(tmpdir(), "ticket-benchmark-"));
  const repo = join(root, "repo");
  const output = join(root, "evidence");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  try {
    await mkdir(join(repo, "tickets"), { recursive: true });
    await writeFile(
      join(repo, "tickets", "stream.md"),
      "# Stream logging\n\nKeep chunks contiguous.\n",
    );
    git("init", "-b", "main");
    git("config", "user.name", "Benchmark test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "-m", "Base");

    const plan = await planTicketBenchmark({ cwd: repo, output });
    expect(plan.tickets.map((ticket) => ticket.source)).toEqual([
      "tickets/stream.md",
    ]);
    expect(plan.arms.map((arm) => `${arm.model}:${arm.effort}`)).toEqual([
      "gpt-6-sol:xhigh",
      "gpt-6-astra:medium",
      "gpt-6-luna:max",
    ]);
    let calls = 0;
    const execute = async () => {
      calls++;
      return {
        status: "passed" as const,
        candidateHead: `candidate-${calls}`,
        usage: null,
      };
    };
    expect(await runTicketBenchmark(plan, execute)).toMatchObject({
      status: "complete",
      completed: 3,
    });
    expect(calls).toBe(3);
    expect(await runTicketBenchmark(plan, execute)).toMatchObject({
      status: "complete",
      completed: 3,
    });
    expect(calls).toBe(3);

    const report = JSON.parse(
      await readFile(join(output, "report.json"), "utf8"),
    );
    expect(report.rows.map((row: { status: string }) => row.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(
      (await readFile(join(output, "evaluations.csv"), "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(4);
    expect(await readFile(join(output, "report.html"), "utf8")).toContain(
      "3/3 slots attempted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
