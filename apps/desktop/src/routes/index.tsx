import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Landing route: creates a room and redirects into it.
 *
 * Nothing in the app could name which room it was in before this, so "copy
 * link" copied the app itself and the sidecar had no room to act in. The id is
 * a uuid because every server route is `/rooms/:id/...` and `RoomSchema` in
 * `@kan/protocol` types the id as one, so these ids stay valid the day
 * `POST /rooms` replaces the local mint.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({
      to: "/room/$roomId",
      params: { roomId: crypto.randomUUID() },
      replace: true,
    });
  },
});
