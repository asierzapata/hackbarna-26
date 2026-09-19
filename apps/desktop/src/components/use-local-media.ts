import * as React from "react";
import { LocalMedia } from "@/lib/room-media";

export function useLocalMedia() {
  const [media] = React.useState(() => new LocalMedia((constraints) => {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("Media capture unavailable"));
    return navigator.mediaDevices.getUserMedia(constraints);
  }));
  const state = React.useSyncExternalStore(media.subscribe, media.getSnapshot);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);

  React.useEffect(() => {
    void media.enable("video", true);
    void media.enable("audio", true);
    return () => media.dispose();
  }, [media]);

  React.useEffect(() => {
    let active = true;
    const refresh = () => {
      void navigator.mediaDevices?.enumerateDevices().then((next) => {
        if (active) setDevices(next.filter((device) => device.deviceId));
      }).catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, [state.audio.track, state.video.track]);

  return { media, state, devices };
}

export type LocalMediaControls = ReturnType<typeof useLocalMedia>;

export function useMicrophoneLevel(track: MediaStreamTrack | null) {
  const [level, setLevel] = React.useState(0);
  React.useEffect(() => {
    setLevel(0);
    if (!track) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    void context.resume().catch(() => {});
    const samples = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(100, Math.round(rms * 500)));
    }, 100);
    const resume = () => { void context.resume().catch(() => {}); };
    window.addEventListener("pointerdown", resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", resume);
      source.disconnect();
      void context.close().catch(() => {});
    };
  }, [track]);
  return level;
}
