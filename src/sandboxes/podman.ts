/**
 * Podman sandbox provider — creates Podman containers with bind-mounts.
 *
 * Usage:
 *   import { podman } from "sandcastle/sandboxes/podman";
 *   await run({ agent: claudeCode("claude-opus-4-8"), sandbox: podman() });
 */

import {
  execFile,
  execFileSync,
  spawn,
  type StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
  type InteractiveExecOptions,
} from "../SandboxProvider.js";
import type { MountConfig } from "../MountConfig.js";
import type { SelinuxLabel } from "../mountUtils.js";
import {
  defaultImageName,
  resolveUserMounts,
  formatVolumeMount,
  processFileMountParents,
} from "../mountUtils.js";
import { MAX_TAIL_CHARS } from "../boundedTail.js";
import { collectProcessOutput } from "../collectProcessOutput.js";
import { registerShutdown } from "../shutdownRegistry.js";

const execFileAsync = promisify(execFile);

export interface PodmanOptions {
  /** Podman image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * SELinux volume label suffix applied to bind mounts.
   *
   * - `"z"` — shared label (default). No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: SelinuxLabel;
  /**
   * User namespace mode for rootless Podman.
   *
   * - `"keep-id"` (default) — maps host UID to `containerUid` inside the
   *   container via `--userns=keep-id:uid=N,gid=N`, so both bind-mounted
   *   files and image-built files have correct ownership without chown.
   * - `false` — disable; use for rootful Podman setups.
   */
  readonly userns?: "keep-id" | false;
  /**
   * The UID of the `agent` user inside the container image (default: 1000).
   *
   * Must match the UID set in the Containerfile. Used with `--userns=keep-id`
   * to map the host user to this UID inside the container.
   */
  readonly containerUid?: number;
  /**
   * The GID of the `agent` user inside the container image (default: 1000).
   *
   * Must match the GID set in the Containerfile. Used with `--userns=keep-id`
   * to map the host group to this GID inside the container.
   */
  readonly containerGid?: number;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
  /**
   * Podman network(s) to attach the container to.
   *
   * - `"my-network"` → `--network my-network`
   * - `["net1", "net2"]` → `--network net1 --network net2`
   *
   * When omitted, Podman's default network is used.
   */
  readonly network?: string | readonly string[];
  /**
   * Supplementary groups to add the container user to, via `--group-add`.
   *
   * Accepts group names or numeric GIDs:
   *
   * - `["docker"]` → `--group-add docker`
   * - `[999]` → `--group-add 999`
   * - `["docker", 999]` → `--group-add docker --group-add 999`
   *
   * Useful for granting access to a bind-mounted Docker socket (Docker-outside-of-Docker).
   * When omitted, no `--group-add` flags are added.
   */
  readonly groups?: readonly (string | number)[];
  /**
   * Host devices to expose to the container, via `--device`.
   *
   * Each entry is a full device spec in `host[:container[:permissions]]` form:
   *
   * - `["/dev/kvm"]` → `--device /dev/kvm`
   * - `["/dev/sda:/dev/xvda:rwm"]` → `--device /dev/sda:/dev/xvda:rwm`
   * - `["/dev/kvm", "/dev/fuse"]` → `--device /dev/kvm --device /dev/fuse`
   *
   * Under rootless Podman, exposing a host device often requires host-side
   * group/permission setup and may interact with `--userns=keep-id`.
   * When omitted, no `--device` flags are added.
   */
  readonly devices?: readonly string[];
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
  /**
   * Limit the CPU resources available to the container, via `--cpus`.
   *
   * Maps directly to `podman run --cpus`. Accepts fractional values:
   *
   * - `2` → `--cpus 2` (at most 2 CPUs)
   * - `1.5` → `--cpus 1.5` (at most 1.5 CPUs)
   *
   * When omitted, no `--cpus` flag is added and the container is unconstrained.
   */
  readonly cpus?: number;
}

/**
 * Create a Podman sandbox provider.
 *
 * The returned provider creates Podman containers with bind-mounts
 * for the worktree and git directories. Calls the `podman` binary
 * on PATH directly. On macOS/Windows, verifies that a Podman Machine
 * is running before container creation.
 */
