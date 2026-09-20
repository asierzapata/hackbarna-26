import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentEntryCard } from "../src/components/thread/AgentEntryCard";
import { ThreadProvider } from "../src/components/thread/thread-context";
import type { AgentEntry } from "../src/lib/thread";

function render(text: string, streaming = false) {
  const entry: AgentEntry = {
    id: "markdown-test", kind: "agent", authorId: "agent", seq: 1,
    at: "2026-09-20T12:00:00Z", text,
  };
  return renderToStaticMarkup(createElement(ThreadProvider, {
    value: { participants: new Map(), currentUserId: "me" },
    children: createElement(AgentEntryCard, { entry, streaming }),
  }));
}

test("agent replies render headings, emphasis, lists, quotes and inline code", () => {
  const html = render("# Summary\n\n**Bold** and *italic* with `code`.\n\n- First\n  - Nested\n\n3. Third\n4. Fourth\n\n> Quoted\n\n---");
  for (const pattern of [/<h1>Summary<\/h1>/, /<strong>Bold<\/strong>/, /<em>italic<\/em>/,
    /<code>code<\/code>/, /<ul>/, /<li>Nested<\/li>/, /<ol start="3">/, /<blockquote>/, /<hr\/>/]) {
    assert.match(html, pattern);
  }
});

test("agent replies support GFM tables, strikethrough and task lists", () => {
  const html = render("| Name | Status |\n| :--- | ---: |\n| Kan | Ready |\n\n~~Old~~\n\n- [x] Done\n- [ ] Next");
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:right">Status<\/th>/);
  assert.match(html, /<td style="text-align:left">Kan<\/td>/);
  assert.match(html, /<del>Old<\/del>/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
});

test("agent replies preserve fenced and leading indented code", () => {
  assert.match(render('```ts\nconst value = "<tag>";\n  next();\n```'), /<pre><code class="language-ts">const value = &quot;&lt;tag&gt;&quot;;\n  next\(\);\n<\/code><\/pre>/);
  assert.match(render("    first();\n    second();"), /<pre><code>first\(\);\nsecond\(\);\n<\/code><\/pre>/);
});

test("agent replies parse paragraphs and explicit line breaks rather than preserving every newline", () => {
  const html = render("First line\ncontinues.\n\nNext paragraph.  \nHard break.");
  assert.match(html, /<p>First line\ncontinues\.<\/p>/);
  assert.match(html, /<p>Next paragraph\.<br\/>\nHard break\.<\/p>/);
});

test("agent reply links retain safe destinations without replacing the app", () => {
  const html = render("[Docs](https://example.com/docs) and https://example.com");
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, 2);
});

test("untrusted Markdown cannot inject HTML or executable URLs", () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[Bad](javascript:alert%281%29)\n\n![Bad](data:text/html,unsafe)');
  assert.doesNotMatch(html, /<script|<img[^>]+onerror|href="javascript:|src="data:/);
});

test("streaming replies render partial Markdown and empty replies keep their existing fallback", () => {
  assert.match(render("## Streaming\n\n```js\nconst x = 1", true), /<h2>Streaming<\/h2>/);
  assert.match(render("## Streaming\n\n```js\nconst x = 1", true), /<pre><code class="language-js">const x = 1\n<\/code><\/pre>/);
  assert.doesNotMatch(render("", true), /No response received/);
  assert.match(render(" \n "), /No response received/);
});
