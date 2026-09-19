import assert from "node:assert/strict";
import { test } from "node:test";

import { nodeDraft, nodePatch } from "../apps/desktop/src/nodes/schema.ts";
import {
  calendarDays,
  eventsOnDate,
  formatDate,
  initialMonth,
  shiftMonth,
  sortEvents,
} from "../apps/desktop/src/nodes/dates.ts";

const events = [
  { id: "review", title: "Review", start: "2026-10-02" },
  { id: "study", title: "Study", start: "2026-09-29", end: "2026-10-02" },
];

test("both node contracts accept date-only events and empty collections", () => {
  for (const type of ["timeline", "calendar"]) {
    assert.equal(nodeDraft.parse({ type, title: "Research", events }).type, type);
    assert.ok(nodeDraft.safeParse({ type, title: "Empty", events: [] }).success);
  }
});

test("reject invalid dates, reversed ranges, and duplicate event IDs", () => {
  for (const invalid of [
    [{ id: "a", title: "Bad", start: "2026-02-29" }],
    [{ id: "a", title: "Bad", start: "2026-09-19T12:00:00Z" }],
    [{ id: "a", title: "Bad", start: "0000-01-01" }],
    [{ id: "a", title: "Bad", start: "2026-10-02", end: "2026-09-29" }],
    [events[0], events[0]],
  ]) {
    for (const type of ["timeline", "calendar"]) {
      assert.equal(nodeDraft.safeParse({ type, title: "Invalid", events: invalid }).success, false);
      assert.equal(nodePatch.safeParse({ type, events: invalid }).success, false);
    }
  }
  assert.equal(nodeDraft.safeParse({ type: "calendar", title: "Bad", events, month: "2026-13" }).success, false);
});

test("accept leap days and validate shared interaction state", () => {
  assert.ok(nodeDraft.safeParse({ type: "timeline", title: "Leap", events: [{ id: "leap", title: "Leap day", start: "2024-02-29" }] }).success);
  assert.ok(nodePatch.safeParse({ type: "timeline", selectedEventId: null }).success);
  assert.ok(nodePatch.safeParse({ type: "calendar", month: "2026-12", selectedDate: "2026-12-31" }).success);
  assert.equal(nodePatch.safeParse({ type: "calendar", selectedDate: "2026-02-30" }).success, false);
});

test("chronological sorting leaves source order intact and finds the initial month", () => {
  assert.deepEqual(sortEvents(events).map((event) => event.id), ["study", "review"]);
  assert.equal(events[0].id, "review");
  assert.equal(initialMonth(events), "2026-09");
  assert.match(initialMonth([]), /^\d{4}-\d{2}$/);
});

test("date ranges include both ends and overlap month boundaries", () => {
  assert.deepEqual(eventsOnDate(events, "2026-09-28"), []);
  assert.deepEqual(eventsOnDate(events, "2026-09-29").map((event) => event.id), ["study"]);
  assert.deepEqual(eventsOnDate(events, "2026-10-02").map((event) => event.id), ["study", "review"]);
  assert.deepEqual(eventsOnDate(events, "2026-10-03"), []);
});

test("month navigation handles year rollover and supported-year boundaries", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2027-01", -1), "2026-12");
  assert.equal(shiftMonth("0099-12", 1), "0100-01");
  assert.equal(shiftMonth("0001-01", -1), "0001-01");
  assert.equal(shiftMonth("9999-12", 1), "9999-12");
});

test("calendar uses a Monday-first grid, including leap years and six-week months", () => {
  const leap = calendarDays("2024-02");
  assert.equal(leap.length, 42);
  assert.equal(leap[3], "2024-02-01");
  assert.equal(leap.filter(Boolean).length, 29);
  assert.equal(calendarDays("2026-02").filter(Boolean).length, 28);
  assert.equal(calendarDays("2026-03")[36], "2026-03-31");
  assert.equal(calendarDays("0001-01")[0], "0001-01-01");
});

test("formatting preserves date-only values regardless of machine timezone", () => {
  assert.match(formatDate("2026-09-19"), /^19 Sept? 2026$/);
});
