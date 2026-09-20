import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const queue = resolve(process.env.KAN_QA_DIR ?? join(root, "qa_bugs"));
const queueCli = join(root, "scripts/qa_queue.py");
const driver = join(root, "scripts/drive.mjs");
const drive = (...args) => {
  const output = execFileSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 20000 });
  return ["shot", "fill", "reload"].includes(args[0]) ? output.trim() : JSON.parse(output);
};
const evaluate = (expression) => drive("eval", `({result:(${expression})})`).result;
const run = (body) => evaluate(`(() => {${body}})()`);
const wait = async (expression) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${expression}`);
};
const queueCommand = (...args) => JSON.parse(execFileSync("python3", [queueCli, "--dir", queue, ...args], { encoding: "utf8" }));
const originalRoute = evaluate("location.pathname");
const id = randomUUID();
const marker = `QA e2e ${id}`;
const reports = [];
let lockOwned = false;
let fixtureCreated = false;
const hadIndex = existsSync(join(queue, "bugs.csv"));
assert.equal(hadIndex, false, "Run this fixture only with a fresh QA queue; existing reports are never removed");
assert.equal(evaluate("!!window.__TAURI_INTERNALS__"), true);
assert.equal(evaluate("document.visibilityState"), "visible", "Keep the native QA window visible so WebKit can finish animations");
assert.equal(evaluate("!!window.__kan"), false, "Start on the catalog or onboarding, not a user canvas");

async function saved() {
  await wait("!!document.querySelector('[data-qa-report-id]')");
  const reportId = evaluate("document.querySelector('[data-qa-report-id]').dataset.qaReportId");
  reports.push(reportId);
  const report = JSON.parse(readFileSync(join(queue, `${reportId}.json`), "utf8"));
  drive("clickText", "Done");
  await wait("!document.querySelector('[role=dialog]')");
  return report;
}

try {
  run(`import('/src/lib/canvas-repository.ts').then(repo => repo.createOfflineCanvas({id:${JSON.stringify(id)},name:${JSON.stringify(marker)}})).then(() => location.assign('/canvas/${id}')); return true;`);
  await wait("!!window.__kan && !!document.querySelector('aside[aria-label=Thread] textarea')");
  fixtureCreated = true;
  const shapeId = run(`const t=window.__kan; const id=t.tools.addNode({draft:{type:'markdown',title:${JSON.stringify(marker)},body:'Before snapshot'},at:{x:150,y:120}}).shapeId; t.editor.select(id); return id;`);
  drive("fill", "aside[aria-label=Thread] textarea", `${marker} chat message`);
  run("document.querySelector('aside[aria-label=Thread] textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true;");
  await wait(`document.querySelector('aside[aria-label=Thread]').textContent.includes(${JSON.stringify(`${marker} chat message`)})`);
  drive("fill", "aside[aria-label=Thread] textarea", `${marker} unsent draft`);
  drive("click", "[data-testid=thread-search-toggle]");
  drive("fill", "[data-testid=thread-search]", marker);
  run("window.dispatchEvent(new ErrorEvent('error',{message:'QA synthetic error token=qa-fixture-private'})); return true;");
  drive("clickText", "Report bug");
  await wait("!!document.querySelector('#qa-description')");
  await pause(300);
  drive("shot", "/tmp/kan-qa-report-dialog.png");
  run(`window.__kan.tools.updateNode({shapeId:${JSON.stringify(shapeId)},patch:{type:'markdown',body:'After snapshot'}}); return true;`);
  drive("clickText", "Save report");
  const blank = await saved();
  assert.equal(blank.description, "");
  assert.equal(blank.route, `/canvas/${id}`);
  assert.ok(JSON.stringify(blank.context.canvas).includes("Before snapshot"));
  assert.ok(!JSON.stringify(blank.context.canvas).includes("After snapshot"));
  assert.deepEqual(blank.context.canvas.value.selectedShapeIds, [shapeId]);
  assert.ok(blank.context.chat.value.entries.some(entry => entry.text === `${marker} chat message`));
  assert.equal(blank.context.composer.value.text, `${marker} unsent draft`);
  assert.equal(blank.context.threadView.value.search, marker);
  assert.equal(typeof blank.context.agent.value.busy, "boolean");
  assert.ok(blank.errors.some(error => error.message.includes("QA synthetic error")));
  assert.ok(!JSON.stringify(blank).includes("qa-fixture-private"));
  assert.equal(blank.runtime.os, "macos");
  assert.equal(queueCommand("list")[0].status, "open");
  console.log("PASS blank description, real native persistence, opening-time canvas snapshot, selection, chat, draft, search, agent state, redacted errors");

  drive("clickText", "Report bug");
  await wait("!!document.querySelector('#qa-description')");
  drive("fill", "#qa-description", `${marker} cancelled`);
  drive("clickText", "Cancel");
  assert.equal(queueCommand("list").length, 1);
  console.log("PASS cancel writes nothing");

  drive("clickText", "Close thread");
  await wait("!document.querySelector('aside[aria-label=Thread]')");
  drive("clickText", "Report bug");
  await wait("!!document.querySelector('#qa-description')");
  const description = `${marker}: commas, \"quotes\"\nand newline`;
  drive("fill", "#qa-description", description);
  mkdirSync(join(queue, ".queue.lock"));
  lockOwned = true;
  drive("clickText", "Save report");
  await wait("document.querySelector('[role=alert]')?.textContent.includes('queue is busy')");
  assert.equal(evaluate("document.querySelector('#qa-description').value"), description);
  rmdirSync(join(queue, ".queue.lock"));
  lockOwned = false;
  run("const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Save report'); b.click(); b.click(); return true;");
  const described = await saved();
  assert.equal(described.description, description);
  assert.equal(described.context.chat.mounted, false);
  assert.ok(described.context.chat.value.entries.some(entry => entry.text === `${marker} chat message`));
  assert.equal(queueCommand("list").length, 2);
  console.log("PASS closed-chat context, optional text, visible native write failure, retained draft, retry, duplicate-click guard");

  const first = queueCommand("claim", "--owner", marker);
  assert.equal(first.id, blank.id);
  queueCommand("update", first.id, "finished", "--owner", marker, "--notes", "E2E fixture verified");
  const second = queueCommand("claim", "--owner", marker);
  assert.equal(second.id, described.id);
  queueCommand("update", second.id, "open", "--owner", marker, "--notes", "E2E reopen check");
  console.log("PASS native CSV consumed by queue helper, FIFO claims, finished/open transitions");
  drive("shot", "/tmp/kan-qa-report-button.png");
  const errors = evaluate("window.__kanErrors.filter(error=>!error.includes('QA synthetic error'))");
  assert.deepEqual(errors, []);
} finally {
  if (lockOwned) rmdirSync(join(queue, ".queue.lock"));
  if (fixtureCreated) {
    run(`window.__kan?.editor.deleteShapes([...window.__kan.editor.getCurrentPageShapeIds()]); import('/src/lib/canvas-repository.ts').then(repo => repo.deleteCanvasEntry(${JSON.stringify(id)})).then(() => location.assign(${JSON.stringify(originalRoute)})); return true;`);
    await wait(`location.pathname === ${JSON.stringify(originalRoute)} && !window.__kan`);
  }
  if (reports.length) {
    mkdirSync(join(queue, ".queue.lock"));
    try {
      const rows = JSON.parse(execFileSync("python3", ["-c", "import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1])))))", join(queue, "bugs.csv")], {encoding:"utf8"}));
      assert.ok(rows.every(row => reports.includes(row.id)), "Foreign report found; leave all reports untouched");
      for (const reportId of reports) unlinkSync(join(queue, `${reportId}.json`));
      unlinkSync(join(queue, "bugs.csv"));
    } finally { rmdirSync(join(queue, ".queue.lock")); }
  }
}
