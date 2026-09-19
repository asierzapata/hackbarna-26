import * as React from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { diagnosticDetails, getDiagnostics, refreshDiagnostics, setDiagnosticCapture, subscribeDiagnostics } from "@/lib/agent-diagnostics";

export function AgentDiagnostics({ turnId }: { turnId?: string }) {
  const [, update] = React.useReducer((value: number) => value + 1, 0);
  const [open, setOpen] = React.useState(false);
  const [preview, setPreview] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [capture, setCapture] = React.useState(false);
  React.useEffect(() => subscribeDiagnostics(update), []);
  const snapshot = getDiagnostics(turnId);
  const failures = [...new Map(snapshot.events.filter((event) => event.failure).map((event) => [`${event.tool ?? "agent"}:${event.failure!.code}:${JSON.stringify(event.failure!.issues ?? [])}`, event])).values()];
  async function loadPreview(includeDetails = false) {
    setError(null); setCopied(false);
    try {
      const data = await refreshDiagnostics(turnId);
      setPreview(JSON.stringify({ schemaVersion: 1, traceId: turnId, ...data, ...(includeDetails ? { details: await diagnosticDetails() } : {}) }, null, 2));
    } catch { setError("Could not read native diagnostics. The local event buffer is shown."); setPreview(JSON.stringify(getDiagnostics(turnId), null, 2)); }
  }
  async function toggleCapture() {
    try { await setDiagnosticCapture(!capture); setCapture(!capture); }
    catch { setError("Could not change diagnostic capture."); }
  }
  return <div className="flex flex-col gap-2" data-agent-diagnostics={turnId ?? "all"}>
    {turnId && failures.length > 0 ? <Collapsible>
      <CollapsibleTrigger render={<Button variant="outline" size="xs" />}>
        {failures.length} diagnostic {failures.length === 1 ? "issue" : "issues"}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 py-2">
        {failures.slice(-12).map((event) => <div key={event.id} className="flex flex-col gap-1 text-xs" data-failure-code={event.failure!.code}>
          <strong>{event.tool ?? "Agent"} · {event.failure!.phase}{event.durationMs !== undefined ? ` · ${Math.round(event.durationMs)} ms` : ""}</strong>
          <span>{event.failure!.message}</span>
          <span className="text-muted-foreground">Outcome: {event.failure!.outcome.replace("_", " ")} · {event.failure!.code}</span>
          {event.failure!.issues?.map((issue, index) => <span key={index}>{issue.path}: {issue.code}</span>)}
        </div>)}
      </CollapsibleContent>
    </Collapsible> : null}
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) void loadPreview(); }}>
      <DialogTrigger render={<Button variant="link" size="xs" />}>View diagnostics</DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Agent diagnostics</DialogTitle>
          <DialogDescription>Review before copying. Default traces contain timings, identifiers and error codes, not prompts or canvas contents. Nothing is uploaded.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={`diagnostic-preview-${turnId ?? "all"}`}>{turnId ? `Trace ${turnId}` : "Recent agent activity"}</FieldLabel>
          <Textarea id={`diagnostic-preview-${turnId ?? "all"}`} value={preview} readOnly rows={12} className="h-64 min-h-0 resize-none field-sizing-fixed" />
          <FieldDescription>Completed changes are kept after a failure. An unknown outcome must be inspected before retrying a mutation.</FieldDescription>
        </Field>
        {!turnId ? <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Optional detail capture lasts five minutes and stays in memory. Error stacks and provider stderr may contain private text despite redaction. Disabling clears captured details.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void toggleCapture()}>{capture ? "Stop detailed capture" : "Capture details for 5 minutes"}</Button>
            <Button variant="outline" size="sm" onClick={() => void loadPreview(true)}>Preview captured details</Button>
          </div>
        </div> : null}
        {error || snapshot.persistenceError ? <FieldError role="alert">{error ?? "Native diagnostic logging is unavailable. The recent in-memory trace is still available."}</FieldError> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          <Button disabled={!preview} onClick={() => { void navigator.clipboard.writeText(preview).then(() => setCopied(true), () => setError("Clipboard unavailable. Select and copy the preview above.")); }}>{copied ? "Copied" : "Copy diagnostics"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
