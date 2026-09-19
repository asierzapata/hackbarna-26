import { BaseBoxShapeUtil, HTMLContainer, stopEventPropagation } from "tldraw";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { eventDateLabel, sortEvents } from "../dates";
import { NodeCard } from "./NodeCard";
import { timelineShapeProps, type TimelineShape } from "./types";

export class TimelineShapeUtil extends BaseBoxShapeUtil<TimelineShape> {
  static override type = "kan-timeline" as const;
  static override props = timelineShapeProps;

  getDefaultProps(): TimelineShape["props"] {
    return {
      w: 440, h: 440, title: "Timeline", events: [], sourceNote: "", selectedEventId: null,
    };
  }

  override canEdit() { return false; }
  override canResize() { return true; }
  override canScroll() { return true; }
  override isAspectRatioLocked() { return false; }

  override getIndicatorPath(shape: TimelineShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: TimelineShape) {
    return [shape.props.title, ...sortEvents(shape.props.events).map((event) => `${event.start}: ${event.title}`)].join("\n");
  }

  component(shape: TimelineShape) {
    const { title, events, sourceNote, selectedEventId } = shape.props;
    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="timeline"
          title={title}
          description={sourceNote || undefined}
          headerMeta={<span className="text-xs text-muted-foreground">{events.length} events</span>}
          footer="Chronological order · Select an event for details"
        >
          <ScrollArea className="min-h-0 flex-1" onPointerDown={stopEventPropagation} onKeyDown={stopEventPropagation}>
            {events.length ? (
              <ol className="kan-timeline" aria-label="Timeline events">
                {sortEvents(events).map((event) => {
                  const selected = selectedEventId === event.id;
                  return (
                    <li key={event.id} data-event-id={event.id} data-selected={selected}>
                      <Button
                        variant={selected ? "secondary" : "ghost"}
                        className="h-auto w-full flex-col items-start gap-1 px-2 py-2 whitespace-normal text-left"
                        aria-expanded={selected}
                        onPointerDown={stopEventPropagation}
                        onClick={() => this.editor.updateShape({
                          id: shape.id, type: shape.type,
                          props: { selectedEventId: selected ? null : event.id },
                        })}
                      >
                        <span>{eventDateLabel(event)}</span>
                        <span className="max-w-full break-words">{event.title}</span>
                      </Button>
                      {selected ? (
                        <div className="flex flex-col gap-2 px-2 pb-3 text-sm" data-event-details>
                          <p className="whitespace-pre-wrap break-words">{event.description || "No additional details."}</p>
                          {event.sourceNote ? <p className="break-words text-xs text-muted-foreground">Source: {event.sourceNote}</p> : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No events yet</EmptyTitle>
                  <EmptyDescription>Events added to this timeline will appear in chronological order.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </ScrollArea>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
