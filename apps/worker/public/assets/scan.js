// Camera decode spike (plan M7, E8). Decodes the same camera frames with the browser's
// BarcodeDetector (where it exists) and with zxing-wasm, times each, and saves every attempt
// with the device details to /scan-test/results.

const root = document.getElementById('scan');
const wasmBase = root.dataset.wasm;
const $ = (selector) => root.querySelector(selector);
const statusLine = $('[data-status]');
const video = $('video');

const TARGETS = {
  'ean-13': { text: '4006381333931', native: 'ean_13', zxing: 'EAN13' },
  'upc-a': { text: '036000291452', native: 'upc_a', zxing: 'UPCA' },
  'code-128': { text: 'AIRSTOCK-0042', native: 'code_128', zxing: 'Code128' },
  qr: {
    text: 'https://airstock.deletecookies.dev/i/AIR-MUG-01',
    native: 'qr_code',
    zxing: 'QRCode',
  },
};
const NATIVE_FORMATS = ['ean_13', 'upc_a', 'code_128', 'qr_code'];
const ZXING_FORMATS = ['EAN13', 'UPCA', 'Code128', 'QRCode'];
const TIMEOUT_MS = 10_000;
const MAX_WIDTH = 1280;

const device = {
  userAgent: navigator.userAgent,
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
  nativeAvailable: 'BarcodeDetector' in window,
  nativeFormats: [],
  cameraPermissionBefore: null,
  camera: null,
  zxing: null,
};

let stream = null;
let nativeDetector = null;
let zxingReady = null;

function show() {
  $('[data-device]').textContent = JSON.stringify(device, null, 2);
}

/** EAN-13 readers often report a UPC-A code with a leading zero. */
function matches(expected, text) {
  return text === expected || text === `0${expected}` || `0${text}` === expected;
}

async function loadZxing() {
  const started = performance.now();
  await ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmBase + path : prefix + path),
    },
    fireImmediately: true,
  });
  const entry = performance
    .getEntriesByType('resource')
    .find((e) => e.name.endsWith('zxing_reader.wasm'));
  device.zxing = {
    version: '3.1.6',
    loadMs: Math.round(performance.now() - started),
    wasmBytes: entry ? entry.encodedBodySize || entry.transferSize || null : null,
  };
  show();
}

async function setup() {
  try {
    const state = await navigator.permissions?.query({ name: 'camera' });
    device.cameraPermissionBefore = state?.state ?? null;
  } catch {
    device.cameraPermissionBefore = 'unsupported';
  }
  if (device.nativeAvailable) {
    try {
      device.nativeFormats = await BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => device.nativeFormats.includes(f));
      if (formats.length) nativeDetector = new BarcodeDetector({ formats });
    } catch (error) {
      device.nativeFormats = [`error: ${error.message}`];
    }
  }
  zxingReady = loadZxing().catch((error) => {
    device.zxing = { error: String(error) };
    show();
  });
  show();
}

async function openCamera() {
  if (stream) return;
  const started = performance.now();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = stream;
  await video.play();
  const settings = stream.getVideoTracks()[0].getSettings();
  device.camera = {
    // Long when the browser asked for permission; short when it was already granted.
    openMs: Math.round(performance.now() - started),
    width: settings.width,
    height: settings.height,
    facingMode: settings.facingMode ?? null,
  };
  show();
}

function frameCanvas() {
  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  return canvas;
}

async function decodeNative(canvas) {
  const found = await nativeDetector.detect(canvas);
  return found[0] ? { text: found[0].rawValue, format: found[0].format } : null;
}

async function decodeZxing(ctx, canvas) {
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const found = await ZXingWASM.readBarcodes(image, {
    formats: ZXING_FORMATS,
    tryHarder: true,
    maxNumberOfSymbols: 1,
  });
  return found[0] ? { text: found[0].text, format: found[0].format } : null;
}

