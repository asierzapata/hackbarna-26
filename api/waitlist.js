const unavailable = "Signup is temporarily unavailable. Please try again soon.";
const reply = (status, body) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createWaitlistHandler({ env = process.env, fetch: send = globalThis.fetch } = {}) {
  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", "cache-control": "no-store" } });
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return reply(403, { error: "Please sign up from the Kan website." });
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return reply(415, { error: "Expected a JSON request." });
    if (Number(request.headers.get("content-length")) > 4096) return reply(413, { error: "Request too large." });
    let body;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, { error: "Enter a valid email address." });
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return reply(413, { error: "Request too large." });
        }
        chunks.push(value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(400, { error: "Enter a valid email address." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Enter a valid email address." });
    if (body.website) return reply(200, { ok: true });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || body.consent !== true) {
      return reply(400, { error: "Enter a valid email address and agree to waitlist updates." });
    }
    const webhook = env.GOOGLE_SHEETS_WEBHOOK_URL?.trim() ?? "";
    const secret = env.WAITLIST_WEBHOOK_SECRET?.trim() ?? "";
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(webhook) || secret.length < 32 || secret.length > 256) return reply(503, { error: unavailable });
    try {
      const signal = AbortSignal.timeout(9000);
      let result = await send(webhook, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, consent: true, consentVersion: "kan-waitlist-v1", secret }),
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303].includes(result.status)) {
        const location = result.headers.get("location");
        if (!location) return reply(503, { error: unavailable });
        const redirect = new URL(location);
        if (redirect.origin !== "https://script.googleusercontent.com" || redirect.username || redirect.password) return reply(503, { error: unavailable });
        result = await send(redirect.href, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal });
      }
      if (result.status === 429) return reply(429, { error: "Too many signups right now. Please try again in a few minutes." });
      if (!result.ok) return reply(503, { error: unavailable });
      const confirmation = await result.json();
      if (confirmation?.ok === false && confirmation.error === "busy") return reply(429, { error: "Too many signups right now. Please try again in a few minutes." });
      if (confirmation?.ok !== true) return reply(503, { error: unavailable });
      return reply(200, { ok: true });
    } catch {
      return reply(503, { error: unavailable });
    }
  };
}

export default { fetch: createWaitlistHandler() };
