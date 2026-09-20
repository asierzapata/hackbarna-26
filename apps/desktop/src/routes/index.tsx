import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RiAddLine, RiLoginBoxLine, RiWifiOffLine } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import { JoinRoomDialog } from "@/components/JoinRoomDialog";
import { CreateCanvasDialog } from "@/components/CreateCanvasDialog";
import { DeleteCanvasDialog } from "@/components/DeleteCanvasDialog";
import { KanBrand } from "@/components/KanBrand";
import {
  CanvasCard,
  CanvasRenameEditor,
  type CanvasCardItem,
} from "@/components/CanvasCard";

import { getInstallationProfile } from "@/lib/installation-profile";
import {
  listLocalCanvases,
  renameCanvas,
  type CanvasCatalogEntry,
} from "@/lib/canvas-repository";
import {
  listServerRooms,
  patchServerRoom,
  type ServerRoomSummary,
} from "@/lib/api-client";
import { duplicateOnlineToOffline } from "@/lib/duplicate-canvas";
import { deleteCanvas } from "@/lib/delete-canvas";

export const Route = createFileRoute("/")({
  component: CatalogPage,
});

type ModeFilter = "all" | "offline" | "online";

interface CatalogItem extends CanvasCardItem {
  /** The entry the rename and the preview are stored against. */
  localCanvasId: string;
  roomId?: string;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMinutes = Math.floor((Date.now() - d.getTime()) / 60000);
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

/**
 * The server and the local catalog can both know about the same online canvas.
 * The server wins on name and code, the local entry contributes the preview,
 * which only ever exists on the device that rendered it.
 */
function mergeCatalog(
  locals: CanvasCatalogEntry[],
  rooms: ServerRoomSummary[],
): CatalogItem[] {
  const byRoomId = new Map<string, CatalogItem>();
  const items: CatalogItem[] = [];

  for (const local of locals) {
    if (local.mode === "online" && local.roomId) {
      byRoomId.set(local.roomId, {
        id: local.roomId,
        name: local.name,
        mode: "online",
        lastActivity: local.lastOpenedAt || local.updatedAt,
        inviteCode: local.roomCode,
        thumbnail: local.thumbnail,
        localCanvasId: local.id,
        roomId: local.roomId,
      });
      continue;
    }
    items.push({
      id: local.id,
      name: local.name,
      mode: "offline",
      lastActivity: local.lastOpenedAt || local.updatedAt,
      thumbnail: local.thumbnail,
      localCanvasId: local.id,
    });
  }

  for (const room of rooms) {
    const cached = byRoomId.get(room.id);
    byRoomId.set(room.id, {
      id: room.id,
      name: room.name,
      mode: "online",
      lastActivity: room.lastOpenedAt || room.updatedAt,
      inviteCode: room.code,
      thumbnail: cached?.thumbnail,
      localCanvasId: cached?.localCanvasId ?? room.localCanvasId,
      roomId: room.id,
    });
  }

  items.push(...byRoomId.values());
  items.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  return items;
}

function CatalogPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = React.useState(true);
  const [userName, setUserName] = React.useState("");
  const [localCanvases, setLocalCanvases] = React.useState<CanvasCatalogEntry[]>([]);
  const [serverRooms, setServerRooms] = React.useState<ServerRoomSummary[]>([]);
  const [isServerReachable, setIsServerReachable] = React.useState(true);
  const [filter, setFilter] = React.useState<ModeFilter>("all");

