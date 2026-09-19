/**
 * Demo board, matching the anchors the thread fixtures already reference.
 *
 * `thread-fixtures.ts` points at `node-cache`, `node-invalidation` and
 * `node-throughput`. Without shapes behind those ids the anchor chips render
 * but jump nowhere, so the two fixture sets have to agree. Both disappear
 * together the day the sync server feeds the board.
 */
import { KAN_NODE_HEIGHT, KAN_NODE_WIDTH } from "@kan/nodes";
import type { NodeDraft } from "@kan/protocol";

export interface SeedShape {
  /** Bare id; `Canvas` runs it through `createShapeId`. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  draft: NodeDraft;
}

export const seedShapes: SeedShape[] = [
  {
    id: "node-cache",
    x: 120,
    y: 120,
    w: KAN_NODE_WIDTH,
    h: KAN_NODE_HEIGHT,
    draft: {
      type: "markdown",
      title: "Cache layer",
      body: "Read-through, 5 minute TTL.\nThe part we are least sure about.",
    },
  },
  {
    id: "node-invalidation",
    x: 520,
    y: 120,
    w: KAN_NODE_WIDTH,
    h: KAN_NODE_HEIGHT,
    draft: {
      type: "decision",
      title: "avoid invalidate-on-write",
      bullets: [
        "Killed us last time under write bursts",
        "Revisit if staleness complaints show up",
      ],
    },
  },
  {
    id: "node-throughput",
    x: 320,
    y: 400,
    w: KAN_NODE_WIDTH,
    h: KAN_NODE_HEIGHT,
    draft: {
      type: "chart",
      title: "Throughput last 7 days",
      spec: { mark: "line", encoding: { x: { field: "day" }, y: { field: "reqs" } } },
      data: [
        { day: "Mon", reqs: 1820 },
        { day: "Tue", reqs: 1905 },
        { day: "Wed", reqs: 1877 },
        { day: "Thu", reqs: 2140 },
        { day: "Fri", reqs: 1960 },
      ],
      sourceNote: "metrics-api · throughput · 7d",
    },
  },
];
