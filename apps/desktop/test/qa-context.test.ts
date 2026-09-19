import assert from "node:assert/strict";
import { test } from "node:test";
import { createQaRegistry, redactQaContext } from "../src/lib/qa-context.ts";

test("QA redacts credentials without removing useful canvas and chat state", () => {
  const result = redactQaContext({
    apiKey: "private", nested: { access_token: "private", password: "private" },
    text: "Bearer secret-value and sk-testPrivateValue1234567890",
    url: "https://example.test/a?ticket=private&token=private#private",
    canvas: { selectedShapeIds: ["shape:1"], title: "Broken table" },
  });
  assert.equal(result.apiKey, "[REDACTED]");
  assert.equal(result.nested.access_token, "[REDACTED]");
  assert.equal(result.nested.password, "[REDACTED]");
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!result.text.includes("secret-value"));
  assert.deepEqual(result.canvas.selectedShapeIds, ["shape:1"]);
});

test("QA captures live sources, retains closed chat, and isolates routes", () => {
  const registry = createQaRegistry();
  let entries = ["one"];
  const unregister = registry.register("/canvas/a", "chat", () => ({ entries }));
  entries = ["one", "two"];
  assert.deepEqual(registry.capture("/canvas/a").chat, { mounted: true, value: { entries } });
  unregister();
  assert.deepEqual(registry.capture("/canvas/a").chat, { mounted: false, value: { entries } });
  assert.deepEqual(registry.capture("/canvas/b"), {});
  registry.register("/canvas/b", "canvas", () => { throw new Error("Unavailable"); });
  assert.deepEqual(registry.capture("/canvas/b").canvas, { error: "Unavailable" });
});
