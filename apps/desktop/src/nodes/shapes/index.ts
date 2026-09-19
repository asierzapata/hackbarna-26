import type { TLShapeUtilConstructor } from "tldraw";

import { CalendarShapeUtil } from "./CalendarShapeUtil";
import { TimelineShapeUtil } from "./TimelineShapeUtil";
import { ChartShapeUtil } from "./ChartShapeUtil";
import { ImageShapeUtil } from "./ImageShapeUtil";
import { LogoShapeUtil } from "./LogoShapeUtil";
import { MapShapeUtil } from "./MapShapeUtil";
import { MarkdownShapeUtil } from "./MarkdownShapeUtil";
import { TableShapeUtil } from "./TableShapeUtil";
import type { KanShape } from "./types";

export function createKanShapeUtils() {
  return [
    MarkdownShapeUtil,
    ChartShapeUtil,
    TableShapeUtil,
    ImageShapeUtil,
    MapShapeUtil,
    LogoShapeUtil,
    TimelineShapeUtil,
    CalendarShapeUtil,
  ] as TLShapeUtilConstructor<KanShape>[];
}

export {
  CalendarShapeUtil,
  TimelineShapeUtil,
  ChartShapeUtil,
  ImageShapeUtil,
  LogoShapeUtil,
  MapShapeUtil,
  MarkdownShapeUtil,
  TableShapeUtil,
};
export * from "./types";
