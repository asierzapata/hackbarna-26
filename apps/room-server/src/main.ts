import { openDb } from "./db";
import { createRoomServer } from "./server";
import { configFromEnv } from "./config";

const config = configFromEnv();
const db = openDb(config.dbPath);
const roomServer = createRoomServer({
  db,
  allowedOrigins: config.allowedOrigins,
  classifier: config.classifier,
  video: config.video,
});
roomServer.engine.start();
roomServer.server.listen(config.port, () => {
  console.log(`room-server listening on :${config.port}`);
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await roomServer.close();
  db.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
