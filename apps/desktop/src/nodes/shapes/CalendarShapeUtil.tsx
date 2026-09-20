import type { CSSProperties } from "react";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { BaseBoxShapeUtil, HTMLContainer, stopEventPropagation } from "tldraw";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  calendarDays,
  eventDateLabel,
  eventsOnDate,
  formatDate,
  formatMonth,
  todayDate,
  shiftMonth,
} from "../dates";
import { NodeCard } from "./NodeCard";
import { calendarShapeProps, type CalendarShape } from "./types";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const eventColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

function eventColor(eventId: string) {
  let hash = 0;
  for (const character of eventId)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return eventColors[(hash >>> 0) % eventColors.length];
}

export class CalendarShapeUtil extends BaseBoxShapeUtil<CalendarShape> {
  static override type = "kan-calendar" as const;
  static override props = calendarShapeProps;

  getDefaultProps(): CalendarShape["props"] {
    return {
      w: 520,
      h: 560,
      title: "Calendar",
      events: [],
      sourceNote: "",
      month: todayDate().slice(0, 7),
      selectedDate: null,
    };
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

  override getIndicatorPath(shape: CalendarShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12);
    return path;
  }

  override getText(shape: CalendarShape) {
    return [
      shape.props.title,
      shape.props.month,
      ...shape.props.events.map((event) => event.title),
    ].join("\n");
  }

  component(shape: CalendarShape) {
    return <CalendarView props={shape.props} onChange={(props) => this.editor.updateShape({ id: shape.id, type: shape.type, props })} />;
  }
}

export function CalendarView({ props, onChange: update }: {
  props: CalendarShape["props"];
  onChange: (props: Partial<CalendarShape["props"]>) => void;
}) {
    const { title, events, sourceNote, month, selectedDate } = props;
    const today = todayDate();
    const selectedEvents = selectedDate
      ? eventsOnDate(events, selectedDate)
      : [];
    const days = calendarDays(month);
    const eventsByDay = days.map((date) =>
      date ? eventsOnDate(events, date) : [],
    );
    const previous = shiftMonth(month, -1);
    const next = shiftMonth(month, 1);
    return (
      <HTMLContainer style={{ pointerEvents: "all" }}>
        <NodeCard
          type="calendar"
          title={title}
          description={sourceNote || undefined}
          headerMeta={
            <span className="text-xs text-muted-foreground">
              {events.length} events
            </span>
          }
          footer="All-day events · Date ranges include the last day"
        >
          <ScrollArea
            className="min-h-0 flex-1"
            onPointerDown={stopEventPropagation}
            onKeyDown={stopEventPropagation}
          >
            <div className="flex min-w-64 flex-col gap-3 pr-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3
                  className="font-medium"
                  aria-live="polite"
                  data-calendar-month
                >
                  {formatMonth(month)}
                </h3>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous month"
                    disabled={previous === month}
                    onPointerDown={stopEventPropagation}
                    onClick={() =>
                      update({ month: previous, selectedDate: null })
                    }
                  >
                    <RiArrowLeftSLine />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onPointerDown={stopEventPropagation}
                    onClick={() =>
                      update({ month: today.slice(0, 7), selectedDate: today })
                    }
                  >
                    Today
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next month"
                    disabled={next === month}
                    onPointerDown={stopEventPropagation}
                    onClick={() => update({ month: next, selectedDate: null })}
                  >
                    <RiArrowRightSLine />
                  </Button>
                </div>
              </div>
              <div
                className="kan-calendar__grid grid grid-cols-7 gap-y-1"
                role="group"
                aria-label={`Days in ${formatMonth(month)}`}
              >
                {weekdays.map((day) => (
                  <span
                    key={day}
                    className="py-1 text-center text-xs text-muted-foreground"
                  >
                    {day}
                  </span>
                ))}
                {days.map((date, index) => {
                  if (!date)
                    return <span key={`blank-${index}`} aria-hidden="true" />;
                  const dayEvents = eventsByDay[index];
                  const primaryEvent = dayEvents[0];
                  const previousEvents =
                    index % 7 === 0 ? [] : (eventsByDay[index - 1] ?? []);
                  const nextEvents =
                    index % 7 === 6 ? [] : (eventsByDay[index + 1] ?? []);
                  const continuesFromPrevious = Boolean(
                    primaryEvent &&
                    previousEvents.some(
                      (event) => event.id === primaryEvent.id,
                    ),
                  );
                  const continuesToNext = Boolean(
                    primaryEvent &&
                    nextEvents.some((event) => event.id === primaryEvent.id),
                  );
                  const style = primaryEvent
                    ? ({
                        "--calendar-event-color": eventColor(primaryEvent.id),
                      } as CSSProperties)
                    : undefined;
                  return (
                    <Button
                      key={date}
                      variant="ghost"
                      className="kan-calendar__day h-11 min-w-0 flex-col gap-0 px-0"
                      data-calendar-date={date}
                      data-has-event={dayEvents.length ? "true" : undefined}
                      data-range-start={
                        primaryEvent && !continuesFromPrevious
                          ? "true"
                          : undefined
                      }
                      data-range-end={
                        primaryEvent && !continuesToNext ? "true" : undefined
                      }
                      aria-label={`${formatDate(date)}, ${dayEvents.length} events`}
                      aria-pressed={date === selectedDate}
                      aria-current={date === today ? "date" : undefined}
                      style={style}
                      onPointerDown={stopEventPropagation}
                      onClick={() => update({ selectedDate: date })}
                    >
                      <span>{Number(date.slice(-2))}</span>
                      {dayEvents.length ? (
                        <span className="kan-calendar__event-count text-xs">
                          {dayEvents.length}{" "}
                          {dayEvents.length === 1 ? "event" : "events"}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
              {selectedDate ? (
                <>
                  <Separator />
                  <section
                    className="flex flex-col gap-2 pb-1"
                    aria-label="Selected day events"
                    aria-live="polite"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-medium">
                        {formatDate(selectedDate)}
                      </h4>
                      {selectedEvents.length ? (
                        <span className="text-xs text-muted-foreground">
                          {selectedEvents.length}{" "}
                          {selectedEvents.length === 1 ? "event" : "events"}
                        </span>
                      ) : null}
                    </div>
                    {selectedEvents.length ? (
                      <ol className="flex flex-col gap-1.5">
                        {selectedEvents.map((event) => (
                          <li
                            key={event.id}
                            className="kan-calendar__event flex flex-col gap-0.5 rounded-md border bg-muted/30 px-2 py-1.5"
                            data-calendar-event={event.id}
                            style={
                              {
                                "--calendar-event-color": eventColor(event.id),
                              } as CSSProperties
                            }
                          >
                            <p className="break-words font-medium">
                              {event.title}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {eventDateLabel(event)}
                            </p>
                            {event.description ? (
                              <p className="whitespace-pre-wrap break-words text-xs leading-snug">
                                {event.description}
                              </p>
                            ) : null}
                            {event.sourceNote ? (
                              <p className="break-words text-xs text-muted-foreground">
                                Source: {event.sourceNote}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No events on this day
                      </p>
                    )}
                  </section>
                </>
              ) : events.length ? null : (
                <>
                  <Separator />
                  <Empty className="p-2">
                    <EmptyHeader>
                      <EmptyTitle>No events yet</EmptyTitle>
                      <EmptyDescription>
                        Add events to this calendar to see them here.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </>
              )}
            </div>
          </ScrollArea>
        </NodeCard>
      </HTMLContainer>
    );
}