export const podman = (options?: PodmanOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const userns = options?.userns ?? "keep-id";
  const containerUid = options?.containerUid ?? 1000;
  const containerGid = options?.containerGid ?? 1000;
  const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;
  const sandboxHomedir = "/home/agent";
  const userMounts = options?.mounts
    ? resolveUserMounts(options.mounts, sandboxHomedir)
    : [];
  // Validate file mounts and collect parent dirs to create at container start.
  // Throws at construction time if any file mount parent is outside sandboxHomedir.
  const parentDirsToCreate = processFileMountParents(
    userMounts,
    sandboxHomedir,
  );

  return createBindMountSandboxProvider({
    name: "podman",
    env: options?.env,
    sandboxHomedir,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const worktreePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings with optional SELinux label (internal + user mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) =>
        formatVolumeMount(m, selinuxLabel),
      );

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      // Pre-flight: check Podman Machine on macOS/Windows
      if (process.platform === "darwin" || process.platform === "win32") {
        await checkPodmanMachine();
      }

      // Pre-flight: verify image exists locally
      await checkImageExists(imageName);

      const env = { ...createOptions.env, HOME: "/home/agent" };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]);
      const volumeArgs = volumeMounts.flatMap((v) => ["-v", v]);
      const usernsArgs = userns
        ? [`--userns=keep-id:uid=${containerUid},gid=${containerGid}`]
        : [];
      const userArgs = ["--user", `${containerUid}:${containerGid}`];
      const networks = options?.network
        ? Array.isArray(options.network)
          ? options.network
          : [options.network]
        : [];
      const networkArgs = networks.flatMap((n) => ["--network", n]);
      const groupArgs = (options?.groups ?? []).flatMap((g) => [
        "--group-add",
        String(g),
      ]);
      const deviceArgs = (options?.devices ?? []).flatMap((d) => [
        "--device",
        d,
      ]);
      const cpusArgs =
        options?.cpus !== undefined ? ["--cpus", String(options.cpus)] : [];

      // Start container via podman run
      await execFileAsync("podman", [
        "run",
        "-d",
        "--name",
        containerName,
        ...userArgs,
        ...usernsArgs,
        ...networkArgs,
        ...groupArgs,
        ...deviceArgs,
        ...cpusArgs,
        "-w",
        worktreePath,
        ...envArgs,
        ...volumeArgs,
        "--entrypoint",
        "sleep",
        imageName,
        "infinity",
      ]).catch((error: Error) => {
        throw new Error(`podman run failed: ${error.message}`);
      });

      // Create parent directories for file mounts and chown to the container user
      for (const dir of parentDirsToCreate) {
        await execFileAsync("podman", [
          "exec",
          "--user",
          "0:0",
          containerName,
          "sh",
          "-c",
          `mkdir -p "$1" && chown "$2" "$1"`,
          "sh",
          dir,
          `${containerUid}:${containerGid}`,
        ]).catch((error: Error) => {
          throw new Error(
            `Failed to create parent directory '${dir}' in container: ${error.message}`,
          );
        });
      }

      // Register synchronous container cleanup via the shared shutdown registry
      // so concurrent sandboxes share a single exit/SIGINT/SIGTERM listener
      // instead of tripping Node's MaxListenersExceededWarning.
      const removeContainerSync = () => {
        try {
          execFileSync("podman", ["rm", "-f", containerName], {
            stdio: "ignore",
            timeout: 5000,
          });
        } catch {
          /* best-effort */
        }
      };
      const unregisterShutdown = registerShutdown(removeContainerSync);

      const handle: BindMountSandboxHandle = {
        worktreePath,

        exec: async (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
            stdin?: string;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.stdin !== undefined) args.push("-i");
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          const proc = spawn("podman", args, {
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
          });
          return collectProcessOutput(proc, {
            stdin: opts?.stdin,
            onLine: opts?.onLine,
            maxOutputTailChars,
            errorPrefix: "podman exec failed",
          });
        },

        interactiveExec: (
          args: string[],
          opts: InteractiveExecOptions,
        ): Promise<{ exitCode: number }> => {
          return new Promise((resolve, reject) => {
            const podmanArgs = ["exec"];
            // Allocate a pseudo-terminal when stdin looks like a TTY
            if (
              "isTTY" in opts.stdin &&
              (opts.stdin as { isTTY?: boolean }).isTTY
            ) {
              podmanArgs.push("-it");
            } else {
              podmanArgs.push("-i");
            }
            if (opts.cwd) podmanArgs.push("-w", opts.cwd);
            podmanArgs.push(containerName, ...args);

            const proc = spawn("podman", podmanArgs, {
              stdio: [opts.stdin, opts.stdout, opts.stderr] as StdioOptions,
            });

            proc.on("error", (error: Error) => {
              reject(new Error(`podman exec failed: ${error.message}`));
            });

            proc.on("close", (code: number | null) => {
              resolve({ exitCode: code ?? 0 });
            });
          });
        },

        copyFileIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          await execFileAsync("podman", [
            "cp",
            hostPath,
            `${containerName}:${sandboxPath}`,
          ]).catch((error: Error) => {
            throw new Error(`podman cp (in) failed: ${error.message}`);
          });
        },

        copyFileOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await execFileAsync("podman", [
            "cp",
            `${containerName}:${sandboxPath}`,
            hostPath,
          ]).catch((error: Error) => {
            throw new Error(`podman cp (out) failed: ${error.message}`);
          });
        },

        close: async (): Promise<void> => {
          unregisterShutdown();
          await execFileAsync("podman", ["rm", "-f", containerName]).catch(
            (error: Error) => {
              throw new Error(`podman rm failed: ${error.message}`);
            },
          );
        },
      };

      return handle;
    },
  });
};

// Re-export for backwards compatibility
export { defaultImageName };

const checkImageExists = async (imageName: string): Promise<void> => {
  await execFileAsync("podman", ["image", "inspect", imageName]).catch(() => {
    throw new Error(
      `Image '${imageName}' not found locally. Build it first with 'podman build -t ${imageName} .'`,
    );
  });
};

const podmanMachineError = () =>
  new Error(
    "Podman Machine is not running. Run 'podman machine init && podman machine start' first.",
  );

const checkPodmanMachine = async (): Promise<void> => {
  try {
    const { stdout } = await execFileAsync("podman", [
      "machine",
      "list",
      "--format",
      "json",
    ]);
    const machines = JSON.parse(stdout.toString()) as Array<{
      Running?: boolean;
    }>;
    if (!machines.some((m) => m.Running)) throw podmanMachineError();
  } catch {
    throw podmanMachineError();
  }
};
