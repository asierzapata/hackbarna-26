import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomAssistantSettings } from "../src/components/RoomAssistantSettings";

const render = (room: { assistantThreshold?: number; assistantCooldownMs?: number }) => renderToStaticMarkup(createElement(RoomAssistantSettings, { room, onSave: async () => room }));

test("online controls expose the actual probability and cooldown with accessible labels", () => {
  const html = render({ assistantThreshold: 0.6, assistantCooldownMs: 5000 });
  assert.match(html, /Probability threshold/);
  assert.match(html, /assistant-threshold-value[^>]*>0\.60/);
  assert.match(html, /assistant-cooldown-value[^>]*>5/);
  assert.equal((html.match(/<input[^>]*type="range"/g) ?? []).length, 2);
  assert.match(html, /aria-labelledby="[^"]*threshold-label"/);
  assert.match(html, /aria-labelledby="[^"]*cooldown-label"/);
});

test("zero settings remain zero rather than falling back to defaults", () => {
  const html = render({ assistantThreshold: 0, assistantCooldownMs: 0 });
  assert.match(html, /assistant-threshold-value[^>]*>0\.00/);
  assert.match(html, /assistant-cooldown-value[^>]*>0/);
  assert.doesNotMatch(html, /server needs an update/);
});

test("an old server visibly disables unsupported controls instead of pretending to save", () => {
  const html = render({});
  assert.match(html, /server needs an update/);
  assert.match(html, /disabled=""/);
});
