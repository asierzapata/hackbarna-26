import * as React from "react";
import type OT from "@opentok/client";
import { getRoomVideoToken, startRoomCaptions } from "@/lib/api-client";
import type { TranscriptInput } from "@kan/protocol";
import { subscribeToOwnCaptions } from "@/lib/room-captions";
import { videoIdentity } from "@/lib/room-media";

export interface VideoPeer {
  connectionId: string;
  userId: string | null;
  name: string;
  stream?: OT.Stream;
}

export function useRoomVideo(roomId: string, joined: boolean, audio: MediaStreamTrack | null, video: MediaStreamTrack | null, onCaption?: (caption: TranscriptInput | null) => void) {
  const [session, setSession] = React.useState<OT.Session | null>(null);
  const [peers, setPeers] = React.useState<VideoPeer[]>([]);
  const [status, setStatus] = React.useState("Connecting call…");
  const [error, setError] = React.useState<string | null>(null);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const sdk = React.useRef<typeof OT | null>(null);
  const sendCaption = React.useRef(onCaption);
  sendCaption.current = onCaption;
  const [captionAttempt, setCaptionAttempt] = React.useState(0);
  const [captionStartError, setCaptionStartError] = React.useState<string | null>(null);
  const [captionReceiveError, setCaptionReceiveError] = React.useState<string | null>(null);
  const [captionStatus, setCaptionStatus] = React.useState("Call transcript · Waiting for call");
  const [publication, setPublication] = React.useState<{ session: OT.Session; stream: OT.Stream } | null>(null);

  React.useEffect(() => {
    if (!session || !audio || publication?.session !== session) {
      setCaptionStatus(!session ? "Call transcript · Waiting for call" : !audio ? "Call transcript · Your microphone is off" : "Call transcript · Waiting for microphone");
      setCaptionStartError(null);
      return;
    }
    const abort = new AbortController();
    let starting = false;
    setCaptionStatus("Call transcript · Starting…");
    const start = async () => {
      if (starting) return;
      starting = true;
      try {
        await startRoomCaptions(roomId, abort.signal);
        if (!abort.signal.aborted) { setCaptionStartError(null); setCaptionStatus("Call transcript · Live"); }
      } catch {
        if (!abort.signal.aborted) { setCaptionStatus("Call transcript · Unavailable"); setCaptionStartError("Live transcription is unavailable. The call and chat still work."); }
      } finally { starting = false; }
    };
    void start();
    const timer = setInterval(() => void start(), 60_000);
    session.on("sessionReconnected", start);
    return () => { abort.abort(); clearInterval(timer); session.off("sessionReconnected", start); };
  }, [roomId, session, audio, publication, captionAttempt]);

  React.useEffect(() => {
    setCaptionReceiveError(null);
    if (!session || !audio || publication?.session !== session) return;
    let active = true;
    const failed = () => { if (active) setCaptionReceiveError("Your live transcript could not be received. Retry transcription."); };
    let stop: (() => void) | undefined;
    try {
      stop = subscribeToOwnCaptions(session, publication.stream, (caption) => sendCaption.current?.(caption), failed, () => { if (active) setCaptionReceiveError(null); });
    } catch { failed(); }
    return () => { active = false; stop?.(); };
  }, [session, audio, publication, captionAttempt]);

  React.useEffect(() => {
    if (!joined) return;
    const abort = new AbortController();
    let current: OT.Session | null = null;
    const active = () => !abort.signal.aborted;
    setPeers([]);
    setSession(null);
    setError(null);
    setStatus("Connecting call…");
    void (async () => {
      const [module, credentials] = await Promise.all([import("@opentok/client"), getRoomVideoToken(roomId, abort.signal)]);
      if (!active()) return;
      const client = module.default;
      sdk.current = client;
      if (!client.checkSystemRequirements()) throw new Error("Video calls are not supported in this webview. You can still use the canvas.");
      const next = client.initSession(credentials.applicationId, credentials.sessionId);
      current = next;
      const addPeer = (connection: OT.Connection, stream?: OT.Stream) => {
        if (!active() || connection.connectionId === next.connection?.connectionId) return;
        const identity = videoIdentity(connection.data);
        setPeers((previous) => {
          const existing = previous.find((peer) => peer.connectionId === connection.connectionId);
          const peer = { ...existing, connectionId: connection.connectionId, userId: identity.id, name: identity.name, ...(stream ? { stream } : {}) };
          return existing ? previous.map((value) => value.connectionId === peer.connectionId ? peer : value) : [...previous, peer];
        });
      };
      next.on("connectionCreated", (event) => addPeer(event.connection));
      next.on("connectionDestroyed", (event) => {
        if (active()) setPeers((previous) => previous.filter((peer) => peer.connectionId !== event.connection.connectionId));
      });
      next.on("streamCreated", (event) => addPeer(event.stream.connection, event.stream));
      next.on("streamDestroyed", (event) => {
        if (active()) setPeers((previous) => previous.map((peer) => peer.stream?.streamId === event.stream.streamId ? { ...peer, stream: undefined } : peer));
      });
      next.on("streamPropertyChanged", (event) => addPeer(event.stream.connection, event.stream));
      next.on("sessionReconnecting", () => { if (active()) setStatus("Reconnecting call…"); });
      next.on("sessionReconnected", () => { if (active()) setStatus("Call connected"); });
      next.on("sessionDisconnected", () => {
        if (!active()) return;
        setSession(null);
        setPeers([]);
        setStatus("Call disconnected");
        setError("The call disconnected. Your canvas is still available. Retry to reconnect.");
      });
      await next.connect.promise(credentials.token);
      if (!active()) { void next.disconnect(); return; }
      setSession(next);
      setStatus("Call connected");
    })().catch((cause: unknown) => {
      if (!active()) return;
      current?.off();
      current?.disconnect();
      setStatus("Call unavailable");
      setError(cause instanceof Error ? cause.message : "Could not connect to the call. Check your connection and retry.");
    });
    return () => {
      abort.abort();
      current?.off();
      current?.disconnect();
    };
  }, [roomId, joined, attempt]);

  React.useEffect(() => {
    setPublishError(null);
    setPublication(null);
    if (!session || !sdk.current || (!audio && !video)) return;
    let active = true;
    let publisher: OT.Publisher | undefined;
    const audioCopy = audio?.clone() ?? null;
    const videoCopy = video?.clone() ?? null;
    const failed = () => {
      if (active) setPublishError("Your media could not be shared. Turn your devices off and on, or retry the call.");
    };
    try {
      publisher = sdk.current.initPublisher(undefined, {
        insertDefaultUI: false,
        audioSource: audioCopy,
        videoSource: videoCopy,
        publishAudio: !!audioCopy,
        publishVideo: !!videoCopy,
        publishCaptions: !!audioCopy,
      }, (failure) => {
        if (!active) return;
        if (failure || !publisher) { failed(); return; }
        void session.publish.promise(publisher).catch(failed);
      });
      publisher.on("streamCreated", ({ stream }) => { if (active) setPublication({ session, stream }); });
      publisher.on("streamDestroyed", () => { if (active) setPublication(null); });
    } catch { failed(); }
    return () => {
      active = false;
      publisher?.destroy();
      audioCopy?.stop();
      videoCopy?.stop();
    };
  }, [session, audio, video]);

  const captionError = captionStartError ?? captionReceiveError;
  return { session, peers, status, error: error ?? publishError, retry: () => setAttempt((value) => value + 1), transcription: { status: captionError ? "Call transcript · Unavailable" : captionStatus, error: captionError, retry: () => setCaptionAttempt((value) => value + 1) } };
}

export type RoomVideo = ReturnType<typeof useRoomVideo>;
