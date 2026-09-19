import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The composer registers a QA source, which reads the current route at render
// time. Static rendering has no document, so give it the one thing it reads.
(globalThis as { window?: unknown }).window = { location: { pathname: "/canvas/test" } };

const { ThreadComposer } = await import("../src/components/thread/ThreadComposer");

function render(props: Parameters<typeof ThreadComposer>[0]) {
  return renderToStaticMarkup(createElement(ThreadComposer, props));
}

test("Ask Kan appears only with a connected agent; Send is always there", () => {
  // The placeholder names the button too, so assert on the control itself.
  const connected = render({ agentReady: true });
  assert.match(connected, /Ask Kan<\/button>/);
  assert.match(connected, /Send<\/button>/);

  const disconnected = render({ agentReady: false });
  assert.doesNotMatch(disconnected, /Ask Kan<\/button>/);
  assert.match(disconnected, /Send<\/button>/);
});
