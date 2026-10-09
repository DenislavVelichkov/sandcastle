#!/usr/bin/env node
// Deterministic external GitHub/Docker/Codex boundary. Never calls a model.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const root = process.env.SANDCASTLE_FIXTURE_ROOT;
assert(root, "Fixture tools require an explicit private root");
const args = process.argv.slice(2);
const tool = basename(process.argv[1]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (name, data) =>
  appendFileSync(join(root, `${name}.jsonl`), JSON.stringify(data) + "\n");
const json = (value) => process.stdout.write(JSON.stringify(value));
const controls = JSON.parse(readFileSync(join(root, "controls.json")));
log("calls", { tool, args });

if (tool === "gh") {
  const endpoint = args.at(-1);
  const issue = {
    title: "Deterministic GitHub task fixture",
    body: "Set value.txt to correct. Fixture data, not model measurements.",
    state: "open",
    html_url: "https://github.com/fixture/consumer/issues/7",
  };
  if (endpoint === "repos/fixture/consumer")
    json({ full_name: "fixture/consumer" });
  else if (endpoint === "repos/fixture/consumer/issues/7") json(issue);
  else if (endpoint === "repos/fixture/consumer/issues/7/comments")
    json([
      [
        {
          user: { login: "fixture" },
          created_at: "2026-10-05T00:00:00Z",
          body: "Frozen fixture comment",
        },
      ],
    ]);
  else if (
    endpoint === "repos/fixture/consumer/issues/7/dependencies/blocked_by"
  )
    json([[]]);
  else if (endpoint === "repos/fixture/consumer/issues/404") {
    process.stderr.write("HTTP 404");
    process.exitCode = 1;
  } else throw new Error(`Unconfigured GitHub fixture request: ${endpoint}`);
} else if (tool === "docker") {
  if (args[0] === "image" && args[1] === "inspect") {
    process.stdout.write(`sha256:${"a".repeat(64)}`);
  } else if (args[0] === "run" && args.includes("--rm")) {
    const mount = args.find((arg) =>
      arg.endsWith(":/tmp/sandcastle-probe.cjs:ro,z"),
    );
    const probe = readFileSync(mount.slice(0, mount.indexOf(":/tmp/")), "utf8");
    const request = JSON.parse(
      /\)\((\{[^\n]+\}), sandboxProbe\)\.catch/.exec(probe)[1],
    );
    json({
      codexVersion: "deterministic-fixture",
      nodeVersion: process.version,
      configSha256: hash(request.config),
      authenticated: true,
      usageAvailable: true,
      models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"].map((model) => ({
        model,
        supportedReasoningEfforts: ["medium", "high", "xhigh", "max"].map(
          (reasoningEffort) => ({ reasoningEffort }),
        ),
      })),
      tools: Object.fromEntries(
        request.capabilities.tools.map((name) => [name, "fixture-boundary"]),
      ),
      freeBytes: 2 ** 40,
      freeInodes: 100000,
      gradingReady: true,
      readOnlySandbox: { ready: true, detail: null },
      environments: {},
    });
  } else if (args[0] === "run") {
    const name = args[args.indexOf("--name") + 1];
    const label = args[args.indexOf("--label") + 1];
    writeFileSync(
      join(root, name),
      JSON.stringify({
        Config: { Labels: { "sandcastle.benchmark.run": label.split("=")[1] } },
      }),
    );
    process.stdout.write(name);
  } else if (args[0] === "rm") {
    const name = args.at(-1);
    if (controls.failStop && name.startsWith("sandcastle-benchmark-")) {
      process.stderr.write("Fixture stop failure, ownership must be retained");
      process.exitCode = 1;
    } else rmSync(join(root, name), { force: true });
  } else if (args[0] === "inspect") {
    if (existsSync(join(root, args[1])))
      json([JSON.parse(readFileSync(join(root, args[1])))]);
    else {
      process.stderr.write("No such container");
      process.exitCode = 1;
    }
  } else if (args[0] === "exec" && args.includes("--version")) {
    process.stdout.write(
      args.includes("codex")
        ? "deterministic-fixture\n"
        : `${process.version}\n`,
    );
  } else if (args[0] === "exec") {
    const cwd = args[args.indexOf("-w") + 1];
    const command = args.at(-1);
    if (!command.startsWith("codex exec")) {
      const result = spawnSync("sh", ["-c", command], {
        cwd,
        encoding: "utf8",
      });
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      process.exitCode = result.status ?? 1;
    } else {
      let prompt = "";
      for await (const chunk of process.stdin) prompt += chunk;
      const judge = prompt.includes("Candidate identity:");
      log("model-calls", { role: judge ? "judge" : "implementation", cwd });
      if (!judge && existsSync(join(cwd, "value.txt"))) {
        writeFileSync(
          join(cwd, "value.txt"),
          controls.bad ? "wrong\n" : "correct\n",
        );
        // A bad worker tries to waive the check. The independent checker must restore it.
        if (controls.bad) writeFileSync(join(cwd, "check.sh"), "exit 0\n");
      }
      if (judge) {
        const socket = /Live inspection socket: (.+)/.exec(prompt)?.[1];
        let inspection;
        if (socket) {
          inspection = JSON.parse(
            execFileSync(
              "curl",
              [
                "--fail",
                "--silent",
                "--unix-socket",
                "inspection.sock",
                "http://localhost/inspect",
              ],
              { cwd: dirname(socket), encoding: "utf8" },
            ),
          );
          assert(inspection.observation.includes("Candidate ready"));
        }
        const correct =
          socket ||
          readFileSync(join(cwd, "value.txt"), "utf8") === "correct\n";
        const output = {
          candidateId: /Candidate identity: (candidate-[a-f0-9-]+)/.exec(
            prompt,
          )[1],
          requirements: [
            {
              id: socket ? "visible-label" : "value",
              verdict: correct ? "met" : "not_met",
              observation: socket
                ? inspection.observation
                : "Directly read this candidate's value.txt.",
              explanation:
                "Deterministic fixture judgment, not measured model quality.",
              evidence: socket
                ? [
                    { kind: "check", id: "check-case:visible-label" },
                    { kind: "visual", id: inspection.evidenceId },
                  ]
                : [
                    {
                      kind: "code",
                      path: "value.txt",
                      startLine: 1,
                      endLine: 1,
                    },
                  ],
            },
          ],
          deviations: [],
          disclosures: [
            "Fixture data, not model-performance measurements or human acceptance.",
          ],
        };
        const rubric = JSON.parse(/Frozen rubric:\n([^\n]+)/.exec(prompt)[1]);
        for (const id of rubric[0].checkCases ?? [])
          if (
            !output.requirements[0].evidence.some(
              (item) => item.kind === "check" && item.id === `check-case:${id}`,
            )
          )
            output.requirements[0].evidence.push({
              kind: "check",
              id: `check-case:${id}`,
            });
        json({
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify(output) },
        });
        process.stdout.write("\n");
      }
      json({
        type: "turn.completed",
        usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 },
      });
      process.stdout.write("\n");
      if (!judge && controls.hold)
        await new Promise(() => setInterval(() => {}, 1000));
    }
  } else
    throw new Error(`Unconfigured Docker fixture request: ${args.join(" ")}`);
} else throw new Error(`Unconfigured fixture tool: ${tool}`);
