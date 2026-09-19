import * as React from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import {
  RiAddLine,
  RiLoginBoxLine,
  RiHardDriveLine,
  RiCloudLine,
  RiFileCopyLine,
  RiTimeLine,
  RiWifiOffLine,
} from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty";
import { JoinRoomDialog } from "@/components/JoinRoomDialog";

import { getInstallationProfile } from "@/lib/installation-profile";
import {
  listLocalCanvases,
  createOfflineCanvas,
  type CanvasCatalogEntry,
} from "@/lib/canvas-repository";
import { listServerRooms, type ServerRoomSummary } from "@/lib/api-client";
import { duplicateOnlineToOffline } from "@/lib/duplicate-canvas";

export const Route = createFileRoute("/")({
  component: CatalogPage,
});

interface UnifiedCanvasItem {
  id: string; // canvasId or roomId
  name: string;
  mode: "offline" | "online";
  localCanvasId: string;
  roomId?: string;
  roomCode?: string;
  lastActivity: string;
  isOwned?: boolean;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function CatalogPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = React.useState(true);
  const [userName, setUserName] = React.useState<string>("");

  const [localCanvases, setLocalCanvases] = React.useState<CanvasCatalogEntry[]>([]);
  const [serverRooms, setServerRooms] = React.useState<ServerRoomSummary[]>([]);
  const [isServerReachable, setIsServerReachable] = React.useState(true);

  // Dialog states
  const [joinDialogOpen, setJoinDialogOpen] = React.useState(false);
  const [duplicatingId, setDuplicatingId] = React.useState<string | null>(null);

  const refreshCatalog = React.useCallback(async () => {
    const profile = await getInstallationProfile();
    if (!profile || !profile.onboardingCompletedAt || !profile.name || profile.onboardingVersion < 2) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    setUserName(profile.name);

    // 1. Fetch local catalog immediately
    const locals = await listLocalCanvases();
    setLocalCanvases(locals);
    setLoading(false);

    // Only contact the backend after an online operation has registered this
    // installation. A purely offline installation must stay purely local.
    if (!locals.some((canvas) => canvas.mode === "online")) return;

    try {
      const rooms = await listServerRooms();
      setServerRooms(rooms);
      setIsServerReachable(true);
    } catch {
      // Disconnected / server not running: retain cached local items
      setIsServerReachable(false);
    }
  }, [navigate]);

  React.useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const handleCreateNew = async () => {
    const newCanvas = await createOfflineCanvas({ name: "Untitled Canvas" });
    void navigate({
      to: "/canvas/$canvasId",
      params: { canvasId: newCanvas.id },
    });
  };

