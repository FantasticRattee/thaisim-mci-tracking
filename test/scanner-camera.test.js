import test from 'node:test';
import assert from 'node:assert/strict';
import { mountScanner } from '../public/scanner.js';

function camera() {
  const track = new EventTarget();
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function fixture(t, { getUserMedia, onScan = () => true, decode = () => null }) {
  const elements = Object.fromEntries(
    ['scannerVideo', 'scannerStatus', 'scannerStart', 'scannerStop', 'scannerFile']
      .map(id => [id, new EventTarget()]),
  );
  const video = elements.scannerVideo;
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  elements['scanner-frame'] = { getBoundingClientRect: () => rect(200, 150, 200, 200) };
  const frames = [];
  Object.assign(video, {
    play: async () => {},
    pause: () => {},
    getBoundingClientRect: () => rect(100, 50, 400, 400),
    videoWidth: 1920,
    videoHeight: 1080,
    readyState: 4,
  });
  const envWindow = Object.assign(new EventTarget(), { isSecureContext: true, jsQR: decode });
  const envDocument = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({
      getContext: () => ({ drawImage: (...args) => frames.push(args), getImageData: () => ({ data: [] }) }),
    }),
  });
  for (const [key, value] of Object.entries({
    window: envWindow,
    document: envDocument,
    navigator: { mediaDevices: { getUserMedia } },
  })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  const root = { dataset: {}, querySelector: selector => elements[selector.slice(1)] };
  const scanner = mountScanner(root, { onScan });
  t.after(() => scanner.destroy());
  return { scanner, root, elements, video, envDocument, frames };
}

test('leaving the scan view while permission is pending releases a late camera', async t => {
  let grantPermission;
  const pending = new Promise(resolve => { grantPermission = resolve; });
  const stream = camera();
  const { root, scanner, video } = fixture(t, { getUserMedia: () => pending });
  assert.equal(root.dataset.scannerState, 'idle');
  const opened = scanner.start();
  assert.equal(root.dataset.scannerState, 'requesting');
  scanner.destroy();
  grantPermission(stream);
  await opened;
  assert.equal(stream.track.stopped, true);
  assert.equal(video.srcObject, null);
  assert.equal(root.dataset.scannerState, 'idle');
});

test('denied camera can be retried and an accepted card stops the stream', async t => {
  let attempts = 0;
  const stream = camera();
  const values = [];
  const { scanner, root, elements } = fixture(t, {
    getUserMedia: async options => {
      assert.equal(options.audio, false);
      assert.equal(options.video.facingMode.ideal, 'environment');
      if (++attempts === 1) throw new DOMException('permission denied', 'NotAllowedError');
      return stream;
    },
    onScan: value => { values.push(value); return true; },
    decode: (_data, width, height) => {
      assert.equal(width, 540);
      assert.equal(height, 540);
      return { data: 'patient-link' };
    },
  });
  await scanner.start();
  assert.equal(root.dataset.scannerState, 'error');
  assert.match(elements.scannerStatus.textContent, /อนุญาต/);
  assert.equal(elements.scannerStart.hidden, false);
  await scanner.start();
  assert.deepEqual(values, ['patient-link']);
  assert.equal(stream.track.stopped, true);
  assert.equal(root.dataset.scannerState, 'idle');
});

test('foreign QR leaves the camera scanning; hiding the page turns it off', async t => {
  const stream = camera();
  const { scanner, root, envDocument, video, elements } = fixture(t, {
    getUserMedia: async () => stream,
    onScan: () => false,
    decode: () => ({ data: 'other-link' }),
  });
  await scanner.start();
  assert.equal(root.dataset.scannerState, 'scanning');
  assert.match(elements.scannerStatus.textContent, /บัตรผู้ป่วย/);
  assert.equal(video.srcObject, stream);
  envDocument.hidden = true;
  envDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(stream.track.stopped, true);
  assert.equal(video.srcObject, null);
  assert.equal(root.dataset.scannerState, 'idle');
});

test('only the aiming frame is decoded when camera and preview aspect ratios differ', async t => {
  const { scanner, video, frames } = fixture(t, { getUserMedia: async () => camera() });
  await scanner.start();
  scanner.stop();
  // 16:9 input covers a square preview: 420 pixels are clipped on each horizontal edge.
  assert.deepEqual(frames[0], [video, 690, 270, 540, 540, 0, 0, 540, 540]);
  video.videoWidth = 1080;
  video.videoHeight = 1920;
  await scanner.start();
  scanner.stop();
  // A portrait camera in the same preview crops on the vertical axis instead.
  assert.deepEqual(frames[1], [video, 270, 690, 540, 540, 0, 0, 540, 540]);
});
