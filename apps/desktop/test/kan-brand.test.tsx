import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KanAppIcon, KanBrand } from "../src/components/KanBrand";

test("compact branding keeps a readable name and a decorative, theme-aware mark", () => {
  const html = renderToStaticMarkup(createElement(KanBrand));
  assert.match(html, /<span[^>]*>Kan<\/span>/);
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(html, /fill="currentColor"/);
  assert.match(html, /class="fill-agent"/);
  assert.match(html, /class="fill-suggestion"/);
  assert.doesNotMatch(html, /<img|<button|<a\s|\/\/ KAN/);
});

test("onboarding uses the bundled full icon without repeating its adjacent heading", () => {
  const html = renderToStaticMarkup(createElement(KanAppIcon));
  assert.match(html, /src="[^"]*src-tauri\/icons\/source\.png"/);
  assert.match(html, /alt=""/);
  assert.match(html, /width="80" height="80"/);
  assert.match(html, /draggable="false"/);
});
