import * as React from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { RiAlertLine, RiArrowLeftLine } from "@remixicon/react";

import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel, ChatReopenButton } from "../components/ChatPanel";
import { AgentProvider } from "../components/agent-context";
import { CanvasProvider, useCanvas } from "../components/canvas-context";
import { SharingHintBanner } from "../components/SharingHintBanner";
import { PublishConfirmationDialog } from "../components/PublishConfirmationDialog";
import { Spinner } from "../components/ui/spinner";
import { getCanvasEntry, touchCanvas, type CanvasCatalogEntry } from "@/lib/canvas-repository";
import { publishCanvas } from "@/lib/publish-canvas";

export const Route = createFileRoute("/canvas/$canvasId")({
  component: CanvasPage,
});

function CanvasPage() {
  const { canvasId } = Route.useParams();
  const navigate = useNavigate();

  const [canvasEntry, setCanvasEntry] = React.useState<CanvasCatalogEntry | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [threadOpen, setThreadOpen] = React.useState(true);
  const [publishDialogOpen, setPublishDialogOpen] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [publishError, setPublishError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void getCanvasEntry(canvasId).then((entry) => {
      if (!active) return;
      setCanvasEntry(entry);
      setLoading(false);
      if (entry) {
        void touchCanvas(canvasId);
      }
    });
    return () => {
      active = false;
    };
  }, [canvasId]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setThreadOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (!canvasEntry) {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <RiAlertLine className="size-8 text-muted-foreground" />
        <h1 className="font-heading text-base font-medium text-foreground">Canvas Not Found</h1>
        <p className="text-xs text-muted-foreground max-w-sm">
          The requested offline canvas does not exist on this device or has been deleted.
        </p>
        <Link
          to="/"
          className="inline-flex items-center justify-center border border-border bg-background hover:bg-muted text-xs h-7 px-2.5 font-medium"
        >
          <RiArrowLeftLine className="size-4 mr-1.5" />
          Back to Canvases
        </Link>
      </main>
    );
  }

  return (
    <AgentProvider>
      <CanvasProvider>
        <CanvasPageContent
          canvasEntry={canvasEntry}
          canvasId={canvasId}
          threadOpen={threadOpen}
          setThreadOpen={setThreadOpen}
          publishDialogOpen={publishDialogOpen}
          setPublishDialogOpen={setPublishDialogOpen}
          isPublishing={isPublishing}
          setIsPublishing={setIsPublishing}
          publishError={publishError}
          setPublishError={setPublishError}
          onPublishSuccess={(roomId) => {
            void navigate({
              to: "/room/$roomId",
              params: { roomId },
              replace: true,
            });
          }}
        />
      </CanvasProvider>
    </AgentProvider>
  );
}

function CanvasPageContent({
  canvasEntry,
  canvasId,
  threadOpen,
  setThreadOpen,
  publishDialogOpen,
  setPublishDialogOpen,
  isPublishing,
  setIsPublishing,
  publishError,
  setPublishError,
  onPublishSuccess,
}: {
  canvasEntry: CanvasCatalogEntry;
  canvasId: string;
  threadOpen: boolean;
  setThreadOpen: (open: boolean) => void;
  publishDialogOpen: boolean;
  setPublishDialogOpen: (open: boolean) => void;
  isPublishing: boolean;
  setIsPublishing: (pub: boolean) => void;
  publishError: string | null;
  setPublishError: (err: string | null) => void;
  onPublishSuccess: (roomId: string) => void;
}) {
  const { editor } = useCanvas();

  const handleConfirmPublish = async () => {
    setIsPublishing(true);
    setPublishError(null);
    try {
      const result = await publishCanvas({
        localCanvasId: canvasId,
        name: canvasEntry.name,
        editor,
      });
      setPublishDialogOpen(false);
      onPublishSuccess(result.room.id);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Failed to publish canvas to server");
      setIsPublishing(false);
    }
  };

  return (
    <div className="workspace">
      <HeaderBar
        title={canvasEntry.name}
        mode="offline"
        onMakeOnline={() => {
          setPublishError(null);
          setPublishDialogOpen(true);
        }}
        isPublishing={isPublishing}
      />
      <main className="workspace__body relative">
        <div className="workspace__canvas relative">
          <SharingHintBanner onMakeOnline={() => setPublishDialogOpen(true)} />
          <Canvas roomId={canvasId} />
        </div>
        {threadOpen ? (
          <ChatPanel roomId={canvasId} onClose={() => setThreadOpen(false)} />
        ) : (
          <ChatReopenButton onClick={() => setThreadOpen(true)} />
        )}
      </main>

      <PublishConfirmationDialog
        open={publishDialogOpen}
        isPublishing={isPublishing}
        error={publishError}
        onConfirm={handleConfirmPublish}
        onCancel={() => {
          if (!isPublishing) setPublishDialogOpen(false);
        }}
      />
    </div>
  );
}
