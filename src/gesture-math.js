// Pure gesture interpretation: coordinates are mirrored and normalized to the viewport.
export const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const damp = (current, target, rate, seconds) => current + (target - current) * (1 - Math.exp(-rate * seconds));

function distance(a, b, aspect = 1) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function jointAngle(a, b, c, aspect) {
  const ax = (a.x - b.x) * aspect;
  const ay = a.y - b.y;
  const bx = (c.x - b.x) * aspect;
  const by = c.y - b.y;
  const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return length > 1e-6 ? Math.acos(clamp((ax * bx + ay * by) / length, -1, 1)) : 0;
}

export function describeHand(points, aspect = 1) {
  if (!Array.isArray(points) || points.length !== 21 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const palm = [0, 5, 9, 13, 17].reduce((center, index) => ({ x: center.x + points[index].x / 5, y: center.y + points[index].y / 5 }), { x: 0, y: 0 });
  const size = Math.max(0.035, (distance(points[0], points[9], aspect) + distance(points[5], points[17], aspect)) / 2);
  const fingers = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]].map(([base, joint, tip]) => {
    const angle = jointAngle(points[base], points[joint], points[tip], aspect);
    const tipFromWrist = distance(points[tip], points[0], aspect);
    return {
      extended: angle > 2.55 && tipFromWrist > distance(points[joint], points[0], aspect) * 1.12,
      curled: angle < 2.1 || tipFromWrist < distance(points[base], points[0], aspect) * 1.2,
    };
  });
  const thumbOpen = jointAngle(points[2], points[3], points[4], aspect) > 2.45 && distance(points[4], points[17], aspect) > size * 1.35;
  return {
    center: { x: clamp(1 - palm.x, 0, 1), y: clamp(palm.y, 0, 1) },
    pointer: { x: clamp(1 - points[8].x, 0, 1), y: clamp(points[8].y, 0, 1) },
    pinchPoint: { x: clamp(1 - (points[4].x + points[8].x) / 2, 0, 1), y: clamp((points[4].y + points[8].y) / 2, 0, 1) },
    pinchRatio: distance(points[4], points[8], aspect) / size,
    open: fingers.every((finger) => finger.extended) && thumbOpen && distance(points[8], points[20], aspect) > size * 1.1,
    fist: fingers.every((finger) => finger.curled) && distance(points[4], palm, aspect) < size * 1.3,
    size,
  };
}

