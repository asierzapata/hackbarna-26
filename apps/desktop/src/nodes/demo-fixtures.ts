import type { NodeDraft } from "./schema";

export const markdownFixture = {
  type: "markdown",
  title: "Cold start options",
  body: `We need a path that improves **time to first request** without making deployments fragile.

- Pre-warm the busiest tenants
- Keep a small shared warm pool
- Snapshot the initialized runtime

[Review the rollout notes](https://example.com/rollout) before choosing a default.`,
} satisfies NodeDraft;

export const throughputChartFixture = {
  type: "chart",
  title: "Throughput last 7 days",
  spec: {
    kind: "bar",
    x: "day",
    series: [
      { key: "requests", label: "Requests" },
      { key: "errors", label: "Errors" },
    ],
    yLabel: "Requests",
  },
  data: [
    { day: "Mon", requests: 820, errors: 21 },
    { day: "Tue", requests: 940, errors: 28 },
    { day: "Wed", requests: 1010, errors: 24 },
    { day: "Thu", requests: 1080, errors: 31 },
    { day: "Fri", requests: 1240, errors: 26 },
    { day: "Sat", requests: 1180, errors: 19 },
    { day: "Sun", requests: 1320, errors: 22 },
  ],
  sourceNote: "Gateway metrics · requests per minute",
} satisfies NodeDraft;

export const latencyChartFixture = {
  type: "chart",
  title: "p95 latency",
  spec: {
    kind: "line",
    x: "day",
    series: [{ key: "latency", label: "p95 ms" }],
    yLabel: "Milliseconds",
  },
  data: [
    { day: "Mon", latency: 242 },
    { day: "Tue", latency: 228 },
    { day: "Wed", latency: 214 },
    { day: "Thu", latency: 205 },
    { day: "Fri", latency: 192 },
    { day: "Sat", latency: 187 },
    { day: "Sun", latency: 176 },
  ],
  sourceNote: "Gateway metrics · rolling p95",
} satisfies NodeDraft;

export const tableFixture = {
  type: "table",
  title: "Options compared",
  columns: ["Option", "Cost", "Effort", "Risk", "Notes"],
  rows: [
    [
      "Pre-warm tenants",
      "$2.4k/mo",
      "Medium",
      "Low",
      "Best for predictable traffic",
    ],
    ["Shared warm pool", "$1.1k/mo", "Low", "Medium", "Fastest path to pilot"],
    [
      "Runtime snapshots",
      "$0.6k/mo",
      "High",
      "Medium",
      "Largest long-term gain",
    ],
    ["No change", "$0", "None", "High", "Misses the SLO"],
  ],
  highlightRow: 1,
  sourceNote: "Estimates from the platform working session",
} satisfies NodeDraft;

function svgDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420"><rect width="720" height="420" fill="#f5f5f4"/><path d="M72 318L210 184l92 88 126-146 220 192" fill="none" stroke="#262626" stroke-width="18"/><circle cx="544" cy="112" r="42" fill="#a3a3a3"/><text x="72" y="80" font-family="system-ui,sans-serif" font-size="30" fill="#525252">Architecture sketch</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const imageFixture = {
  type: "image",
  title: "Proposed warm-pool flow",
  src: svgDataUrl(),
  alt: "Placeholder architecture sketch with a rising path",
  caption: "Working sketch for the shared warm-pool proposal",
} satisfies NodeDraft;

export const mapFixture = {
  type: "map",
  title: "Candidate offices",
  markers: [
    { lat: 41.4036, lng: 2.1744, label: "Sagrada Família" },
    { lat: 41.387, lng: 2.1701, label: "Plaça Catalunya" },
    { lat: 41.3797, lng: 2.1897, label: "Barceloneta" },
  ],
  style: "aquarelle",
} satisfies NodeDraft;

export const logoFixture = {
  type: "logo",
  domain: "maptiler.com",
  name: "MapTiler",
  note: "maps sponsor",
} satisfies NodeDraft;

const researchEvents = [
  {
    id: "kickoff",
    title: "Research kickoff",
    start: "2026-09-14",
    description: "Agree on the research question and divide the reading list.",
  },
  {
    id: "reading",
    title: "Literature review",
    start: "2026-09-16",
    end: "2026-09-21",
    description:
      "Read the selected papers and collect supporting and conflicting evidence.",
    sourceNote: "Team reading list",
  },
  {
    id: "discussion",
    title: "Study group discussion",
    start: "2026-09-19",
    description: "Compare findings and identify gaps in the evidence.",
  },
  {
    id: "synthesis",
    title: "Synthesis workshop",
    start: "2026-09-29",
    end: "2026-10-02",
    description: "Turn the evidence into a shared summary and next steps.",
  },
  {
    id: "review",
    title: "Final review",
    start: "2026-10-05",
    description: "Review conclusions and decide what to investigate next.",
  },
];

export const timelineFixture = {
  type: "timeline",
  title: "Research milestones",
  events: researchEvents,
  sourceNote: "Study group · September–October 2026",
} satisfies NodeDraft;

export const calendarFixture = {
  type: "calendar",
  title: "Study calendar",
  events: researchEvents,
  month: "2026-09",
  sourceNote: "Study group · Reading and discussion sessions",
} satisfies NodeDraft;

export const demoFixtures = {
  markdown: markdownFixture,
  chart: throughputChartFixture,
  table: tableFixture,
  image: imageFixture,
  map: mapFixture,
  logo: logoFixture,
  timeline: timelineFixture,
  calendar: calendarFixture,
};
