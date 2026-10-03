import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

// Camera pixels exist only in a transient ImageBitmap. No upload, recording or persistence.
let landmarker = null;
let busy = false;

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const files = await FilesetResolver.forVisionTasks(data.wasmPath, true);
      landmarker = await HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: data.modelPath, delegate: 'CPU' },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.62,
        minHandPresenceConfidence: 0.62,
        minTrackingConfidence: 0.65,
      });
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: error?.message || 'Hand model unavailable' });
    }
    return;
  }
  if (data.type === 'dispose') {
    landmarker?.close();
    landmarker = null;
    self.close();
    return;
  }
  if (data.type !== 'frame') return;
  if (busy || !landmarker) {
    data.bitmap?.close();
    self.postMessage({ type: 'error', message: 'Hand model is not ready' });
    return;
  }
  busy = true;
  const started = performance.now();
  try {
    const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
    self.postMessage({ type: 'result', id: data.id, landmarks: result.landmarks, inferenceMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error?.message || 'Hand tracking failed' });
  } finally {
    data.bitmap.close();
    busy = false;
  }
};
