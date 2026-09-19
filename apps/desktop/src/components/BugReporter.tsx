import * as React from "react";
import { useRouterState } from "@tanstack/react-router";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RiBugLine } from "@remixicon/react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Textarea } from "./ui/textarea";
import { Spinner } from "./ui/spinner";
import { qaRegistry, redactQaContext } from "@/lib/qa-context";
import { getQaErrors } from "@/lib/qa-errors";

type SavedReport = { id: string; path: string };

export function BugReporter() {
  const route = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<SavedReport | null>(null);
  const report = React.useRef<Record<string, unknown> | null>(null);
  const inFlight = React.useRef(false);

  function changeOpen(next: boolean) {
    if (inFlight.current) return;
    if (next) {
      setSaved(null);
      setError(null);
      setDescription("");
      report.current = {
        id: crypto.randomUUID(), schemaVersion: 1, capturedAt: new Date().toISOString(),
        route, context: qaRegistry.capture(route), errors: getQaErrors(),
        environment: {
          userAgent: navigator.userAgent, language: navigator.language, online: navigator.onLine,
          viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio },
          desktop: isTauri(), development: import.meta.env.DEV,
        },
      };
    }
    setOpen(next);
  }

  async function save() {
    if (inFlight.current || !report.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (!isTauri()) throw new Error("Open the desktop app to save reports to qa_bugs/. The browser preview cannot write local reports.");
      const result = await invoke<SavedReport>("qa_save_report", {
        report: redactQaContext({ ...report.current, description: description.trim() }),
      });
      setSaved(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="fixed bottom-3 left-3 z-30 shadow-sm" />}>
        <RiBugLine data-icon="inline-start" />
        Report bug
      </DialogTrigger>
      <DialogContent showCloseButton={!saving} onKeyDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{saved ? "Bug report saved" : "Report a bug"}</DialogTitle>
          <DialogDescription>
            {saved ? "Added to the local QA queue as open." : "Save a snapshot of what is happening right now. Nothing is uploaded."}
          </DialogDescription>
        </DialogHeader>
        {saved ? (
          <p role="status" className="break-all text-xs text-muted-foreground" data-qa-report-id={saved.id}>
            Saved to {saved.path}
          </p>
        ) : (
          <FieldGroup>
            <Field data-disabled={saving}>
              <FieldLabel htmlFor="qa-description">What is not working? (optional)</FieldLabel>
              <Textarea id="qa-description" value={description} onChange={(event) => setDescription(event.target.value)}
                placeholder="What happened, and what did you expect?" rows={4} maxLength={10000} disabled={saving} />
              <FieldDescription>
                Includes canvas contents, selection, chat and draft text, agent status, and recent errors from when this dialog opened.
                Known credential fields and URL query strings are removed. Content may still contain private information.
                Embedded images are omitted. Stored locally in qa_bugs/.
              </FieldDescription>
            </Field>
            {error ? <FieldError role="alert">{error}</FieldError> : null}
          </FieldGroup>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={saving}>{saved ? "Done" : "Cancel"}</Button>
          {!saved ? <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {saving ? "Saving…" : "Save report"}
          </Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
