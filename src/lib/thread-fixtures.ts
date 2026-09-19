/**
 * Stand-in room data for UI work. Replace with the realtime room store once
 * the transport lands — `ThreadPanel` only needs entries + participants.
 */
import type { CanvasAnchor, Participant, ThreadEntry } from "./thread";

const day = "2026-09-19";
const at = (time: string) => `${day}T${time}+02:00`;

export const demoParticipants: Participant[] = [
  { id: "asier", name: "asier", kind: "human" },
  { id: "marta", name: "marta", kind: "human" },
  { id: "jon", name: "jon", kind: "human" },
  { id: "assistant", name: "assistant", kind: "agent", operatorId: "asier" },
  { id: "marta-agent", name: "assistant", kind: "agent", operatorId: "marta" },
];

export const demoAnchors: CanvasAnchor[] = [
  { nodeId: "node-invalidation", label: "Invalidation" },
];

export const demoEntries: ThreadEntry[] = [
  {
    id: "t1",
    kind: "transcript",
    at: at("10:41:02"),
    authorId: "jon",
    text: "so the cache layer is the part I'm least sure about",
  },
  {
    id: "t2",
    kind: "transcript",
    at: at("10:41:30"),
    authorId: "marta",
    text: "we could invalidate on write but that's what killed us last time",
  },
  {
    id: "t3",
    kind: "transcript",
    at: at("10:42:11"),
    authorId: "jon",
    text: "what was the throughput last week anyway",
    trigger: { label: "trigger", confidence: 0.91 },
  },
  {
    id: "t4",
    kind: "transcript",
    at: at("10:43:04"),
    authorId: "marta",
    text: "check grafana metrics API",
  },
  {
    id: "m1",
    kind: "message",
    at: at("10:43:12"),
    authorId: "asier",
    text: "@assistant pull the numbers and put them next to the cache node",
    mentions: ["assistant"],
    anchors: [{ nodeId: "node-cache", label: "Cache layer" }],
  },
  {
    id: "a1",
    kind: "agent",
    at: at("10:43:18"),
    authorId: "assistant",
    model: "Claude",
    durationMs: 4200,
    text: "Throughput averaged 1.9k req/s last week, peaking Thursday. I added a chart next to Cache layer and linked it to Invalidation.",
    steps: [
      {
        id: "s1",
        tool: "queryData",
        summary: "metrics-api · throughput · 7d",
        state: "done",
      },
      {
        id: "s2",
        tool: "addNode",
        summary: "chart · 'Throughput last 7 days' · near Cache layer",
        target: { nodeId: "node-throughput", label: "Throughput last 7 days" },
        state: "done",
      },
      {
        id: "s3",
        tool: "linkNodes",
        summary: "Throughput → Invalidation",
        target: { nodeId: "node-invalidation", label: "Invalidation" },
        state: "done",
      },
      {
        id: "s4",
        tool: "readCanvas",
        summary: "resolved 'the cache node' to Cache layer",
        state: "done",
      },
      {
        id: "s5",
        tool: "editNode",
        summary: "Cache layer · appended metrics note",
        state: "done",
      },
    ],
  },
  {
    id: "g1",
    kind: "suggestion",
    at: at("10:43:40"),
    authorId: "marta-agent",
    sourceEntryId: "t2",
    sourceLabel: "from marta's comment 10:42",
    quote: "we could invalidate on write but that's what killed us last time",
    proposal: { type: "decision", label: "avoid invalidate-on-write" },
    shortcut: "⌘↵",
  },
  {
    id: "y1",
    kind: "system",
    at: at("10:44:01"),
    authorId: "asier",
    text: "asier moved 'Cold start' under OPEN QUESTIONS",
  },
];
