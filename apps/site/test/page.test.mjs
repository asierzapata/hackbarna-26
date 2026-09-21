import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("v1 is screenshot-led with no video player or orphaned video links", () => {
  assert.doesNotMatch(html, /<video\b|href="#walkthrough"|canvas-walkthrough\.mp4/);
  assert.match(html, /Explore the product/);
  assert.match(html, /class="hero-product-link"/);
  assert.match(html, /src="\/screenshot-kan\.png"/);
});

test("editorial landing includes product evidence and accessible conversion sections", () => {
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
  assert.match(html, /AI canvas/);
  assert.match(html, /name="twitter:card"/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /id="use-cases"/);
  assert.match(html, /id="prototype-proof"/);
  assert.ok([...html.matchAll(/<details\b/g)].length >= 5);
  assert.doesNotMatch(html, /Trusted by thousands|5-star|Limited spots/);
});

test("copy leads with the outcome and preserves waitlist and capability disclosures", () => {
  const headline = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(headline, "Turn team conversations into plans you can work on.");
  for (const text of ["Plan an event", "Shape a project", "Compare your options", "No account needed to join."]) {
    assert.ok(html.includes(text), `Missing approved copy: ${text}`);
  }
  assert.match(html, /toolset isn’t in shared rooms yet/);
  assert.match(html, /provider’s limits and usage charges apply/);
  assert.match(html, /We haven’t announced an access date/);
  assert.doesNotMatch(html, /Not a mockup|Not just a concept|something worth opening|What’s under the hood|What works in the prototype today/);
});

test("hero award links to the verified HackBarna winner announcement", () => {
  const badge = html.match(/<a\b[^>]*class="award-badge"[\s\S]*?<\/a>/)?.[0];
  assert.ok(badge, "Missing hero award badge");
  assert.match(badge, /href="https:\/\/lnkd\.in\/p\/e8HsQ896"/);
  assert.match(badge, /1st place/);
  assert.match(badge, /HackBarna AI Summit 2026/);
  assert.match(badge, /rel="noopener noreferrer"/);
  assert.ok(html.indexOf(badge) < html.indexOf('<h1 id="hero-title">'));
});

test("decorative arrows use SVG paths instead of emoji-capable text glyphs", () => {
  assert.equal(/[\u2190-\u21ff\u2794-\u27bf]/u.test(html), false, "Text arrows can render as emoji on iOS");
  const arrows = [...html.matchAll(/<svg\b[^>]*class="arrow-icon"[^>]*>[\s\S]*?<\/svg>/g)];
  assert.equal(arrows.length, 13);
  for (const [arrow] of arrows) {
    assert.match(arrow, /aria-hidden="true"/);
    assert.match(arrow, /focusable="false"/);
    assert.match(arrow, /<path\b/);
  }
});

test("all page anchors resolve and both waitlist forms remain", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `Missing #${target}`);
  assert.equal([...html.matchAll(/\bdata-waitlist-form\b/g)].length, 2);
  const rendered = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g, "");
  assert.doesNotMatch(rendered, /href="[^"]*\.dmg"/);
});
