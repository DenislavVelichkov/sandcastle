// Explicit browser validation of one retained HTML file, without adjacent data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as browser from "../src/templates/benchmark-runtime-browser/adapter.mjs";

const report = process.argv[2] && resolve(process.argv[2]);
const output = process.argv[3] && resolve(process.argv[3]);
assert(
  report && output,
  "Usage: pnpm exec node scripts/prove-offline-benchmark-report.mjs /absolute/report.html /absolute/empty-proof",
);
await mkdir(output, { recursive: true, mode: 0o700 });
assert.equal((await readdir(output)).length, 0, "Preserve existing proof");
const root = join(output, "disposable");
const worktree = join(root, "document");
const downloads = join(root, "downloads");
for (const dir of [worktree, downloads]) await mkdir(dir, { recursive: true });
const file = join(worktree, "report.html");
await cp(report, file);
const c = {
  root,
  worktree,
  evidence: output,
  config: { file: "report.html" },
  signal: AbortSignal.timeout(60_000),
  remainingMs: 60_000,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let client;
let verified = false;
try {
  const identity = await browser.prepare(c);
  const state = JSON.parse(await readFile(join(root, "browser.json")));
  const targets = await (
    await fetch(`http://127.0.0.1:${state.debugPort}/json/list`)
  ).json();
  const target = targets.find((item) => item.url === state.url);
  assert(target);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((accept, reject) => {
    socket.addEventListener("open", accept, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  const requests = [],
    errors = [],
    receipts = [];
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
    if (message.method === "Network.requestWillBeSent")
      requests.push(message.params.request.url);
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    if (message.method?.startsWith("Browser.download")) receipts.push(message);
  });
  const abort = () => {
    for (const pair of pending.values()) pair.reject(c.signal.reason);
    pending.clear();
    socket.close();
  };
  c.signal.addEventListener("abort", abort, { once: true });
  client = {
    call: (method, params = {}) =>
      new Promise((accept, reject) => {
        c.signal.throwIfAborted();
        const id = ++next;
        pending.set(id, { accept, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => {
      c.signal.removeEventListener("abort", abort);
      socket.close();
    },
  };
  const evaluate = async (expression) => {
    const result = await client.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await client.call("Network.enable");
  await client.call("Runtime.enable");
  await client.call("Network.setBlockedURLs", {
    urls: ["http://*", "https://*"],
  });
  await client.call("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await client.call("Page.navigate", { url: pathToFileURL(file).href });
  for (
    let tries = 0;
    await evaluate(
      "document.readyState !== 'complete' || !document.querySelector('[data-point]')",
    );
    tries++
  ) {
    assert(tries < 100, "Direct-file report failed readiness");
    await delay(50);
  }
  assert.equal(await evaluate("location.protocol"), "file:");
  const views = [];
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    await client.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const layout = await evaluate(
      "({width:innerWidth, documentWidth:document.documentElement.scrollWidth})",
    );
    assert(layout.documentWidth <= layout.width, JSON.stringify(layout));
    const screenshot = await client.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, "base64");
    const name = `report-${width}.png`;
    await writeFile(join(output, name), bytes, { mode: 0o600 });
    views.push({ ...layout, height, screenshot: name, sha256: digest(bytes) });
  }
  await evaluate(
    "document.querySelector('[data-graph]:not([hidden]) [data-point]').focus()",
  );
  const focus = await evaluate(
    "({index:document.activeElement.dataset.point,outline:getComputedStyle(document.activeElement).outlineStyle,details:document.querySelector('#point-detail').innerText})",
  );
  assert.equal(focus.index, "0");
  assert.notEqual(focus.outline, "none");
  assert(focus.details.includes("gpt-6-astra"));
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
  });
  assert.equal(await evaluate("document.activeElement.dataset.point"), "1");
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
  });
  assert(
    (
      await evaluate("document.querySelector('#point-detail').innerText")
    ).includes("high"),
  );
  await evaluate(
    "document.querySelector('[name=cost-unit][value=codexStandard]').click(); document.querySelector('[name=cost-scope][value=implementation]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-graph]:not([hidden])').dataset.graph",
    ),
    "implementation:codexStandard",
  );
  const ax = await client.call("Accessibility.getFullAXTree");
  assert(
    ax.nodes.some(
      (node) =>
        node.role?.value === "button" &&
        node.name?.value.includes("gpt-6-astra"),
    ),
  );
  assert(
    ax.nodes.some(
      (node) =>
        node.role?.value === "radio" &&
        node.name?.value.includes("Codex Standard"),
    ),
  );
  for (const [kind, name, dataId] of [
    ["json", "report.json", "report-data"],
    ["csv", "evaluations.csv", "csv-data"],
  ]) {
    await evaluate(`document.querySelector('[data-export=${kind}]').click()`);
    for (let tries = 0; !(await readdir(downloads)).includes(name); tries++) {
      assert(tries < 100, "Browser download did not complete");
      await delay(50);
    }
    const downloaded = await readFile(join(downloads, name));
    const embedded = await evaluate(
      `document.querySelector('#${dataId}').textContent`,
    );
    const expected = kind === "json" ? embedded : JSON.parse(embedded);
    if (kind === "json")
      assert.deepEqual(JSON.parse(downloaded), JSON.parse(expected));
    else assert.equal(downloaded.toString(), expected);
    await cp(join(downloads, name), join(output, `downloaded-${name}`));
  }
  assert.equal(errors.length, 0);
  assert(
    requests.every((url) => /^(file|blob|data):/.test(url)),
    JSON.stringify(requests),
  );
  await writeFile(
    join(output, "proof.json"),
    JSON.stringify(
      {
        dataKind: "fixture",
        reportSha256: digest(await readFile(file)),
        browser: identity,
        directFile: true,
        adjacentData: false,
        externalRequests: [],
        views,
        keyboard: "passed",
        accessibilityTree: "passed",
        downloads: "passed",
        receipts,
        errors,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  verified = true;
} finally {
  client?.close();
  const cleanup = {
    ...c,
    signal: AbortSignal.timeout(30_000),
    remainingMs: 30_000,
  };
  await browser.stop(cleanup);
  assert(
    await browser.verifyStopped(cleanup),
    "Owned report browser stop remains unverified",
  );
  await writeFile(
    join(output, "cleanup.json"),
    JSON.stringify({
      status: "passed",
      unit: JSON.parse(await readFile(join(root, "browser.json"))).unit,
    }) + "\n",
    { mode: 0o600 },
  );
  if (verified) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ proof: join(output, "proof.json"), cleanup: "passed" }),
);
