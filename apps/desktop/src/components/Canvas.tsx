import * as React from "react";
import {
  Tldraw,
  atom,
  createUserId,
  UserRecordType,
  defaultBindingUtils,
  defaultShapeUtils,
  DefaultStylePanel,
  ToolbarItem,
  TldrawUiMenuContextProvider,
  TldrawUiPopover,
  TldrawUiPopoverContent,
  TldrawUiPopoverTrigger,
  TldrawUiToolbar,
  TldrawUiToolbarButton,
  useEditor,
  useValue,
  type Editor,
  type TLAssetStore,
  type TLComponents,
  type TLUiOverrides,
} from "tldraw";
import { useSync } from "@tldraw/sync";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";
import "@/nodes/nodes.css";

import { shapeUtils } from "@/lib/canvas-shapes";
import { consumeCanvasInitialRecords } from "@/lib/canvas-repository";
import {
  createSocketTicket,
  fetchServerAsset,
  getRoomWebSocketUrl,
  uploadServerAsset,
} from "@/lib/api-client";
import { createKanShapeUtils } from "@/nodes/shapes";
import { MermaidPasteHandler } from "./MermaidPasteHandler";
import {
  createCanvasTools,
  isGroupedFrame,
  ungroupCanvasFrame,
  type CanvasTools,
} from "@/nodes/tools";
import { useCanvas } from "./canvas-context";
import { CanvasThinkingOverlay } from "./CanvasThinkingOverlay";

const assetUrls = getAssetUrlsByImport();
const canvasShapeUtils = [...shapeUtils, ...createKanShapeUtils()];
const syncShapeUtils = [...defaultShapeUtils, ...shapeUtils];

const primaryTools = [
  "select",
  "hand",
  "draw",
  "eraser",
  "arrow",
  "text",
  "note",
];
const extraTools = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "oval",
  "rhombus",
  "star",
  "cloud",
  "heart",
  "x-box",
  "check-box",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "arrow-right",
  "line",
  "highlight",
  "laser",
  "frame",
];

function CanvasToolbar() {
  const editor = useEditor();
  const readonly = useValue(
    "readonly",
    () => editor.getInstanceState().isReadonly,
    [editor],
  );
  if (readonly) return null;

  return (
    <div className="tlui-main-toolbar tlui-main-toolbar--horizontal">
      <TldrawUiToolbar
        label="Canvas tools"
        className="tlui-main-toolbar__tools kan-toolbar"
        tooltipSide="top"
      >
        <TldrawUiMenuContextProvider type="toolbar" sourceId="toolbar">
          {primaryTools.map((tool) => (
            <ToolbarItem key={tool} tool={tool} />
          ))}
        </TldrawUiMenuContextProvider>
        <TldrawUiPopover id="kan-toolbar-color">
          <TldrawUiPopoverTrigger>
            <TldrawUiToolbarButton type="tool" title="Color and style">
              <span className="kan-style-panel__swatch" aria-hidden />
            </TldrawUiToolbarButton>
          </TldrawUiPopoverTrigger>
          <TldrawUiPopoverContent side="top" collisionPadding={8}>
            <DefaultStylePanel isMobile />
          </TldrawUiPopoverContent>
        </TldrawUiPopover>
        <TldrawUiPopover id="kan-toolbar-more">
          <TldrawUiPopoverTrigger>
            <TldrawUiToolbarButton type="tool" title="More tools">
              <span aria-hidden>•••</span>
            </TldrawUiToolbarButton>
          </TldrawUiPopoverTrigger>
          <TldrawUiPopoverContent side="top" align="end" collisionPadding={8}>
            <TldrawUiToolbar
              label="More canvas tools"
              orientation="grid"
              className="kan-toolbar__overflow"
            >
              <TldrawUiMenuContextProvider type="toolbar" sourceId="toolbar">
                {extraTools.map((tool) => (
                  <ToolbarItem key={tool} tool={tool} />
                ))}
              </TldrawUiMenuContextProvider>
            </TldrawUiToolbar>
          </TldrawUiPopoverContent>
        </TldrawUiPopover>
      </TldrawUiToolbar>
    </div>
  );
}

const canvasComponents = {
  PageMenu: null,
  NavigationPanel: null,
  MenuPanel: null,
  MainMenu: null,
  QuickActions: null,
  ActionsMenu: null,
  StylePanel: null,
  Toolbar: CanvasToolbar,
  InFrontOfTheCanvas: CanvasThinkingOverlay,
} satisfies TLComponents;

