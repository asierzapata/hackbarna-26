import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { selectableAgentModels } from "../src/lib/agent-models";
import { ModelSelectorKit } from "../src/components/ui/ai-model-select";

const models = [
  { id: "fable", label: "Fable High" },
  { id: "gpt-5-6-sol-low", label: "GPT-5.6 Sol Low Thinking" },
  { id: "gpt-5-6-luna-low", label: "GPT-5.6 Luna Low Thinking" },
  { id: "gpt-5-6-luna-high-priority", label: "GPT-5.6 Luna High Thinking Fast" },
  { id: "gpt-5-6-luna-high", label: "GPT-5.6 Luna High Thinking" },
  { id: "gpt-5-6-terra-high", label: "GPT-5.6 Terra High Thinking" },
  { id: "gpt-5-6-sol-high", label: "GPT-5.6 Sol High Thinking" },
  { id: "fusion-sidekick-luna-high", label: "Fusion (Fable + Luna)" },
];

test("model options contain exactly Luna, Terra, Sol with real high-thinking IDs", () => {
  assert.deepEqual(selectableAgentModels(models), [
    { id: "gpt-5-6-luna-high", label: "Luna" },
    { id: "gpt-5-6-terra-high", label: "Terra" },
    { id: "gpt-5-6-sol-high", label: "Sol" },
  ]);
  assert.equal(models[4].label, "GPT-5.6 Luna High Thinking");
});

test("current family variant is retained rather than silently switching models", () => {
  assert.equal(selectableAgentModels(models, "gpt-5-6-luna-low")[0].id, "gpt-5-6-luna-low");
});

test("unavailable families are omitted and substring or fusion matches are excluded", () => {
  assert.deepEqual(selectableAgentModels([]), []);
  assert.deepEqual(selectableAgentModels([
    { id: "solar", label: "Solar" },
    { id: "fusion", label: "Fusion with Sol" },
    { id: "provider-id", label: "Terra" },
  ]), [{ id: "provider-id", label: "Terra" }]);
});

test("picker displays the actual excluded current model instead of falsely selecting Luna", () => {
  const markup = renderToStaticMarkup(createElement(ModelSelectorKit, { models, value: { id: "fable" } }));
  assert.match(markup, /Model: Fable High/);
  assert.doesNotMatch(markup, /Model: Luna/);
});
