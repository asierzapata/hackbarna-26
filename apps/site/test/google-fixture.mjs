import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../google-apps-script.gs", import.meta.url), "utf8");
export const fixtureSecret = "local-fixture-secret-never-use-in-production";

export function createGoogleFixture() {
  const properties = { SPREADSHEET_ID: "sheet-fixture", WAITLIST_WEBHOOK_SECRET: fixtureSecret };
  const state = { rows: null, appends: [], lockAvailable: true, locked: false, releases: 0, opens: 0, failOpen: false, failFlush: false, failAppend: false, flushes: 0 };
  const cellValue = value => typeof value === "string" && value.startsWith("'") ? value.slice(1) : value;
  const sheet = {
    getLastRow: () => state.rows.length,
    getRange: (row, column, count = 1, columns = 1) => ({
      getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: columns }, (_, j) => state.rows[row + i - 1]?.[column + j - 1] ?? "")),
      setValues: values => {
        assert.equal(values.length, count);
        values.forEach((cells, i) => {
          assert.equal(cells.length, columns);
          state.rows[row + i - 1] ??= [];
          cells.forEach((value, j) => { state.rows[row + i - 1][column + j - 1] = cellValue(value); });
        });
      },
    }),
    appendRow: row => {
      assert.equal(state.locked, true, "writes must hold the script lock");
      if (state.failAppend) throw new Error("private spreadsheet failure");
      state.appends.push([...row]);
      state.rows.push(Array.from(row, cellValue));
    },
    setFrozenRows: () => {},
  };
  const spreadsheet = {
    getId: () => "sheet-fixture",
    getSheetByName: name => { assert.equal(name, "Waitlist"); return state.rows === null ? null : sheet; },
    insertSheet: name => { assert.equal(name, "Waitlist"); assert.equal(state.rows, null); state.rows = []; return sheet; },
  };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name] ?? null, setProperties: values => Object.assign(properties, values) }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (!state.lockAvailable || state.locked) return false; state.locked = true; return true; },
      releaseLock: () => { state.locked = false; state.releases++; },
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: id => { assert.equal(id, "sheet-fixture"); state.opens++; if (state.failOpen) throw new Error("private spreadsheet failure"); return spreadsheet; },
      flush: () => { state.flushes++; if (state.failFlush) throw new Error("private flush failure"); },
    },
    Utilities: { getUuid: randomUUID },
    ContentService: { MimeType: { JSON: "application/json" }, createTextOutput: text => ({ text, setMimeType(type) { this.type = type; return this; } }) },
  });
  vm.runInContext(source, context);
  const post = body => {
    const result = context.doPost({ postData: { contents: JSON.stringify(body) } });
    assert.equal(result.type, "application/json");
    return JSON.parse(result.text);
  };
  return { properties, state, context, post };
}
