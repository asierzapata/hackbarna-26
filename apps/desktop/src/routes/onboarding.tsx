import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KanAppIcon } from "@/components/KanBrand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { completeOnboarding } from "@/lib/onboarding";
import {
  getInstallationProfile,
  saveInstallationProfile,
  validateDisplayName,
  type InstallationProfile,
} from "@/lib/installation-profile";
import { AgentProvider, useAgent } from "@/components/agent-context";
import { AgentSetup } from "@/components/AgentSetup";

export const Route = createFileRoute("/onboarding")({
  component: () => (
    <AgentProvider>
      <OnboardingPage />
    </AgentProvider>
  ),
});

function OnboardingPage() {
  const navigate = useNavigate();
  const agent = useAgent();
  const [name, setName] = React.useState("");
  const [profile, setProfile] = React.useState<InstallationProfile | null>(
    null,
  );
  const [step, setStep] = React.useState<"name" | "ai">("name");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isChecking, setIsChecking] = React.useState(true);
  const pending =
    isSubmitting || agent.busy || agent.status.state === "connecting";

  React.useEffect(() => {
    void getInstallationProfile()
      .then((existing) => {
        if (existing?.onboardingCompletedAt && existing.name) {
          if (existing.onboardingVersion >= 2) {
            void navigate({ to: "/", replace: true });
            return;
          }
          setProfile(existing);
          setName(existing.name);
          setStep("ai");
        }
        setIsChecking(false);
      })
      .catch((cause) => {
        setError(String(cause));
        setIsChecking(false);
      });
  }, [navigate]);

  const finish = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (profile?.onboardingCompletedAt) {
        await saveInstallationProfile({ ...profile, onboardingVersion: 2 });
        void navigate({ to: "/", replace: true });
      } else {
        const result = await completeOnboarding(name);
        void navigate({
          to: "/canvas/$canvasId",
          params: { canvasId: result.firstCanvasId },
          replace: true,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsSubmitting(false);
    }
  };

  if (isChecking) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <main className="flex min-h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <KanAppIcon />
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            {profile ? "Your AI, ready when you are" : "Welcome to Kan"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your infinite collaborative canvas for teams and AI agents.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              {step === "name" ? "Make yourself at home" : "Choose your AI"}
            </CardTitle>
            <CardDescription>
              {step === "name"
                ? "First, tell us what to call you."
                : "Connect once. Keep your account and default model across restarts."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === "name" ? (
              <form
                id="onboarding-name"
                onSubmit={(event) => {
                  event.preventDefault();
                  const validation = validateDisplayName(name);
                  if (!validation.valid) {
                    setError(validation.error ?? "Please enter a valid name");
                    return;
                  }
                  setName(validation.normalized);
                  setError(null);
                  setStep("ai");
                }}
              >
                <FieldGroup>
                  <Field data-invalid={!!error}>
                    <FieldLabel htmlFor="display-name-input">
                      What should we call you?
                    </FieldLabel>
                    <Input
                      id="display-name-input"
                      autoFocus
                      autoComplete="name"
                      placeholder="Your display name"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setError(null);
                      }}
                      maxLength={80}
                      aria-invalid={!!error}
                    />
                    <FieldDescription>
                      Your name is shown to others when you collaborate.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </form>
            ) : (
              <AgentSetup />
            )}
            {error && <FieldError>{error}</FieldError>}
          </CardContent>
          <CardFooter className="flex-col gap-2">
            {step === "name" ? (
              <Button
                form="onboarding-name"
                type="submit"
                className="w-full"
                disabled={!name.trim()}
              >
                Continue
              </Button>
            ) : (
              <>
                {agent.status.state === "ready" && (
                  <Button
                    className="w-full"
                    disabled={pending}
                    onClick={() => {
                      void finish();
                    }}
                  >
                    {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                    Start creating
                  </Button>
                )}
                {agent.status.state !== "ready" && (
                  <Button
                    variant="ghost"
                    className="w-full"
                    disabled={pending}
                    onClick={() => {
                      void finish();
                    }}
                  >
                    Set up later
                  </Button>
                )}
                {!profile && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setStep("name");
                      setError(null);
                    }}
                  >
                    Back
                  </Button>
                )}
              </>
            )}
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
