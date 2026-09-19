import { z } from "zod";
import { startRoomExecutor } from "./executor";

async function main() {
  const env = z.object({ KAN_SERVER_URL: z.string(), KAN_ROOM_ID: z.uuid(), KAN_USER_ID: z.uuid(), KAN_USER_SECRET: z.string().regex(/^[0-9a-f]{64}$/), KAN_AGENT_COMMAND: z.string().min(1), KAN_AGENT_ARGS: z.string().default("[]"), KAN_AUTO_CLAIM: z.enum(["true", "false"]).default("false") }).parse(process.env);
  const args = z.array(z.string()).parse(JSON.parse(env.KAN_AGENT_ARGS));
  const executor = await startRoomExecutor({ serverUrl: env.KAN_SERVER_URL, roomId: env.KAN_ROOM_ID, credential: { userId: env.KAN_USER_ID, secret: env.KAN_USER_SECRET }, agent: { command: env.KAN_AGENT_COMMAND, args }, autoClaim: env.KAN_AUTO_CLAIM === "true", onEvent: (event) => process.stdout.write(JSON.stringify(event) + "\n") });
  let pending = Buffer.alloc(0), closing = false;
  const close = async () => { if (closing) return; closing = true; process.stdin.destroy(); await executor.close(); };
  const command = z.discriminatedUnion("type", [z.strictObject({ type: z.literal("claim"), triggerId: z.uuid() }), z.strictObject({ type: z.literal("close") })]);
  process.stdin.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let i = 0; i <= chunk.length; i++) {
      if (i !== chunk.length && chunk[i] !== 10) continue;
      const part = chunk.subarray(start, i);
      if (pending.length + part.length > 65536) { void close(); process.exitCode = 1; return; }
      pending = Buffer.concat([pending, part]); start = i + 1;
      if (i === chunk.length) break;
      try {
        const input = command.parse(JSON.parse(pending.toString("utf8"))); pending = Buffer.alloc(0);
        if (input.type === "close") void close();
        else void executor.claim(input.triggerId).catch(() => process.stdout.write('{"type":"error","error":"claim_failed"}\n'));
      } catch { pending = Buffer.alloc(0); process.stdout.write('{"type":"error","error":"invalid_command"}\n'); }
    }
  });
  process.stdin.once("end", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}
void main().catch(() => { process.stdout.write('{"type":"error","error":"configuration_failed"}\n'); process.exitCode = 1; });
