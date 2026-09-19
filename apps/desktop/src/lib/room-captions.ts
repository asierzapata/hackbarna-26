import type OT from "@opentok/client";
import type { TranscriptInput } from "@kan/protocol";

export function subscribeToOwnCaptions(
  session: OT.Session,
  stream: OT.Stream,
  send: (caption: TranscriptInput | null) => void,
  onError: () => void,
  onReady: () => void = () => {},
) {
  let active = true;
  let destroyed = false;
  let id: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    id = undefined;
    send(null);
  };
  const subscriber = session.subscribe(stream, undefined, {
    subscribeToAudio: false,
    subscribeToVideo: false,
    subscribeToCaptions: true,
    audioVolume: 0,
    insertDefaultUI: false,
  }, (error) => { if (active) { if (error) onError(); else onReady(); } });
  subscriber.on("destroyed", () => {
    destroyed = true;
    if (!active) return;
    active = false;
    clear();
    onError();
  });
  subscriber.on("disconnected", () => { if (active) { clear(); onError(); } });
  subscriber.on("connected", () => { if (active) onReady(); });
  subscriber.on("captionReceived", (event) => {
    if (!active || event.streamId !== stream.streamId) return;
    const text = event.caption.trim().slice(0, 8000);
    if (!text) {
      if (event.isFinal) clear();
      return;
    }
    clearTimeout(timer);
    id ??= crypto.randomUUID();
    send({ id, text, isFinal: event.isFinal });
    if (event.isFinal) id = undefined;
    else timer = setTimeout(clear, 15_000);
  });
  return () => {
    active = false;
    clear();
    subscriber.off();
    if (!destroyed) session.unsubscribe(subscriber);
  };
}
