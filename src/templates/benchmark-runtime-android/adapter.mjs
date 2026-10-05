import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// This reference supports Linux x86_64 Android SDK guests and a Java APK fixture.
// A real project supplies its own build, service isolation and prerequisite policy.
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
const statePath = (c) => join(c.root, "device.json");
const state = async (c) => JSON.parse(await readFile(statePath(c), "utf8"));
const save = (c, value) =>
  writeFile(statePath(c), JSON.stringify(value), { mode: 0o600 });
const environment = (c, s) => ({
  ...process.env,
  ANDROID_HOME: s.sdk,
  ANDROID_SDK_ROOT: s.sdk,
  ANDROID_USER_HOME: join(c.root, "android"),
  ANDROID_EMULATOR_HOME: join(c.root, "android"),
  ANDROID_AVD_HOME: join(c.root, "avds"),
  ADB_SERVER_SOCKET: `tcp:127.0.0.1:${s.adbPort}`,
  ANDROID_ADB_SERVER_PORT: String(s.adbPort),
  ADB_SERVER_PORT: String(s.adbPort),
  ADB_MDNS_AUTO_CONNECT: "0",
  TMPDIR: join(c.root, "tmp"),
  ANDROID_TMP: join(c.root, "tmp"),
  NETSIM_INSTANCE: String(s.consolePort),
  XDG_RUNTIME_DIR: join(c.root, "run"),
  SC_RUNTIME_ROOT: c.root,
  SC_ANDROID_SDK: s.sdk,
  SC_DEVICE_SERIAL: s.serial,
  SC_ADB_PORT: String(s.adbPort),
  SC_BUILD_TOOLS: s.buildTools,
  SC_API: String(s.api),
});
const command = async (c, s, name, args, options = {}) => {
  c.signal.throwIfAborted();
  const result = await exec(name, args, {
    env: environment(c, s),
    cwd: c.worktree,
    signal: c.signal,
    timeout: Math.max(1, c.remainingMs),
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
};
const adb = (c, s, ...args) =>
  command(
    c,
    s,
    join(s.sdk, "platform-tools", "adb"),
    ["-P", String(s.adbPort), "-s", s.serial, ...args],
    { encoding: args[0] === "exec-out" ? "buffer" : "utf8" },
  );
const portFree = async (port) => {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  const chosen = server.address().port;
  await new Promise((accept) => server.close(accept));
  return chosen;
};
const listening = (port) =>
  new Promise((accept) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (ready) => {
      socket.destroy();
      accept(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
const choosePort = async (port) => {
  try {
    return await portFree(port);
  } catch {
    throw new Error(
      `Owned Android port ${port} is occupied; choose a free private lane`,
    );
  }
};
const processStart = async (pid) => {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const ownedProcesses = async (c) => {
  const processes = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const env = await readFile(`/proc/${name}/environ`, "utf8");
      if (!env.split("\0").includes(`SC_RUNTIME_ROOT=${c.root}`)) continue;
      const start = await processStart(Number(name));
      if (start) processes.push({ pid: Number(name), start });
    } catch (error) {
      if (!["ENOENT", "EACCES", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return processes;
};
const launch = async (c, s, name, args, label) => {
  const log = await open(join(c.evidence, `${label}.log`), "a", 0o600);
  // The launch intent identifies the private root even if death precedes PID export.
  s.launching = label;
  await save(c, s);
  const child = spawn(name, args, {
    env: environment(c, s),
    cwd: c.root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  await new Promise((accept, reject) => {
    child.once("spawn", accept);
    child.once("error", reject);
  });
  s.processes.push({
    pid: child.pid,
    start: await processStart(child.pid),
    label,
  });
  s.launching = null;
  await save(c, s);
  await log.close();
  child.unref();
};
const wait = async (c, read, description) => {
  const end = Date.now() + Math.min(c.remainingMs, 120000);
  while (Date.now() < end) {
    c.signal.throwIfAborted();
    try {
      if (await read()) return;
    } catch (error) {
      if (c.signal.aborted) throw error;
    }
    await delay(300, undefined, { signal: c.signal });
  }
  throw new Error(`Owned Android runtime unavailable: ${description}`);
};
const installedBuild = async (c, s) => {
  const path = (await adb(c, s, "shell", "pm", "path", s.application))
    .trim()
    .replace(/^package:/, "");
  if (!path.startsWith("/data/app/") || path.includes("\n"))
    throw new Error("Owned candidate APK is unavailable");
  return digest(await adb(c, s, "exec-out", "cat", path));
};
export async function prepare(c) {
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    (c.config.architecture ?? "x86_64") !== "x86_64"
  )
    throw new Error(
      "Android reference adapter requires a Linux x86_64 host and x86_64 system image; supply a compatible project adapter",
    );
  const sdk = c.config.sdk ?? process.env.ANDROID_HOME;
  if (typeof sdk !== "string")
    throw new Error("Set adapter.config.sdk to the owning Android SDK");
  const api = c.config.api ?? 35;
  const consolePort = c.config.consolePort ?? 5680;
  if (
    !Number.isInteger(consolePort) ||
    consolePort < 5554 ||
    consolePort > 5680 ||
    consolePort % 2
  )
    throw new Error(
      "Reserve a free even Android console port from 5554 through 5680",
    );
  const s = {
    sdk,
    api,
    consolePort,
    adbPort: await choosePort(c.config.adbPort ?? 0),
    grpcPort: await choosePort(c.config.grpcPort ?? 0),
    serial: `emulator-${consolePort}`,
    avd: `sandcastle_${digest(c.root).slice(0, 16)}`,
    application: "io.sandcastle.fixture",
    buildTools: c.config.buildTools ?? "35.0.0",
    processes: [],
    ownedPorts: [],
    launching: null,
    build: null,
  };
  await save(c, s);
  for (const port of [
    s.consolePort,
    s.consolePort + 1,
    s.adbPort,
    s.grpcPort,
  ]) {
    try {
      await portFree(port);
    } catch {
      throw new Error(
        `Owned Android port ${port} is occupied; choose a free lane, do not borrow a running device or service`,
      );
    }
  }
  if (
    new Set([s.consolePort, s.consolePort + 1, s.adbPort, s.grpcPort]).size !==
    4
  )
    throw new Error("Android runtime ports must be distinct");
  await access(
    join(
      sdk,
      "system-images",
      `android-${api}`,
      "google_apis",
      "x86_64",
      "system.img",
    ),
  );
  for (const name of ["avds", "tmp", "run"])
    await mkdir(join(c.root, name), { recursive: true, mode: 0o700 });
  const manager = join(sdk, "cmdline-tools", "latest", "bin", "avdmanager");
  // No stored AVD or user data is copied; only the read-only SDK image is shared.
  await new Promise((accept, reject) => {
    const child = spawn(
      manager,
      [
        "create",
        "avd",
        "-n",
        s.avd,
        "-p",
        join(c.root, "avds", `${s.avd}.avd`),
        "-k",
        `system-images;android-${api};google_apis;x86_64`,
        "-d",
        "pixel_7",
      ],
      {
        env: environment(c, s),
        signal: c.signal,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let failure = "";
    child.stderr.on("data", (chunk) => (failure += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(`Private AVD creation failed: ${failure.slice(-2000)}`),
          ),
    );
    child.stdin.end("no\n");
  });
  await appendFile(
    join(c.root, "avds", `${s.avd}.avd`, "config.ini"),
    "\nhw.ramSize=2048\nhw.cpu.ncore=2\nhw.gpu.enabled=yes\nhw.gpu.mode=host\ndisk.dataPartition.size=2G\n",
  );
  await launch(
    c,
    s,
    join(sdk, "platform-tools", "adb"),
    ["-L", `tcp:${s.adbPort}`, "server", "nodaemon"],
    "adb",
  );
  s.ownedPorts.push(s.adbPort);
  await save(c, s);
  await wait(
    c,
    async () => {
      const owned = s.processes.find((item) => item.label === "adb");
      if ((await processStart(owned.pid)) !== owned.start)
        throw new Error(
          "Owned ADB server exited before readiness; see adb.log",
        );
      return listening(s.adbPort);
    },
    "private ADB server readiness",
  );
  await launch(
    c,
    s,
    join(sdk, "emulator", "emulator"),
    [
      "-avd",
      s.avd,
      "-port",
      String(s.consolePort),
      "-grpc",
      String(s.grpcPort),
      "-grpc-use-jwt",
      "-gpu",
      "host",
      "-no-window",
      "-no-audio",
      "-no-snapshot",
      "-no-boot-anim",
      "-no-metrics",
      "-netsim-args",
      `--instance ${s.consolePort} --no-web-ui --debug-no-network --debug-no-wmedium --logtostderr`,
      "-memory",
      "2048",
      "-cores",
      "2",
      "-camera-back",
      "none",
      "-camera-front",
      "none",
      "-adb-path",
      join(sdk, "platform-tools", "adb"),
    ],
    "emulator",
  );
  s.ownedPorts.push(s.consolePort, s.consolePort + 1, s.grpcPort);
  await save(c, s);
  await wait(
    c,
    async () =>
      (await adb(c, s, "shell", "getprop", "sys.boot_completed")).trim() ===
      "1",
    "Android boot completion",
  );
  if (
    (await adb(c, s, "emu", "avd", "name")).split(/\r?\n/)[0].trim() !== s.avd
  )
    throw new Error(
      "The native serial belongs to another AVD; refusing to borrow it",
    );
  const renderer = (await adb(c, s, "shell", "dumpsys", "SurfaceFlinger"))
    .split("\n")
    .find((line) => line.includes("GLES:"));
  if (
    !renderer ||
    /swiftshader|lavapipe|llvmpipe|softpipe|swangle|software/i.test(renderer) ||
    !/NVIDIA|AMD|Intel|Radeon|Apple|Adreno|Mali|GeForce/i.test(renderer)
  )
    throw new Error(
      `Host GPU proof unavailable: ${renderer ?? "missing GLES renderer"}. No software fallback was selected`,
    );
  const buildCommand = c.config.buildCommand;
  if (typeof buildCommand !== "string")
    throw new Error("The native fixture requires adapter.config.buildCommand");
  await command(c, s, "sh", ["-c", buildCommand]);
  const apk = join(c.root, "build", "candidate.apk");
  s.build = digest(await readFile(apk));
  await adb(c, s, "install", "-r", apk);
  await adb(
    c,
    s,
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    `${s.application}/.MainActivity`,
  );
  await adb(c, s, "shell", "input", "keyevent", "KEYCODE_WAKEUP");
  await adb(c, s, "shell", "wm", "dismiss-keyguard");
  if ((await installedBuild(c, s)) !== s.build)
    throw new Error("Installed APK differs from the candidate build");
  s.renderer = renderer;
  await save(c, s);
  await writeFile(
    join(c.evidence, "device-proof.json"),
    JSON.stringify({
      avd: s.avd,
      serial: s.serial,
      boot: "1",
      renderer,
      apkSha256: s.build,
      worktree: c.worktree,
      ports: [s.consolePort, s.consolePort + 1, s.adbPort, s.grpcPort],
      privateData: join(c.root, "avds"),
    }),
    { mode: 0o600 },
  );
  return {
    kind: "native",
    build: s.build,
    profile: `android-${api}-x86_64-headless`,
    device: s.serial,
    ports: [s.consolePort, s.consolePort + 1, s.adbPort, s.grpcPort],
    services: [`private-adb:${s.adbPort}`, `private-netsim:${s.consolePort}`],
    architecture: "x86_64",
    renderer,
  };
}
export async function check(c) {
  const s = await state(c);
  try {
    return {
      stdout: await command(c, s, "sh", ["-c", c.check], {
        cwd: c.checkWorktree,
      }),
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    if (c.signal.aborted) throw error;
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      exitCode: typeof error.code === "number" ? error.code : 1,
    };
  }
}
export async function capture(c) {
  const s = await state(c);
  if ((await installedBuild(c, s)) !== s.build)
    throw new Error("Candidate runtime APK changed before capture");
  const bytes = await adb(c, s, "exec-out", "screencap", "-p");
  await writeFile(join(c.evidence, "screen.png"), bytes, { mode: 0o600 });
  return [
    {
      id: "native-screen",
      path: "screen.png",
      mediaType: "image/png",
      observation: `Owned ${s.serial}, build ${s.build}, headless Android candidate screen.`,
    },
  ];
}
export async function inspect(c) {
  const s = await state(c);
  if ((await installedBuild(c, s)) !== s.build)
    throw new Error("The live native app is another build");
  await adb(
    c,
    s,
    "shell",
    "uiautomator",
    "dump",
    "/sdcard/sandcastle-inspection.xml",
  );
  const hierarchy = await adb(
    c,
    s,
    "shell",
    "cat",
    "/sdcard/sandcastle-inspection.xml",
  );
  const activity = await adb(
    c,
    s,
    "shell",
    "dumpsys",
    "activity",
    "activities",
  );
  if (!activity.includes(`${s.application}/.MainActivity`))
    throw new Error("Owned candidate activity is not available to the judge");
  return {
    build: s.build,
    observation: hierarchy.toString("utf8").slice(0, 64000),
  };
}
export async function stop(c) {
  let s;
  try {
    s = await state(c);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (s.launching)
    throw new Error(
      `Interrupted ${s.launching} launch has no verified PID; retain the private root for targeted reconciliation`,
    );
  for (const item of [...s.processes].reverse()) {
    const actual = await processStart(item.pid);
    if (!actual) continue;
    if (actual !== item.start)
      throw new Error(
        "Owned Android process identity changed; refusing to signal a reused PID",
      );
    try {
      process.kill(-item.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const end = Date.now() + Math.min(c.remainingMs, 10000);
    while ((await processStart(item.pid)) && Date.now() < end)
      await delay(100, undefined, { signal: c.signal });
    if ((await processStart(item.pid)) === item.start)
      process.kill(-item.pid, "SIGKILL");
  }
  // SDK helpers can detach from the recorded emulator process group. Their
  // inherited private root still supplies an exact attempt ownership identity.
  for (const item of await ownedProcesses(c)) {
    if ((await processStart(item.pid)) !== item.start) continue;
    try {
      process.kill(item.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await wait(
    c,
    () => verifyStopped(c),
    "verified native process and port removal",
  );
}
export async function verifyStopped(c) {
  let s;
  try {
    s = await state(c);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (s.launching) return false;
  if ((await ownedProcesses(c)).length) return false;
  for (const item of s.processes)
    if ((await processStart(item.pid)) === item.start) return false;
  for (const port of s.ownedPorts) {
    try {
      await portFree(port);
    } catch {
      return false;
    }
  }
  return true;
}