const canvasOverrides: TLUiOverrides = {
  actions: (editor, actions) => {
    const groupAction = actions.group;
    if (!groupAction) return actions;

    return {
      ...actions,
      group: {
        ...groupAction,
        onSelect(source) {
          const selectedShapeIds = editor.getSelectedShapeIds();
          const onlySelectedShape = editor.getOnlySelectedShape();
          if (onlySelectedShape && isGroupedFrame(onlySelectedShape)) {
            ungroupCanvasFrame(editor, onlySelectedShape.id);
            return;
          }
          if (
            selectedShapeIds.length < 2 ||
            (onlySelectedShape && editor.isShapeOfType(onlySelectedShape, "group"))
          ) {
            groupAction.onSelect(source);
            return;
          }
          createCanvasTools(editor).groupNodes({ shapeIds: selectedShapeIds });
        },
      },
    };
  },
};

type KanDevWindow = Window & {
  __kan?: { editor: Editor; tools: CanvasTools };
};

export function Canvas({
  roomId,
  online = false,
  onlineUser,
}: {
  roomId: string;
  online?: boolean;
  onlineUser?: { id: string; name: string };
}) {
  return online ? (
    onlineUser ? <OnlineCanvas roomId={roomId} user={onlineUser} /> : null
  ) : (
    <OfflineCanvas roomId={roomId} />
  );
}

function OfflineCanvas({ roomId }: { roomId: string }) {
  const { setEditor } = useCanvas();

  const onMount = React.useCallback(
    (editor: Editor) => {
      setEditor(editor);

      // Seed initial records if this canvas was duplicated or initialized with snapshot
      if (editor.getCurrentPageShapeIds().size === 0) {
        void consumeCanvasInitialRecords(roomId).then((initialRecords) => {
          if (initialRecords?.length) editor.store.put(initialRecords as any[]);
        });
      }

      if (import.meta.env.DEV) {
        (window as KanDevWindow).__kan = {
          editor,
          tools: createCanvasTools(editor),
        };
      }

      return () => {
        setEditor(null);
        if ((window as KanDevWindow).__kan?.editor === editor) {
          delete (window as KanDevWindow).__kan;
        }
      };
    },
    [roomId, setEditor],
  );

  return (
    <section className="canvas" aria-label="Infinite canvas">
      <div className="canvas__viewport">
        <Tldraw
          // Remounts the editor on a room change, so two rooms never share a
          // store. Swaps for `store={useSync(...)}` when the server exists.
          key={roomId}
          persistenceKey={`kan-room-${roomId}`}
          assetUrls={assetUrls}
          shapeUtils={canvasShapeUtils}
          components={canvasComponents}
          overrides={canvasOverrides}
          onMount={onMount}
        >
          <MermaidPasteHandler />
        </Tldraw>
      </div>
    </section>
  );
}

const resolvedAssets = new Map<string, Promise<string>>();
const onlineAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    const uploaded = await uploadServerAsset(
      file,
      file.type || "application/octet-stream",
    );
    return { src: `/assets/${uploaded.id}` };
  },
  resolve(asset) {
    const src = asset.props.src;
    if (!src) return null;
    const match = /^\/assets\/([0-9a-f-]{36})$/.exec(src);
    if (!match) return src;
    let pending = resolvedAssets.get(match[1]);
    if (!pending) {
      pending = fetchServerAsset(match[1]).then((blob) =>
        URL.createObjectURL(blob),
      );
      resolvedAssets.set(match[1], pending);
    }
    return pending;
  },
};

function OnlineCanvas({ roomId, user }: { roomId: string; user: { id: string; name: string } }) {
  const { setEditor } = useCanvas();
  const users = React.useMemo(() => ({
    currentUser: atom("room user", UserRecordType.create({ id: createUserId(user.id), name: user.name, color: "#5273c9" })),
  }), [user.id, user.name]);
  const getSyncUri = React.useCallback(async () => {
    const { ticket } = await createSocketTicket(roomId, "sync");
    return getRoomWebSocketUrl(roomId, "sync", ticket);
  }, [roomId]);
  const store = useSync({
    shapeUtils: syncShapeUtils,
    bindingUtils: defaultBindingUtils,
    assets: onlineAssetStore,
    users,
    uri: getSyncUri,
  });

  const onMount = React.useCallback(
    (editor: Editor) => setEditor(editor),
    [setEditor],
  );
  React.useEffect(() => () => setEditor(null), [setEditor]);

  return (
    <section className="canvas" aria-label="Infinite canvas">
      <div className="canvas__viewport">
        <Tldraw
          key={roomId}
          store={store}
          assetUrls={assetUrls}
          shapeUtils={shapeUtils}
          components={canvasComponents}
          overrides={canvasOverrides}
          onMount={onMount}
        >
          <MermaidPasteHandler />
        </Tldraw>
      </div>
    </section>
  );
}
