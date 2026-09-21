const WAITLIST_HEADERS = ["Email", "Signed up at (UTC)", "Consent"];

function waitlistSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName("Waitlist") || spreadsheet.insertSheet("Waitlist");
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(WAITLIST_HEADERS);
    sheet.setFrozenRows(1);
  } else {
    const headers = sheet.getRange(1, 1, 1, 3).getValues()[0];
    if (!WAITLIST_HEADERS.every((header, index) => headers[index] === header)) {
      throw new Error("The Waitlist tab has different headers. Use a dedicated sheet.");
    }
  }
  return sheet;
}

function setupWaitlist() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Open this script from Extensions > Apps Script in your Google Sheet.");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error("Waitlist is busy. Try setup again.");
  try {
    waitlistSheet_(spreadsheet);
    SpreadsheetApp.flush();
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty("WAITLIST_WEBHOOK_SECRET") || (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    if (secret.trim().length < 32 || secret.trim().length > 256) throw new Error("Use a shared secret between 32 and 256 characters.");
    properties.setProperties({ SPREADSHEET_ID: spreadsheet.getId(), WAITLIST_WEBHOOK_SECRET: secret });
  } finally {
    lock.releaseLock();
  }
}

function waitlistResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return waitlistResponse_({ ok: false, error: "method" });
}

function doPost(event) {
  let body;
  try {
    const text = event && event.postData && event.postData.contents;
    if (typeof text !== "string" || text.length > 4096) return waitlistResponse_({ ok: false, error: "invalid" });
    body = JSON.parse(text);
  } catch {
    return waitlistResponse_({ ok: false, error: "invalid" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return waitlistResponse_({ ok: false, error: "invalid" });
  const properties = PropertiesService.getScriptProperties();
  const secret = (properties.getProperty("WAITLIST_WEBHOOK_SECRET") || "").trim();
  const spreadsheetId = properties.getProperty("SPREADSHEET_ID");
  if (secret.length < 32 || secret.length > 256 || !spreadsheetId) return waitlistResponse_({ ok: false, error: "unavailable" });
  if (body.secret !== secret) return waitlistResponse_({ ok: false, error: "unauthorized" });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || body.consent !== true || body.consentVersion !== "kan-waitlist-v1") {
    return waitlistResponse_({ ok: false, error: "invalid" });
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return waitlistResponse_({ ok: false, error: "busy" });
  try {
    const sheet = waitlistSheet_(SpreadsheetApp.openById(spreadsheetId));
    const count = sheet.getLastRow() - 1;
    const exists = count > 0 && sheet.getRange(2, 1, count, 1).getValues().some(row => String(row[0]).trim().toLowerCase() === email);
    if (!exists) {
      const literalEmail = /^[=+\-@']/.test(email) ? "'" + email : email;
      sheet.appendRow([literalEmail, new Date().toISOString(), "kan-waitlist-v1"]);
    }
    SpreadsheetApp.flush();
    return waitlistResponse_({ ok: true });
  } catch {
    return waitlistResponse_({ ok: false, error: "unavailable" });
  } finally {
    lock.releaseLock();
  }
}
