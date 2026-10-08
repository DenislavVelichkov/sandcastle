import type { AgentCommandOptions, CodexOptions } from "./AgentProvider.js";

/** @internal The worker is serialized into the sandbox, so all runtime imports live inside it. */
export async function codexStartupWorker(request: {
  mode: "inspect" | "run";
  cwd?: string;
  home?: string;
  snapshot?: string;
  timeoutMs: number;
  model?: string;
  options?: Pick<
    CodexOptions,
    "effort" | "serviceTier" | "readOnly" | "approvalsReviewer"
  >;
  resumeSession?: AgentCommandOptions["resumeSession"];
  forkSession?: boolean;
}): Promise<any> {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs/promises");
  const { join, relative } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const cwd = request.cwd ?? process.cwd();
  const deadline = Date.now() + request.timeoutMs;
  const timeoutError = () =>
    new Error(
      `Mandatory activation checks timed out after ${request.timeoutMs} ms; ticket work was not released`,
    );
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(timeoutError()),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const fingerprint = async (root: string): Promise<string> => {
    const entries: string[] = [];
    const active = new Set<string>();
    const visit = async (path: string): Promise<void> => {
      const stat = await fs.lstat(path);
      const name = relative(root, path);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(path);
        if (relative(root, target).startsWith(".."))
          throw new Error(`Source symlink escapes its read-only root: ${path}`);
        entries.push(`link:${name}:${await fs.readlink(path)}`);
        return visit(target);
      }
      if (stat.isDirectory()) {
        if (active.has(path)) throw new Error(`Source symlink cycle: ${path}`);
        active.add(path);
        for (const entry of (await fs.readdir(path)).sort())
          if (entry !== ".git") await visit(join(path, entry));
        active.delete(path);
      } else if (stat.isFile())
        entries.push(
          `file:${name}:${stat.mode & 0o777}:${hash(await fs.readFile(path))}`,
        );
      else throw new Error(`Unsupported source file: ${path}`);
    };
    await visit(root);
    return hash(entries.join("\n"));
  };
  let snapshot: any;
  if (request.mode === "run")
    await bounded(async () => {
      if (!request.home || !request.snapshot)
        throw new Error("Missing mandatory startup snapshot");
      snapshot = JSON.parse(await fs.readFile(request.snapshot, "utf8"));
      if (snapshot.version !== 1)
        throw new Error("Unsupported startup snapshot");
      if (
        !snapshot.hooks?.some(
          (hook: any) => hook.startupContext && hook.enabled,
        ) ||
        !snapshot.alwaysSkills?.length
      )
        throw new Error(
          "Missing mandatory instruction hook or every-session skills in startup snapshot",
        );
      // The config and sources are immutable; logs, hook state, and plugin data are private to this container.
      const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");
      const mounts = mountInfo
        .trim()
        .split("\n")
        .map((line) => {
          const fields = line.split(" ");
          return {
            path: fields[4]!.replace(/\\([0-7]{3})/g, (_, octal: string) =>
              String.fromCharCode(parseInt(octal, 8)),
            ),
            ro: fields[5]!.split(",").includes("ro"),
          };
        });
      for (const source of snapshot.sources) {
        const mount = mounts
          .filter(
            (m) =>
              source.path === m.path || source.path.startsWith(`${m.path}/`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!mount?.ro)
          throw new Error(
            `Plugin/skill source must be mounted read-only: ${source.path}`,
          );
        if (mounts.some((m) => m.path.startsWith(source.path + "/") && !m.ro))
          throw new Error(
            `Writable mount inside plugin/skill source: ${source.path}`,
          );
        if ((await fingerprint(source.path)) !== source.sha256)
          throw new Error(
            `Host source files changed or differ in the sandbox: ${source.path}. Restart the launcher to refresh the startup snapshot.`,
          );
      }
      const skillText = await Promise.all(
        snapshot.alwaysSkills.map(async (name: string) => {
          const skill = snapshot.skills.find(
            (skill: any) => skill.name === name && skill.enabled,
          );
          if (
            !skill ||
            !snapshot.sources.some((source: any) =>
              skill.path.startsWith(source.path + "/"),
            )
          )
            throw new Error(
              `Every-session skill is missing, disabled, or outside verified sources: ${name}`,
            );
          return `# Explicit skill: $${name}\n\n${await fs.readFile(skill.path, "utf8")}`;
        }),
      );
      if (
        snapshot.instructions !==
        "Load and apply these instructions in every agent session. Activate the other available skills when their descriptions match the task.\n\n" +
          skillText.join("\n\n")
      )
        throw new Error(
          "Injected skill instructions differ from the verified source files; restart the launcher",
        );
      for (const directory of [
        request.home,
        join(request.home, "plugins/data"),
        process.env.XDG_CONFIG_HOME!,
        process.env.XDG_CACHE_HOME!,
        process.env.XDG_STATE_HOME!,
      ]) {
        if (!directory)
          throw new Error("Missing writable hook storage configuration");
        await fs.mkdir(directory, { recursive: true });
        const proof = join(directory, `.sandcastle-write-${process.pid}`);
        await fs.writeFile(proof, "storage check", { flag: "wx" });
        await fs.unlink(proof);
      }
    });
  let child: import("node:child_process").ChildProcessWithoutNullStreams;
  let disconnect = () => {};
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const notifications: any[] = [];
  let sequence = 0;
  let failure: Error | undefined;
  let work = false;
  let threadId: string | undefined;
  let stderr = "";
  const emit = (value: unknown) =>
    process.stdout.write(JSON.stringify(value) + "\n");
  const kill = () => disconnect();
  const fail = (error: Error) => {
    failure ??= error;
    for (const call of pending.values()) call.reject(failure);
    pending.clear();
  };
  const connect = (disableDelegation = false) => {
    child = spawn(
      "codex",
      [
        "app-server",
        "--stdio",
        ...(disableDelegation ? ["-c", "agents.enabled=false"] : []),
      ],
      {
        cwd,
        env: {
          ...process.env,
          ...(request.home ? { CODEX_HOME: request.home } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const connection = child;
    let stopped = false;
    const lines = createInterface({ input: connection.stdout });
    disconnect = () => {
      stopped = true;
      lines.close();
      try {
        process.platform === "win32"
          ? connection.kill("SIGKILL")
          : process.kill(-connection.pid!, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    connection.stderr.on("data", (value) => {
      stderr = (stderr + String(value)).slice(-4000);
    });
    connection.on("error", (error) => {
      if (!stopped) fail(error);
    });
    connection.on("exit", () => {
      if (!stopped)
        fail(
          new Error(
            `Codex app-server exited during startup or work. ${stderr}`,
          ),
        );
    });
    connection.stdin.on("error", (error) => {
      if (!stopped) fail(error);
    });
    lines.on("line", (line) => {
      if (stopped) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        message.error
          ? call.reject(new Error(message.error.message))
          : call.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // A startup probe must not approve external actions. Normal work also keeps the configured never-approval contract.
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32603,
              message: "Sandcastle startup runner cannot approve this action",
            },
          }) + "\n",
        );
        fail(
          new Error(`Unexpected approval or input request: ${message.method}`),
        );
      } else {
        if (
          message.method === "turn/completed" ||
          (!work &&
            message.method === "item/completed" &&
            message.params?.item?.type === "commandExecution") ||
          message.method?.startsWith("hook/")
        )
          notifications.push(message);
        if (
          message.method === "hook/completed" &&
          message.params?.run?.status !== "completed"
        ) {
          fail(
            new Error(
              `Hook ${message.params.run.eventName} failed (${message.params.run.status}): ${message.params.run.entries?.map((entry: any) => entry.text).join("; ")}`,
            ),
          );
          kill();
        }
        if (work && message.params?.threadId === threadId) {
          if (
            message.method === "item/completed" &&
            message.params.item?.type === "agentMessage"
          )
            emit({
              type: "item.completed",
              item: { type: "agent_message", text: message.params.item.text },
            });
          if (
            message.method === "item/started" &&
            message.params.item?.type === "commandExecution"
          )
            emit({
              type: "item.started",
              item: {
                type: "command_execution",
                command: message.params.item.command,
              },
            });
          if (message.method === "thread/tokenUsage/updated") {
            const usage = message.params.tokenUsage?.last;
            if (usage)
              emit({
                type: "turn.completed",
                usage: {
                  input_tokens: usage.inputTokens,
                  cached_input_tokens: usage.cachedInputTokens,
                  output_tokens: usage.outputTokens,
                },
              });
          }
        }
      }
    });
  };
  const rpc = async (method: string, params: unknown): Promise<any> => {
    if (failure) throw failure;
    const id = ++sequence;
    const response = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return response;
  };
  const waitFor = async (
    predicate: (message: any) => boolean,
    after = 0,
    description?: string,
  ): Promise<any> => {
    while (true) {
      if (failure)
        throw description
          ? new Error(`${description}: ${failure.message}`)
          : failure;
      const message = notifications.slice(after).find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const timeout = setTimeout(
    () => {
      fail(timeoutError());
      kill();
    },
    Math.max(1, deadline - Date.now()),
  );
  const initialize = async (disableDelegation = false) => {
    connect(disableDelegation);
    await rpc("initialize", {
      clientInfo: { name: "sandcastle-startup", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
  };
  try {
    await initialize(
      request.mode === "run" &&
        !snapshot.hooks.some(
          (hook: any) =>
            hook.enabled &&
            ["subagentStart", "subagentStop"].includes(hook.eventName),
        ),
    );
    const inspect = async () => {
      const config = await rpc("config/read", { cwd, includeLayers: true });
      const skills = await rpc("skills/list", {
        cwds: [cwd],
        forceReload: true,
      });
      const plugins = await rpc("plugin/installed", { cwds: [cwd] });
      const hooks = await rpc("hooks/list", { cwds: [cwd] });
      const skillEntry = skills.data?.find((entry: any) => entry.cwd === cwd);
      const hookEntry = hooks.data?.find((entry: any) => entry.cwd === cwd);
      if (
        !skillEntry ||
        !hookEntry ||
        skillEntry.errors?.length ||
        hookEntry.errors?.length ||
        plugins.marketplaceLoadErrors?.length
      )
        throw new Error(
          `Cannot load selected skills, plugins, or hooks: ${JSON.stringify([skillEntry?.errors, hookEntry?.errors, plugins.marketplaceLoadErrors])}`,
        );
      return {
        config,
        skills: skillEntry.skills,
        hooks: hookEntry.hooks,
        plugins: plugins.marketplaces.flatMap((entry: any) =>
          entry.plugins
            .filter((plugin: any) => plugin.installed)
            .map((plugin: any) => ({ ...plugin, marketplacePath: entry.path })),
        ),
      };
    };
    const observed = await inspect();
    if (request.mode === "inspect") return { ...observed, fingerprint };
    const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
    const review = `Review exact definitions on the host: CODEX_HOME=${quote(snapshot.registrationHome ?? request.home)} codex --cd ${quote(snapshot.hostCwd)}, then open /hooks. Restart the launcher after review.`;
    const verify = (observed: any) => {
      const hookStates: Record<string, any> = {};
      for (const layer of (observed.config.layers ?? [])
        .filter((layer: any) => !layer.disabledReason)
        .reverse())
        for (const [key, state] of Object.entries(
          layer.config.hooks?.state ?? {},
        ))
          hookStates[key] = { ...hookStates[key], ...(state as object) };
      for (const expected of snapshot.skills) {
        const actual = observed.skills.find(
          (skill: any) =>
            skill.name === expected.name &&
            [expected.path, expected.sandboxPath].includes(skill.path),
        );
        if (!actual || actual.enabled !== expected.enabled)
          throw new Error(
            `Missing skill or changed intentional disable: ${expected.name}`,
          );
      }
      for (const expected of snapshot.plugins) {
        const actual = observed.plugins.find(
          (plugin: any) => plugin.id === expected.id,
        );
        if (
          !actual ||
          actual.enabled !== expected.enabled ||
          actual.localVersion !== expected.localVersion
        )
          throw new Error(
            `Plugin activation/version differs from host: ${expected.id}`,
          );
      }
      for (const expected of snapshot.hooks) {
        const actual = observed.hooks.find(
          (hook: any) => hook.key === expected.key,
        );
        if (
          !actual ||
          actual.currentHash !== expected.currentHash ||
          actual.enabled !== expected.enabled
        )
          throw new Error(
            `Required hook registration or exact definition changed: ${expected.key}. ${review}`,
          );
        if (
          actual.enabled &&
          !["trusted", "managed"].includes(actual.trustStatus)
        )
          throw new Error(
            `Untrusted or changed hook: ${expected.key}. ${review}`,
          );
        const approvedHash = hookStates[actual.key]?.trusted_hash;
        if (
          actual.enabled &&
          (actual.trustStatus === "trusted" || approvedHash !== undefined) &&
          approvedHash !== actual.currentHash
        )
          throw new Error(
            `Missing or stale hook approval in hooks.state: ${expected.key}. The current definition must match its approved hash. ${review}`,
          );
      }
      if (
        observed.hooks.some(
          (hook: any) =>
            hook.enabled &&
            !snapshot.hooks.some((expected: any) => expected.key === hook.key),
        )
      )
        throw new Error(
          "Hook inventory changed after preparation; restart the launcher",
        );
    };
    verify(observed);
    // Read the ticket from stdin only into this controller; never send it to Codex until activation passes.
    let ticket = "";
    await bounded(async () => {
      for await (const chunk of process.stdin) ticket += chunk;
    });
    const required = snapshot.hooks.filter((hook: any) => hook.enabled);
    const sources = new Set(required.map((hook: any) => hook.eventName));
    const childProbe =
      sources.has("subagentStart") || sources.has("subagentStop");
    const startParams = {
      cwd,
      model: request.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        ...(!childProbe ? { agents: { enabled: false } } : {}),
        ...(request.options?.readOnly ? { project_doc_max_bytes: 0 } : {}),
        ...(request.options?.effort
          ? { model_reasoning_effort: request.options.effort }
          : {}),
        ...(request.options?.serviceTier
          ? { service_tier: request.options.serviceTier }
          : {}),
      },
    };
    const started = request.resumeSession
      ? await rpc(request.forkSession ? "thread/fork" : "thread/resume", {
          ...startParams,
          threadId: request.resumeSession,
        })
      : await rpc("thread/start", {
          ...startParams,
          experimentalRawEvents: false,
        });
    threadId = started.thread.id;
    const prompt = [
      "This is Sandcastle's mandatory activation probe. Do not inspect or perform ticket work, change project files, access external services, or emit a completion promise.",
      "Use the shell tool once to run exactly: printf 'sandcastle activation probe\\n'. Then reply STARTUP_PROBE_COMPLETE.",
      childProbe
        ? "Start one subagent with only this instruction: Reply STARTUP_CHILD_COMPLETE without using tools or doing any work. Wait for it to finish."
        : "",
      "The following skills must already have been loaded by the startup hook: " +
        snapshot.alwaysSkills.join(", "),
    ].join("\n");
    const before = notifications.length;
    const probe = await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    const completed = await waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params.threadId === threadId &&
        message.params.turn.id === probe.turn.id,
      before,
    );
    if (completed.params.turn.status !== "completed")
      throw new Error(
        `Activation probe failed: ${JSON.stringify(completed.params.turn.error)}`,
      );
    const verifyShellProbe = (start: number, root: string, turn: string) => {
      const commands = notifications
        .slice(start)
        .filter(
          (message) =>
            message.method === "item/completed" &&
            message.params?.threadId === root &&
            message.params?.turnId === turn &&
            message.params.item?.type === "commandExecution",
        );
      if (
        commands.length !== 1 ||
        commands[0].params.item.exitCode !== 0 ||
        commands[0].params.item.status !== "completed" ||
        commands[0].params.item.aggregatedOutput?.trim() !==
          "sandcastle activation probe"
      )
        throw new Error(
          "Activation shell probe did not execute successfully with the expected output; ticket work cannot start",
        );
    };
    verifyShellProbe(before, threadId!, probe.turn.id);
    // Built-in delegation has a fail-open SubagentStart contract. Sandcastle's
    // ticket agents use separate guarded invocations; only the harmless probe
    // may exercise Codex's child lifecycle.
    // Hook notifications are authoritative execution and injection receipts, not a model's claim that checks passed.
    const verifyRuns = async (hooks: any[], start = 0) => {
      for (const hook of hooks) {
        const matches = (message: any) =>
          message.params?.run?.sourcePath === hook.sourcePath &&
          message.params.run.displayOrder === hook.displayOrder &&
          message.params.run.eventName === hook.eventName &&
          (["subagentStart", "subagentStop"].includes(hook.eventName) ||
            message.params.threadId === threadId);
        const description = `Required lifecycle event did not execute successfully: ${hook.key} (${hook.eventName}). Check its matcher and the configured probe. Ticket work cannot start`;
        if (
          !notifications
            .slice(start)
            .some(
              (message) =>
                ["hook/started", "hook/completed"].includes(message.method) &&
                matches(message),
            )
        )
          throw new Error(description);
        const run = await waitFor(
          (message) => message.method === "hook/completed" && matches(message),
          start,
          description,
        );
        if (
          hook.startupContext &&
          !run.params.run.entries.some(
            (entry: any) =>
              entry.kind === "context" && entry.text === snapshot.instructions,
          )
        )
          throw new Error(
            `Startup hook did not inject the complete required skill instructions: ${hook.key}`,
          );
      }
    };
    await verifyRuns(required);
    if (childProbe) {
      // An in-memory thread/resume ignores reloads. Reconnect before resuming
      // the persisted thread, then prove root activation with delegation off.
      kill();
      await initialize(true);
      const rootBefore = notifications.length;
      await rpc("thread/resume", {
        ...startParams,
        threadId,
        config: {
          ...startParams.config,
          agents: { enabled: false },
        },
      });
      const rootProbe = await rpc("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: prompt.replace(
              "Start one subagent with only this instruction: Reply STARTUP_CHILD_COMPLETE without using tools or doing any work. Wait for it to finish.",
              "All ticket agents run through Sandcastle's startup gate. Built-in delegation is disabled in this session.",
            ),
          },
        ],
      });
      const rootCompleted = await waitFor(
        (message) =>
          message.method === "turn/completed" &&
          message.params.threadId === threadId &&
          message.params.turn.id === rootProbe.turn.id,
        rootBefore,
      );
      if (rootCompleted.params.turn.status !== "completed")
        throw new Error(
          `Resumed activation probe failed: ${JSON.stringify(rootCompleted.params.turn.error)}`,
        );
      verifyShellProbe(rootBefore, threadId!, rootProbe.turn.id);
      await verifyRuns(
        required.filter(
          (hook: any) =>
            !["subagentStart", "subagentStop"].includes(hook.eventName),
        ),
        rootBefore,
      );
    }
    // Re-read registration/trust after execution, and recheck files before releasing the ticket.
    const after = await inspect();
    verify(after);
    const delegation = after.config.layers
      ?.filter((layer: any) => !layer.disabledReason)
      .find((layer: any) => typeof layer.config.agents?.enabled === "boolean")
      ?.config.agents.enabled;
    if (delegation !== false)
      throw new Error(
        "Built-in delegation must be disabled for ticket work; every ticket agent must use the Sandcastle startup gate",
      );
    for (const hook of required)
      if (
        !after.hooks.some(
          (actual: any) =>
            actual.key === hook.key &&
            actual.currentHash === hook.currentHash &&
            actual.enabled &&
            ["trusted", "managed"].includes(actual.trustStatus),
        )
      )
        throw new Error(`Hook changed during startup: ${hook.key}`);
    for (const source of snapshot.sources)
      if ((await fingerprint(source.path)) !== source.sha256)
        throw new Error(`Source changed during activation: ${source.path}`);
    clearTimeout(timeout);
    process.stderr.write(
      "Sandcastle activation checks passed. Releasing ticket work.\n",
    );
    work = true;
    emit({ type: "thread.started", thread_id: threadId });
    const workBefore = notifications.length;
    const turn = await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: snapshot.instructions + "\n\n" + ticket }],
      sandboxPolicy: {
        type: request.options?.readOnly ? "readOnly" : "dangerFullAccess",
      },
    });
    const result = await waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params.threadId === threadId &&
        message.params.turn.id === turn.turn.id,
      workBefore,
    );
    if (result.params.turn.status !== "completed")
      throw new Error(
        `Codex work failed: ${JSON.stringify(result.params.turn.error)}`,
      );
  } finally {
    clearTimeout(timeout);
    kill();
  }
}
