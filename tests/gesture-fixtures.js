// Synthetic MediaPipe-shaped landmarks, used by tests and the hidden Debug replay.
// No camera images or user photographs are involved.
export function naturalHand({ offsetX = 0, offsetY = 0, relaxedFinger = false, rotation = 0, tilt = 0, aspect = 1, missingDepth = false } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  points[0] = { x: 0.5, y: 0.80, z: 0 };
  const bases = [5, 9, 13, 17];
  const fingerX = [0.452, 0.482, 0.512, 0.542];
  const fingerLengths = [0.28, 0.31, 0.28, 0.23];
  for (let finger = 0; finger < 4; finger++) {
    for (let joint = 0; joint < 4; joint++) points[bases[finger] + joint] = {
      x: fingerX[finger], y: 0.58 + (finger === 3 ? 0.02 : 0) - joint * fingerLengths[finger] / 3, z: 0,
    };
  }
  points[1] = { x: 0.455, y: 0.725, z: 0 };
  points[2] = { x: 0.416, y: 0.660, z: 0 };
  points[3] = { x: 0.399, y: 0.612, z: 0 };
  points[4] = { x: 0.436, y: 0.571, z: 0 }; // Naturally bent thumb.
  if (relaxedFinger) {
    points[19] = { x: 0.592, y: 0.475, z: 0 };
    points[20] = { x: 0.620, y: 0.483, z: 0 }; // Slightly bent pinky; three clear extended fingers.
  }
  return points.map((point) => {
    const x = (point.x - 0.5) * aspect;
    const y = point.y - 0.65;
    const rolledX = x * Math.cos(rotation) - y * Math.sin(rotation);
    const rolledY = x * Math.sin(rotation) + y * Math.cos(rotation);
    const transformed = {
      x: 0.5 + rolledX / aspect + offsetX,
      y: 0.65 + rolledY * Math.cos(tilt) + offsetY,
      z: rolledY * Math.sin(tilt) / aspect,
    };
    if (missingDepth) delete transformed.z;
    return transformed;
  });
}

export function curlFinger(points, base) {
  const result = points.map((point) => ({ ...point }));
  result[base + 1] = { ...result[base], y: result[base].y - 0.08 };
  result[base + 2] = { ...result[base], y: result[base].y - 0.02 };
  result[base + 3] = { ...result[base], y: result[base].y + 0.035 };
  return result;
}

export function fistHand(options = {}) {
  let points = naturalHand();
  for (const base of [5, 9, 13, 17]) points = curlFinger(points, base);
  points[4] = { x: 0.465, y: 0.635, z: 0 };
  return points.map((point) => ({ ...point, x: point.x + (options.offsetX || 0), y: point.y + (options.offsetY || 0) }));
}

export function pinchHand() {
  const points = naturalHand();
  points[4] = { ...points[8], x: points[8].x + 0.015 };
  return points;
}

export function spreadHand(offsetX = 0) {
  const points = naturalHand();
  points[0] = { x: 0.5 + offsetX, y: 0.78, z: 0 };
  const fingerX = [0.42, 0.49, 0.56, 0.64];
  const spread = [-0.018, -0.006, 0.006, 0.025];
  for (let finger = 0; finger < 4; finger++) {
    for (let joint = 0; joint < 4; joint++) points[[5, 9, 13, 17][finger] + joint] = {
      x: fingerX[finger] + offsetX + spread[finger] * joint, y: 0.58 - joint * 0.105, z: 0,
    };
  }
  points[1] = { x: 0.42 + offsetX, y: 0.70, z: 0 };
  points[2] = { x: 0.36 + offsetX, y: 0.63, z: 0 };
  points[3] = { x: 0.30 + offsetX, y: 0.56, z: 0 };
  points[4] = { x: 0.24 + offsetX, y: 0.49, z: 0 };
  return points;
}
