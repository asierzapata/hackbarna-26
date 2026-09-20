import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const drive = (...args) => execFileSync("node", ["scripts/drive.mjs", ...args], { cwd: root, encoding: "utf8" });
const snapshot = JSON.parse(drive("snapshot"));
// The scope toggle group, the eagerness select and the background-checks
// switch all moved behind the single assistant chip in the thread header.
if (!snapshot.buttons.some((label) => label.startsWith("Kan assistant:"))) throw new Error("the assistant menu is not mounted");
drive("fill", "textarea", "ordinary assistant e2e message");
drive("clickText", "Send");
const after = JSON.parse(drive("snapshot"));
if (!after.entries.some((entry) => entry.includes("ordinary assistant e2e message"))) throw new Error("ordinary message was not persisted in the thread");
const shot = process.env.ASSISTANT_SCREENSHOT ?? "/tmp/kan-assistant.e2e.png";
drive("shot", shot);
if (readFileSync(shot).length === 0) throw new Error("screenshot is empty");
console.log(JSON.stringify({ observed: ["assistant controls", "ordinary message", "screenshot"], screenshot: shot }));
