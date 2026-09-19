import type { DatedEvent } from "./schema";

export function todayDate() {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function sortEvents(events: DatedEvent[]) {
  return [...events].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function initialMonth(events: DatedEvent[]) {
  return (sortEvents(events)[0]?.start ?? todayDate()).slice(0, 7);
}

export function eventsOnDate(events: DatedEvent[], date: string) {
  return sortEvents(events.filter((event) => event.start <= date && (event.end ?? event.start) >= date));
}

export function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return month;
  return date.toISOString().slice(0, 7);
}

export function calendarDays(month: string): (string | null)[] {
  const date = new Date(`${month}-01T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  const count = date.getUTCDate();
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return day > 0 && day <= count ? `${month}-${String(day).padStart(2, "0")}` : null;
  });
}

export function formatDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

export function formatMonth(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long", year: "numeric", timeZone: "UTC",
  });
}

export function eventDateLabel(event: DatedEvent) {
  return event.end && event.end !== event.start
    ? `${formatDate(event.start)} – ${formatDate(event.end)}`
    : formatDate(event.start);
}
