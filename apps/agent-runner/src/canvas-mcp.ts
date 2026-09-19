import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasToolInputs, DataQueryInput } from "@kan/protocol";
import { TOOL_DESCRIPTIONS } from "./tool-descriptions";
import { HttpError, type RunClient } from "./run-client";

export function createCanvasMcpServer(runClient: RunClient, mode: "act" | "propose") {
  const server = new McpServer({ name: "kan-canvas", version: "0.1.0" });
  const result = async (call: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await call()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof HttpError ? `http_${error.status}` : "tool_failed" }) }] }; }
  };
  server.registerTool("getCanvas", { description: TOOL_DESCRIPTIONS.getCanvas, inputSchema: CanvasToolInputs.getCanvas }, (input) => result(() => runClient.canvas(input)));
  server.registerTool("queryData", { description: TOOL_DESCRIPTIONS.queryData, inputSchema: DataQueryInput }, (input) => result(() => runClient.query(input)));
  if (mode === "propose") {
    server.registerTool("proposeNode", { description: TOOL_DESCRIPTIONS.proposeNode, inputSchema: CanvasToolInputs.proposeNode }, ({ draft, requestId }) => result(() => runClient.propose(draft, requestId)));
  } else {
    server.registerTool("addNode", { description: TOOL_DESCRIPTIONS.addNode, inputSchema: CanvasToolInputs.addNode }, ({ requestId, ...input }) => result(() => runClient.mutate({ type: "add", ...input }, requestId)));
    server.registerTool("updateNode", { description: TOOL_DESCRIPTIONS.updateNode, inputSchema: CanvasToolInputs.updateNode }, ({ requestId, ...input }) => result(() => runClient.mutate({ type: "update", ...input }, requestId)));
    server.registerTool("connectNodes", { description: TOOL_DESCRIPTIONS.connectNodes, inputSchema: CanvasToolInputs.connectNodes }, ({ requestId, ...input }) => result(() => runClient.mutate({ type: "connect", ...input }, requestId)));
    server.registerTool("arrange", { description: TOOL_DESCRIPTIONS.arrange, inputSchema: CanvasToolInputs.arrange }, ({ requestId, ...input }) => result(() => runClient.mutate({ type: "arrange", ...input }, requestId)));
  }
  return server;
}
