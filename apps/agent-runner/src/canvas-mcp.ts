import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasToolInputs, DataQueryInput, normalizeFailure } from "@kan/protocol";
import { recordRunnerDiagnostic } from "./diagnostics";
import { TOOL_DESCRIPTIONS } from "./tool-descriptions";
import { type RunClient } from "./run-client";

export function createCanvasMcpServer(runClient: RunClient, mode: "act" | "propose") {
  const server = new McpServer({ name: "kan-canvas", version: "0.1.0" });
  const result = async (tool: string, call: () => Promise<unknown>, requestId: string = crypto.randomUUID()) => {
    const started = performance.now();
    recordRunnerDiagnostic({ event: "tool.received", runId: runClient.runId, requestId, tool });
    try {
      const text = JSON.stringify(await call());
      recordRunnerDiagnostic({ event: "tool.execution_finished", runId: runClient.runId, requestId, tool, bytes: Buffer.byteLength(text), durationMs: performance.now() - started });
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const detail = normalizeFailure(error, "execution");
      recordRunnerDiagnostic({ event: "tool.execution_failed", runId: runClient.runId, requestId, tool, durationMs: performance.now() - started, failure: detail });
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(detail) }] };
    }
  };
  server.registerTool("getCanvas", { description: TOOL_DESCRIPTIONS.getCanvas, inputSchema: CanvasToolInputs.getCanvas }, (input) => result("getCanvas", () => runClient.canvas(input)));
  server.registerTool("queryData", { description: TOOL_DESCRIPTIONS.queryData, inputSchema: DataQueryInput }, (input) => result("queryData", () => runClient.query(input)));
  if (mode === "propose") {
    server.registerTool("proposeNode", { description: TOOL_DESCRIPTIONS.proposeNode, inputSchema: CanvasToolInputs.proposeNode }, ({ draft, requestId }) => result("proposeNode", () => runClient.propose(draft, requestId), requestId));
  } else {
    server.registerTool("addNode", { description: TOOL_DESCRIPTIONS.addNode, inputSchema: CanvasToolInputs.addNode }, ({ requestId, ...input }) => result("addNode", () => runClient.mutate({ type: "add", ...input }, requestId), requestId));
    server.registerTool("updateNode", { description: TOOL_DESCRIPTIONS.updateNode, inputSchema: CanvasToolInputs.updateNode }, ({ requestId, ...input }) => result("updateNode", () => runClient.mutate({ type: "update", ...input }, requestId), requestId));
    server.registerTool("connectNodes", { description: TOOL_DESCRIPTIONS.connectNodes, inputSchema: CanvasToolInputs.connectNodes }, ({ requestId, ...input }) => result("connectNodes", () => runClient.mutate({ type: "connect", ...input }, requestId), requestId));
    server.registerTool("arrange", { description: TOOL_DESCRIPTIONS.arrange, inputSchema: CanvasToolInputs.arrange }, ({ requestId, ...input }) => result("arrange", () => runClient.mutate({ type: "arrange", ...input }, requestId), requestId));
  }
  return server;
}
