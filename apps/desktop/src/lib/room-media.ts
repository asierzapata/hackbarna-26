export type MediaKind = "audio" | "video";
export interface DeviceState {
  track: MediaStreamTrack | null;
  pending: boolean;
  deviceId: string;
  error: string | null;
}

function emptyDevice(): DeviceState {
  return { track: null, pending: false, deviceId: "", error: null };
}

export class LocalMedia {
  private state = { audio: emptyDevice(), video: emptyDevice() };
  private versions = { audio: 0, video: 0 };
  private listeners = new Set<() => void>();

  constructor(private capture: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(kind: MediaKind, value: Partial<DeviceState>) {
    this.state = { ...this.state, [kind]: { ...this.state[kind], ...value } };
    for (const listener of this.listeners) listener();
  }

  async enable(kind: MediaKind, enabled: boolean, deviceId = this.state[kind].deviceId) {
    const version = ++this.versions[kind];
    this.state[kind].track?.stop();
    this.update(kind, { track: null, pending: enabled, deviceId, error: null });
    if (!enabled) return;
    try {
      const constraints: MediaTrackConstraints = {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        ...(kind === "audio" ? { echoCancellation: true, noiseSuppression: true } : {}),
      };
      const stream = await this.capture({ audio: kind === "audio" ? constraints : false, video: kind === "video" ? constraints : false });
      if (this.versions[kind] !== version) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const [track] = stream.getTracks();
      if (!track) throw new DOMException("No device", "NotFoundError");
      track.addEventListener("ended", () => {
        if (this.versions[kind] === version) this.update(kind, { track: null, error: `${kind === "video" ? "Camera" : "Microphone"} disconnected. Choose a device and try again.` });
      }, { once: true });
      this.update(kind, { track, pending: false });
    } catch (error) {
      if (this.versions[kind] !== version) return;
      const name = error instanceof Error ? error.name : "";
      const device = kind === "video" ? "Camera" : "Microphone";
      const message = name === "NotAllowedError" || name === "SecurityError"
        ? `${device} permission is blocked. Allow access in your system or browser settings, then try again.`
        : name === "NotFoundError" || name === "OverconstrainedError"
          ? `${device} not found. Connect a device or choose another input.`
          : `${device} could not start. Check that another app is not using it, then try again.`;
      this.update(kind, { pending: false, error: message });
    }
  }

  dispose() {
    void this.enable("audio", false);
    void this.enable("video", false);
  }
}

export function videoIdentity(data: string): { id: string | null; name: string } {
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === "object" && "id" in value && "name" in value
      && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128
      && typeof value.name === "string" && value.name.trim().length > 0) {
      return { id: value.id, name: value.name.trim().slice(0, 80) };
    }
  } catch {}
  return { id: null, name: "Colleague" };
}
