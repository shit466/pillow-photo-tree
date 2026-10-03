import { createGestureInterpreter } from './gesture-math.js';

const TOUCH_FALLBACK = '没关系，也可以用手指控制。';
const noop = () => {};
const cancellationError = () => new DOMException('Hand tracking canceled', 'AbortError');

function modelPaths() {
  const base = import.meta.env.BASE_URL || '/';
  return {
    wasm: new URL(`${base}mediapipe/wasm`, document.baseURI).href,
    model: new URL(`${base}mediapipe/hand_landmarker.task`, document.baseURI).href,
  };
}

function assertNotCanceled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function createMainEngine(paths, signal) {
  assertNotCanceled(signal);
  // Lazy import: Three.js and touch controls never wait for MediaPipe.
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
  assertNotCanceled(signal);
  const files = await FilesetResolver.forVisionTasks(paths.wasm);
  // Abortable model fetch prevents a canceled startup from downloading and retaining
  // the model. The WASM API itself is not abortable; any late task is closed below.
  const response = await fetch(paths.model, { signal });
  if (!response.ok) throw new Error(`Hand model unavailable (${response.status})`);
  const model = new Uint8Array(await response.arrayBuffer());
  assertNotCanceled(signal);
  const task = await HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.62,
    minHandPresenceConfidence: 0.62,
    minTrackingConfidence: 0.65,
  });
  if (signal?.aborted) {
    try { task.close(); } catch { /* A lost browser context may already be closed. */ }
    throw cancellationError();
  }
  let closed = false;
  return {
    backend: 'main-thread',
    async detect(video, timestamp) {
      const started = performance.now();
      const result = task.detectForVideo(video, timestamp);
      return { landmarks: result.landmarks, inferenceMs: performance.now() - started };
    },
    destroy() {
      if (closed) return;
      closed = true;
      try { task.close(); } catch { /* Browser context teardown already frees WASM. */ }
    },
  };
}

function createWorkerEngine(paths, signal) {
  return new Promise((resolve, reject) => {
    assertNotCanceled(signal);
    // 0.10.x ships classic WASM loaders. Vite emits a self-contained IIFE worker for
    // production; its classic context allows MediaPipe's importScripts(). During
    // development Vite serves ESM workers and the compatible main-thread path is used.
    const worker = import.meta.env.DEV
      ? new Worker(new URL('./gesture-worker.js', import.meta.url), { type: 'module' })
      : new Worker(new URL('./gesture-worker.js', import.meta.url));
    let initialized = false;
    let disposed = false;
    let pending = null;
    let nextId = 0;
    const startupTimer = setTimeout(() => fail(new Error('Hand worker startup timed out')), 16000);

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(startupTimer);
      signal?.removeEventListener('abort', dispose);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(cancellationError());
        pending = null;
      }
      // Termination releases both in-flight network work and the worker's WASM heap.
      try { worker.postMessage({ type: 'dispose' }); }
      catch { /* The worker may already have failed. */ }
      finally { worker.terminate(); }
      if (!initialized) reject(cancellationError());
    }
    signal?.addEventListener('abort', dispose, { once: true });

    function fail(error) {
      clearTimeout(startupTimer);
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        pending = null;
      }
      if (!initialized) {
        signal?.removeEventListener('abort', dispose);
        worker.terminate();
        disposed = true;
        reject(error);
      }
    }

    worker.onmessage = ({ data }) => {
      if (data.type === 'error') return fail(new Error(data.message));
      if (data.type === 'ready') {
        clearTimeout(startupTimer);
        initialized = true;
        resolve({
          backend: 'worker',
          async detect(source, timestamp) {
            if (disposed || pending) throw new Error('Hand worker is busy or closed');
            // At most one bounded, ephemeral frame can be in flight.
            const sourceWidth = source.videoWidth || source.width;
            const sourceHeight = source.videoHeight || source.height;
            if (!sourceWidth || !sourceHeight) throw new Error('Hand frame is empty');
            const width = Math.min(sourceWidth, 640);
            const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
            const bitmap = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
            if (disposed) {
              bitmap.close();
              throw new Error('Hand worker is closed');
            }
            const id = ++nextId;
            return new Promise((frameResolve, frameReject) => {
              pending = {
                id, resolve: frameResolve, reject: frameReject,
                timer: setTimeout(() => fail(new Error('Hand worker response timed out')), 2500),
              };
              try {
                worker.postMessage({ type: 'frame', id, bitmap, timestamp }, [bitmap]);
              } catch (error) {
                bitmap.close();
                fail(error);
              }
            });
          },
          destroy: dispose,
        });
      } else if (data.type === 'result' && pending?.id === data.id) {
        clearTimeout(pending.timer);
        const complete = pending.resolve;
        pending = null;
        complete(data);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message || 'Hand worker unavailable'));
    };
    worker.postMessage({ type: 'init', wasmPath: paths.wasm, modelPath: paths.model });
  });
}

