import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel, ChatReopenButton } from "../components/ChatPanel";
import { WorkspacePanels } from "../components/WorkspacePanels";
import { AgentProvider } from "../components/agent-context";
import { CanvasProvider } from "../components/canvas-context";
import { getServerRoom } from "@/lib/api-client";
import { getCanvasEntry, touchCanvas } from "@/lib/canvas-repository";
import { duplicateOnlineToOffline } from "@/lib/duplicate-canvas";
import { getInstallationProfile } from "@/lib/installation-profile";
import { RoomPrejoin, RoomParticipantStrip } from "../components/RoomVideo";
import { useLocalMedia } from "../components/use-local-media";
import { useRoomVideo } from "../components/use-room-video";
import { createWsTransport } from "@/lib/room-transport";

export const Route = createFileRoute("/room/$roomId")({
  component: RoomPage,
});

function RoomPage() {
  const { roomId } = Route.useParams();
  return <RoomWorkspace key={roomId} roomId={roomId} />;
}

function RoomWorkspace({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const [joined, setJoined] = React.useState(false);
  const [identity, setIdentity] = React.useState<{ id: string; name: string } | null>(null);
  const media = useLocalMedia();
  const transport = React.useMemo(() => createWsTransport(roomId), [roomId]);
  const call = useRoomVideo(roomId, joined, media.state.audio.track, media.state.video.track, transport.sendTranscript);

  React.useEffect(() => {
    let active = true;
    void getInstallationProfile().then((profile) => {
      if (active && profile) setIdentity({ id: profile.installationId, name: profile.name });
    });
    return () => { active = false; };
  }, []);

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
            onDuplicateOffline={joined ? handleDuplicateOffline : undefined}
          />
          {!joined || !identity ? <RoomPrejoin title={roomTitle} name={identity?.name ?? "You"} controls={media} onJoin={() => { if (identity) setJoined(true); }} onCancel={() => void navigate({ to: "/" })} /> : <main className="workspace__body relative">
            <WorkspacePanels
              chatOpen={threadOpen}
              canvas={<div className="relative flex h-full min-h-0 flex-col">
                <Canvas roomId={roomId} online onlineUser={identity} />
                <RoomParticipantStrip name={identity.name} controls={media} call={call} />
              </div>}
              chat={
                <ChatPanel
                  className="h-full w-full"
                  roomId={roomId}
                  roomTransport={transport}
                  transcription={call.transcription}
                  online
                  onClose={() => setThreadOpen(false)}
                />
              }
            />
            {!threadOpen ? <ChatReopenButton onClick={() => setThreadOpen(true)} /> : null}
          </main>}
        </div>
      </CanvasProvider>
    </AgentProvider>
  );
}
