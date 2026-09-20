import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type TLBaseShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { NodeDraftSchema, type NodeDraft } from "@kan/protocol";

export { planDiagram, diagramPlacement } from "./diagram";

export const KAN_NODE_TYPE = "kan-node";
export const KAN_MAP_TYPE = "kan-map";
export const KAN_TABLE_TYPE = "kan-table";
export const KAN_NODE_WIDTH = 320;
export const KAN_NODE_HEIGHT = 200;

export function kanNodeSize(type: NodeDraft["type"]) {
  if (type === "calendar") return { w: 520, h: 560 };
  if (type === "map") return { w: 480, h: 360 };
  if (type === "table") return { w: 480, h: 280 };
  return { w: KAN_NODE_WIDTH, h: KAN_NODE_HEIGHT };
}

const draftValidator = new T.Validator<NodeDraft>(
  (value): NodeDraft => NodeDraftSchema.parse(value),
  undefined,
  true,
);

const kanMapMarkerProps = T.object({
  lat: T.number,
  lng: T.number,
  label: T.string,
  note: T.optional(T.string),
});

export const kanMapShapeProps = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  title: T.string,
  markers: T.arrayOf(kanMapMarkerProps),
  center: T.nullable(T.object({ lat: T.number, lng: T.number })),
  zoom: T.nullable(T.number),
  style: T.literalEnum("streets", "aquarelle", "light", "dark", "satellite", "outdoor"),
  sourceNote: T.optional(T.string),
  selectedMarker: T.number,
};

const kanTableCellProps = T.or(
  T.or(T.string, T.number),
  T.nullable(T.boolean),
);

export const kanTableShapeProps = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  title: T.string,
  columns: T.arrayOf(T.string),
  rows: T.arrayOf(T.arrayOf(kanTableCellProps)),
  highlightRow: T.number,
  sourceNote: T.string,
  sortBy: T.nullable(T.object({ column: T.number, dir: T.literalEnum("asc", "desc") })),
  selectedRows: T.arrayOf(T.number),
};

export const kanShapeProps = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  draft: draftValidator,
};

export type KanNodeShape = TLBaseShape<typeof KAN_NODE_TYPE, { w: number; h: number; draft: NodeDraft }>;

export function createKanSchema() {
  return createTLSchema({
    shapes: {
      ...defaultShapeSchemas,
      [KAN_NODE_TYPE]: { props: kanShapeProps },
      [KAN_MAP_TYPE]: { props: kanMapShapeProps },
      [KAN_TABLE_TYPE]: { props: kanTableShapeProps },
    },
    bindings: defaultBindingSchemas,
  });
}
