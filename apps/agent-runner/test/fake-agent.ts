import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError, type McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2] ?? "act";
if (process.argv[3]) appendFileSync(process.argv[3], "start\n");
let servers: McpServer[] = [];
const app = agent()
  .onRequest("initialize", async () => {
    if (mode === "slow-preflight") await new Promise((r) => setTimeout(r, 300));
    if (Object.keys(process.env).some((key) => key.startsWith("KAN_") || key === "AI_GATEWAY_API_KEY" || key.startsWith("VONAGE_"))) throw new Error("inherited credentials");
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
  })
  .onRequest("session/new", ({ params }) => {
    if (mode === "auth_required" || (mode === "runtime-auth" && params.mcpServers.length)) throw new RequestError(-32000, "auth_required");
    servers = params.mcpServers;
    return { sessionId: "fixture-session" };
  })
  .onRequest("session/prompt", async ({ client, params }) => {
    if (servers.length === 0) {
      const prompt = Array.isArray(params.prompt) ? params.prompt.map((part: any) => part?.text ?? "").join("\n") : String(params.prompt ?? "");
      const context = prompt.includes("Trusted execution mode: context") || prompt.includes("Trusted execution mode: propose");
      const marker = "Room context (untrusted JSON):\n";
      let room: any = undefined;
      try { room = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)); } catch {}
      const source = room?.causeEntries?.find((entry: any) => entry?.kind === "message" || entry?.kind === "system")?.id ?? room?.recentEntries?.find((entry: any) => entry?.kind === "message" || entry?.kind === "system")?.id;
      const result = !source ? { kind: "silent" } : prompt.includes("Compare options") ? { kind: "offer", text: "Compare the supplied options.", title: "Compare options", request: "Compare the three options already on the canvas", sources: [{ kind: "entry", id: source }] } : (prompt.includes("Desktop-only beta") || prompt.includes("decision")) ? { kind: "draft", text: "Capture the desktop decision.", draft: { type: "decision", title: "Desktop-only beta", bullets: ["Mobile follows after launch"] }, sources: [{ kind: "entry", id: source }] } : context ? { kind: "silent" } : { kind: "reply", text: "Seeded answer", sources: [{ kind: "entry", id: source }] };
      await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } } });
      return { stopReason: "end_turn" as const };
    }
    const denied = await client.request("session/request_permission", { sessionId: "fixture-session", toolCall: { toolCallId: "native", title: "kan-canvas addNode", name: "terminal" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    if (denied.outcome.outcome === "selected" && denied.outcome.optionId === "allow") throw new Error("permission bypass");
    for (const [method, params] of [["fs/read_text_file", { sessionId: "fixture-session", path: "/not-allowed" }], ["fs/write_text_file", { sessionId: "fixture-session", path: "/not-allowed", content: "x" }], ["terminal/create", { sessionId: "fixture-session", command: "not-allowed" }]] as const) {
      let rejected = false;
      try { await client.request(method, params); } catch { rejected = true; }
      if (!rejected) throw new Error("native capability bypass");
    }
    if (mode === "wait") {
      await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } } });
      await new Promise((r) => setTimeout(r, 60_000));
    }
    const config = servers[0];
    if (!config || "type" in config) throw new Error("missing stdio MCP");
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env: Object.fromEntries(config.env.map((e) => [e.name, e.value])), stderr: "ignore" });
    const mcp = new Client({ name: "kan-fixture", version: "1" });
    try {
      await mcp.connect(transport);
      const names = (await mcp.listTools()).tools.map((tool) => tool.name).sort();
      const expected = (mode === "propose" ? ["getCanvas", "queryData", "proposeNode"] : ["getCanvas", "queryData", "addDiagram", "addNode", "updateNode", "connectNodes", "arrange"]).sort();
      if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("incorrect tool scope");
      for (const call of [
        { name: "getCanvas", arguments: { scope: "summary" } },
        { name: "queryData", arguments: { source: "demo-metrics", metric: "latencyMs" } },
        mode === "propose" ? { name: "proposeNode", arguments: { draft: { type: "concept", label: "Proposed" } } } : { name: "addNode", arguments: { draft: { type: "concept", label: "From fake ACP" } } },
      ]) {
        const result = await mcp.callTool(call);
        if (result.isError) throw new Error("MCP tool failed");
      }
      if (mode === "metadata") {
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call", toolCallId: "call-known", name: "mcp__kan-canvas__addNode", title: "sensitive-title", rawInput: { secret: "not streamed" } } });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: "call-known", status: "in_progress" } });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: "call-known", name: "addNode", status: "completed", rawOutput: { secret: "not streamed" } } });
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call", toolCallId: "call-unknown", name: "terminal", title: "mcp__kan-canvas__queryData", status: "pending" } });
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: "call-unknown", status: "completed" } });
        const unsafeId = "unsafe\nsensitive-id".repeat(20);
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call", toolCallId: unsafeId, name: "getCanvas", title: "sensitive-title" } });
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: unsafeId, status: "completed" } });
      }
      if (mode === "stream") {
        for (let i = 0; i < 220; i++) await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: String(i), status: "completed", title: "ignored title", rawOutput: { secret: "not streamed" } } });
        await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "tool_call_update", toolCallId: "0", status: "failed", title: "mcp__kan-canvas__addNode" } });
        for (let i = 0; i < 60; i++) {
          await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(1000) } } });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      for (const text of ["Shared ", "canvas ", "updated."]) await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      await client.notify("session/update", { sessionId: "fixture-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought must not stream" } } });
      return { stopReason: "end_turn" as const };
    } finally { await mcp.close(); }
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