  const handleDuplicate = async (item: UnifiedCanvasItem) => {
    if (!item.roomId) return;
    setDuplicatingId(item.id);
    try {
      const copy = await duplicateOnlineToOffline({
        roomId: item.roomId,
        sourceName: item.name,
      });
      void navigate({
        to: "/canvas/$canvasId",
        params: { canvasId: copy.id },
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to duplicate canvas");
      setDuplicatingId(null);
    }
  };

  // Split into Offline and Online items
  const offlineItems: CanvasCatalogEntry[] = React.useMemo(() => {
    return localCanvases.filter((c) => c.mode === "offline");
  }, [localCanvases]);

  const onlineItems: UnifiedCanvasItem[] = React.useMemo(() => {
    const map = new Map<string, UnifiedCanvasItem>();

    // 1. Server rooms
    for (const r of serverRooms) {
      map.set(r.id, {
        id: r.id,
        name: r.name,
        mode: "online",
        localCanvasId: r.localCanvasId,
        roomId: r.id,
        roomCode: r.code,
        lastActivity: r.lastOpenedAt || r.updatedAt,
      });
    }

    // 2. Local entries marked online (deduplicate against matching server rooms by localCanvasId or roomId)
    for (const l of localCanvases) {
      if (l.mode === "online" && l.roomId) {
        if (!map.has(l.roomId)) {
          // If not fetched from server, show cached local representation
          map.set(l.roomId, {
            id: l.roomId,
            name: l.name,
            mode: "online",
            localCanvasId: l.id,
            roomId: l.roomId,
            roomCode: l.roomCode,
            lastActivity: l.lastOpenedAt || l.updatedAt,
          });
        }
      }
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return arr;
  }, [serverRooms, localCanvases]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-full w-full bg-background flex flex-col">
      {/* Top Header */}
      <header className="header-bar">
        <div className="header-bar__brand flex items-center gap-2">
          <span>// KAN</span>
          {userName ? (
            <span className="text-xs font-mono font-normal text-muted-foreground pl-2 border-l border-border">
              {userName}
            </span>
          ) : null}
        </div>

        <div className="header-bar__slot" />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setJoinDialogOpen(true)}
            className="text-xs h-7 gap-1.5 font-sans"
          >
            <RiLoginBoxLine className="size-3.5" />
            Join canvas
          </Button>

          <Button
            size="sm"
            variant="default"
            onClick={handleCreateNew}
            className="text-xs h-7 gap-1.5 font-sans"
          >
            <RiAddLine className="size-3.5" />
            New canvas
          </Button>

        </div>
      </header>

      {/* Catalog Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 md:p-8 space-y-8">
        <div className="space-y-1">
          <h1 className="font-heading text-xl font-bold text-foreground">Canvases</h1>
          <p className="text-xs text-muted-foreground font-sans">
            Manage your local offline canvases and collaborative online rooms.
          </p>
        </div>

        {/* Offline Section */}
        <section className="space-y-3" aria-labelledby="offline-heading">
          <div className="flex items-center justify-between pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <RiHardDriveLine className="size-4 text-muted-foreground" />
              <h2 id="offline-heading" className="font-heading text-xs font-semibold uppercase tracking-wider text-foreground">
                Offline Canvases
              </h2>
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              {offlineItems.length} {offlineItems.length === 1 ? "canvas" : "canvases"}
            </span>
          </div>

          {offlineItems.length === 0 ? (
            <Empty className="py-8 border border-border">
              <EmptyHeader>
                <EmptyTitle>No offline canvases</EmptyTitle>
                <EmptyDescription>Create your first offline canvas to start sketching.</EmptyDescription>
              </EmptyHeader>
              <Button size="sm" variant="outline" onClick={handleCreateNew} className="text-xs gap-1.5">
                <RiAddLine className="size-3.5" />
                Create canvas
              </Button>
            </Empty>
          ) : (
            <div className="border border-border divide-y divide-border bg-card">
              {offlineItems.map((canvas) => (
                <div
                  key={canvas.id}
                  className="flex items-center justify-between p-3 sm:px-4 hover:bg-muted/40 transition-colors gap-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      to="/canvas/$canvasId"
                      params={{ canvasId: canvas.id }}
                      className="font-heading text-xs font-medium text-foreground hover:underline truncate block"
                    >
                      {canvas.name}
                    </Link>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
                      <span className="flex items-center gap-1">
                        <RiTimeLine className="size-3" />
                        {formatDate(canvas.lastOpenedAt)}
                      </span>
                      <span>·</span>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1 font-mono uppercase">
                        Offline
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void navigate({
                          to: "/canvas/$canvasId",
                          params: { canvasId: canvas.id },
                        })
                      }
                      className="text-xs gap-1"
                    >
                      <RiCloudLine className="size-3" />
                      Make online
                    </Button>

                    <Link
                      to="/canvas/$canvasId"
                      params={{ canvasId: canvas.id }}
                      className="inline-flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/80 h-6 px-2 text-xs font-medium"
                    >
                      Open
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Online Section */}
        <section className="space-y-3" aria-labelledby="online-heading">
          <div className="flex items-center justify-between pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <RiCloudLine className="size-4 text-primary" />
              <h2 id="online-heading" className="font-heading text-xs font-semibold uppercase tracking-wider text-foreground">
                Online Rooms
              </h2>
              {!isServerReachable ? (
                <Badge variant="destructive" className="text-[10px] h-4 gap-1 px-1.5 font-mono">
                  <RiWifiOffLine className="size-2.5" /> Disconnected
                </Badge>
              ) : null}
            </div>
            <span className="text-[11px] font-mono text-muted-foreground">
              {onlineItems.length} {onlineItems.length === 1 ? "room" : "rooms"}
            </span>
          </div>

          {onlineItems.length === 0 ? (
            <Empty className="py-8 border border-border">
              <EmptyMedia variant="icon">
                <RiCloudLine />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No online canvases yet</EmptyTitle>
                <EmptyDescription>
                  Make any offline canvas online to collaborate live, or join an existing room with a code.
                </EmptyDescription>
              </EmptyHeader>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setJoinDialogOpen(true)} className="text-xs gap-1.5">
                  <RiLoginBoxLine className="size-3.5" />
                  Join canvas
                </Button>
              </div>
            </Empty>
          ) : (
            <div className="border border-border divide-y divide-border bg-card">
              {onlineItems.map((room) => (
                <div
                  key={room.id}
                  className="flex items-center justify-between p-3 sm:px-4 hover:bg-muted/40 transition-colors gap-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      to="/room/$roomId"
                      params={{ roomId: room.id }}
                      className="font-heading text-xs font-medium text-foreground hover:underline truncate block"
                    >
                      {room.name}
                    </Link>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono">
                      <span className="flex items-center gap-1">
                        <RiTimeLine className="size-3" />
                        {formatDate(room.lastActivity)}
                      </span>
                      {room.roomCode ? (
                        <>
                          <span>·</span>
                          <span className="uppercase text-primary/90 font-mono">Code: {room.roomCode}</span>
                        </>
                      ) : null}
                      <span>·</span>
                      <Badge variant="default" className="text-[10px] h-4 px-1 font-mono uppercase">
                        Online
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleDuplicate(room)}
                      disabled={duplicatingId === room.id}
                      className="text-xs gap-1"
                      title="Create independent offline copy"
                    >
                      {duplicatingId === room.id ? (
                        <Spinner className="size-3" />
                      ) : (
                        <RiFileCopyLine className="size-3" />
                      )}
                      Duplicate offline
                    </Button>

                    <Link
                      to="/room/$roomId"
                      params={{ roomId: room.id }}
                      className="inline-flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/80 h-6 px-2 text-xs font-medium"
                    >
                      Open
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Join Room Dialog */}
      <JoinRoomDialog
        open={joinDialogOpen}
        onClose={() => setJoinDialogOpen(false)}
        onJoined={(roomId) => {
          setJoinDialogOpen(false);
          void navigate({
            to: "/room/$roomId",
            params: { roomId },
          });
        }}
      />

      {/* Publish Confirmation Dialog */}
    </div>
  );
}
