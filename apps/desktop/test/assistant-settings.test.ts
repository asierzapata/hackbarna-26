import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_EAGERNESS } from "@kan/protocol";

import {
  CHIME_IN_OPTIONS,
  chimeInOption,
  fromChimeIn,
  toChimeIn,
} from "../src/lib/assistant-settings";
import { entrySearchText, matchesSearch, buildThreadRows } from "../src/lib/thread";
import type { MessageEntry, ThreadEntry, TriggerEntry } from "../src/lib/thread";

test("the ladder covers every eagerness level plus the manual case", () => {
  assert.deepEqual(
    CHIME_IN_OPTIONS.map((option) => option.value),
    ["asked", "relaxed", "balanced", "eager", "insistent"],
  );
  assert.equal(chimeInOption("asked").label, "Only when asked");
  assert.ok(CHIME_IN_OPTIONS.every((option) => option.description.length > 0));
});

test("manual scope reads as 'only when asked' whatever the stored eagerness", () => {
  assert.equal(toChimeIn("manual", "insistent"), "asked");
  assert.equal(toChimeIn("own", "eager"), "eager");
  assert.equal(toChimeIn("room", "relaxed"), "relaxed");
});

test("a corrupt stored eagerness falls back instead of showing nothing", () => {
  assert.equal(toChimeIn("own", "nonsense" as never), DEFAULT_EAGERNESS);
});

test("leaving 'only when asked' restores the scope that was active before", () => {
  assert.deepEqual(fromChimeIn("asked", "room"), { scope: "manual" });
  assert.deepEqual(fromChimeIn("eager", "room"), { scope: "room", eagerness: "eager" });
  // Never resolve back into manual: the ladder would have no way out.
  assert.deepEqual(fromChimeIn("eager", "manual"), { scope: "own", eagerness: "eager" });
});

const message = (id: string, text: string, extra: Partial<MessageEntry> = {}): MessageEntry => ({
  kind: "message",
  id,
  seq: Number(id),
  at: "2026-09-20T10:00:00.000Z",
  authorId: "asier",
  text,
  ...extra,
});

test("search reaches anchors and attachments, not only the body", () => {
  const entry = message("1", "look at this", {
    anchors: [{ nodeId: "shape:a", label: "Venue map" }],
    attachments: [{ id: "f1", name: "budget.csv", kind: "file" }],
  });
  assert.ok(matchesSearch(entry, "venue"));
  assert.ok(matchesSearch(entry, "budget.csv"));
  assert.ok(!matchesSearch(entry, "sponsors"));
});

test("an empty or whitespace query matches everything", () => {
  const entry = message("1", "anything");
  assert.ok(matchesSearch(entry, ""));
  assert.ok(matchesSearch(entry, "   "));
});

test("search is case-insensitive and covers agent step summaries", () => {
  const entry: ThreadEntry = {
    kind: "agent",
    id: "9",
    seq: 9,
    at: "2026-09-20T10:00:00.000Z",
    authorId: "assistant",
    text: "done",
    steps: [{ id: "s1", tool: "addNode", summary: "Added the sponsors table" }],
  };
  assert.ok(entrySearchText(entry).includes("sponsors table"));
  assert.ok(matchesSearch(entry, "SPONSORS"));
});

test("buildThreadRows narrows the stream to matches", () => {
  const rows = buildThreadRows(
    [message("1", "venue is booked"), message("2", "sponsors are not")],
    "venue",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type === "entry" && rows[0].entry.id, "1");
});

test("contextual triggers stay hidden now that the agent-activity tab is gone", () => {
  const trigger: TriggerEntry = {
    kind: "trigger",
    id: "3",
    seq: 3,
    at: "2026-09-20T10:00:00.000Z",
    authorId: "assistant",
    triggerId: "t1",
    requestedBy: "asier",
    reason: "contextual",
    mode: "context",
    status: "done",
    anchors: [],
    assigneeSessionId: null,
    attempt: 1,
  };
  assert.equal(buildThreadRows([trigger]).length, 0);
  // An explicit act request is still the user's own work, so it stays visible.
  assert.equal(buildThreadRows([{ ...trigger, mode: "act" }]).length, 1);
});
