import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexStartupWorker } from "./codexStartupWorker.js";

const mount = vi.hoisted(() => ({ path: "", writable: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: (path: any, options: any) =>
      path === "/proc/self/mountinfo"
        ? Promise.resolve(
            `1 0 0:1 / ${mount.path} ${mount.writable ? "rw" : "ro"} - test test ro\n`,
          )
        : fs.readFile(path, options),
  };
});

// An actual subprocess speaks the Codex protocol. Failures are controlled at
// the provider boundary; the startup controller is exercised without a model.
const server = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const fixture = JSON.parse(fs.readFileSync(process.env.STARTUP_FIXTURE, 'utf8'));
let turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({method, params});
const receipt = hook => notify('hook/completed', {threadId:'thread-1', run:{sourcePath:hook.sourcePath, displayOrder:hook.displayOrder, eventName:hook.eventName, status:fixture.failure === 'execution' ? 'failed' : 'completed', entries:hook.startupContext ? [{kind:'context',text:fixture.failure === 'context' ? 'truncated' : fixture.snapshot.instructions}] : []}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  fs.appendFileSync(process.env.STARTUP_TRANSCRIPT, JSON.stringify(message) + '\n');
  const reply = result => send({id:message.id,result});
  if (fixture.failure === 'timeout') return;
  switch(message.method) {
    case 'initialize': return reply({});
    case 'config/read': return reply({layers:[{config:{agents:{enabled:!process.argv.includes('agents.enabled=false')},hooks:{state:fixture.failure === 'approval-state' ? {} : Object.fromEntries(fixture.snapshot.hooks.map(hook => [hook.key,{trusted_hash:fixture.failure === 'approval-hash' || (fixture.failure === 'post-approval' && turn > 0) ? 'stale-approved-definition' : hook.currentHash}]))}}}]});
    case 'skills/list': return reply({data:[{cwd:message.params.cwds[0], errors:[], skills:fixture.failure === 'skill' ? [] : fixture.snapshot.skills}]});
    case 'plugin/installed': return reply({marketplaces:[{plugins:fixture.snapshot.plugins.map(plugin => ({...plugin,installed:true,localVersion:fixture.failure === 'version' || (fixture.failure === 'post-version' && turn > 0) ? '2.0.0' : plugin.localVersion}))}],marketplaceLoadErrors:[]});
    case 'hooks/list': return reply({data:[{cwd:message.params.cwds[0],errors:[],warnings:[],hooks:fixture.snapshot.hooks.map(hook => ({...hook,trustStatus:fixture.failure === 'trust' ? 'untrusted' : 'trusted',currentHash:fixture.failure === 'hash' || (fixture.failure === 'post-hash' && turn > 0) ? 'changed-definition' : hook.currentHash}))}]});
    case 'thread/start': case 'thread/resume': case 'thread/fork':
      reply({thread:{id:'thread-1'}});
      if(fixture.failure !== 'missing') fixture.snapshot.hooks.filter(hook => hook.enabled && hook.eventName === 'sessionStart').forEach(receipt);
      return;
    case 'turn/start': {
      turn++;
      const id = 'turn-' + turn;
      reply({turn:{id}});
      if(turn === 1) fixture.snapshot.hooks.filter(hook => hook.enabled && hook.eventName !== 'sessionStart').forEach(receipt);
      else notify('item/completed',{threadId:'thread-1',item:{type:'agentMessage',text:'Task completed'}});
      notify('turn/completed',{threadId:'thread-1',turn:{id,status:'completed'}});
      if (fixture.failure === 'post-source') fs.writeFileSync(fixture.snapshot.skills[0].path, 'Changed during startup');
      return;
    }
  }
  send({id:message.id,error:{message:'Unsupported RPC: '+message.method}});
});
`;

let root: string;
let snapshot: any;
let failure = "";
let stdinDescriptor: PropertyDescriptor;
let stdout: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "startup-gate-"));
  await mkdir(join(root, "bin"));
  for (const name of ["ponytail", "unslop"]) {
    await mkdir(join(root, "source", name), { recursive: true });
    await writeFile(
      join(root, "source", name, "SKILL.md"),
      `${name} instructions\n`,
    );
    await chmod(join(root, "source", name, "SKILL.md"), 0o644);
  }
  await writeFile(join(root, "bin/codex"), server);
  await chmod(join(root, "bin/codex"), 0o755);
  mount.path = join(root, "source");
  mount.writable = false;
  const sha256 = createHash("sha256")
    .update(
      ["ponytail", "unslop"]
        .map(
          (name) =>
            `file:${name}/SKILL.md:420:${createHash("sha256").update(`${name} instructions\n`).digest("hex")}`,
        )
        .join("\n"),
    )
    .digest("hex");
  snapshot = {
    version: 1,
    hostCwd: root,
    instructions:
      "Load and apply these instructions in every agent session. Activate the other available skills when their descriptions match the task.\n\n" +
      ["ponytail", "unslop"]
        .map((name) => `# Explicit skill: $${name}\n\n${name} instructions\n`)
        .join("\n\n"),
    alwaysSkills: ["ponytail", "unslop"],
    sources: [{ path: join(root, "source"), sha256 }],
    skills: [
      {
        name: "ponytail",
        path: join(root, "source/ponytail/SKILL.md"),
        enabled: true,
      },
      {
        name: "unslop",
        path: join(root, "source/unslop/SKILL.md"),
        enabled: true,
      },
      {
        name: "optional-disabled",
        path: join(root, "source/ponytail/SKILL.md"),
        enabled: false,
      },
    ],
    plugins: [{ id: "ponytail@example", enabled: true, localVersion: "1.0.0" }],
    hooks: [
      {
        key: "startup",
        sourcePath: join(root, "home/hooks.json"),
        eventName: "sessionStart",
        displayOrder: 0,
        currentHash: "exact-startup-definition",
        enabled: true,
        startupContext: true,
      },
      {
        key: "guard",
        sourcePath: join(root, "home/hooks.json"),
        eventName: "preToolUse",
        displayOrder: 1,
        currentHash: "exact-guard-definition",
        enabled: true,
      },
      {
        key: "disabled",
        sourcePath: join(root, "home/hooks.json"),
        eventName: "stop",
        displayOrder: 2,
        currentHash: "disabled-definition",
        enabled: false,
      },
    ],
  };
  vi.stubEnv("PATH", join(root, "bin") + ":" + process.env.PATH);
  vi.stubEnv("STARTUP_FIXTURE", join(root, "fixture.json"));
  vi.stubEnv("STARTUP_TRANSCRIPT", join(root, "transcript.jsonl"));
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"])
    vi.stubEnv(name, join(root, name));
  failure = "";
  stdout = "";
  stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", {
    value: Readable.from(["PRIVATE_TICKET_PROMPT"]),
    configurable: true,
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  Object.defineProperty(process, "stdin", stdinDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const run = async (
  options: {
    resumeSession?: string;
    forkSession?: boolean;
    timeoutMs?: number;
  } = {},
) => {
  await writeFile(
    join(root, "fixture.json"),
    JSON.stringify({ snapshot, failure }),
  );
  await writeFile(join(root, "snapshot.json"), JSON.stringify(snapshot));
  return codexStartupWorker({
    mode: "run",
    cwd: root,
    home: join(root, "home"),
    snapshot: join(root, "snapshot.json"),
    model: "test-model",
    timeoutMs: 2000,
    ...options,
  });
};
const transcript = async () =>
  readFile(join(root, "transcript.jsonl"), "utf8").catch(() => "");

describe("mandatory Codex activation gate", () => {
  it("releases task work in the checked session after successful execution and exact context injection", async () => {
    await run();
    const calls = (await transcript())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const turns = calls.filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[0].params.input[0].text).not.toContain(
      "PRIVATE_TICKET_PROMPT",
    );
    expect(turns[1].params.input[0].text).toBe(
      snapshot.instructions + "\n\nPRIVATE_TICKET_PROMPT",
    );
    expect(turns[1].params.threadId).toBe(turns[0].params.threadId);
    expect(
      calls.find((call) => call.method === "thread/start").params.sandbox,
    ).toBe("read-only");
    expect(turns[1].params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(stdout).toContain('"thread_id":"thread-1"');
    expect(stdout).toContain("Task completed");
  });
  it.each([
    ["skill", "Missing skill"],
    ["version", "Plugin activation/version"],
    ["trust", "Untrusted or changed hook"],
    ["approval-state", "Missing or stale hook approval in hooks.state"],
    ["approval-hash", "Missing or stale hook approval in hooks.state"],
    ["post-approval", "Missing or stale hook approval in hooks.state"],
    ["hash", "exact definition changed"],
    ["execution", "Hook sessionStart failed"],
    ["missing", "did not execute successfully"],
    ["context", "did not inject the complete"],
    ["timeout", "timed out"],
    ["post-hash", "exact definition changed"],
    ["post-version", "Plugin activation/version"],
    ["post-source", "Source changed during activation"],
  ])("withholds the task for %s failure", async (mode, message) => {
    failure = mode;
    await expect(
      run({ timeoutMs: mode === "timeout" ? 150 : 2000 }),
    ).rejects.toThrow(message);
    expect(await transcript()).not.toContain("PRIVATE_TICKET_PROMPT");
  });
  it("rejects source drift and writable source mounts before any agent session", async () => {
    await writeFile(
      join(root, "source/ponytail/SKILL.md"),
      "Changed instructions",
    );
    await expect(run()).rejects.toThrow("Host source files changed");
    expect(await transcript()).toBe("");
    mount.writable = true;
    await expect(run()).rejects.toThrow("must be mounted read-only");
  });
  it("proves child instruction injection, reconnects, and gates task work with built-in delegation disabled", async () => {
    snapshot.hooks.push({
      ...snapshot.hooks[0],
      key: "child",
      eventName: "subagentStart",
      displayOrder: 3,
    });
    await run();
    const calls = (await transcript())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === "initialize")).toHaveLength(
      2,
    );
    const resume = calls.find((call) => call.method === "thread/resume");
    expect(resume.params.config.agents).toEqual({ enabled: false });
    const turns = calls.filter((call) => call.method === "turn/start");
    expect(turns).toHaveLength(3);
    expect(turns[0].params.input[0].text).not.toContain(
      "PRIVATE_TICKET_PROMPT",
    );
    expect(turns[1].params.input[0].text).not.toContain(
      "PRIVATE_TICKET_PROMPT",
    );
    expect(turns[2].params.input[0].text).toContain("PRIVATE_TICKET_PROMPT");
  });
  it("rejects instructions that do not match the selected skill files", async () => {
    snapshot.instructions = "Incomplete mandatory instructions";
    await expect(run()).rejects.toThrow("Injected skill instructions differ");
    expect(await transcript()).toBe("");
  });
  it.each([
    [false, "thread/resume"],
    [true, "thread/fork"],
  ])(
    "runs a fresh activation probe for resumed sessions, fork=%s",
    async (forkSession, method) => {
      await run({ resumeSession: "existing-session", forkSession });
      const calls = await transcript();
      expect(calls).toContain(`"method":"${method}"`);
      expect(calls).toContain("mandatory activation probe");
      expect(calls).toContain("PRIVATE_TICKET_PROMPT");
    },
  );
});
