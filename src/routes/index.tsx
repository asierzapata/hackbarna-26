import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel } from "../components/ChatPanel";
import { CallBar } from "../components/CallBar";
import { DevinProvider } from "../components/devin-context";

export const Route = createFileRoute("/")({
  component: WorkspacePage,
});

function WorkspacePage() {
  // The workspace owns thread visibility so the panel's Esc / close control
  // has something real to do.
  const [threadOpen, setThreadOpen] = React.useState(true);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setThreadOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The header button and the thread share one agent connection.
  return (
    <DevinProvider>
      <div className="workspace">
        <HeaderBar />
        <main className="workspace__body">
          <div className="workspace__canvas">
            <Canvas />
            <CallBar />
          </div>
          {threadOpen ? <ChatPanel onClose={() => setThreadOpen(false)} /> : null}
        </main>
      </div>
    </DevinProvider>
  );
}
