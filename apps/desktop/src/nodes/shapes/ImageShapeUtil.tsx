import * as React from "react";
import { RiImageLine } from "@remixicon/react";
import { BaseBoxShapeUtil, HTMLContainer } from "tldraw";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { NodeCard } from "./NodeCard";
import { imageShapeProps, type ImageShape } from "./types";

export class ImageShapeUtil extends BaseBoxShapeUtil<ImageShape> {
  static override type = "kan-image" as const;
  static override props = imageShapeProps;

  getDefaultProps(): ImageShape["props"] {
    return {
      w: 360,
      h: 300,
      title: "",
      src: "",
      alt: "",
      caption: "",
    };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override isAspectRatioLocked() {
    return false;
  }

  override getIndicatorPath(shape: ImageShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: ImageShape) {
    return `${shape.props.title}\n${shape.props.alt}\n${shape.props.caption}`;
  }

  component(shape: ImageShape) {
    const [failed, setFailed] = React.useState(false);

    React.useEffect(() => setFailed(false), [shape.props.src]);

    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="image"
          title={shape.props.title || "Image"}
          description={shape.props.caption || undefined}
        >
          {failed ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiImageLine />
                </EmptyMedia>
                <EmptyTitle>Image unavailable</EmptyTitle>
                <EmptyDescription>{shape.props.alt}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <img
              className="size-full min-h-0 object-contain"
              src={shape.props.src}
              alt={shape.props.alt}
              draggable={false}
              onError={() => setFailed(true)}
            />
          )}
        </NodeCard>
      </HTMLContainer>
    );
  }
}