async function scan() {
  const form = Object.fromEntries(
    ['target', 'decoder', 'distance', 'light'].map((n) => [n, $(`[name=${n}]`).value]),
  );
  const target = TARGETS[form.target];
  const decoders = form.decoder === 'both' ? ['native', 'zxing'] : [form.decoder];
  const button = $('[data-action=scan]');
  button.disabled = true;
  try {
    await openCamera();
    if (decoders.includes('zxing')) await zxingReady;
    const runs = {};
    for (const d of decoders) {
      runs[d] = {
        available: d === 'native' ? Boolean(nativeDetector) : Boolean(device.zxing?.loadMs),
        frames: 0,
        busyMs: 0,
        result: null,
        ms: null,
      };
    }
    const canvas = frameCanvas();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const started = performance.now();
    statusLine.textContent = 'Scanning…';
    while (performance.now() - started < TIMEOUT_MS) {
      const pending = decoders.filter((d) => runs[d].available && !runs[d].result);
      if (pending.length === 0) break;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const d of pending) {
        const t = performance.now();
        const result = d === 'native' ? await decodeNative(canvas) : await decodeZxing(ctx, canvas);
        runs[d].frames++;
        runs[d].busyMs += performance.now() - t;
        if (result) {
          runs[d].result = result;
          runs[d].ms = Math.round(performance.now() - started);
        }
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    const attempts = decoders.map((d) => {
      const run = runs[d];
      return {
        at: new Date().toISOString(),
        target: form.target,
        decoder: d,
        distance: form.distance,
        light: form.light,
        available: run.available,
        success: Boolean(run.result),
        correct: run.result ? matches(target.text, run.result.text) : false,
        ms: run.ms,
        text: run.result?.text ?? null,
        format: run.result?.format ?? null,
        frames: run.frames,
        avgFrameMs: run.frames ? Math.round(run.busyMs / run.frames) : null,
      };
    });
    record(attempts);
    statusLine.textContent = attempts
      .map((a) =>
        !a.available
          ? `${a.decoder}: not available`
          : a.success
            ? `${a.decoder}: ${a.correct ? 'read' : 'WRONG'} in ${a.ms} ms`
            : `${a.decoder}: nothing in 10 s`,
      )
      .join(' · ');
  } catch (error) {
    statusLine.textContent = `Camera error: ${error.name}: ${error.message}`;
    record([
      {
        at: new Date().toISOString(),
        target: form.target,
        decoder: 'camera',
        error: `${error.name}: ${error.message}`,
      },
    ]);
  } finally {
    button.disabled = false;
  }
}

function record(attempts) {
  const tbody = $('[data-results]');
  for (const a of attempts) {
    const row = document.createElement('tr');
    const cells = [
      a.target,
      a.decoder,
      [a.distance, a.light].filter(Boolean).join(', '),
      a.error ??
        (!a.available ? 'n/a' : a.success ? (a.correct ? 'read' : `wrong: ${a.text}`) : 'missed'),
      a.ms === null || a.ms === undefined ? '' : `${a.ms} ms`,
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      row.append(td);
    }
    tbody.prepend(row);
  }
  fetch('/scan-test/results', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-airstock-request': '1' },
    body: JSON.stringify({ device, attempts }),
  }).catch(() => {});
}

// A keyboard-wedge scanner types the code and presses Enter.
let wedgeStarted = null;
$('[name=wedge]').addEventListener('keydown', (event) => {
  if (wedgeStarted === null) wedgeStarted = performance.now();
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const text = event.target.value.trim();
  const target = Object.entries(TARGETS).find(([, t]) => matches(t.text, text));
  record([
    {
      at: new Date().toISOString(),
      target: target ? target[0] : 'unknown',
      decoder: 'wedge',
      available: true,
      success: Boolean(text),
      correct: Boolean(target),
      ms: Math.round(performance.now() - wedgeStarted),
      text,
    },
  ]);
  event.target.value = '';
  wedgeStarted = null;
});

$('[data-action=scan]').addEventListener('click', scan);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setup();
