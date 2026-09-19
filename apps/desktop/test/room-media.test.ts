import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMedia, videoIdentity } from "../src/lib/room-media";

function track() {
  return { stopped: false, stop() { this.stopped = true; }, addEventListener() {} } as unknown as MediaStreamTrack & { stopped: boolean };
}
function stream(value: MediaStreamTrack) {
  return { getTracks: () => [value] } as MediaStream;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("preview requests only the selected device, and disabling releases it", async () => {
  const camera = track();
  const requests: MediaStreamConstraints[] = [];
  const media = new LocalMedia(async (constraints) => { requests.push(constraints); return stream(camera); });
  await media.enable("video", true, "camera-2");
  assert.deepEqual(requests, [{ video: { deviceId: { exact: "camera-2" } }, audio: false }]);
  assert.equal(media.getSnapshot().video.track, camera);
  await media.enable("video", false);
  assert.equal(camera.stopped, true);
  assert.equal(media.getSnapshot().video.track, null);
});

test("permission results arriving after cancel cannot reactivate capture", async () => {
  const request = deferred<MediaStream>();
  const camera = track();
  const media = new LocalMedia(() => request.promise);
  const opening = media.enable("video", true);
  media.dispose();
  request.resolve(stream(camera));
  await opening;
  assert.equal(camera.stopped, true);
  assert.equal(media.getSnapshot().video.track, null);
});

test("device changes discard out-of-order results without stopping the new device", async () => {
  const first = deferred<MediaStream>();
  const oldTrack = track();
  const newTrack = track();
  let calls = 0;
  const media = new LocalMedia(() => ++calls === 1 ? first.promise : Promise.resolve(stream(newTrack)));
  const opening = media.enable("video", true, "first");
  await media.enable("video", true, "second");
  first.resolve(stream(oldTrack));
  await opening;
  assert.equal(oldTrack.stopped, true);
  assert.equal(newTrack.stopped, false);
  assert.equal(media.getSnapshot().video.track, newTrack);
  media.dispose();
  assert.equal(newTrack.stopped, true);
});

test("camera denial does not disable the microphone and can be retried", async () => {
  const mic = track();
  let denied = true;
  const media = new LocalMedia(async (constraints) => {
    if (constraints.video && denied) throw new DOMException("denied", "NotAllowedError");
    return stream(mic);
  });
  await Promise.all([media.enable("video", true), media.enable("audio", true)]);
  assert.match(media.getSnapshot().video.error ?? "", /permission/i);
  assert.equal(media.getSnapshot().video.pending, false);
  assert.equal(media.getSnapshot().audio.track, mic);
  denied = false;
  await media.enable("video", true);
  assert.equal(media.getSnapshot().video.error, null);
  media.dispose();
});

test("video identity accepts server identity but handles invalid connection data", () => {
  assert.deepEqual(videoIdentity('{"id":"person-1","name":"Alice"}'), { id: "person-1", name: "Alice" });
  for (const data of ["", "not json", "null", '{"id":23,"name":[]}', '{"id":"","name":""}']) {
    assert.deepEqual(videoIdentity(data), { id: null, name: "Colleague" });
  }
});