  const [joinDialogOpen, setJoinDialogOpen] = React.useState(false);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [duplicatingId, setDuplicatingId] = React.useState<string | null>(null);
  const [renameTargetId, setRenameTargetId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [removeTargetId, setRemoveTargetId] = React.useState<string | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [isRemoving, setIsRemoving] = React.useState(false);

  const refreshCatalog = React.useCallback(async () => {
    const profile = await getInstallationProfile();
    if (
      !profile ||
      !profile.onboardingCompletedAt ||
      !profile.name ||
      profile.onboardingVersion < 2
    ) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    setUserName(profile.name);

    const locals = await listLocalCanvases();
    setLocalCanvases(locals);
    setLoading(false);

    // Only contact the backend after an online operation has registered this
    // installation. A purely offline installation must stay purely local.
    if (!locals.some((canvas) => canvas.mode === "online")) return;

    try {
      setServerRooms(await listServerRooms());
      setIsServerReachable(true);
    } catch {
      setIsServerReachable(false);
    }
  }, [navigate]);

  React.useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const items = React.useMemo(
    () => mergeCatalog(localCanvases, serverRooms),
    [localCanvases, serverRooms],
  );

  const visibleItems = React.useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.mode === filter)),
    [items, filter],
  );

  const openItem = (item: CatalogItem) => {
    if (item.mode === "online" && item.roomId) {
      void navigate({ to: "/room/$roomId", params: { roomId: item.roomId } });
      return;
    }
    void navigate({
      to: "/canvas/$canvasId",
      params: { canvasId: item.localCanvasId },
    });
  };

  const handleDuplicate = async (item: CatalogItem) => {
    if (!item.roomId) return;
    setDuplicatingId(item.id);
    try {
      const copy = await duplicateOnlineToOffline({
        roomId: item.roomId,
        sourceName: item.name,
      });
      void navigate({ to: "/canvas/$canvasId", params: { canvasId: copy.id } });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to duplicate canvas");
      setDuplicatingId(null);
    }
  };

  const beginRemove = (item: CatalogItem) => {
    if (isRemoving) return;
    setRemoveTargetId(item.id);
    setRemoveError(null);
  };

  const cancelRemove = () => {
    if (isRemoving) return;
    setRemoveTargetId(null);
    setRemoveError(null);
  };

  const handleRemove = async () => {
    const target = items.find((item) => item.id === removeTargetId);
    if (!target) return;

    setIsRemoving(true);
    setRemoveError(null);
    try {
      await deleteCanvas(target.id, target.mode);
      // Drop it from both sources rather than refetching: a full refresh would
      // contact the server again, and the card should go the moment it is gone.
      setLocalCanvases((canvases) =>
        canvases.filter((canvas) => canvas.id !== target.localCanvasId),
      );
      setServerRooms((rooms) => rooms.filter((room) => room.id !== target.roomId));
      setRemoveTargetId(null);
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : "Failed to remove canvas",
      );
    } finally {
      setIsRemoving(false);
    }
  };

  const beginRename = (item: CatalogItem) => {
    if (isRenaming) return;
    setRenameTargetId(item.id);
    setRenameDraft(item.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    if (isRenaming) return;
    setRenameTargetId(null);
    setRenameDraft("");
    setRenameError(null);
  };

  const handleRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = items.find((item) => item.id === renameTargetId);
    if (!target) return;

    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenameError("Canvas name cannot be empty");
      return;
    }

    setIsRenaming(true);
    setRenameError(null);
    try {
      // Online canvases are named on the server first: that is the copy every
      // other participant sees. The local entry follows so the card stays
      // correct while disconnected.
      let appliedName = trimmed;
      if (target.mode === "online" && target.roomId) {
        const result = await patchServerRoom(target.roomId, { name: trimmed });
        appliedName = result.room.name;
        setServerRooms((rooms) =>
          rooms.map((room) =>
            room.id === target.roomId
              ? { ...room, name: appliedName, updatedAt: result.room.updatedAt }
              : room,
          ),
        );
      }

      if (localCanvases.some((canvas) => canvas.id === target.localCanvasId)) {
        const updated = await renameCanvas(target.localCanvasId, appliedName);
        setLocalCanvases((canvases) =>
          canvases.map((canvas) => (canvas.id === updated.id ? updated : canvas)),
        );
      }

      setRenameTargetId(null);
      setRenameDraft("");
    } catch (err) {
      setRenameError(
        err instanceof Error ? err.message : "Failed to rename canvas",
      );
    } finally {
      setIsRenaming(false);
    }
  };

  const removeTarget = items.find((item) => item.id === removeTargetId);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const filters: { value: ModeFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "offline", label: "Offline" },
    { value: "online", label: "Online" },
  ];

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background">
      <header className="header-bar sticky top-0 z-20 shrink-0">
        <div className="header-bar__brand flex items-center gap-2">
          <KanBrand />
          {userName ? (
            <span className="border-l border-border pl-3 font-sans text-sm font-normal text-muted-foreground">
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
            className="h-7 gap-1.5"
          >
            <RiLoginBoxLine className="size-3.5" />
            Join canvas
          </Button>

          <Button
            size="sm"
            variant="default"
            onClick={() => setCreateDialogOpen(true)}
            className="h-7 gap-1.5"
          >
            <RiAddLine className="size-3.5" />
            New canvas
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 p-6 md:p-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="font-sans text-[28px] font-semibold tracking-tight text-foreground">
              Canvases
            </h1>
            <p className="font-sans text-sm text-muted-foreground">
              Kept on this device, or shared online for others to edit with you.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {!isServerReachable ? (
              <Badge
                variant="destructive"
                className="h-5 gap-1 px-1.5 font-mono text-xs"
              >
                <RiWifiOffLine className="size-2.5" /> Disconnected
              </Badge>
            ) : null}
            <div
              role="radiogroup"
              aria-label="Filter canvases"
              className="flex items-center gap-0.5 rounded-lg bg-muted p-1"
            >
              {filters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={
                    filter === option.value
                      ? "rounded-md bg-card px-3 py-1 text-sm font-medium text-foreground shadow-sm"
                      : "rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {visibleItems.length === 0 ? (
          <Empty className="border border-border py-12">
            <EmptyMedia variant="icon">
              <RiAddLine />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>
                {items.length === 0
                  ? "No canvases yet"
                  : `No ${filter} canvases`}
              </EmptyTitle>
              <EmptyDescription>
                {items.length === 0
                  ? "Create one to start sketching, or join a canvas with an invite code."
                  : "Nothing here yet. Switch the filter, or create one."}
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                onClick={() => setCreateDialogOpen(true)}
                className="gap-1.5 text-xs"
              >
                <RiAddLine className="size-3.5" />
                New canvas
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setJoinDialogOpen(true)}
                className="gap-1.5 text-xs"
              >
                <RiLoginBoxLine className="size-3.5" />
                Join canvas
              </Button>
            </div>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleItems.map((item) => (
              <CanvasCard
                key={item.id}
                item={item}
                formatDate={formatDate}
                onOpen={() => openItem(item)}
                onRename={() => beginRename(item)}
                onDuplicate={
                  item.mode === "online" ? () => void handleDuplicate(item) : undefined
                }
                onRemove={() => beginRemove(item)}
                isDuplicating={duplicatingId === item.id}
                isRenaming={isRenaming}
                isRemoving={isRemoving && removeTargetId === item.id}
                renameEditor={
                  renameTargetId === item.id ? (
                    <CanvasRenameEditor
                      value={renameDraft}
                      onChange={setRenameDraft}
                      onSubmit={(event) => void handleRename(event)}
                      onCancel={cancelRename}
                      busy={isRenaming}
                      error={renameError}
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </main>

      <CreateCanvasDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={(canvas) => {
          setCreateDialogOpen(false);
          if (canvas.mode === "online" && canvas.roomId) {
            void navigate({
              to: "/room/$roomId",
              params: { roomId: canvas.roomId },
            });
            return;
          }
          void navigate({
            to: "/canvas/$canvasId",
            params: { canvasId: canvas.localCanvasId },
          });
        }}
      />

      <DeleteCanvasDialog
        open={removeTarget !== undefined}
        name={removeTarget?.name ?? ""}
        mode={removeTarget?.mode ?? "offline"}
        inviteCode={removeTarget?.inviteCode}
        busy={isRemoving}
        error={removeError}
        onConfirm={() => void handleRemove()}
        onCancel={cancelRemove}
      />

      <JoinRoomDialog
        open={joinDialogOpen}
        onClose={() => setJoinDialogOpen(false)}
        onJoined={(roomId) => {
          setJoinDialogOpen(false);
          void navigate({ to: "/room/$roomId", params: { roomId } });
        }}
      />
    </div>
  );
}
