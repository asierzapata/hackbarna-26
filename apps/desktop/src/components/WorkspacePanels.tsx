import * as React from "react";
import { usePanelRef } from "react-resizable-panels";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

export function WorkspacePanels({
  canvas,
  chat,
  chatOpen,
}: {
  canvas: React.ReactNode;
  chat: React.ReactNode;
  chatOpen: boolean;
}) {
  const chatPanelRef = usePanelRef();

  React.useLayoutEffect(() => {
    if (chatOpen) {
      chatPanelRef.current?.expand();
    } else {
      chatPanelRef.current?.collapse();
    }
  }, [chatOpen, chatPanelRef]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="size-full min-h-0"
    >
      <ResizablePanel
        defaultSize="68%"
        minSize="50%"
        className="h-full min-h-0 min-w-0"
      >
        <div className="workspace__canvas relative h-full min-h-0">{canvas}</div>
      </ResizablePanel>
      <ResizableHandle withHandle disabled={!chatOpen} />
      <ResizablePanel
        panelRef={chatPanelRef}
        defaultSize="32%"
        minSize="320px"
        maxSize="50%"
        collapsedSize="0%"
        collapsible
        className="h-full min-h-0 min-w-0"
      >
        <div className="h-full min-h-0" inert={!chatOpen} aria-hidden={!chatOpen || undefined}>
          {chat}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
