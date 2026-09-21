import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaitlistHandler } from "../../../api/waitlist.js";

const env = {
  GOOGLE_SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/test-deployment/exec",
  WAITLIST_WEBHOOK_SECRET: "test-only-shared-secret-not-a-real-secret",
};
const request = (body = { email: "hello@example.com", consent: true }, options = {}) => new Request("https://www.getkan.dev/api/waitlist", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://www.getkan.dev" }, body: JSON.stringify(body), ...options,
});
const handler = (fetch = async () => Response.json({ ok: true }), config = env) => createWaitlistHandler({ env: config, fetch });

test("sends normalized signup and consent to the server-only Google endpoint", async () => {
  let call;
  const response = await handler(async (url, options) => {
    call = { url, ...options };
    return Response.json({ ok: true });
  })(request({ email: " Hello@Example.COM ", consent: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(call.url, env.GOOGLE_SHEETS_WEBHOOK_URL);
  assert.equal(call.redirect, "manual");
  assert.deepEqual(JSON.parse(call.body), { email: "hello@example.com", consent: true, consentVersion: "kan-waitlist-v1", secret: env.WAITLIST_WEBHOOK_SECRET });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("follows Google's content redirect with GET and never forwards the secret", async () => {
  const calls = [];
  const location = "https://script.googleusercontent.com/macros/echo?test=result";
  const response = await handler(async (url, options) => {
    calls.push({ url, ...options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location } }) : Response.json({ ok: true });
  })(request());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, location);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].redirect, "error");
  assert.doesNotMatch(JSON.stringify(calls[1]), /test-only-shared-secret/);
});

test("does not follow login, unsafe, missing, or body-preserving redirects", async () => {
  for (const [status, location] of [
    [302, "https://accounts.google.com/login"], [302, "https://other.example/result"],
    [302, "http://script.googleusercontent.com/macros/echo"], [302, "https://script.googleusercontent.com:8443/macros/echo"],
    [302, null], [307, "https://script.googleusercontent.com/macros/echo"], [308, "https://script.googleusercontent.com/macros/echo"],
  ]) {
    let calls = 0;
    const response = await handler(async () => {
      assert.equal(++calls, 1);
      return new Response(null, { status, headers: location ? { location } : {} });
    })(request());
    assert.equal(response.status, 503);
  }
});

for (const body of [{ email: "bad", consent: true }, { email: "a@b.com" }, { email: "a@b.com", consent: "true" }, null, [], { email: "a".repeat(260) + "@b.com", consent: true }]) {
  test(`rejects invalid signup ${JSON.stringify(body)?.slice(0, 70)}`, async () => {
    const response = await handler(() => assert.fail("must not contact Google"))(request(body));
    assert.equal(response.status, 400);
  });
}

test("rejects wrong methods, cross-origin requests, and non-JSON bodies", async () => {
  const run = handler(() => assert.fail("must not contact Google"));
  assert.equal((await run(new Request("https://www.getkan.dev/api/waitlist"))).status, 405);
  assert.equal((await run(request({}, { headers: { origin: "https://other.example", "content-type": "application/json" } }))).status, 403);
  assert.equal((await run(request({}, { headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal((await run(request({}, { body: "{" }))).status, 400);
  assert.equal((await run(request({}, { body: "x".repeat(5000) }))).status, 413);
});

test("honeypot submissions do not reach Google", async () => {
  const response = await handler(() => assert.fail("must not contact Google"))(request({ email: "a@b.com", consent: true, website: "spam" }));
  assert.equal(response.status, 200);
});

test("missing or unsafe configuration fails before contacting a provider", async () => {
  const configs = [{}, { ...env, WAITLIST_WEBHOOK_SECRET: "short" }];
  for (const url of ["https://other.example/exec", "http://script.google.com/macros/s/id/exec", "https://script.google.com/macros/s/id/dev", "https://script.google.com/macros/s/id/exec?secret=test", "https://user@script.google.com/macros/s/id/exec"]) configs.push({ ...env, GOOGLE_SHEETS_WEBHOOK_URL: url });
  for (const config of configs) assert.equal((await handler(() => assert.fail("must not send the secret"), config)(request())).status, 503);
});

test("Google must confirm persistence with JSON ok:true, not just HTTP 200", async () => {
  for (const result of [new Response("<html>Sign in</html>"), Response.json({}), Response.json({ ok: "true" }), Response.json({ ok: false, error: "unauthorized" }), Response.json({ ok: false, error: "unavailable" })]) {
    const response = await handler(async () => result)(request());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /unauthorized|test-only|Sign in/);
  }
  assert.equal((await handler(async () => Response.json({ ok: false, error: "busy" }))(request())).status, 429);
});

test("provider failures never leak details or report success", async () => {
  for (const status of [400, 401, 429, 500]) {
    const response = await handler(async () => new Response("secret provider details", { status }))(request());
    assert.equal(response.status, status === 429 ? 429 : 503);
    assert.doesNotMatch(await response.text(), /secret|test-only/);
  }
  assert.equal((await handler(async () => { throw new Error("secret network failure"); })(request())).status, 503);
});
