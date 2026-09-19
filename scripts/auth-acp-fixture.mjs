#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.KAN_AUTH_FIXTURE_DIR;
if (!dir) process.exit(1);
const openai = process.argv.includes("-y");
const provider = openai ? "openai" : "devin";
const key = process.env[openai ? "CODEX_API_KEY" : "WINDSURF_API_KEY"];
const token = join(dir, `${provider}-subscription`);
const expired = join(dir, "expired");
const authenticationCount = join(dir, "auth-count");
let model = "model-a";
let authenticated = key === "kan-e2e-not-a-real-key" || existsSync(token);
const config = () => [{ id: "model", category: "model", type: "select", name: "Model", currentValue: model, options: [
  { value: "model-a", name: "Fixture Fast" },
  { value: "model-b", name: "Fixture Reasoning" },
] }];
const modelState = () => openai
  ? { models: { currentModelId: model, availableModels: [{ modelId: "model-a", name: "Fixture Fast" }, { modelId: "model-b", name: "Fixture Reasoning" }] } }
  : { configOptions: config() };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!request.id) continue;
  const { id, method, params = {} } = request;
  let result = {};
  if (method === "initialize") {
    result = { protocolVersion: 1, agentInfo: { name: "kan-auth-fixture", title: `${provider} fixture` }, agentCapabilities: {}, authMethods: [
      { id: "api-key", name: "API key" }, { id: openai ? "chat-gpt" : "devin-browser", name: "Subscription" },
    ] };
  } else if (method === "authenticate") {
    writeFileSync(authenticationCount, String(Number(existsSync(authenticationCount) ? readFileSync(authenticationCount, "utf8") : 0) + 1));
    if (params.methodId === "api-key") {
      authenticated = key === "kan-e2e-not-a-real-key";
      if (openai && authenticated) writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }));
    } else {
      authenticated = true;
      writeFileSync(token, "fixture-subscription");
    }
  } else if (method === "session/new") {
    if (!authenticated || existsSync(expired)) {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      continue;
    }
    result = { sessionId: "fixture-session", ...modelState() };
  } else if (method === "session/set_config_option" || method === "session/set_model") {
    model = params.value ?? params.modelId;
    writeFileSync(join(dir, "selected-model"), model);
    result = modelState();
  } else if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Executed by ${model}` } } } });
    result = { stopReason: "end_turn" };
  } else if (method !== "session/cancel") {
    send({ id, error: { code: -32601, message: "Unsupported fixture method" } });
    continue;
  }
  send({ id, result });
}
