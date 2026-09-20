import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseEvaluationRows } from "./nebius-evaluation";

const Dataset = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), name: z.string().optional(), status: z.enum(["READY", "PENDING", "FAILED", "TEMPORARY", "DRAFT"]) });
const Listing = z.object({ data: z.array(Dataset), has_more: z.boolean(), last_id: z.string().nullable().optional() });
export class DataLabError extends Error {}

export async function publishEvaluation(apiKey: string, value: unknown, options: { request?: typeof fetch; pause?: (ms: number) => Promise<unknown> } = {}) {
  if (!apiKey.trim()) throw new DataLabError("Publishing requires NEBIUS_API_KEY");
  const rows = parseEvaluationRows(value).map(row => ({ ...row, history: JSON.stringify(row.history), model_decision: JSON.stringify(row.model_decision) }))
    .sort((a, b) => a.case_id.localeCompare(b.case_id));
  const hash = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  const name = `Kan - Nebius classifier eval - ${hash}`;
  const request = options.request ?? fetch;
  async function api(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await request(`https://api.tokenfactory.nebius.com/v1/datasets${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${apiKey.trim()}`, "content-type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DataLabError("Nebius Data Lab request failed; no write retry was attempted. Rerun publishing to check for an existing dataset.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DataLabError(`Nebius Data Lab HTTP ${response.status}`);
    }
    try { return await response.json(); }
    catch { throw new DataLabError("Nebius Data Lab returned invalid JSON"); }
  }
  let dataset: z.infer<typeof Dataset> | undefined;
  let after: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = Listing.parse(await api(`?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`));
    dataset = page.data.find(item => item.name === name);
    if (dataset || !page.has_more) break;
    if (!page.last_id || cursors.has(page.last_id) || cursors.size >= 100) throw new DataLabError("Cannot safely finish dataset lookup; no dataset created");
    cursors.add(page.last_id);
    after = page.last_id;
  }
  const reused = !!dataset;
  if (!dataset) {
    const schema = Object.entries(rows[0]).map(([name, value]) => ({ name, type: { name: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "integer" : "string" } }));
    dataset = Dataset.parse(await api("", { name, schema, folder: "/", rows }));
  }
  const id = dataset.id;
  let status = dataset.status;
  for (let attempt = 0; status !== "READY" && status !== "FAILED" && attempt < 30; attempt++) {
    await (options.pause ?? pause)(2_000);
    status = z.object({ status: Dataset.shape.status }).parse(await api(`/${id}`)).status;
  }
  if (status === "FAILED") throw new DataLabError(`Nebius Data Lab dataset ${id} failed; existing data was not overwritten`);
  if (status !== "READY") throw new DataLabError(`Nebius Data Lab dataset ${id} is still ${status}; rerun publishing to check it without creating a duplicate`);
  const content = z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).parse(await api(`/${id}/content?limit=${rows.length + 1}`));
  const stored = content.rows.sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)));
  if (!isDeepStrictEqual(stored, rows)) throw new DataLabError(`Nebius Data Lab dataset ${id}: stored rows do not match the evaluation`);
  return { event: "dataset-ready", id, name, status, rowCount: rows.length, reused };
}