/** Debug-only asset / Worker check. Uses a synthetic blank canvas; no camera access. */
export async function probeHandWorker() {
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') throw new Error('Hand Worker unsupported');
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  let engine = null;
  try {
    engine = await createWorkerEngine(modelPaths());
    const result = await engine.detect(canvas, performance.now());
    return { backend: engine.backend, handCount: result.landmarks.length, inferenceMs: result.inferenceMs };
  } finally {
    engine?.destroy();
    canvas.width = canvas.height = 1;
  }
}

/**
 * All camera use starts inside start(). Frames are never uploaded, recorded or stored.
 * x/y callbacks are mirrored viewport coordinates in 0..1. onScale receives a target
 * absolute scale; onRotate supplies signed radians/second for the scene's inertia.
 */
export function createHandController(options = {}) {
  const onStatus = options.onStatus || noop;
  const onQuality = options.onQuality || noop;
  const interpreter = createGestureInterpreter(options);
  const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
  const lowerPerformance = (navigator.hardwareConcurrency || 4) <= 4 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const initialFps = lowerPerformance ? 15 : isMobile ? 18 : 24;
  const metrics = { inferenceMs: 0, fps: 0, targetFps: initialFps, backend: 'none', handCount: 0, lastGesture: 'none', error: null };
  const paths = modelPaths();
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  // Safari needs a live inline video element; its contents are never presented as UI.
  video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
  let stream = null;
  let engine = null;
  let sessionAbort = null;
  let desired = false;
  let active = false;
  let destroyed = false;
  let generation = 0;
  let pendingStart = null;
  let timer = null;
  let lastVideoTime = -1;
  let lastCompletedAt = 0;
  let errors = 0;

  function closeSession({ keepDesired = false, status = 'idle' } = {}) {
    generation += 1;
    active = false;
    sessionAbort?.abort();
    sessionAbort = null;
    if (!keepDesired) desired = false;
    pendingStart = null;
    clearTimeout(timer);
    timer = null;
    interpreter.reset();
    stopTracks(stream);
    stream = null;
    video.pause();
    video.srcObject = null;
    engine?.destroy();
    engine = null;
    metrics.handCount = 0;
    metrics.fps = 0;
    metrics.backend = 'none';
    if (!destroyed && status) onStatus({ state: status, message: status === 'paused' ? '已暂停手势控制' : '触控模式' });
  }

  function fail(error) {
    metrics.error = error?.name || error?.message || 'Camera unavailable';
    closeSession({ status: null });
    if (!destroyed) onStatus({ state: 'error', message: TOUCH_FALLBACK });
  }

  async function makeEngine(signal) {
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
      try { return await createWorkerEngine(paths, signal); }
      catch (error) {
        assertNotCanceled(signal);
        metrics.error = `Worker fallback: ${error.message}`;
      }
    }
    metrics.targetFps = 15;
    return createMainEngine(paths, signal);
  }

  function schedule(token, delay) {
    if (!active || !desired || destroyed || document.hidden || token !== generation) return;
    clearTimeout(timer);
    timer = setTimeout(() => infer(token), Math.max(4, delay));
  }

  async function infer(token) {
    if (!active || !desired || destroyed || document.hidden || token !== generation) return;
    const started = performance.now();
    const interval = 1000 / metrics.targetFps;
    if (video.readyState < 2 || video.videoWidth === 0 || video.currentTime === lastVideoTime) {
      schedule(token, interval);
      return;
    }
    lastVideoTime = video.currentTime;
    const currentEngine = engine;
    try {
      const result = await currentEngine.detect(video, started);
      if (token !== generation || destroyed || !active) return;
      errors = 0;
      metrics.inferenceMs = metrics.inferenceMs ? metrics.inferenceMs * 0.85 + result.inferenceMs * 0.15 : result.inferenceMs;
      metrics.handCount = result.landmarks.length;
      metrics.targetFps = currentEngine.backend === 'main-thread' || metrics.inferenceMs > 36 ? 15 : initialFps;
      const completed = performance.now();
      metrics.fps = lastCompletedAt ? metrics.fps * 0.8 + (1000 / (completed - lastCompletedAt)) * 0.2 : metrics.targetFps;
      lastCompletedAt = completed;
      interpreter.process(result.landmarks, completed, video.videoWidth / video.videoHeight);
      metrics.lastGesture = interpreter.lastGesture;
      onQuality({ inferenceMs: metrics.inferenceMs });
    } catch (error) {
      if (token !== generation || destroyed || !active) return;
      if (currentEngine.backend === 'worker') {
        // Some Safari versions cannot transfer a video ImageBitmap. Keep controls usable.
        currentEngine.destroy();
        engine = null;
        try {
          const replacement = await createMainEngine(paths, sessionAbort?.signal);
          if (token !== generation || destroyed || !active) {
            replacement.destroy();
            return;
          }
          engine = replacement;
          metrics.backend = replacement.backend;
          metrics.targetFps = 15;
          interpreter.reset();
        } catch (replacementError) {
          if (token === generation) fail(replacementError);
          return;
        }
      } else if (++errors >= 3) {
        fail(error);
        return;
      }
    }
    schedule(token, 1000 / metrics.targetFps - (performance.now() - started));
  }

  async function start() {
    if (destroyed) return false;
    desired = true;
    if (active) return true;
    if (pendingStart) return pendingStart;
    if (document.hidden) {
      onStatus({ state: 'paused', message: '已暂停手势控制' });
      return false;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      fail(new Error('Camera requires HTTPS and browser support'));
      return false;
    }
    const token = ++generation;
    const abortController = new AbortController();
    sessionAbort = abortController;
    onStatus({ state: 'loading', message: '正在启用本地手势识别…' });
    pendingStart = (async () => {
      try {
        // Only this explicit action requests camera permission. Audio is never requested.
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 640 }, frameRate: { ideal: initialFps, max: 24 } },
        });
        if (token !== generation || destroyed || !desired || document.hidden) {
          stopTracks(cameraStream);
          return false;
        }
        stream = cameraStream;
        if (!video.isConnected) document.body.append(video);
        video.srcObject = cameraStream;
        await video.play();
        if (token !== generation || destroyed || !desired) return false;
        const readyEngine = await makeEngine(abortController.signal);
        if (token !== generation || destroyed || !desired || document.hidden) {
          readyEngine.destroy();
          return false;
        }
        engine = readyEngine;
        active = true;
        errors = 0;
        lastVideoTime = -1;
        lastCompletedAt = 0;
        metrics.backend = readyEngine.backend;
        for (const track of stream.getVideoTracks()) {
          track.addEventListener('ended', () => {
            if (token === generation && active && !document.hidden) fail(new Error('Camera stream ended'));
          }, { once: true });
        }
        onStatus({ state: 'active', message: '手势控制已开启' });
        schedule(token, 0);
        return true;
      } catch (error) {
        if (token === generation && !destroyed) fail(error);
        return false;
      } finally {
        if (token === generation) pendingStart = null;
      }
    })();
    return pendingStart;
  }

  function onVisibility() {
    if (!desired || destroyed) return;
    if (document.hidden) closeSession({ keepDesired: true, status: 'paused' });
    else void start();
  }

  function onPageHide() {
    if (desired && !destroyed) closeSession({ keepDesired: true, status: 'paused' });
  }

  function onPageShow() {
    if (desired && !destroyed && !document.hidden) void start();
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  return {
    start,
    stop() { closeSession(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeSession({ status: null });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      video.remove();
    },
    get active() { return active; },
    get stats() { return { ...metrics }; },
  };
}
