import { createFileRoute } from "@tanstack/react-router";
import { HeaderBar } from "../components/HeaderBar";
import { Canvas } from "../components/Canvas";
import { ChatPanel } from "../components/ChatPanel";
import { CallBar } from "../components/CallBar";

export const Route = createFileRoute("/")({
  component: WorkspacePage,
});

function WorkspacePage() {
  return (
    <div className="workspace">
      <HeaderBar />
      <main className="workspace__body">
        <div className="workspace__canvas">
          <Canvas />
          <CallBar />
        </div>
        <ChatPanel />
      </main>
    </div>
  );
}
