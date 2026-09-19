export const DEMO_ROWS = [
  { date: "2026-09-12", throughput: 1200, latencyMs: 180, errorRate: 0.012 },
  { date: "2026-09-13", throughput: 1250, latencyMs: 175, errorRate: 0.011 },
  { date: "2026-09-14", throughput: 1300, latencyMs: 170, errorRate: 0.010 },
  { date: "2026-09-15", throughput: 1280, latencyMs: 172, errorRate: 0.012 },
  { date: "2026-09-16", throughput: 1400, latencyMs: 160, errorRate: 0.009 },
  { date: "2026-09-17", throughput: 1450, latencyMs: 155, errorRate: 0.008 },
  { date: "2026-09-18", throughput: 1500, latencyMs: 150, errorRate: 0.007 },
];

export function queryDemoData(input: { source: "demo-metrics"; metric: "throughput" | "latencyMs" | "errorRate"; from?: string; to?: string }) {
  return {
    columns: ["date", input.metric],
    rows: DEMO_ROWS.filter((row) => (!input.from || row.date >= input.from) && (!input.to || row.date <= input.to)).map((row) => ({ date: row.date, [input.metric]: row[input.metric] })),
    note: "Synthetic demo data, not production measurements. Fixed dates 2026-09-12 through 2026-09-18 inclusive. throughput is requests/day; latencyMs is milliseconds; errorRate is a fraction. No aggregation is performed.",
  };
}
