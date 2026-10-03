import { cp, mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base = fileURLToPath(new URL('../public/mediapipe/', import.meta.url));
await mkdir(base, { recursive: true });
await cp(fileURLToPath(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url)), `${base}wasm/`, { recursive: true });
const target = `${base}hand_landmarker.task`;
try { await access(target); } catch {
  const url = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
}
console.log('Local MediaPipe model and WASM ready. Camera frames remain on the device.');
