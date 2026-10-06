import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCodexStartup } from "./codexStartup.js";

const mock = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("./codexStartupWorker.js", () => ({
  codexStartupWorker: mock.inspect,
}));
let root: string;
let home: string;
let host: any;
let selection: any;
let previousStates: any;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadata = (document: any, path: string) => {
  let order = 0;
  return Object.entries(document.hooks).flatMap(([event, groups]) =>
    (groups as any[]).flatMap((group) =>
      group.hooks.map((handler: any) => ({
        key: `${path}::${order}`,
        sourcePath: path,
        displayOrder: order++,
        eventName: event[0]!.toLowerCase() + event.slice(1),
        command: handler.command,
        enabled: true,
        trustStatus: "untrusted",
        currentHash: digest({ event, matcher: group.matcher, handler }),
      })),
    ),
  );
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "startup-preparation-"));
  home = join(root, "host");
  await mkdir(home);
  vi.stubEnv("CODEX_HOME", home);
  const plugins = [
    {
      id: "ponytail@example",
      name: "ponytail",
      localVersion: "1.0.0",
      enabled: true,
    },
    {
      id: "cursor-codex@example",
      name: "cursor-codex",
      localVersion: "1.0.0",
      enabled: true,
    },
    {
      id: "optional@example",
      name: "optional",
      localVersion: "1.0.0",
      enabled: false,
    },
  ];
  const skills = [];
  for (const [plugin, name] of [
    [plugins[0]!, "ponytail"],
    [plugins[1]!, "unslop"],
  ] as const) {
    const source = join(home, "plugins/cache/example", plugin.name, "1.0.0");
    await mkdir(join(source, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(source, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: plugin.name }),
    );
    const path = join(source, "skills", name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${name} full instructions`);
    skills.push({
      name: `${plugin.name}:${name}`,
      path,
      pluginId: plugin.id,
      enabled: true,
    });
    if (name === "ponytail") {
      await mkdir(join(source, "hooks"));
      await writeFile(
        join(source, "hooks/legacy.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: 'node "$PLUGIN_ROOT/hooks/activate.js"',
                  },
                ],
              },
            ],
          },
        }),
      );
    }
  }
  const disabledPath = join(home, "skills/optional/SKILL.md");
  await mkdir(dirname(disabledPath), { recursive: true });
  await writeFile(disabledPath, "Optional instructions");
  skills.push({ name: "optional", path: disabledPath, enabled: false });
  const document = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "printf unchanged" }] },
        {
          hooks: [
            { type: "command", command: "printf intentionally-disabled" },
          ],
        },
      ],
    },
  };
  await writeFile(join(home, "hooks.json"), JSON.stringify(document));
  const hooks = metadata(document, join(home, "hooks.json"));
  hooks[0]!.trustStatus = "trusted";
  hooks[1]!.enabled = false;
  host = {
    skills,
    plugins,
    hooks,
    config: {
      layers: [
        {
          config: {
            hooks: {
              state: {
                [hooks[0]!.key]: { trusted_hash: hooks[0]!.currentHash },
                [hooks[1]!.key]: { enabled: false },
              },
            },
          },
        },
      ],
    },
    fingerprint: async () => "source-fingerprint",
  };
  selection = {
    version: 1,
    plugins: "host",
    skills: "host",
    alwaysSkills: ["ponytail", "unslop"],
    hookFiles: [{ pluginId: "ponytail@example", path: "hooks/legacy.json" }],
    timeoutMs: 5000,
  };
  previousStates = {};
  mock.inspect.mockImplementation(async (request: any) => {
    if (request.home === home) return host;
    const hooksPath = join(request.home, "hooks.json");
    const hooks = await readFile(hooksPath, "utf8").then(
      (text) => metadata(JSON.parse(text), hooksPath),
      () => [],
    );
    return {
      ...host,
      hooks,
      config: { layers: [{ config: { hooks: { state: previousStates } } }] },
    };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});
const prepare = async () => {
  await writeFile(join(root, "startup.json"), JSON.stringify(selection));
  return prepareCodexStartup({ cwd: root, selectionFile: "startup.json" });
};
describe("Codex startup preparation", () => {
  it("registers legacy hooks with writable data and mounts all plugin/skill sources read-only", async () => {
    const prepared = await prepare();
    expect(prepared.mounts.every((mount) => mount.readonly)).toBe(true);
    expect(
      prepared.mounts.some(
        (mount) => mount.hostPath === join(home, "plugins/cache"),
      ),
    ).toBe(true);
    expect(
      prepared.mounts.some(
        (mount) => mount.sandboxPath === "/home/agent/.codex/config.toml",
      ),
    ).toBe(true);
    expect(
      prepared.mounts.some(
        (mount) => mount.sandboxPath === "/home/agent/.codex/plugins/data",
      ),
    ).toBe(false);
    expect(prepared.env.CODEX_HOME).toBe("/home/agent/.codex");
    const snapshot = JSON.parse(
      await readFile(join(root, "startup/snapshot.json"), "utf8"),
    );
    expect(snapshot.instructions).toContain("ponytail full instructions");
    expect(snapshot.instructions).toContain("unslop full instructions");
    expect(
      snapshot.skills.find((skill: any) => skill.name === "optional").enabled,
    ).toBe(false);
    expect(
      snapshot.plugins.find((plugin: any) => plugin.id === "optional@example")
        .enabled,
    ).toBe(false);
    const generated = JSON.parse(
      await readFile(join(root, "startup/hooks.json"), "utf8"),
    );
    const legacy = generated.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(legacy).toContain("PLUGIN_ROOT=");
    expect(legacy).toContain("PLUGIN_DATA=");
    expect(legacy).toContain('mkdir -p "$PLUGIN_DATA"');
    for (const event of ["SessionStart", "SubagentStart"]) {
      expect(generated.hooks[event][0].hooks[0].additionalContextLimit).toBe(0);
      expect(generated.hooks[event][0].hooks[0].command).toContain(
        "Startup skill instructions changed",
      );
    }
  });
  it.each(["trusted", "managed"])(
    "preserves unchanged %s approval and intentional hook disables without trusting new definitions",
    async (trust) => {
      host.hooks[0].trustStatus = trust;
      const prepared = await prepare();
      const snapshot = JSON.parse(
        await readFile(join(root, "startup/snapshot.json"), "utf8"),
      );
      const config = await readFile(join(root, "startup/config.toml"), "utf8");
      const unchanged = snapshot.hooks.find(
        (hook: any) => hook.command === "printf unchanged",
      );
      const disabled = snapshot.hooks.find(
        (hook: any) => hook.command === "printf intentionally-disabled",
      );
      expect(config).toContain(
        `"${unchanged.key}" = { "trusted_hash" = "${unchanged.currentHash}", "enabled" = true }`,
      );
      expect(config).toContain(`"${disabled.key}" = { "enabled" = false }`);
      for (const hook of snapshot.hooks.filter(
        (hook: any) => hook.startupContext,
      ))
        expect(config).not.toContain(`"trusted_hash" = "${hook.currentHash}"`);
    },
  );
  it("retains project-home review state on a subsequent preparation", async () => {
    await mkdir(join(root, "startup"));
    await writeFile(join(root, "startup/config.toml"), "# reviewed fixture\n");
    previousStates = {
      "reviewed-project-hook": {
        trusted_hash: "exact-reviewed-definition",
        enabled: true,
      },
    };
    await prepare();
    expect(await readFile(join(root, "startup/config.toml"), "utf8")).toContain(
      '"reviewed-project-hook" = { "trusted_hash" = "exact-reviewed-definition", "enabled" = true }',
    );
  });
  it("carries the complete host hook state into the mounted config at the container plugin path", async () => {
    const pluginRoot = dirname(dirname(dirname(host.skills[0].path)));
    const hostKey = `${pluginRoot}/hooks/hooks.json:session_start:0:0`;
    const containerKey = hostKey.replace(home, "/home/agent/.codex");
    const approval = {
      trusted_hash: "previously-approved-plugin-definition",
      enabled: true,
    };
    host.config.layers[0].config.hooks.state[hostKey] = approval;

    const prepared = await prepare();
    const configMount = prepared.mounts.find(
      (mount) => mount.sandboxPath === "/home/agent/.codex/config.toml",
    )!;
    const config = await readFile(configMount.hostPath, "utf8");
    expect(configMount.readonly).toBe(true);
    expect(config).toContain('"hooks" = { "state" = {');
    for (const key of [hostKey, containerKey])
      expect(config).toContain(
        `"${key}" = { "trusted_hash" = "${approval.trusted_hash}", "enabled" = true }`,
      );
  });
  it.each(["untrusted", "trusted"])(
    "retains a stale approved hash without approving a %s current definition",
    async (trust) => {
      const hook = host.hooks[0];
      hook.trustStatus = trust;
      host.config.layers[0].config.hooks.state[hook.key].trusted_hash =
        "old-approved-definition";
      await prepare();
      const config = await readFile(join(root, "startup/config.toml"), "utf8");
      expect(config).toContain(
        `"${hook.key}" = { "trusted_hash" = "old-approved-definition" }`,
      );
      expect(config).not.toContain(`"trusted_hash" = "${hook.currentHash}"`);
    },
  );
  it("does not transfer an approval when the matcher changes but the command stays the same", async () => {
    const path = join(home, "hooks.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    document.hooks.Stop[0].matcher = "changed-matcher";
    await writeFile(path, JSON.stringify(document));
    await prepare();
    const snapshot = JSON.parse(
      await readFile(join(root, "startup/snapshot.json"), "utf8"),
    );
    const changed = snapshot.hooks.find(
      (hook: any) => hook.command === "printf unchanged",
    );
    expect(changed.currentHash).not.toBe(host.hooks[0].currentHash);
    const config = await readFile(join(root, "startup/config.toml"), "utf8");
    expect(config).not.toContain(`"trusted_hash" = "${changed.currentHash}"`);
  });
  it("stops for an intentionally disabled every-session skill without re-enabling it", async () => {
    host.skills[0].enabled = false;
    await expect(prepare()).rejects.toThrow("intentionally disabled: ponytail");
    expect(host.skills[0].enabled).toBe(false);
  });
  it("stops for missing required plugins and hook files", async () => {
    selection.plugins = ["missing@example"];
    await expect(prepare()).rejects.toThrow("missing on the host");
    selection.plugins = "host";
    selection.hookFiles[0].path = "hooks/missing.json";
    await expect(prepare()).rejects.toThrow("ENOENT");
  });
});
