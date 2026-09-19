import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type TLBaseShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { NodeDraftSchema, type NodeDraft } from "@kan/protocol";

export const KAN_NODE_TYPE = "kan-node";
export const KAN_NODE_WIDTH = 320;
export const KAN_NODE_HEIGHT = 200;

const draftValidator = new T.Validator<NodeDraft>(
  (value): NodeDraft => NodeDraftSchema.parse(value),
  undefined,
  true,
);

export const kanShapeProps = {
  w: T.positiveNumber,
  h: T.positiveNumber,
  draft: draftValidator,
};

export type KanNodeShape = TLBaseShape<typeof KAN_NODE_TYPE, { w: number; h: number; draft: NodeDraft }>;

export function createKanSchema() {
  return createTLSchema({
    shapes: { ...defaultShapeSchemas, [KAN_NODE_TYPE]: { props: kanShapeProps } },
    bindings: defaultBindingSchemas,
  });
}
