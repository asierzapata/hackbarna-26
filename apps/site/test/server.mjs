import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createWaitlistHandler } from "../../../api/waitlist.js";
import { createGoogleFixture, fixtureSecret } from "./google-fixture.mjs";

const mode = process.argv[2] ?? "unconfigured";
if (!["unconfigured", "fixture"].includes(mode)) throw new Error("Expected unconfigured or fixture mode");
const google = mode === "fixture" ? createGoogleFixture() : null;
const handler = createWaitlistHandler(google ? {
  env: { GOOGLE_SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/local-fixture/exec", WAITLIST_WEBHOOK_SECRET: fixtureSecret },
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    await new Promise(resolve => setTimeout(resolve, 350));
    if (body.email === "unavailable@example.com") return Response.json({ ok: false, error: "unavailable" });
    if (body.email === "limited@example.com") return Response.json({ ok: false, error: "busy" });
    if (body.email === "login@example.com") return new Response("<html>Sign in to Google</html>");
    return Response.json(google.post(body));
  },
} : { env: {} });
const server = createServer(async (req, res) => {
  try {
    if (google && req.method === "GET" && req.url === "/api/__test/waitlist") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ count: Math.max(0, (google.state.rows?.length ?? 0) - 1) }));
      return;
    }
    if (req.url !== "/api/waitlist") { res.writeHead(404).end(); return; }
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers,
      ...(!["GET", "HEAD"].includes(req.method) ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    });
    const result = await handler(request);
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res.writeHead(500).end();
  }
});
server.listen(1434, "127.0.0.1", () => console.log(`Local waitlist API :1434 (${mode}; no provider calls; fixture rows are in-memory only)`));