/** Interpret landmarks without accessing a camera, DOM, storage or network. */
export function createGestureInterpreter({
  onRotate = () => {}, onScale = () => {}, onPinch = () => {}, onPinchEnd = () => {},
  onMode = () => {}, onPointer = () => {}, getScale = () => 1, getMode = () => 'tree',
} = {}) {
  let previous = null;
  let velocity = 0;
  let pinchActive = false;
  let pinchCandidateAt = null;
  let releaseCandidateAt = null;
  let openAt = null;
  let openAnchor = null;
  let fistAt = null;
  let lastModeAt = -Infinity;
  let lastSwipeAt = -Infinity;
  let lastPinchAt = -Infinity;
  let lastHandAt = -Infinity;
  let twoHandAt = null;
  let zoomBaseline = null;
  let smoothedScale = 1;
  let pointer = null;
  let lastGesture = 'none';

  function releasePinch() {
    if (pinchActive) onPinchEnd();
    pinchActive = false;
    pinchCandidateAt = releaseCandidateAt = null;
  }

  function reset() {
    releasePinch();
    previous = pointer = openAnchor = zoomBaseline = null;
    openAt = fistAt = twoHandAt = null;
    velocity = 0;
    lastHandAt = -Infinity;
    lastGesture = 'none';
    onPointer({ x: 0.5, y: 0.5, visible: false });
  }

  function process(landmarks, now, aspect = 1) {
    const hands = (landmarks || []).map((points) => describeHand(points, aspect)).filter(Boolean);
    if (!hands.length) {
      // A short dropout should not make a focused photo flicker back and forth.
      if (now - lastHandAt > 180) reset();
      return;
    }
    lastHandAt = now;
    if (hands.length >= 2) {
      releasePinch();
      previous = null;
      velocity = 0;
      openAt = fistAt = null;
      onPointer({ x: 0.5, y: 0.5, visible: false });
      const separation = distance(hands[0].center, hands[1].center, aspect);
      if (separation < 0.16) {
        twoHandAt = zoomBaseline = null;
        return;
      }
      if (twoHandAt === null) twoHandAt = now;
      if (now - twoHandAt < 180) return;
      if (zoomBaseline === null) {
        zoomBaseline = { separation, scale: clamp(getScale(), 0.65, 1.65), time: now };
        smoothedScale = zoomBaseline.scale;
      }
      const dt = clamp((now - zoomBaseline.time) / 1000, 0.01, 0.15);
      zoomBaseline.time = now;
      // Relative distance starts at the current tree scale, so reacquisition never snaps.
      const ratio = separation / zoomBaseline.separation;
      const target = clamp(zoomBaseline.scale * ratio, 0.65, 1.65);
      smoothedScale = damp(smoothedScale, target, 6, dt);
      onScale(smoothedScale);
      lastGesture = 'zoom';
      return;
    }
    twoHandAt = zoomBaseline = null;
    const hand = hands[0];
    const dt = previous ? clamp((now - previous.time) / 1000, 0.015, 0.15) : 1 / 20;
    const dx = previous ? hand.center.x - previous.x : 0;
    const dy = previous ? hand.center.y - previous.y : 0;
    // Ignore hand reacquisition or a landmark identity jump instead of injecting a spin.
    const continuous = previous && now - previous.time < 220 && Math.abs(dx) < 0.16 && Math.abs(dy) < 0.16;
    const rawVelocity = continuous ? dx / dt : 0;
    velocity = damp(velocity, rawVelocity, 10, dt);
    const moved = continuous && Math.abs(dx) > 0.003 && Math.abs(dx) > Math.abs(dy) * 0.55 && Math.abs(rawVelocity) > 0.075;
    previous = { ...hand.center, time: now };

    const desiredPointer = pinchActive ? hand.pinchPoint : hand.pointer;
    pointer = pointer ? { x: damp(pointer.x, desiredPointer.x, 18, dt), y: damp(pointer.y, desiredPointer.y, 18, dt) } : desiredPointer;
    onPointer({ ...pointer, visible: true });

    if (!pinchActive && !hand.fist && hand.pinchRatio < 0.32) {
      if (pinchCandidateAt === null) pinchCandidateAt = now;
      if (now - pinchCandidateAt >= 65) {
        pinchActive = true;
        lastPinchAt = now;
        onPinch({ ...hand.pinchPoint });
      }
    } else if (!pinchActive) {
      pinchCandidateAt = null;
    }
    if (pinchActive) {
      openAt = fistAt = null;
      lastGesture = 'pinch';
      if (hand.pinchRatio > 0.48 || hand.fist) {
        if (releaseCandidateAt === null) releaseCandidateAt = now;
        if (now - releaseCandidateAt >= 55) {
          releasePinch();
          lastPinchAt = now;
        }
      } else {
        releaseCandidateAt = null;
      }
      return;
    }

    // Fist and open-palm holds have lower priority than pinch and two-hand zoom.
    // Only a stationary palm may scatter the tree; waving an open hand rotates it.
    if (moved) {
      lastSwipeAt = now;
      openAt = null;
      openAnchor = null;
      if (!hand.fist && now - lastPinchAt > 180) {
        onRotate(clamp(velocity * 3.4, -3.1, 3.1));
        lastGesture = 'rotate';
      }
    }
    const stable = !moved && Math.abs(velocity) < 0.13 && now - lastSwipeAt > 300 && now - lastPinchAt > 350;
    const canChangeMode = now - lastModeAt > 1500;
    if (hand.open && stable && getMode() === 'tree' && canChangeMode) {
      if (openAt === null || !openAnchor || distance(hand.center, openAnchor, aspect) > 0.035) {
        openAt = now;
        openAnchor = hand.center;
      } else if (now - openAt >= 550) {
        lastModeAt = now;
        openAt = null;
        onMode('galaxy');
        lastGesture = 'galaxy';
      }
    } else {
      openAt = null;
      openAnchor = null;
    }
    if (hand.fist && stable && getMode() === 'galaxy' && canChangeMode) {
      if (fistAt === null) fistAt = now;
      else if (now - fistAt >= 350) {
        lastModeAt = now;
        fistAt = null;
        onMode('tree');
        lastGesture = 'tree';
      }
    } else {
      fistAt = null;
    }
  }

  return { process, reset, get lastGesture() { return lastGesture; } };
}
