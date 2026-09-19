import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel } from "../components/ChatPanel";
import { AgentProvider } from "../components/agent-context";
import { CanvasProvider } from "../components/canvas-context";
import { getServerRoom } from "@/lib/api-client";
import { getCanvasEntry, touchCanvas } from "@/lib/canvas-repository";
import { duplicateOnlineToOffline } from "@/lib/duplicate-canvas";

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams();
  const navigate = useNavigate();

  const [threadOpen, setThreadOpen] = React.useState(true);
  const [roomTitle, setRoomTitle] = React.useState("Online Canvas");
  const [roomCode, setRoomCode] = React.useState<string | undefined>(undefined);
  const [isDuplicating, setIsDuplicating] = React.useState(false);

  React.useEffect(() => {
    let active = true;

    // First check local catalog
    void getCanvasEntry(roomId).then((entry) => {
      if (!active) return;
      if (entry) {
        setRoomTitle(entry.name);
        if (entry.roomCode) setRoomCode(entry.roomCode);
        void touchCanvas(entry.id);
      }
    });

    // Then try server room detail for fresh title / code
    void getServerRoom(roomId)
      .then((detail) => {
        if (!active) return;
        setRoomTitle(detail.room.name);
        setRoomCode(detail.room.code);
      })
      .catch((err) => {
        console.warn(`Could not fetch room detail for ${roomId}:`, err);
      });

    return () => {
      active = false;
    };
  }, [roomId]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setThreadOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleDuplicateOffline = async () => {
    if (isDuplicating) return;
    setIsDuplicating(true);
    try {
      const copy = await duplicateOnlineToOffline({
        roomId,
        sourceName: roomTitle,
      });
      void navigate({
        to: "/canvas/$canvasId",
        params: { canvasId: copy.id },
      });
    } catch (err) {
      console.error("Failed to duplicate room offline:", err);
      alert(err instanceof Error ? err.message : "Failed to create offline copy");
    } finally {
      setIsDuplicating(false);
    }
  };

  return (
    <AgentProvider>
      <CanvasProvider>
        <div className="workspace">
          <HeaderBar
            title={roomTitle}
            mode="online"
            roomCode={roomCode}
            onDuplicateOffline={handleDuplicateOffline}
          />
          <main className="workspace__body">
            <div className="workspace__canvas">
              <Canvas roomId={roomId} online />
            </div>
            {threadOpen ? (
              <ChatPanel roomId={roomId} online onClose={() => setThreadOpen(false)} />
            ) : null}
          </main>
        </div>
      </CanvasProvider>
    </AgentProvider>
  );
}
