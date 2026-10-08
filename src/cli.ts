import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import { withBenchmarkActivity } from "./benchmark.js";
import { writeBenchmarkReport } from "./benchmarkReport.js";
import { benchmarkPostRunInstructions } from "./benchmarkPostRun.js";
import { planTicketBenchmark, runTicketBenchmark } from "./ticketBenchmark.js";
import {
  cancelBenchmark,
  readBenchmarkLog,
  readBenchmarkProgress,
  resumeTicketBenchmark,
  watchBenchmarkProgress,
} from "./benchmarkProgress.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { ConfigDirError, InitError } from "./errors.js";
import { VERSION } from "./version.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .sandcastle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. codex)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. gpt-6.1-sol). Defaults to the agent's default model",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription("Sandbox provider to use (e.g. docker, podman)"),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );

      const isInteractive = process.stdin.isTTY === true;
      const failIfNonInteractive = (flag: string) =>
        Effect.fail(
          new InitError({
            message: `${flag} is required in non-interactive mode (no TTY detected).`,
          }),
        );

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts above.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") return params.choice.value;
          if (!isInteractive) {
            yield* failIfNonInteractive(params.flag);
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            yield* Effect.fail(
              new InitError({ message: params.cancelMessage }),
            );
          }
          return confirmed === true;
        });

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "codex",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () =>
              execSync(
                'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
                { cwd, stdio: "ignore" },
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
        }),
      );

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

      // If the chosen template imports zod on the host (the planner templates
      // build their <plan> output schema with it) and the host doesn't already
      // declare it, offer to install it. Without this, the very first
      // `npx tsx .sandcastle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (!alreadyInstalled) {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc.
      const providerLabel = selectedSandboxProvider.label;
      if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const containerfileDir = join(cwd, CONFIG_DIR);
          if (selectedSandboxProvider.name === "podman") {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              podmanBuildImage(imageName, containerfileDir),
            );
          } else {
            yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              buildImage(imageName, containerfileDir, {
                buildArgs: defaultUidBuildArgs(),
              }),
            );
          }
          yield* d.status(
            "Init complete! Image built successfully.",
            "success",
          );
        } else {
          yield* d.status(
            `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
            "success",
          );
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Root command ---

const benchmarkCommand = Command.make(
  "benchmark",
  {
    project: Options.text("project").pipe(
      Options.withDescription(
        "Project directory independent of the launch directory",
      ),
      Options.optional,
    ),
    repository: Options.text("repository").pipe(
      Options.withDescription("Intended GitHub owner/repo for issue inputs"),
      Options.optional,
    ),
    prompt: Options.text("prompt").pipe(
      Options.withDescription(
        "Explicit input or fallback for a confirmed missing ticket",
      ),
      Options.optional,
    ),
    judge: Options.text("judge").pipe(
      Options.withDescription(
        "Independent judge model:effort (default: gpt-6.1-sol:xhigh)",
      ),
      Options.optional,
    ),
    contract: Options.text("contract").pipe(
      Options.withDescription(
        "Project-relative launch contract JSON with rubric and readiness probes",
      ),
      Options.optional,
    ),
    preflight: Options.boolean("preflight").pipe(
      Options.withDescription(
        "Observe actual worker readiness without inference; print the frozen plan",
      ),
    ),
    ticket: Options.text("ticket").pipe(
      Options.withDescription(
        "Ticket file, GitHub issue URL or issue number; repeat for multiple tickets",
      ),
      Options.repeated,
    ),
    arm: Options.text("arm").pipe(
      Options.withDescription(
        "Model:effort; replaces defaults (Astra medium, high, xhigh, max); ExtraHigh/extra-high/extra_high mean xhigh",
      ),
      Options.repeated,
    ),
    base: Options.text("base").pipe(
      Options.withDescription("Git commit or ref to start candidates from"),
      Options.optional,
    ),
    image: Options.text("image").pipe(
      Options.withDescription("Docker worker image"),
      Options.optional,
    ),
    prepare: Options.text("prepare").pipe(
      Options.withDescription("Sandbox setup command before each model call"),
      Options.optional,
    ),
    check: Options.text("check").pipe(
      Options.withDescription(
        "Independent sandbox check after each model call",
      ),
      Options.optional,
    ),
    output: Options.text("output").pipe(
      Options.withDescription("Host evidence directory"),
      Options.optional,
    ),
    maxMinutes: Options.text("max-minutes").pipe(
      Options.withDescription("Model-call window in minutes (default: 60)"),
      Options.optional,
    ),
    maxNewSlots: Options.text("max-new-slots").pipe(
      Options.withDescription(
        "Maximum new evaluation slots per dispatch; frozen in the plan",
      ),
      Options.optional,
    ),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDescription(
        "Print the frozen plan without making model calls",
      ),
    ),
  },
  ({
    project,
    repository,
    prompt,
    judge,
    contract,
    preflight,
    ticket,
    arm,
    base,
    image,
    prepare,
    check,
    output,
    maxMinutes,
    maxNewSlots,
    dryRun,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const optional = (value: Option.Option<string>) =>
        value._tag === "Some" ? value.value : undefined;
      if (dryRun && preflight) {
        return yield* Effect.fail(
          new InitError({
            message:
              "Choose --dry-run for scheduling or --preflight for worker readiness",
          }),
        );
      }
      const plan = yield* Effect.tryPromise({
        try: () =>
          planTicketBenchmark({
            cwd: process.cwd(),
            project: optional(project),
            repository: optional(repository),
            prompt: optional(prompt),
            judge: optional(judge),
            contract: optional(contract),
            preflight: preflight || !dryRun,
            maxNewSlots:
              maxNewSlots._tag === "Some"
                ? Number(maxNewSlots.value)
                : undefined,
            tickets: ticket,
            arms: arm,
            base: optional(base),
            image: optional(image),
            prepare: optional(prepare),
            check: optional(check),
            output: optional(output),
            maxMinutes:
              maxMinutes._tag === "Some" ? Number(maxMinutes.value) : undefined,
          }),
        catch: (error) => new InitError({ message: String(error) }),
      });
      if (dryRun || preflight) {
        console.log(JSON.stringify(plan, null, 2));
        if (preflight && plan.readiness?.status === "blocked")
          process.exitCode = 1;
        return;
      }
      yield* d.status(
        `Benchmarking ${plan.tickets.map((item) => item.source).join(", ")} with ${plan.arms.map((item) => `${item.model}:${item.effort}`).join(", ")}; ${plan.slots.length} implementation slots planned`,
        "info",
      );
      const result = yield* Effect.tryPromise({
        try: async () => {
          return withBenchmarkInterrupt((signal) =>
            runTicketBenchmark(
              plan,
              undefined,
              maxNewSlots._tag === "Some"
                ? Number(maxNewSlots.value)
                : Infinity,
              { signal },
            ),
          );
        },
        catch: (error) => new InitError({ message: String(error) }),
      });
      yield* d.status(
        `${result.status}: ${result.completed}/${plan.slots.length} slots attempted`,
        result.status === "complete" ? "success" : "info",
      );
      for (const line of benchmarkPostRunInstructions(result.output))
        yield* d.status(line, "info");
      if (result.status !== "judge-pending" && result.status !== "complete")
        process.exitCode = result.status === "cancelled" ? 130 : 1;
    }),
);

const benchmarkReportCommand = Command.make(
  "benchmark-report",
  {
    directory: Options.text("directory").pipe(
      Options.withDescription("Absolute host benchmark directory"),
    ),
    policyId: Options.text("policy-id").pipe(
      Options.withDescription(
        "Frozen policy identity, required only for historical pilot reports",
      ),
      Options.optional,
    ),
    output: Options.text("output").pipe(
      Options.withDescription("Local output directory for HTML, JSON and CSV"),
    ),
    manifest: Options.text("manifest").pipe(
      Options.withDescription("Frozen host manifest JSON"),
      Options.optional,
    ),
  },
  ({ directory, policyId, output, manifest }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const files = yield* Effect.tryPromise({
        try: () => {
          const id = policyId._tag === "Some" ? policyId.value : undefined;
          const generate = () =>
            writeBenchmarkReport({
              directory,
              policyId: id,
              outputDirectory: output,
              ...(manifest._tag === "Some"
                ? { manifestPath: manifest.value }
                : {}),
            });
          return id
            ? withBenchmarkActivity(
                directory,
                id,
                "benchmark-report",
                5 * 60_000,
                generate,
              )
            : generate();
        },
        catch: (error) => new InitError({ message: String(error) }),
      });
      if (policyId._tag === "Some") {
        yield* d.status(`Report: ${files.html}`, "success");
        yield* d.status(`Evidence: ${files.json}, ${files.csv}`, "info");
      } else {
        for (const line of benchmarkPostRunInstructions(
          directory,
          dirname(files.html),
        ))
          yield* d.status(line, "info");
      }
    }),
);

const benchmarkDirectoryOption = Options.text("directory").pipe(
  Options.withDescription(
    "Original external implementation benchmark directory",
  ),
);
const withBenchmarkInterrupt = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const interrupt = () => controller.abort("Host received SIGINT");
  const terminate = () => controller.abort("Host received SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
};
const benchmarkStatusCommand = Command.make(
  "benchmark-status",
  {
    directory: benchmarkDirectoryOption,
    after: Options.text("after").pipe(
      Options.withDescription("Last observed sequence cursor; default 0"),
      Options.optional,
    ),
    watch: Options.boolean("watch").pipe(
      Options.withDescription(
        "Observe saved progress until ownership ends; disconnecting leaves execution active",
      ),
    ),
    logAttempt: Options.text("log-attempt").pipe(
      Options.withDescription(
        "Explicitly read this attempt's bounded private log tail",
      ),
      Options.optional,
    ),
    logRole: Options.choice("log-role", [
      "implementation",
      "checks",
      "judge",
    ]).pipe(Options.withDefault("implementation")),
  },
  ({ directory, after, watch, logAttempt, logRole }) =>
    Effect.tryPromise({
      try: async () => {
        if (logAttempt._tag === "Some") {
          if (watch)
            throw new Error(
              "Choose either passive progress watch or a private log tail",
            );
          console.log(
            JSON.stringify({
              attemptId: logAttempt.value,
              role: logRole,
              privateLog: await readBenchmarkLog(
                resolve(directory),
                logAttempt.value,
                logRole,
              ),
            }),
          );
          return;
        }
        const cursor = after._tag === "Some" ? Number(after.value) : 0;
        if (!watch) {
          console.log(
            JSON.stringify(
              await readBenchmarkProgress(resolve(directory), {
                after: cursor,
              }),
            ),
          );
          return;
        }
        await withBenchmarkInterrupt(async (signal) => {
          for await (const progress of watchBenchmarkProgress(
            resolve(directory),
            { after: cursor, signal },
          ))
            console.log(JSON.stringify(progress));
        });
      },
      catch: (error) => new InitError({ message: String(error) }),
    }),
);
const benchmarkCancelCommand = Command.make(
  "benchmark-cancel",
  {
    directory: benchmarkDirectoryOption,
    reason: Options.text("reason").pipe(
      Options.withDescription(
        "Persist the reason for stopping this run's owned operations",
      ),
    ),
  },
  ({ directory, reason }) =>
    Effect.tryPromise({
      try: async () => {
        console.log(
          JSON.stringify(await cancelBenchmark(resolve(directory), reason)),
        );
      },
      catch: (error) => new InitError({ message: String(error) }),
    }),
);
const benchmarkResumeCommand = Command.make(
  "benchmark-resume",
  {
    directory: benchmarkDirectoryOption,
    retryAttempt: Options.text("retry-attempt").pipe(
      Options.withDescription(
        "Explicitly retry one failed/interrupted attempt with a new linked identity",
      ),
      Options.optional,
    ),
    rejudgeAssessment: Options.text("rejudge-assessment").pipe(
      Options.withDescription(
        "Create a new linked assessment under the unchanged frozen judge and rubric",
      ),
      Options.optional,
    ),
    rejudgeReason: Options.text("reason").pipe(
      Options.withDescription("Required reason for explicit rejudging"),
      Options.optional,
    ),
    maxNewSlots: Options.text("max-new-slots").pipe(
      Options.withDescription(
        "Dispatch limit within the original frozen maximum",
      ),
      Options.optional,
    ),
  },
  ({
    directory,
    retryAttempt,
    rejudgeAssessment,
    rejudgeReason,
    maxNewSlots,
  }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await withBenchmarkInterrupt((signal) =>
          resumeTicketBenchmark(
            resolve(directory),
            {
              retryAttemptId:
                retryAttempt._tag === "Some" ? retryAttempt.value : undefined,
              rejudgeAssessmentId:
                rejudgeAssessment._tag === "Some"
                  ? rejudgeAssessment.value
                  : undefined,
              rejudgeReason:
                rejudgeReason._tag === "Some" ? rejudgeReason.value : undefined,
              maxNewSlots:
                maxNewSlots._tag === "Some"
                  ? Number(maxNewSlots.value)
                  : undefined,
            },
            { signal },
          ),
        );
        console.log(JSON.stringify(result));
        for (const line of benchmarkPostRunInstructions(result.output))
          console.error(line);
        if (!["judge-pending", "complete"].includes(result.status))
          process.exitCode = result.status === "cancelled" ? 130 : 1;
      },
      catch: (error) => new InitError({ message: String(error) }),
    }),
);

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    dockerCommand,
    podmanCommand,
    benchmarkCommand,
    benchmarkReportCommand,
    benchmarkStatusCommand,
    benchmarkCancelCommand,
    benchmarkResumeCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
