import assert from "node:assert/strict";
import { test } from "node:test";

import { isMermaidSource, stripMermaidFence } from "../src/lib/mermaid";

const diagram = `flowchart TD
  Plan[HackBarna 26] --> Venue[Norrsken]
`;

test("detects raw and fenced Mermaid diagrams without hijacking ordinary text", () => {
  assert.equal(isMermaidSource(diagram), true);
  assert.equal(isMermaidSource(`Here is the plan:\n\`\`\`mermaid\n${diagram}\`\`\``), true);
  assert.equal(isMermaidSource("graph paper is useful"), false);
  assert.equal(isMermaidSource("timeline"), false);
});

test("strips Mermaid fences before the parser receives source", () => {
  assert.equal(stripMermaidFence(`\`\`\`mermaid\n${diagram}\`\`\``), diagram.trim());
  assert.equal(stripMermaidFence(`Intro\n\`\`\`mermaid\n${diagram}\`\`\``), diagram.trim());
});
