// Load the same decoder for video frames and photos, including on browsers
// without a native QR detector. The script is served by the application.
let decoderRequest;
function loadDecoder() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!decoderRequest) {
    decoderRequest = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/jsQR.js';
      script.onload = () => {
        script.remove();
        if (window.jsQR) resolve(window.jsQR);
        else reject(new Error('QR decoder unavailable'));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('QR decoder unavailable'));
      };
      document.head.append(script);
    }).catch(error => {
      decoderRequest = undefined;
      throw error;
    });
  }
  return decoderRequest;
}

function cameraError(error) {
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'เปิดกล้องไม่ได้ กรุณาอนุญาตให้เว็บใช้กล้องในเบราว์เซอร์ หรือเลือกภาพ QR';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'ไม่พบกล้องบนอุปกรณ์นี้ เลือกภาพ QR จากเครื่องได้';
    case 'NotReadableError':
    case 'AbortError':
      return 'กล้องยังไม่พร้อม ปิดแอปที่กำลังใช้กล้องแล้วลองอีกครั้ง หรือเลือกภาพ QR';
    default:
      return 'เปิดเครื่องสแกนไม่ได้ กรุณาลองอีกครั้ง หรือเลือกภาพ QR';
  }
}

export function mountScanner(root, { onScan }) {
  const video = root.querySelector('#scannerVideo');
  const guide = root.querySelector('.scanner-frame');
  const status = root.querySelector('#scannerStatus');
  const startButton = root.querySelector('#scannerStart');
  const stopButton = root.querySelector('#scannerStop');
  const fileInput = root.querySelector('#scannerFile');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const listeners = new AbortController();
  const events = { signal: listeners.signal };
  let generation = 0;
  let stream = null;
  let timer;
  let destroyed = false;

  function display(state, message) {
    root.dataset.scannerState = state;
    if (status.textContent !== message) status.textContent = message;
    const busy = ['requesting', 'scanning', 'image'].includes(state);
    startButton.hidden = busy;
    stopButton.hidden = !busy;
  }

  // A permission prompt or file decode can finish after the user leaves.
  // Invalidate that work before releasing any live media resources.
  function release() {
    generation++;
    clearTimeout(timer);
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    video.pause();
    video.srcObject = null;
    return generation;
  }

  function stop() {
    release();
    display('idle', 'กดเปิดกล้อง หรือเลือกภาพ QR ของผู้ป่วย');
  }

  function decodeFrame(decoder, source, width, height, maxSide, left = 0, top = 0) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    context.drawImage(source, left, top, width, height, 0, 0, w, h);
    const frame = context.getImageData(0, 0, w, h);
    return decoder(frame.data, w, h, { inversionAttempts: 'dontInvert' })?.data;
  }

  function decodeCameraFrame(decoder) {
    const viewport = video.getBoundingClientRect();
    const frame = guide.getBoundingClientRect();
    if (!viewport.width || !viewport.height) return;
    // With centered object-fit: cover, part of the camera frame may be off-screen.
    // Map just the visible guide back into camera pixels so nearby cards cannot win.
    const scale = Math.max(viewport.width / video.videoWidth, viewport.height / video.videoHeight);
    const originX = viewport.left + (viewport.width - video.videoWidth * scale) / 2;
    const originY = viewport.top + (viewport.height - video.videoHeight * scale) / 2;
    const left = Math.max(frame.left, viewport.left);
    const top = Math.max(frame.top, viewport.top);
    const width = Math.round((Math.min(frame.right, viewport.right) - left) / scale);
    const height = Math.round((Math.min(frame.bottom, viewport.bottom) - top) / scale);
    if (width <= 0 || height <= 0) return;
    return decodeFrame(decoder, video, width, height, 960,
      Math.round((left - originX) / scale), Math.round((top - originY) / scale));
  }

  function fail(id, message) {
    if (id !== generation) return;
    release();
    display('error', message);
  }

  function openCode(id, value) {
    if (!onScan(value)) return false;
    if (id === generation) {
      release();
      display('idle', 'อ่านบัตรแล้ว กำลังเปิดแฟ้มผู้ป่วย');
    }
    return true;
  }

  async function start() {
    if (destroyed) return;
    const id = release();
    if (!window.isSecureContext)
      return fail(id, 'ต้องเปิดเว็บผ่าน HTTPS หรือ localhost เพื่อใช้กล้อง หรือเลือกภาพ QR จากเครื่อง');
    if (!navigator.mediaDevices?.getUserMedia)
      return fail(id, 'เบราว์เซอร์นี้เปิดกล้องไม่ได้ เลือกภาพ QR จากเครื่องได้');
    display('requesting', 'กำลังขอใช้กล้อง…');
    try {
      const camera = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (id !== generation) {
        camera.getTracks().forEach(track => track.stop());
        return;
      }
      stream = camera;
      camera.getVideoTracks().forEach(track => {
        track.addEventListener('ended', () => fail(id, 'กล้องหยุดทำงาน กดเปิดกล้องเพื่อลองใหม่'), { once: true });
      });
      video.muted = true;
      video.playsInline = true;
      video.srcObject = camera;
      await video.play();
      if (id !== generation) return;
      const decoder = await loadDecoder();
      if (id !== generation) return;
      display('scanning', 'จัด QR ของผู้ป่วยหนึ่งใบให้อยู่ในกรอบ');
      let lastRejected = null;
      function tick() {
        if (id !== generation) return;
        try {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
            const value = decodeCameraFrame(decoder);
            if (value && value !== lastRejected) {
              if (openCode(id, value)) return;
              lastRejected = value;
              display('scanning', 'รหัสนี้ใช้เปิดแฟ้มไม่ได้ กรุณาสแกน QR บนบัตรผู้ป่วย ThaiSim');
            }
          }
          timer = setTimeout(tick, 180);
        } catch {
          fail(id, 'อ่านภาพจากกล้องไม่ได้ กรุณาลองอีกครั้ง หรือเลือกภาพ QR');
        }
      }
      tick();
    } catch (error) {
      fail(id, cameraError(error));
    }
  }

  async function scanFile() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || destroyed) return;
    const id = release();
    display('image', 'กำลังอ่าน QR จากภาพ…');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
      image.src = url;
      const [decoder] = await Promise.all([loadDecoder(), loaded]);
      if (id !== generation) return;
      const value = decodeFrame(decoder, image, image.naturalWidth, image.naturalHeight, 1920);
      if (!value) return fail(id, 'ไม่พบ QR ในภาพ ลองเลือกภาพที่เห็น QR ชัดเจนทั้งบัตร');
      if (!openCode(id, value)) fail(id, 'QR ในภาพนี้ใช้เปิดแฟ้มไม่ได้ กรุณาเลือกภาพบัตรผู้ป่วย ThaiSim');
    } catch {
      fail(id, 'อ่านภาพไม่ได้ กรุณาลองใหม่ด้วยภาพ QR ชนิด JPG หรือ PNG');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  startButton.addEventListener('click', start, events);
  stopButton.addEventListener('click', stop, events);
  fileInput?.addEventListener('change', scanFile, events);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); }, events);
  window.addEventListener('pagehide', stop, events);
  display('idle', 'กดเปิดกล้อง หรือเลือกภาพ QR ของผู้ป่วย');
  return {
    start,
    stop,
    destroy() {
      destroyed = true;
      listeners.abort();
      stop();
    },
  };
}
