import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { BaseBoxShapeUtil, HTMLContainer, stopEventPropagation } from "tldraw";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { calendarDays, eventDateLabel, eventsOnDate, formatDate, formatMonth, todayDate, shiftMonth } from "../dates";
import { NodeCard } from "./NodeCard";
import { calendarShapeProps, type CalendarShape } from "./types";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export class CalendarShapeUtil extends BaseBoxShapeUtil<CalendarShape> {
  static override type = "kan-calendar" as const;
  static override props = calendarShapeProps;

  getDefaultProps(): CalendarShape["props"] {
    return {
      w: 520, h: 560, title: "Calendar", events: [], sourceNote: "",
      month: todayDate().slice(0, 7), selectedDate: null,
    };
  }

  override canEdit() { return false; }
  override canResize() { return true; }
  override canScroll() { return true; }
  override isAspectRatioLocked() { return false; }

  override getIndicatorPath(shape: CalendarShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: CalendarShape) {
    return [shape.props.title, shape.props.month, ...shape.props.events.map((event) => event.title)].join("\n");
  }

  component(shape: CalendarShape) {
    const { title, events, sourceNote, month, selectedDate } = shape.props;
    const today = todayDate();
    const selectedEvents = selectedDate ? eventsOnDate(events, selectedDate) : [];
    const previous = shiftMonth(month, -1);
    const next = shiftMonth(month, 1);
    const update = (props: Partial<CalendarShape["props"]>) => {
      this.editor.updateShape({ id: shape.id, type: shape.type, props });
    };
    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="calendar"
          title={title}
          description={sourceNote || undefined}
          headerMeta={<span className="text-xs text-muted-foreground">{events.length} events</span>}
          footer="All-day events · Date ranges include the last day"
        >
          <ScrollArea className="min-h-0 flex-1" onPointerDown={stopEventPropagation} onKeyDown={stopEventPropagation}>
            <div className="flex min-w-64 flex-col gap-3 pr-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium" aria-live="polite" data-calendar-month>{formatMonth(month)}</h3>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Previous month" disabled={previous === month}
                    onPointerDown={stopEventPropagation} onClick={() => update({ month: previous, selectedDate: null })}>
                    <RiArrowLeftSLine />
                  </Button>
                  <Button variant="outline" size="sm" onPointerDown={stopEventPropagation}
                    onClick={() => update({ month: today.slice(0, 7), selectedDate: today })}>Today</Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Next month" disabled={next === month}
                    onPointerDown={stopEventPropagation} onClick={() => update({ month: next, selectedDate: null })}>
                    <RiArrowRightSLine />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1" role="group" aria-label={`Days in ${formatMonth(month)}`}>
                {weekdays.map((day) => <span key={day} className="py-1 text-center text-xs text-muted-foreground">{day}</span>)}
                {calendarDays(month).map((date, index) => {
                  if (!date) return <span key={`blank-${index}`} aria-hidden="true" />;
                  const dayEvents = eventsOnDate(events, date);
                  return (
                    <Button
                      key={date}
                      variant={date === selectedDate ? "default" : dayEvents.length ? "secondary" : "ghost"}
                      className="h-11 min-w-0 flex-col gap-0 px-0"
                      data-calendar-date={date}
                      aria-label={`${formatDate(date)}, ${dayEvents.length} events`}
                      aria-pressed={date === selectedDate}
                      aria-current={date === today ? "date" : undefined}
                      onPointerDown={stopEventPropagation}
                      onClick={() => update({ selectedDate: date })}
                    >
                      <span>{Number(date.slice(-2))}</span>
                      {dayEvents.length ? <span className="text-[10px]">{dayEvents.length} {dayEvents.length === 1 ? "event" : "events"}</span> : null}
                    </Button>
                  );
                })}
              </div>
              <Separator />
              <section className="flex flex-col gap-3 pb-2" aria-label="Selected day events" aria-live="polite">
                {selectedDate ? <h4 className="text-sm font-medium">{formatDate(selectedDate)}</h4> : null}
                {selectedEvents.length ? (
                  <ol className="flex flex-col gap-3">
                    {selectedEvents.map((event) => (
                      <li key={event.id} className="flex flex-col gap-1 border-l-2 border-primary pl-3" data-calendar-event={event.id}>
                        <p className="break-words font-medium">{event.title}</p>
                        <p className="text-xs text-muted-foreground">{eventDateLabel(event)}</p>
                        {event.description ? <p className="whitespace-pre-wrap break-words text-sm">{event.description}</p> : null}
                        {event.sourceNote ? <p className="break-words text-xs text-muted-foreground">Source: {event.sourceNote}</p> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty className="p-2">
                    <EmptyHeader>
                      <EmptyTitle>{selectedDate ? "No events on this day" : events.length ? "Select a day" : "No events yet"}</EmptyTitle>
                      <EmptyDescription>{selectedDate ? "Choose another date to explore." : "Select a date to inspect its events."}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </section>
            </div>
          </ScrollArea>
        </NodeCard>
      </HTMLContainer>
    );
  }
}
