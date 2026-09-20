import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanels } from "../src/components/WorkspacePanels";
import { AgentEntryCard } from "../src/components/thread/AgentEntryCard";
import { ThreadProvider } from "../src/components/thread/thread-context";

function renderWorkspace(chatOpen: boolean) {
  return renderToStaticMarkup(createElement(WorkspacePanels, {
    chatOpen,
    canvas: createElement("span", { "data-testid": "canvas" }, "canvas"),
    chat: createElement("span", { "data-testid": "chat" }, "chat"),
  }));
}

function renderAgent(text: string, streaming: boolean) {
  return renderToStaticMarkup(createElement(ThreadProvider, {
    value: {
      participants: { assistant: { id: "assistant", name: "Agent", kind: "agent" } },
      currentUserId: "user",
    },
    children: createElement(AgentEntryCard, {
      entry: {
        id: "agent-1",
        seq: 1,
        kind: "agent",
        at: "2026-09-19T00:00:00.000Z",
        authorId: "assistant",
        text,
        model: "Hidden model",
        durationMs: 1000,
        steps: [{ id: "step-1", tool: "tool", summary: "Hidden tool" }],
      },
      streaming,
    }),
  }));
}

test("workspace renders both panel contents in either chat state and hides closed chat accessibly", () => {
  for (const chatOpen of [false, true]) {
    const markup = renderWorkspace(chatOpen);
    assert.match(markup, /data-testid="canvas"/);
    assert.match(markup, /data-testid="chat"/);
    assert.match(markup, /h-full/);
    assert.match(markup, /min-h-0/);
    if (!chatOpen) {
      assert.match(markup, /inert=""/);
      assert.match(markup, /aria-hidden="true"/);
    }
  }
});

test("a streaming agent turn narrates its steps through an accessible status", () => {
  const markup = renderAgent("", true);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  // The rail reports what is running; the model name and raw duration stay out.
  assert.match(markup, /Hidden tool/);
  assert.doesNotMatch(markup, /No response received|Hidden model|1000/);
});

test("completed empty agent turns say that no response was received", () => {
  const markup = renderAgent("", false);
  assert.match(markup, />No response received<\/span>/);
  assert.doesNotMatch(markup, />Working<\/span>/);
});

test("a reply is shown alongside the steps that produced it", () => {
  const markup = renderAgent("Updated the box.", true);
  assert.match(markup, /Updated the box\./);
  assert.match(markup, /Hidden tool/);
  assert.doesNotMatch(markup, /No response received|Hidden model|1000/);
});
