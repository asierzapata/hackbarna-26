import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessProblems, framesDue, parseOptions } from "./record-product-demo.mjs";

const ready = {
  native: true, visible: true, online: true, canvas: true, thread: true,
  agent: true, call: true, captions: true, microphone: true,
  participants: 2, playingVideos: 2, width: 1440, height: 900,
};

test("requires the complete visible integrated experience", () => {
  assert.deepEqual(readinessProblems(ready), []);
  for (const key of ["native", "visible", "online", "canvas", "thread", "agent", "call", "captions", "microphone"]) {
    assert.ok(readinessProblems({ ...ready, [key]: false }).length > 0, key);
  }
  for (const [key, value] of [["participants", 1], ["playingVideos", 1], ["width", 800], ["height", 600]]) {
    assert.ok(readinessProblems({ ...ready, [key]: value }).length > 0, key);
  }
});

test("solo narration explicitly allows one participant, but still requires a playing camera", () => {
  const solo = { ...ready, participants: 1, playingVideos: 1 };
  assert.deepEqual(readinessProblems(solo, { solo: true }), []);
  assert.ok(readinessProblems(solo).length > 0);
  assert.ok(readinessProblems({ ...solo, playingVideos: 0 }, { solo: true }).length > 0);
  assert.ok(readinessProblems({ ...solo, visible: false }, { solo: true }).length > 0);
  assert.equal(parseOptions(["--check", "--solo"]).solo, true);
  assert.equal(parseOptions([]).solo, false);
});

test("microphone recording is opt-in and requires an explicit device index", () => {
  assert.equal(parseOptions([]).microphone, undefined);
  assert.equal(parseOptions(["--record", "--consent", "--output", "/tmp/mic.mp4", "--microphone", "1"]).microphone, "1");
  for (const value of ["-1", "1.5", "default", ""]) assert.throws(() => parseOptions(["--microphone", value]), /microphone/);
});

test("elapsed time, not capture throughput, determines the video duration", () => {
  assert.equal(framesDue(0, 8), 0);
  assert.equal(framesDue(125, 8), 1);
  assert.equal(framesDue(1500, 8), 12);
  assert.equal(framesDue(20000, 8), 160);
  assert.equal(framesDue(60000, 8), 480);
});

test("recording requires explicit consent and an output, and cannot target site assets", () => {
  assert.throws(() => parseOptions(["--record"]), /consent/);
  assert.throws(() => parseOptions(["--record", "--consent"]), /output/);
  assert.throws(() => parseOptions(["--record", "--consent", "--output", "apps/site/public/live.mp4"]), /public/);
  assert.throws(() => parseOptions(["--record", "--consent", "--output", "recording.txt"]), /mp4/);
  const options = parseOptions(["--record", "--consent", "--output", "/tmp/kan-live-demo.mp4", "--seconds", "90"]);
  assert.equal(options.mode, "record");
  assert.equal(options.seconds, 90);
});

test("preflight is read-only and unsafe or ambiguous arguments are rejected", () => {
  assert.equal(parseOptions([]).mode, "check");
  assert.equal(parseOptions(["--brief"]).mode, "brief");
  assert.throws(() => parseOptions(["--unknown"]), /Unknown/);
  assert.throws(() => parseOptions(["--check", "--record", "--consent", "--output", "/tmp/x.mp4"]), /one mode/);
  for (const value of ["0", "-1", "181", "NaN", "1.5"]) {
    assert.throws(() => parseOptions(["--record", "--consent", "--output", "/tmp/x.mp4", "--seconds", value]), /seconds/);
  }
});
