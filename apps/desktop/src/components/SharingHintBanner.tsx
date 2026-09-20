import * as React from "react";
import { RiInformationLine, RiCloseLine, RiCloudLine } from "@remixicon/react";
import { Button } from "./ui/button";
import { getInstallationProfile, dismissSharingHint } from "@/lib/installation-profile";

export interface SharingHintBannerProps {
  onMakeOnline?: () => void;
}

export function SharingHintBanner({ onMakeOnline }: SharingHintBannerProps) {
  const [dismissed, setDismissed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    void getInstallationProfile().then((profile) => {
      setDismissed(Boolean(profile?.sharingHintDismissedAt));
    });
  }, []);

  const handleDismiss = React.useCallback(async () => {
    setDismissed(true);
    await dismissSharingHint();
  }, []);

  if (dismissed !== false) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Sharing introduction"
      className="absolute top-3 right-4 z-40 max-w-sm rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3.5 shadow-md animate-in fade-in slide-in-from-top-2 duration-200"
    >
      <div className="flex items-start gap-2.5">
        <RiInformationLine className="size-4 text-primary shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-xs text-foreground/90 leading-relaxed font-sans">
            This canvas is saved on this device. Make it online to share it and edit together.
            Once online, it stays online. You can always make a separate offline copy.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="xs"
              variant="default"
              onClick={handleDismiss}
              className="text-xs h-6 px-2 font-medium"
            >
              Got it
            </Button>
            {onMakeOnline ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void handleDismiss();
                  onMakeOnline();
                }}
                className="text-xs h-6 px-2 gap-1"
              >
                <RiCloudLine className="size-3" />
                Make online
              </Button>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground -mr-1 -mt-1 p-1"
          aria-label="Dismiss message"
        >
          <RiCloseLine className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
