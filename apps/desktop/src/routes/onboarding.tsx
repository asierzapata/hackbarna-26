import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RiSparklingLine, RiAlertLine } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  completeOnboarding,
  isOnboardingComplete,
} from "@/lib/onboarding";
import { validateDisplayName } from "@/lib/installation-profile";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isChecking, setIsChecking] = React.useState(true);

  React.useEffect(() => {
    void isOnboardingComplete().then((complete) => {
      if (complete) {
        void navigate({ to: "/", replace: true });
      } else {
        setIsChecking(false);
      }
    });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateDisplayName(name);
    if (!validation.valid) {
      setError(validation.error ?? "Please enter a valid display name");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await completeOnboarding(validation.normalized);
      void navigate({
        to: "/canvas/$canvasId",
        params: { canvasId: result.firstCanvasId },
        replace: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize installation profile");
      setIsSubmitting(false);
    }
  };

  if (isChecking) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <main className="flex min-h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-8">
        <div className="space-y-2 text-center">
          <div className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-primary/80 uppercase tracking-widest">
            <RiSparklingLine className="size-3.5" />
            <span>Kan Canvas</span>
          </div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Welcome to Kan
          </h1>
          <p className="text-xs text-muted-foreground font-sans">
            Your infinite collaborative canvas for teams and AI agents.
          </p>
        </div>

        <div className="border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label
                htmlFor="display-name-input"
                className="block font-heading text-xs font-medium text-foreground"
              >
                What should we call you?
              </label>
              <Input
                id="display-name-input"
                type="text"
                autoFocus
                placeholder="Your display name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                disabled={isSubmitting}
                className="text-sm"
                autoComplete="name"
                maxLength={80}
              />
              <p className="text-[11px] text-muted-foreground leading-normal">
                Your name is shown to others when you collaborate.
              </p>
            </div>

            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
              >
                <RiAlertLine className="size-4 shrink-0 mt-0.5" />
                <span className="leading-snug">{error}</span>
              </div>
            ) : null}

            <Button
              type="submit"
              size="default"
              variant="default"
              disabled={isSubmitting || !name.trim()}
              className="w-full text-xs font-medium tracking-wide"
            >
              {isSubmitting ? (
                <>
                  <Spinner className="size-3.5 mr-1.5" />
                  Starting...
                </>
              ) : (
                "Start creating"
              )}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
