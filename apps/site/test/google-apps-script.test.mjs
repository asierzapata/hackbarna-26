import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleFixture, fixtureSecret } from "./google-fixture.mjs";
import { createWaitlistHandler } from "../../../api/waitlist.js";

const signup = (email = "hello@example.com") => ({ email, consent: true, consentVersion: "kan-waitlist-v1", secret: fixtureSecret });

test("creates a dedicated sheet, stores consent and UTC time, and deduplicates retries", () => {
  const f = createGoogleFixture();
  assert.deepEqual(f.post(signup(" Hello@Example.COM ")), { ok: true });
  assert.deepEqual(f.post(signup()), { ok: true });
  assert.equal(f.state.rows.length, 2);
  assert.deepEqual(f.state.rows[0], ["Email", "Signed up at (UTC)", "Consent"]);
  assert.equal(f.state.rows[1][0], "hello@example.com");
  assert.match(f.state.rows[1][1], /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(f.state.rows[1][2], "kan-waitlist-v1");
  assert.equal(f.state.releases, 2);
  assert.ok(f.state.flushes > 0);
});

test("requires a shared secret and consent before opening the sheet", () => {
  const f = createGoogleFixture();
  for (const body of [null, [], {}, { ...signup(), secret: "wrong" }, { ...signup(), consent: false }, { ...signup(), consentVersion: "other" }, signup("bad")]) {
    assert.equal(f.post(body).ok, false);
  }
  assert.equal(f.state.opens, 0);
  assert.equal(f.state.rows, null);
});

test("formula-like email addresses are written as literal text and still deduplicated", () => {
  const f = createGoogleFixture();
  for (const email of ["=a@example.com", "+a@example.com", "-a@example.com", "'a@example.com"]) {
    assert.deepEqual(f.post(signup(email)), { ok: true });
    assert.deepEqual(f.post(signup(email.toUpperCase())), { ok: true });
  }
  assert.equal(f.state.rows.length, 5);
  for (const row of f.state.appends.slice(1)) assert.ok(row[0].startsWith("'"));
  assert.equal(f.state.rows[1][0], "=a@example.com");
});

test("lock contention returns busy without touching storage", () => {
  const f = createGoogleFixture();
  f.state.lockAvailable = false;
  assert.deepEqual(f.post(signup()), { ok: false, error: "busy" });
  assert.equal(f.state.opens, 0);
});

test("storage failures release the lock and do not expose private errors", () => {
  for (const flag of ["failOpen", "failAppend", "failFlush"]) {
    const f = createGoogleFixture();
    f.state[flag] = true;
    assert.deepEqual(f.post(signup()), { ok: false, error: "unavailable" });
    assert.equal(f.state.locked, false);
    assert.equal(f.state.releases, 1);
  }
});

test("does not overwrite an existing sheet with different headers", () => {
  const f = createGoogleFixture();
  f.state.rows = [["Existing", "private", "data"]];
  assert.deepEqual(f.post(signup()), { ok: false, error: "unavailable" });
  assert.deepEqual(f.state.rows, [["Existing", "private", "data"]]);
});

test("setup generates the secret once, binds the sheet, and keeps existing data", () => {
  const f = createGoogleFixture();
  delete f.properties.WAITLIST_WEBHOOK_SECRET;
  f.context.setupWaitlist();
  const secret = f.properties.WAITLIST_WEBHOOK_SECRET;
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.equal(f.properties.SPREADSHEET_ID, "sheet-fixture");
  f.context.setupWaitlist();
  assert.equal(f.properties.WAITLIST_WEBHOOK_SECRET, secret);
  assert.equal(f.state.rows.length, 1);
});

test("the real API and Apps Script contract survives redirects and duplicate retries", async () => {
  const f = createGoogleFixture();
  let confirmation;
  const run = createWaitlistHandler({
    env: { GOOGLE_SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/fixture/exec", WAITLIST_WEBHOOK_SECRET: fixtureSecret },
    fetch: async (_url, options) => {
      if (options.method === "POST") {
        confirmation = f.post(JSON.parse(options.body));
        return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?fixture=result" } });
      }
      assert.equal(options.body, undefined);
      return Response.json(confirmation);
    },
  });
  for (const email of ["one@example.com", "ONE@example.com"]) {
    const response = await run(new Request("https://www.getkan.dev/api/waitlist", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, consent: true }),
    }));
    assert.equal(response.status, 200);
  }
  assert.equal(f.state.rows.length, 2);
  assert.equal(f.state.rows[1][0], "one@example.com");
});

test("a retry after an uncertain write does not duplicate the row", () => {
  const f = createGoogleFixture();
  f.state.failFlush = true;
  assert.equal(f.post(signup()).ok, false);
  const timestamp = f.state.rows[1][1];
  f.state.failFlush = false;
  assert.deepEqual(f.post(signup()), { ok: true });
  assert.equal(f.state.rows.length, 2);
  assert.equal(f.state.rows[1][1], timestamp);
});

test("GET never exposes the sheet or claims to store a signup", () => {
  const f = createGoogleFixture();
  assert.deepEqual(JSON.parse(f.context.doGet().text), { ok: false, error: "method" });
  assert.equal(f.state.opens, 0);
});
