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
export const KAN_NODE_WIDTH = 320;
export const KAN_NODE_HEIGHT = 200;

export function kanNodeSize(type: NodeDraft["type"]) {
  if (type === "calendar") return { w: 520, h: 560 };
  if (type === "map") return { w: 480, h: 360 };
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
  selectedMarker: T.number,
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
    },
    bindings: defaultBindingSchemas,
  });
}
