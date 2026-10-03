// Pure gesture interpretation: coordinates are mirrored and normalized to the viewport.
export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const damp = (current, target, rate, seconds) => current + (target - current) * (1 - Math.exp(-rate * seconds));

function distance(a, b, aspect = 1, depth = false) {
  // MediaPipe's normalized z uses the same scale as x, not y.
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, depth ? (a.z - b.z) * aspect : 0);
}

function jointAngle(a, b, c, aspect, depth) {
  const ax = (a.x - b.x) * aspect;
  const ay = a.y - b.y;
  const az = depth ? (a.z - b.z) * aspect : 0;
  const bx = (c.x - b.x) * aspect;
  const by = c.y - b.y;
  const bz = depth ? (c.z - b.z) * aspect : 0;
  const length = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
  return length > 1e-6 ? Math.acos(clamp((ax * bx + ay * by + az * bz) / length, -1, 1)) : 0;
}

export function describeHand(points, aspect = 1) {
  if (!Array.isArray(points) || points.length !== 21 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const depth = points.every((point) => Number.isFinite(point.z));
  const palm = [0, 5, 9, 13, 17].reduce((center, index) => ({
    x: center.x + points[index].x / 5,
    y: center.y + points[index].y / 5,
    z: center.z + (depth ? points[index].z / 5 : 0),
  }), { x: 0, y: 0, z: 0 });
  const size = Math.max(0.035, (distance(points[0], points[9], aspect, depth) + distance(points[5], points[17], aspect, depth)) / 2);
  const fingers = [5, 9, 13, 17].map((base) => {
    const angle = jointAngle(points[base], points[base + 1], points[base + 3], aspect, depth);
    const tipFromWrist = distance(points[base + 3], points[0], aspect, depth);
    const jointFromWrist = distance(points[base + 1], points[0], aspect, depth);
    const baseFromWrist = distance(points[base], points[0], aspect, depth);
    const path = distance(points[base], points[base + 1], aspect, depth)
      + distance(points[base + 1], points[base + 2], aspect, depth)
      + distance(points[base + 2], points[base + 3], aspect, depth);
    const straightness = path > 1e-6 ? distance(points[base], points[base + 3], aspect, depth) / path : 0;
    return {
      // A natural palm has relaxed joints; fully straight, widely spread fingers
      // and a straight thumb are not necessary. At least three fingers must
      // still be clearly extended, so a peace sign/pointing hand cannot qualify.
      extended: angle > 2.25 && straightness > 0.74 && tipFromWrist > jointFromWrist * 1.04,
      relaxed: angle > 1.90 && straightness > 0.63 && tipFromWrist > jointFromWrist * 0.97 && tipFromWrist > baseFromWrist * 1.23,
      curled: angle < 1.95 || tipFromWrist < baseFromWrist * 1.15,
    };
  });
  const extendedFingers = fingers.filter((finger) => finger.extended).length;
  const pinchRatio = distance(points[4], points[8], aspect, depth) / size;
  const open = extendedFingers >= 3 && fingers.every((finger) => finger.extended || finger.relaxed) && pinchRatio > 0.48;
  return {
    center: { x: clamp(1 - palm.x, 0, 1), y: clamp(palm.y, 0, 1) },
    pointer: { x: clamp(1 - points[8].x, 0, 1), y: clamp(points[8].y, 0, 1) },
    pinchPoint: { x: clamp(1 - (points[4].x + points[8].x) / 2, 0, 1), y: clamp((points[4].y + points[8].y) / 2, 0, 1) },
    pinchRatio,
    open,
    openConfidence: open ? (extendedFingers === 4 ? 1 : 0.85) : extendedFingers / 8,
    extendedFingers,
    fist: fingers.every((finger) => finger.curled) && distance(points[4], palm, aspect, depth) < size * 1.3,
    size,
  };
}

/** Interpret landmarks without accessing a camera, DOM, storage or network. */
export function createGestureInterpreter({
  onRotate = () => {}, onScale = () => {}, onPinch = () => {}, onPinchEnd = () => {},
  onMode = () => {}, onPointer = () => {}, onFeedback = () => {}, getScale = () => 1, getMode = () => 'tree',
} = {}) {
  let previous = null;
  let smoothedCenter = null;
  let motionWindow = [];
  let motionCandidateAt = null;
  let velocity = 0;
  let pinchActive = false;
  let pinchCandidateAt = null;
  let releaseCandidateAt = null;
  let poseHold = null;
  let modeLatch = null;
  let latchReleaseAt = null;
  let lastModeAt = -Infinity;
  let lastMotionAt = -Infinity;
  let lastPinchAt = -Infinity;
  let lastHandAt = -Infinity;
  let twoHandAt = null;
  let zoomBaseline = null;
  let smoothedScale = 1;
  let pointer = null;
  let lastGesture = 'none';
  let diagnostics = { pose: 'none', progress: 0, handCount: 0, openConfidence: 0, extendedFingers: 0, speed: 0, directionConsistency: 0, holdMs: 0 };

  function feedback(pose, progress, handCount, values = {}) {
    diagnostics = { ...diagnostics, ...values, pose, progress: clamp(progress, 0, 1), handCount };
    onFeedback({ pose, progress: diagnostics.progress, handCount });
  }

  function releasePinch() {
    if (pinchActive) onPinchEnd();
    pinchActive = false;
    pinchCandidateAt = releaseCandidateAt = null;
  }

  function reset() {
    releasePinch();
    previous = smoothedCenter = pointer = zoomBaseline = poseHold = modeLatch = latchReleaseAt = null;
    motionWindow = [];
    motionCandidateAt = null;
    twoHandAt = null;
    velocity = 0;
    lastHandAt = lastMotionAt = -Infinity;
    lastGesture = 'none';
    onPointer({ x: 0.5, y: 0.5, visible: false });
    feedback('none', 0, 0, { openConfidence: 0, extendedFingers: 0, speed: 0, directionConsistency: 0, holdMs: 0 });
  }

  function clearHold() {
    poseHold = null;
  }

  function updateLatch(hand, now) {
    if (!modeLatch) return;
    const stillHeld = modeLatch === 'open' ? hand.open : hand.fist;
    if (stillHeld) latchReleaseAt = null;
    else if (latchReleaseAt === null) latchReleaseAt = now;
    else if (now - latchReleaseAt > 180) modeLatch = latchReleaseAt = null;
  }

  function hold(pose, hand, now, aspect, duration, target) {
    const center = smoothedCenter || hand.center;
    const holdRadius = clamp(hand.size * 0.30, 0.045, 0.06);
    if (!poseHold || poseHold.pose !== pose || now - poseHold.lastValidAt > 180 || distance(center, poseHold.anchor, aspect) > holdRadius) {
      poseHold = { pose, anchor: { ...center }, elapsed: 0, time: now, valid: true, lastValidAt: now };
    } else {
      // Tiny pose-confidence/dropout gaps pause progress without erasing it.
      // Long gaps never count as part of the hold.
      if (poseHold.valid) poseHold.elapsed += clamp(now - poseHold.time, 0, 100);
      poseHold.time = poseHold.lastValidAt = now;
      poseHold.valid = true;
    }
    feedback(pose, poseHold.elapsed / duration, 1, { holdMs: poseHold.elapsed });
    if (poseHold.elapsed >= duration) {
      lastModeAt = now;
      modeLatch = pose;
      latchReleaseAt = null;
      clearHold();
      lastGesture = target;
      feedback(pose, 1, 1, { holdMs: duration });
      onMode(target);
    }
  }

  function process(landmarks, now, aspect = 1) {
    const hands = (landmarks || []).map((points) => describeHand(points, aspect)).filter(Boolean);
    if (!hands.length) {
      if (poseHold) {
        poseHold.valid = false;
        if (now - poseHold.lastValidAt > 140) clearHold();
      }
      // A short dropout should not make a focused photo flicker back and forth.
      if (now - lastHandAt > 180) reset();
      else feedback('none', poseHold ? poseHold.elapsed / (poseHold.pose === 'open' ? 550 : 350) : 0, 0);
      return;
    }
    lastHandAt = now;
    if (hands.length >= 2) {
      releasePinch();
      previous = smoothedCenter = null;
      motionWindow = [];
      motionCandidateAt = null;
      velocity = 0;
      clearHold();
      onPointer({ x: 0.5, y: 0.5, visible: false });
      const separation = distance(hands[0].center, hands[1].center, aspect);
      if (separation < 0.16) {
        twoHandAt = zoomBaseline = null;
        feedback('zoom', 0, hands.length, { holdMs: 0 });
        return;
      }
      if (twoHandAt === null) twoHandAt = now;
      feedback('zoom', clamp((now - twoHandAt) / 180, 0, 1), hands.length, { holdMs: 0 });
      if (now - twoHandAt < 180) return;
      if (zoomBaseline === null) {
        zoomBaseline = { separation, scale: clamp(getScale(), 0.65, 1.65), time: now };
        smoothedScale = zoomBaseline.scale;
      }
      const dt = clamp((now - zoomBaseline.time) / 1000, 0.01, 0.15);
      zoomBaseline.time = now;
      // Relative distance starts at the current tree scale, so reacquisition never snaps.
      const target = clamp(zoomBaseline.scale * separation / zoomBaseline.separation, 0.65, 1.65);
      smoothedScale = damp(smoothedScale, target, 6, dt);
      onScale(smoothedScale);
      lastGesture = 'zoom';
      return;
    }
    twoHandAt = zoomBaseline = null;
    const hand = hands[0];
    const dt = previous ? clamp((now - previous.time) / 1000, 0.015, 0.15) : 1 / 20;
    const dx = previous ? hand.center.x - previous.rawX : 0;
    const dy = previous ? hand.center.y - previous.rawY : 0;
    // Ignore hand reacquisition or a landmark identity jump instead of injecting a spin.
    const continuous = previous && now - previous.time < 220 && Math.abs(dx) < 0.16 && Math.abs(dy) < 0.16;
    const oldCenter = smoothedCenter;
    smoothedCenter = continuous ? {
      x: damp(smoothedCenter.x, hand.center.x, 10, dt),
      y: damp(smoothedCenter.y, hand.center.y, 10, dt),
    } : { ...hand.center };
    const smoothDx = continuous ? smoothedCenter.x - oldCenter.x : 0;
    const smoothDy = continuous ? smoothedCenter.y - oldCenter.y : 0;
    velocity = continuous ? damp(velocity, smoothDx / dt, 12, dt) : 0;
    if (!continuous) { motionWindow = []; motionCandidateAt = null; }
    motionWindow.push({ ...smoothedCenter, time: now });
    while (motionWindow.length > 1 && now - motionWindow[0].time > 300) motionWindow.shift();
    const oldest = motionWindow[0];
    const netX = (smoothedCenter.x - oldest.x) * aspect;
    const netY = smoothedCenter.y - oldest.y;
    const span = (now - oldest.time) / 1000;
    let path = 0;
    for (let index = 1; index < motionWindow.length; index++) path += distance(motionWindow[index], motionWindow[index - 1], aspect);
    const netDistance = Math.hypot(netX, netY);
    const consistency = path > 1e-6 ? netDistance / path : 0;
    const speed = span > 0 ? netDistance / span : 0;
    // Jitter changes direction and cancels in this window. A slow, deliberate
    // wave keeps moving in one direction and must not count as a stationary hold.
    const sustainedMotion = span >= 0.20 && netDistance > 0.015 && speed > 0.055 && consistency > 0.72;
    const quickMotion = continuous && span >= 0.10 && consistency > 0.80
      && Math.hypot(dx * aspect, dy) > 0.025
      && Math.hypot(smoothDx * aspect, smoothDy) / dt > 0.18;
    // A noisy inference can produce a single directional spike. Require a
    // sustained trend for 200ms; pause a hold during that uncertainty.
    if (sustainedMotion) {
      if (motionCandidateAt === null) motionCandidateAt = now;
    } else motionCandidateAt = null;
    const moving = Boolean(quickMotion || (motionCandidateAt !== null && now - motionCandidateAt >= 200));
    const motionPending = sustainedMotion && !moving;
    const horizontalMotion = moving && Math.abs(netX) > Math.abs(netY) * 0.6;
    previous = { rawX: hand.center.x, rawY: hand.center.y, time: now };
    feedback('none', 0, 1, { openConfidence: hand.openConfidence, extendedFingers: hand.extendedFingers, speed, directionConsistency: consistency, holdMs: 0 });
    updateLatch(hand, now);

    const desiredPointer = pinchActive ? hand.pinchPoint : hand.pointer;
    pointer = pointer ? { x: damp(pointer.x, desiredPointer.x, 18, dt), y: damp(pointer.y, desiredPointer.y, 18, dt) } : desiredPointer;
    onPointer({ ...pointer, visible: true });

    if (!pinchActive && !hand.fist && hand.pinchRatio < 0.32) {
      if (pinchCandidateAt === null) pinchCandidateAt = now;
      clearHold();
      feedback('pinch', clamp((now - pinchCandidateAt) / 65, 0, 1), 1);
      if (now - pinchCandidateAt >= 65) {
        pinchActive = true;
        lastPinchAt = now;
        onPinch({ ...hand.pinchPoint });
      }
    } else if (!pinchActive) {
      pinchCandidateAt = null;
    }
    if (pinchActive) {
      clearHold();
      lastGesture = 'pinch';
      feedback('pinch', 1, 1);
      if (hand.pinchRatio > 0.48 || hand.fist) {
        if (releaseCandidateAt === null) releaseCandidateAt = now;
        if (now - releaseCandidateAt >= 55) {
          releasePinch();
          lastPinchAt = now;
        }
      } else releaseCandidateAt = null;
      return;
    }
    if (pinchCandidateAt !== null) return;

    // Pinch and two-hand zoom take priority over mode holds. Waving a palm
    // rotates; only a stationary palm can scatter the tree.
    if (moving) {
      lastMotionAt = now;
      clearHold();
      feedback('move', 0, 1);
      if (horizontalMotion && !hand.fist && now - lastPinchAt > 180) {
        onRotate(clamp(velocity * 3.4, -3.1, 3.1));
        lastGesture = 'rotate';
      }
    }
    const stable = !moving && Math.abs(velocity) < 0.10 && now - lastMotionAt > 240 && now - lastPinchAt > 350;
    const canChangeMode = now - lastModeAt > 1500;
    const eligiblePose = hand.open && getMode() === 'tree' ? 'open' : hand.fist && getMode() === 'galaxy' ? 'fist' : null;
    if (eligiblePose && stable && !motionPending && canChangeMode && modeLatch !== eligiblePose) {
      hold(eligiblePose, hand, now, aspect, eligiblePose === 'open' ? 550 : 350, eligiblePose === 'open' ? 'galaxy' : 'tree');
    } else if (poseHold && !moving && canChangeMode && ((motionPending && eligiblePose === poseHold.pose) || (stable && now - poseHold.lastValidAt <= 140))) {
      poseHold.valid = false;
      poseHold.time = now;
      if (motionPending && eligiblePose === poseHold.pose) poseHold.lastValidAt = now;
      feedback(poseHold.pose, poseHold.elapsed / (poseHold.pose === 'open' ? 550 : 350), 1, { holdMs: poseHold.elapsed });
    } else {
      clearHold();
      if (!moving && eligiblePose) feedback(eligiblePose, modeLatch === eligiblePose ? 1 : 0, 1);
    }
  }

  return { process, reset, get lastGesture() { return lastGesture; }, get diagnostics() { return { ...diagnostics }; } };
}
