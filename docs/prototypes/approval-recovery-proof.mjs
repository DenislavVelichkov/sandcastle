// Throwaway proof. No agent, sandbox, product task or real human approval runs.
// node docs/prototypes/approval-recovery-proof.mjs [path/to/supervise.mjs]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, open, readFile, rename, link, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const self = fileURLToPath(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
// Same fsync/rename ordering as the inspected setup controller; scratch files only.
async function save(path, value, exclusive = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    if (exclusive) await link(temp, path); else await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await rm(temp, { force: true }); }
}

const [mode, directory, extra] = process.argv.slice(2);
if (mode === "status") {
  console.log(JSON.stringify(await read(join(directory, "state.json"))));
} else if (mode === "deliver") {
  // Fixed scratch filename. Production names must be validated, controller-owned IDs.
  const a = JSON.parse(extra), path = join(directory, "inbox", "response.json");
  try { await save(path, a, true); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.deepEqual(await read(path), a, "Conflicting response ID");
  }
  console.log("queued");
} else if (mode === "torn-write") {
  const file = await open(join(directory, "state.json.torn.tmp"), "w", 0o600);
  await file.writeFile('{"unfinished":'); await file.sync();
  process.send({ ready: true });
  setInterval(() => {}, 1000);
} else if (mode === "worker") {
  const abort = new AbortController();
  process.on("message", (message) => {
    if (message?.type === "sandcastle-cancel") abort.abort(message.signal);
  });
  process.on("disconnect", () => abort.abort("parent-disconnected"));
  abort.signal.addEventListener("abort", () => {
    void (async () => {
      const work = await readFile(join(directory, "dirty.txt"));
      const session = await readFile(join(directory, "session.jsonl"));
      await save(join(directory, "stopped.json"), {
        reason: abort.signal.reason, work: hash(work), session: hash(session), stopped: true,
      });
      process.exit(0);
    })().catch((error) => { console.error(error); process.exit(1); });
  }, { once: true });
  process.send({ type: "sandcastle-ready" });
  console.log("worker-ready");
} else if (mode === "supervise") {
  const { supervise } = await import(pathToFileURL(extra).href);
  process.exitCode = await supervise(self, ["worker", directory], directory);
} else {
  const html = await readFile(new URL("./approval-recovery.html", import.meta.url), "utf8");
  const model = html.split('<script id="model">')[1].split("</script>")[0];
  const { initial, answer, step } = runInNewContext(model + "\n({ initial, answer, step })", { structuredClone });
  const act = (s, type) => step(s, { type });
  const pending = (s = initial()) => act(act(s, "checks"), "request");
  const deliver = (s, a) => step(s, { type: "deliver", answer: a });
  let s = pending();
  assert.equal(s.status, "waiting-for-human");
  assert.equal(s.other, "running");
  const approval = answer(s);
  assert.equal(Object.keys(deliver(s, { ...approval, actor: "impostor" }).receipts).length, 0);
  assert.equal(Object.keys(deliver(s, { ...approval, decision: "looks good" }).receipts).length, 0);
  for (const key of ["run", "task", "request", "candidate", "evidence", "contract"]) {
    const stale = act(deliver(s, { ...approval, [key]: "wrong" }), "apply");
    assert.equal(stale.status, "waiting-for-human");
  }
  const rejection = answer(s, "Reject");
  s = act(deliver(s, rejection), "apply");
  assert.equal(s.status, "rejected"); assert.equal(s.used, 1);
  s = pending(act(s, "rework"));
  assert.equal(s.used, 2); assert.equal(s.pending.id, "request-2");
  s = act(deliver(s, approval), "apply");
  assert.equal(s.status, "waiting-for-human");
  const current = answer(s);
  s = act(deliver(s, current), "apply");
  assert.equal(s.status, "accepted"); assert.equal(s.integrations, 0);
  s = act(s, "integrate"); s = act(s, "integrate");
  assert.equal(s.integrations, 1);
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  assert.match(deliver(s, reordered).note, /Duplicate delivery/);
  assert.equal(act(deliver(s, current), "apply").integrations, 1);
  assert.match(deliver(s, { ...current, decision: "Reject" }).note, /Conflicting reuse/);
  let paused = pending(initial("stop-first"));
  paused = deliver(paused, answer(paused));
  assert.equal(act(paused, "apply").status, "waiting-for-human");
  assert.equal(act(act(paused, "stop"), "apply").status, "accepted");
  let capped = pending();
  for (let attempt = 0; attempt < 3; attempt++) {
    capped = act(deliver(capped, answer(capped, "Reject")), "apply");
    capped = act(capped, "rework");
    if (capped.status !== "capped") capped = pending(capped);
  }
  assert.equal(capped.status, "capped"); assert.equal(capped.used, 3);
  assert.equal(act(act(capped, "stop"), "restart").used, 3);
  const cancelled = act(pending(), "cancel");
  assert.equal(act(deliver(cancelled, approval), "apply").status, "cancelled");
  assert.equal(act(initial(), "block").status, "environment-blocked");
  console.log("PASS model: exact identity, rejection, duplicates, conflict, stop-first, caps, cancellation, single integration");

  const scratch = await mkdtemp(join(tmpdir(), "sandcastle-PROTOTYPE-wipe-me-"));
  try {
    await mkdir(join(scratch, "inbox"));
    await mkdir(join(scratch, "execution.lock"));
    s = pending();
    await save(join(scratch, "state.json"), s);
    await writeFile(join(scratch, "dirty.txt"), "incomplete work\n");
    await writeFile(join(scratch, "session.jsonl"), '{"session":"demo-session"}\n');
    const observed = JSON.parse(execFileSync(process.execPath, [self, "status", scratch], { encoding: "utf8" }));
    assert.equal(observed.pending.id, s.pending.id);
    for (let duplicate = 0; duplicate < 2; duplicate++)
      assert.equal(execFileSync(process.execPath, [self, "deliver", scratch, JSON.stringify(answer(s))], { encoding: "utf8" }).trim(), "queued");
    s = act(deliver(s, await read(join(scratch, "inbox", "response.json"))), "apply");
    await save(join(scratch, "state.json"), s);
    const restored = await read(join(scratch, "state.json"));
    assert.equal(act(deliver(restored, answer(pending())), "apply").status, "accepted");
    assert.equal(restored.used, 1);
    console.log("PASS disk: status and answer submission during execution lock, response survives reload, no allowance reset");

    const child = fork(self, ["torn-write", scratch], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const exit = once(child, "exit");
    await once(child, "message", { signal: AbortSignal.timeout(5000) });
    child.kill("SIGKILL"); await exit;
    assert.deepEqual(await read(join(scratch, "state.json")), restored);
    assert.equal(await readFile(join(scratch, "dirty.txt"), "utf8"), "incomplete work\n");
    assert.equal(await readFile(join(scratch, "session.jsonl"), "utf8"), '{"session":"demo-session"}\n');
    console.log("PASS crash: kill during temporary state write retains prior complete snapshot and fixture files");

    if (mode) {
      const supervisor = resolve(mode);
      for (const signal of ["SIGINT", "SIGTERM", "parent-disconnected"]) {
        await rm(join(scratch, "stopped.json"), { force: true });
        const parent = fork(self, ["supervise", scratch, supervisor], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
        const finished = once(parent, "exit", { signal: AbortSignal.timeout(10000) });
        try {
          await once(parent.stdout, "data", { signal: AbortSignal.timeout(5000) });
          if (signal === "parent-disconnected") parent.disconnect(); else parent.kill(signal);
          const [code] = await finished;
          assert.equal(code, signal === "SIGINT" ? 130 : 143);
          const receipt = await read(join(scratch, "stopped.json"));
          assert.equal(receipt.reason, signal); assert.equal(receipt.stopped, true);
          assert.equal(receipt.work, hash(await readFile(join(scratch, "dirty.txt"))));
          assert.equal(receipt.session, hash(await readFile(join(scratch, "session.jsonl"))));
        } finally { if (parent.exitCode === null) parent.kill("SIGKILL"); }
      }
      console.log("PASS inspected supervisor: SIGINT, SIGTERM and Node IPC disconnect await the fixture's durable stop receipt");
    }
    console.log("NOT PROVEN: Desktop quit/close/Stop delivery, real authorization, sandbox transfer or actual Git integration");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
