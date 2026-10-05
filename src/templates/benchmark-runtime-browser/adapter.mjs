import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// Linux Chromium reference, with one private profile, server and limited scope.
const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const live = new Map();
const state = async (c) =>
  JSON.parse(await readFile(join(c.root, "browser.json"), "utf8"));
const save = (c, s) =>
  writeFile(join(c.root, "browser.json"), JSON.stringify(s), { mode: 0o600 });
const portFree = async (port) => {
  const server = tcpServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  const value = server.address().port;
  await new Promise((accept) => server.close(accept));
  return value;
};
const command = (c, name, args) =>
  exec(name, args, {
    signal: c.signal,
    timeout: Math.max(1, c.remainingMs),
    maxBuffer: 4 * 1024 * 1024,
  });
const connect = async (url, signal) => {
  signal.throwIfAborted();
  const socket = new WebSocket(url);
  await new Promise((accept, reject) => {
    const abort = () => {
      socket.close();
      reject(signal.reason);
    };
    const finish = (callback, value) => {
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => finish(accept), { once: true });
    socket.addEventListener("error", (error) => finish(reject, error), {
      once: true,
    });
  });
  const pending = new Map();
  let next = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const pair = pending.get(message.id);
    if (pair) {
      pending.delete(message.id);
      message.error
        ? pair.reject(new Error(message.error.message))
        : pair.accept(message.result);
    }
  });
  const abort = () => {
    for (const pair of pending.values())
      pair.reject(
        signal.reason ??
          new Error("Owned browser inspection connection closed"),
      );
    pending.clear();
    socket.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  socket.addEventListener("close", abort, { once: true });
  return {
    call: (method, params = {}) =>
      new Promise((accept, reject) => {
        signal.throwIfAborted();
        const id = ++next;
        pending.set(id, { accept, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => {
      signal.removeEventListener("abort", abort);
      socket.close();
    },
  };
};
const page = async (c, s, operation) => {
  const version = await fetch(`http://127.0.0.1:${s.debugPort}/json/version`, {
    signal: c.signal,
  });
  if (!(await version.json()).webSocketDebuggerUrl?.endsWith(s.browserSocket))
    throw new Error("Debugging port is not the owned private browser profile");
  const response = await fetch(`http://127.0.0.1:${s.debugPort}/json/list`, {
    signal: c.signal,
  });
  const target = (await response.json()).find(
    (item) => item.type === "page" && item.url === s.url,
  );
  if (!target) throw new Error("Owned Chromium candidate page is unavailable");
  const client = await connect(target.webSocketDebuggerUrl, c.signal);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
};
export async function prepare(c) {
  if (typeof WebSocket !== "function")
    throw new Error(
      "The browser reference adapter requires Node.js 22 or later for built-in WebSocket inspection",
    );
  if (process.platform !== "linux")
    throw new Error(
      "The Chromium reference requires Linux user systemd scopes; provide a platform-specific adapter",
    );
  const file = await realpath(
    resolve(c.worktree, c.config.file ?? "index.html"),
  );
  if (relative(c.worktree, file).startsWith("../"))
    throw new Error("Browser fixture escaped the exact candidate");
  const bytes = await readFile(file);
  const s = {
    build: digest(bytes),
    serverPort: c.config.serverPort ?? 0,
    debugPort: null,
    ownedPorts: [],
    unit: `sandcastle-browser-${digest(c.root).slice(0, 24)}.scope`,
    url: null,
    file,
  };
  await save(c, s);
  await command(c, "systemctl", ["--user", "show-environment"]);
  const server = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      })
      .end(bytes);
  });
  live.set(c.root, server);
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(s.serverPort, "127.0.0.1", accept);
  });
  s.serverPort = server.address().port;
  s.ownedPorts.push(s.serverPort);
  s.url = `http://127.0.0.1:${s.serverPort}/`;
  await save(c, s);
  const profile = join(c.root, "profile");
  await mkdir(profile, { recursive: true });
  const log = await open(join(c.evidence, "browser.log"), "a", 0o600);
  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      `--unit=${s.unit}`,
      "--property=MemoryMax=1024M",
      "--property=CPUQuota=200%",
      "--property=TasksMax=128",
      c.config.browser ?? "google-chrome",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--renderer-process-limit=1",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      s.url,
    ],
    { detached: true, stdio: ["ignore", log.fd, log.fd] },
  );
  await new Promise((accept, reject) => {
    child.once("spawn", accept);
    child.once("error", reject);
  });
  await log.close();
  child.unref();
  const end = Date.now() + Math.min(c.remainingMs, 20000);
  let ready = false;
  while (Date.now() < end) {
    c.signal.throwIfAborted();
    try {
      const [port, browserSocket] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split("\n");
      s.debugPort = Number(port);
      if (
        !Number.isInteger(s.debugPort) ||
        s.debugPort < 1 ||
        !browserSocket.startsWith("/devtools/browser/")
      )
        throw new Error("Private debugging identity unavailable");
      s.browserSocket = browserSocket;
      await page(c, s, async (client) => {
        await client.call("Emulation.setDeviceMetricsOverride", {
          width: 800,
          height: 600,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const result = await client.call("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (result.result.value !== "complete") throw new Error("Page loading");
      });
      ready = true;
      break;
    } catch (error) {
      if (c.signal.aborted) throw error;
    }
    await delay(100, undefined, { signal: c.signal });
  }
  if (!ready)
    throw new Error(
      "Owned Chromium failed readiness; check browser.log, user systemd and sandbox support",
    );
  s.ownedPorts.push(s.debugPort);
  await save(c, s);
  return {
    kind: "browser",
    build: s.build,
    profile: "chromium-800x600",
    device: `private-chromium-${digest(c.root).slice(0, 16)}`,
    ports: [s.serverPort, s.debugPort],
    services: [s.unit, `candidate-http:${s.serverPort}`],
  };
}
export async function inspect(c) {
  const s = await state(c);
  if (digest(await readFile(s.file)) !== s.build)
    throw new Error("Browser candidate bytes changed");
  const observation = await page(c, s, async (client) => {
    const result = await client.call("Runtime.evaluate", {
      expression:
        "JSON.stringify({title:document.title,text:document.body.innerText,html:document.documentElement.outerHTML})",
      returnByValue: true,
    });
    return result.result.value;
  });
  return { build: s.build, observation };
}
export async function capture(c) {
  const s = await state(c);
  await inspect(c);
  const result = await page(c, s, (client) =>
    client.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    }),
  );
  await writeFile(
    join(c.evidence, "screen.png"),
    Buffer.from(result.data, "base64"),
    { mode: 0o600 },
  );
  return [
    {
      id: "browser-screen",
      path: "screen.png",
      mediaType: "image/png",
      observation:
        "Exact candidate document at 800 by 600 in an owned Chromium profile.",
    },
  ];
}
export async function check(c) {
  const s = await state(c);
  try {
    const result = await exec("sh", ["-c", c.check], {
      cwd: c.checkWorktree,
      env: { ...process.env, SC_CANDIDATE_URL: s.url },
      signal: c.signal,
      timeout: Math.max(1, c.remainingMs),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (c.signal.aborted) throw error;
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      exitCode: typeof error.code === "number" ? error.code : 1,
    };
  }
}
export async function stop(c) {
  const server = live.get(c.root);
  if (server) {
    server.closeAllConnections();
    await new Promise((accept, reject) =>
      server.close((error) =>
        error && error.code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(error)
          : accept(),
      ),
    );
    live.delete(c.root);
  }
  let s;
  try {
    s = await state(c);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    await command(c, "systemctl", [
      "--user",
      "kill",
      "--signal=SIGKILL",
      s.unit,
    ]);
  } catch (error) {
    if (!/not loaded|not found|does not exist/.test(error.stderr ?? ""))
      throw error;
  }
  const end = Date.now() + Math.min(c.remainingMs, 10000);
  while (Date.now() < end) {
    if (await verifyStopped(c)) return;
    await delay(100, undefined, { signal: c.signal });
  }
  throw new Error(
    "Owned browser scope or ports still exist; retain ownership for reconciliation",
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
  try {
    const result = await command(c, "systemctl", [
      "--user",
      "show",
      s.unit,
      "--property=ActiveState",
      "--value",
    ]);
    if (!/inactive|failed/.test(result.stdout.trim())) return false;
  } catch (error) {
    if (!/not loaded|not found|does not exist/.test(error.stderr ?? ""))
      throw error;
  }
  for (const port of s.ownedPorts)
    if (port) {
      try {
        await portFree(port);
      } catch {
        return false;
      }
    }
  return true;
}
