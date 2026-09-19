import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
} from "tldraw";

import { ScrollArea } from "@/components/ui/scroll-area";
import { NodeCard } from "./NodeCard";
import { markdownShapeProps, type MarkdownShape } from "./types";

export class MarkdownShapeUtil extends BaseBoxShapeUtil<MarkdownShape> {
  static override type = "kan-markdown" as const;
  static override props = markdownShapeProps;

  getDefaultProps(): MarkdownShape["props"] {
    return { w: 360, h: 240, title: "Note", body: "" };
  }

  override canEdit() {
    return false;
  }

  override canResize() {
    return true;
  }

  override canScroll() {
    return true;
  }

  override isAspectRatioLocked() {
    return false;
  }

  override getIndicatorPath(shape: MarkdownShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: MarkdownShape) {
    return `${shape.props.title}\n${shape.props.body}`;
  }

  component(shape: MarkdownShape) {
    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="markdown"
          title={shape.props.title}
          contentClassName="px-0"
        >
          <ScrollArea className="min-h-0 flex-1 px-3">
            <div className="kan-prose pb-3">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ children, ...props }) => (
                    <a
                      {...props}
                      target="_blank"
                      rel="noreferrer"
                      onPointerDown={stopEventPropagation}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {shape.props.body}
              </ReactMarkdown>
            </div>
          </ScrollArea>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
