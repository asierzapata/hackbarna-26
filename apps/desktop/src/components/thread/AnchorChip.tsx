import { RiCropLine } from "@remixicon/react";

import { Badge } from "@/components/ui/badge";
import type { CanvasAnchor } from "@/lib/thread";

/**
 * A canvas node an entry is pinned to. Clickable when the host wires
 * `onJump`, otherwise a plain label.
 */
export function AnchorChip({
  anchor,
  onJump,
}: {
  anchor: CanvasAnchor;
  onJump?: (anchor: CanvasAnchor) => void;
}) {
  const content = (
    <>
      <RiCropLine />
      {anchor.label}
    </>
  );

  if (!onJump) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        {content}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 text-muted-foreground"
      render={
        <button type="button" onClick={() => onJump(anchor)} title={`Jump to ${anchor.label}`} />
      }
    >
      {content}
    </Badge>
  );
}
