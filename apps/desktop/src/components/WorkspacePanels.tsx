import * as React from "react";

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
  if (!chatOpen) {
    return <div className="workspace__canvas relative">{canvas}</div>;
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="size-full">
      <ResizablePanel defaultSize="68%" minSize="50%" className="min-w-0">
        <div className="workspace__canvas relative">{canvas}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        defaultSize="32%"
        minSize="24%"
        maxSize="50%"
        className="min-w-0"
      >
        {chat}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
