import { Tldraw } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";

const assetUrls = getAssetUrlsByImport();

export function Canvas() {
  return (
    <section className="canvas" aria-label="Infinite canvas">
      <div className="canvas__viewport">
        <Tldraw assetUrls={assetUrls} />
      </div>
    </section>
  );
}
