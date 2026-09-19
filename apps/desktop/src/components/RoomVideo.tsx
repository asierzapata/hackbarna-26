import * as React from "react";
import { RiArrowRightLine, RiEyeLine, RiMicLine, RiMicOffLine, RiVideoOnLine, RiVideoOffLine, RiVolumeUpLine, RiShieldCheckLine } from "@remixicon/react";
import { createUserId, useValue } from "tldraw";
import type OT from "@opentok/client";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Spinner } from "./ui/spinner";
import { useCanvas } from "./canvas-context";
import { useMicrophoneLevel, type LocalMediaControls } from "./use-local-media";
import type { RoomVideo } from "./use-room-video";

function Initials({ name }: { name: string }) {
  return <span className="room-video__initials" aria-hidden>{name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?"}</span>;
}

function LocalPreview({ track, name }: { track: MediaStreamTrack | null; name: string }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || !track) return;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => {});
    return () => { element.srcObject = null; };
  }, [track]);
  return track
    ? <video ref={ref} autoPlay muted playsInline className="room-video__local" aria-label="Your camera preview" />
    : <div className="room-video__placeholder"><Initials name={name} /><span>Camera off</span></div>;
}

function MediaButtons({ controls, compact = false }: { controls: LocalMediaControls; compact?: boolean }) {
  return <div className="flex items-center justify-center gap-2">
    {(["audio", "video"] as const).map((kind) => {
      const device = controls.state[kind];
      const enabled = !!device.track || device.pending;
      const label = kind === "audio" ? enabled ? "Mute microphone" : "Unmute microphone" : enabled ? "Turn camera off" : "Turn camera on";
      const Icon = kind === "audio" ? enabled ? RiMicLine : RiMicOffLine : enabled ? RiVideoOnLine : RiVideoOffLine;
      return <Button key={kind} size={compact ? "icon-xs" : "default"} variant={enabled ? "secondary" : "outline"} title={label} aria-label={label} aria-pressed={enabled} onClick={() => void controls.media.enable(kind, !enabled)}>
        {device.pending ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
        {!compact && (kind === "audio" ? enabled ? "Mic on" : "Mic off" : enabled ? "Camera on" : "Camera off")}
      </Button>;
    })}
  </div>;
}

export function RoomPrejoin({ title, name, controls, onJoin, onCancel }: {
  title: string;
  name: string;
  controls: LocalMediaControls;
  onJoin: () => void;
  onCancel: () => void;
}) {
  const level = useMicrophoneLevel(controls.state.audio.track);
  const sound = React.useRef<AudioContext | null>(null);
  const [speakerError, setSpeakerError] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  React.useEffect(() => () => { void sound.current?.close().catch(() => {}); }, []);
  const testSpeaker = async () => {
    setSpeakerError(false);
    setTesting(true);
    try {
      const context = new AudioContext();
      sound.current = context;
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.5);
      oscillator.frequency.value = 440;
      oscillator.connect(gain).connect(context.destination);
      oscillator.onended = () => { void context.close(); setTesting(false); };
      oscillator.start();
      oscillator.stop(context.currentTime + 0.5);
    } catch {
      setSpeakerError(true);
      setTesting(false);
      void sound.current?.close().catch(() => {});
    }
  };
  const pending = controls.state.audio.pending || controls.state.video.pending;
  return <main className="room-prejoin" aria-labelledby="prejoin-title">
    <div className="room-prejoin__layout">
      <section className="flex min-w-0 flex-col gap-4" aria-label="Camera and microphone preview">
        <div className="room-prejoin__preview">
          <LocalPreview track={controls.state.video.track} name={name} />
          <span className="room-prejoin__you">{name} · You</span>
          {controls.state.video.pending && <span className="room-prejoin__pending" role="status">Waiting for camera permission…</span>}
        </div>
        <MediaButtons controls={controls} />
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><RiShieldCheckLine className="size-4" />Only you can see and hear this preview.</p>
      </section>
      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Before you enter</p>
          <h1 id="prejoin-title" className="text-3xl font-medium tracking-tight">Ready to join?</h1>
          <p className="truncate text-lg" title={title}>{title}</p>
          <p className="text-sm text-muted-foreground">Check your camera and sound. Make yourself at home.</p>
          <p className="text-xs text-muted-foreground">When your microphone is on, Vonage transcribes your speech. The transcript is saved in the room chat, collapsed by default. Join muted to listen without being transcribed.</p>
        </div>
        <FieldGroup>
          {(["video", "audio"] as const).map((kind) => <Field key={kind}>
            <FieldLabel htmlFor={`room-${kind}-input`}>{kind === "video" ? "Camera" : "Microphone"}</FieldLabel>
            <NativeSelect id={`room-${kind}-input`} className="w-full" value={controls.state[kind].deviceId} onChange={(event) => void controls.media.enable(kind, true, event.target.value)}>
              <NativeSelectOption value="">System default</NativeSelectOption>
              {controls.devices.filter((device) => device.kind === `${kind}input`).map((device, index) => <NativeSelectOption key={device.deviceId} value={device.deviceId}>{device.label || `${kind === "video" ? "Camera" : "Microphone"} ${index + 1}`}</NativeSelectOption>)}
            </NativeSelect>
            {kind === "audio" && <>
              <meter className="room-prejoin__meter" min={0} max={100} value={level} aria-label="Microphone input level" />
              <FieldDescription>{controls.state.audio.pending ? "Waiting for microphone permission…" : controls.state.audio.track ? "Say something — the meter should move." : "Your microphone is off. You can join muted."}</FieldDescription>
            </>}
          </Field>)}
        </FieldGroup>
        <Button variant="outline" className="self-start" disabled={testing} onClick={() => void testSpeaker()}><RiVolumeUpLine data-icon="inline-start" />{testing ? "Playing test sound…" : "Test speakers"}</Button>
        {(controls.state.audio.error || controls.state.video.error || speakerError) && <Alert>
          <AlertTitle>Check your devices</AlertTitle>
          <AlertDescription>{[controls.state.video.error, controls.state.audio.error, speakerError ? "Could not play sound. Check your system output device." : null].filter(Boolean).map((error) => <p key={error}>{error}</p>)}<p>You can still join with camera and microphone off.</p></AlertDescription>
        </Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" disabled={pending} onClick={onJoin}>Join room<RiArrowRightLine data-icon="inline-end" /></Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {pending && <Button variant="outline" onClick={() => { controls.media.dispose(); onJoin(); }}>Join without devices</Button>}
        </div>
      </section>
    </div>
  </main>;
}

function RemoteVideo({ session, stream }: { session: OT.Session; stream: OT.Stream }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const subscriberRef = React.useRef<OT.Subscriber | null>(null);
  React.useEffect(() => {
    if (!ref.current) return;
    let active = true;
    setError(false);
    setBlocked(false);
    const subscriber = session.subscribe(stream, ref.current, {
      insertMode: "append", width: "100%", height: "100%", fitMode: "cover", showControls: false,
      style: { buttonDisplayMode: "off", nameDisplayMode: "off", audioLevelDisplayMode: "off", audioBlockedDisplayMode: "off" },
    }, (failure) => { if (active && failure) setError(true); });
    subscriberRef.current = subscriber;
    subscriber.on("audioBlocked", () => { if (active) setBlocked(true); });
    subscriber.on("audioUnblocked", () => { if (active) setBlocked(false); });
    return () => {
      active = false;
      subscriber.off();
      session.unsubscribe(subscriber);
      subscriberRef.current = null;
    };
  }, [session, stream]);
  return <>
    <div ref={ref} className="room-video__stream" />
    {error && <span className="room-video__notice" role="status">Media unavailable</span>}
    {blocked && <div className="room-video__notice"><Button size="xs" onClick={() => void subscriberRef.current?.subscribeToAudio.promise(true)}>Enable sound</Button></div>}
  </>;
}

export function RoomParticipantStrip({ name, controls, call }: { name: string; controls: LocalMediaControls; call: RoomVideo }) {
  const { editor } = useCanvas();
  const collaborators = useValue("call collaborators", () => editor?.getCollaborators() ?? [], [editor]);
  const following = useValue("call following", () => editor?.getInstanceState().followingUserId ?? null, [editor]);
  const peers = call.peers.map((peer) => ({ ...peer, canvasId: peer.userId ? createUserId(peer.userId) : null }));
  for (const person of collaborators) {
    if (!peers.some((peer) => peer.canvasId === person.userId)) {
      peers.push({ connectionId: person.userId, userId: null, name: person.userName, canvasId: person.userId });
    }
  }
  return <section className="room-video" aria-label="Room participants">
    <div className="room-video__strip">
      <article className="room-video__tile" aria-label="Your participant tile">
        <div className="room-video__picture"><LocalPreview track={controls.state.video.track} name={name} /></div>
        <div className="room-video__footer"><span className="truncate" title={`${name} (you)`}>You</span><MediaButtons controls={controls} compact /></div>
      </article>
      {peers.map((peer) => {
        const isFollowing = !!peer.canvasId && following === peer.canvasId;
        const canFollow = !!peer.canvasId && collaborators.some((person) => person.userId === peer.canvasId && person.camera);
        return <article key={peer.connectionId} className={cn("room-video__tile", isFollowing && "room-video__tile--following")} aria-label={`${peer.name}'s participant tile`}>
          <div className="room-video__picture">
            <div className="room-video__placeholder"><Initials name={peer.name} /></div>
            {peer.stream && call.session && <RemoteVideo session={call.session} stream={peer.stream} />}
            {!peer.stream?.hasAudio && <span className="room-video__muted" title="Microphone off"><RiMicOffLine className="size-3" /></span>}
          </div>
          <div className="room-video__footer">
            <span className="truncate" title={peer.name}>{peer.name}</span>
            <Button size="icon-xs" variant={isFollowing ? "default" : "ghost"} disabled={!canFollow && !isFollowing} aria-pressed={isFollowing} aria-label={isFollowing ? `Stop following ${peer.name}` : `Follow ${peer.name}'s view`} title={isFollowing ? "Stop following" : canFollow ? "Follow their view" : "Waiting for their canvas"} onClick={() => {
              if (isFollowing) editor?.stopFollowingUser();
              else if (peer.canvasId) editor?.startFollowingUser(peer.canvasId);
            }}><RiEyeLine /></Button>
          </div>
        </article>;
      })}
    </div>
    <div className="room-video__status" role="status">{call.status}{call.status === "Call connected" && peers.length === 0 ? " · Waiting for colleagues" : ""}</div>
    {(call.error || controls.state.audio.error || controls.state.video.error) && <Alert className="pointer-events-auto max-w-md">
      <AlertDescription>{call.error || controls.state.video.error || controls.state.audio.error}</AlertDescription>
      {call.error && <Button size="xs" variant="outline" className="mt-2 justify-self-start" onClick={call.retry}>Retry call</Button>}
    </Alert>}
  </section>;
}
