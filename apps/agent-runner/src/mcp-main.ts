import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createCanvasMcpServer } from "./canvas-mcp";
import { RunClient } from "./run-client";

async function main() {
  const env = z.object({ KAN_RUN_SERVER_URL: z.string(), KAN_RUN_ROOM_ID: z.uuid(), KAN_RUN_RUN_ID: z.uuid(), KAN_RUN_LEASE_TOKEN: z.string().regex(/^[0-9a-f]{64}$/) }).parse(process.env);
  const client = new RunClient(env.KAN_RUN_SERVER_URL, env.KAN_RUN_ROOM_ID, env.KAN_RUN_RUN_ID, env.KAN_RUN_LEASE_TOKEN);
  const context = await client.request<{ trigger: { mode: "act" | "propose" } }>("/context");
  const server = createCanvasMcpServer(client, context.trigger.mode);
  await server.connect(new StdioServerTransport());
}
void main().catch(() => { process.exitCode = 1; });
