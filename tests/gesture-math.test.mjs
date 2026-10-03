import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { naturalHand, fistHand, pinchHand, curlFinger, spreadHand } from './gesture-fixtures.js';
const moduleUrl = process.env.GESTURE_MATH_MODULE ? pathToFileURL(process.env.GESTURE_MATH_MODULE).href : new URL('../src/gesture-math.js', import.meta.url).href;
const { describeHand, createGestureInterpreter } = await import(moduleUrl);

function controller(initialMode = 'tree', updateMode = true) {
  let mode = initialMode;
  let scale = 1;
  const events = { modes: [], rotations: [], pinches: [], releases: [], scales: [], feedback: [] };
  const interpreter = createGestureInterpreter({
    getMode: () => mode, getScale: () => scale,
    onMode: (next) => { events.modes.push(next); if (updateMode) mode = next; },
    onRotate: (speed) => events.rotations.push(speed),
    onScale: (next) => { scale = next; events.scales.push(next); },
    onPinch: (point) => events.pinches.push(point), onPinchEnd: () => events.releases.push(true),
    onFeedback: (value) => events.feedback.push(value),
  });
  return { interpreter, events, get mode() { return mode; }, get scale() { return scale; } };
}

function run(interpreter, from, to, frame, aspect = 1) {
  for (let time = from; time <= to; time += 50) interpreter.process(frame(time), time, aspect);
}

// Copy of the restrictive *geometry* conditions before this fix. The fixture
// must fail these conditions, ensuring the test really covers the reported bug.
function oldOpen(points, aspect = 1) {
  const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const angle = (a, b, c) => {
    const ax = (a.x - b.x) * aspect, ay = a.y - b.y;
    const bx = (c.x - b.x) * aspect, by = c.y - b.y;
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)))));
  };
  const size = Math.max(0.035, (distance(points[0], points[9]) + distance(points[5], points[17])) / 2);
  return [5, 9, 13, 17].every((base) => angle(points[base], points[base + 1], points[base + 3]) > 2.55 && distance(points[base + 3], points[0]) > distance(points[base + 1], points[0]) * 1.12)
    && angle(points[2], points[3], points[4]) > 2.45
    && distance(points[4], points[17]) > size * 1.35
    && distance(points[8], points[20]) > size * 1.1;
}

test('natural palm with close fingers, bent thumb, and one relaxed finger is recognized', () => {
  const points = naturalHand();
  assert.equal(oldOpen(points), false, 'fixture reproduces the old strict thumb/spread failure');
  assert.equal(describeHand(points).open, true);
  const relaxed = describeHand(naturalHand({ relaxedFinger: true }));
  assert.equal(relaxed.open, true);
  assert.equal(relaxed.extendedFingers, 3);
});

test('3D geometry handles rolled/slanted palms; landmarks without z fall back to 2D', () => {
  for (const aspect of [0.75, 1, 4 / 3]) {
    for (const rotation of [-1.0, 0, 1.1]) {
      const points = naturalHand({ rotation, tilt: 1.1, aspect, relaxedFinger: true });
      assert.equal(describeHand(points, aspect).open, true, `aspect ${aspect}, roll ${rotation}`);
    }
  }
  assert.equal(describeHand(naturalHand({ rotation: 1.2, missingDepth: true })).open, true);
  assert.equal(describeHand([]), null);
  assert.equal(describeHand(naturalHand().map((p, i) => i === 3 ? { ...p, x: NaN } : p)), null);
});

test('pointing, peace, and three extended fingers with one fully curled finger cannot scatter', () => {
  for (const curled of [[9, 13, 17], [13, 17], [17]]) {
    let points = naturalHand();
    for (const base of curled) points = curlFinger(points, base);
    assert.equal(describeHand(points).open, false);
    const app = controller();
    run(app.interpreter, 0, 1200, () => [points]);
    assert.deepEqual(app.events.modes, []);
  }
});

test('550ms open hold tolerates alternating ±0.004 tracking jitter and a missing frame', () => {
  const app = controller();
  run(app.interpreter, 0, 750, (time) => time === 250 ? [] : [naturalHand({ offsetX: time / 50 % 2 ? 0.004 : -0.004, relaxedFinger: true })]);
  assert.deepEqual(app.events.modes, ['galaxy']);
  assert.equal(app.events.rotations.length, 0, 'jitter must not spin the tree');
  assert(app.events.feedback.some((value) => value.pose === 'open' && value.progress > 0.4 && value.progress < 1));
  assert(app.events.feedback.some((value) => value.pose === 'open' && value.progress === 1));
});

test('even a palm satisfying the old strict geometry survives tiny tracking jitter', () => {
  assert.equal(oldOpen(spreadHand()), true, 'isolate temporal hold failure from pose detection');
  const app = controller();
  run(app.interpreter, 0, 750, (time) => [spreadHand(time / 50 % 2 ? 0.004 : -0.004)]);
  assert.deepEqual(app.events.modes, ['galaxy']);
  assert.equal(app.events.rotations.length, 0);
});

test('natural holding drift and larger tracking jitter still trigger at camera aspect', () => {
  for (const drift of [0.015, 0.022]) {
    const app = controller();
    run(app.interpreter, 0, 900, (time) => [naturalHand({ offsetX: time / 1000 * drift + (time / 50 % 2 ? 0.009 : -0.009), offsetY: time / 50 % 2 ? 0.004 : -0.004 })], 4 / 3);
    assert.deepEqual(app.events.modes, ['galaxy'], `holding drift ${drift}/sec`);
    assert.equal(app.events.rotations.length, 0);
  }
});

test('one low-confidence pose frame pauses hold and preserves progress', () => {
  const app = controller();
  run(app.interpreter, 0, 750, (time) => [time === 250 ? curlFinger(naturalHand(), 17) : naturalHand()]);
  assert.deepEqual(app.events.modes, ['galaxy']);
});

test('short holds and prolonged pose/tracking loss cannot accumulate into a mode change', () => {
  const app = controller();
  run(app.interpreter, 0, 450, () => [naturalHand()]);
  assert.deepEqual(app.events.modes, []);
  run(app.interpreter, 500, 800, () => []);
  run(app.interpreter, 850, 1300, () => [naturalHand()]);
  assert.deepEqual(app.events.modes, []);
  app.interpreter.process([naturalHand()], 1400);
  assert.deepEqual(app.events.modes, ['galaxy']);

  const lowConfidence = controller();
  run(lowConfidence.interpreter, 0, 400, () => [naturalHand()]);
  run(lowConfidence.interpreter, 450, 750, () => [curlFinger(naturalHand(), 17)]);
  run(lowConfidence.interpreter, 800, 1200, () => [naturalHand()]);
  assert.deepEqual(lowConfidence.events.modes, []);
});

test('fast waves rotate with mirrored direction and never scatter', () => {
  for (const direction of [-1, 1]) {
    const app = controller();
    run(app.interpreter, 0, 1400, (time) => [naturalHand({ offsetX: direction * (time % 700) / 2000 })]);
    assert.deepEqual(app.events.modes, []);
    assert(app.events.rotations.some((speed) => direction * speed < 0));
  }
});

test('long slow deliberate waves do not become a stationary open-palm hold', () => {
  const app = controller();
  run(app.interpreter, 0, 4000, (time) => [naturalHand({ offsetX: time / 1000 * 0.06 })]);
  assert.deepEqual(app.events.modes, []);
  assert(app.events.rotations.some((speed) => speed < 0));
  assert(app.events.feedback.some((value) => value.pose === 'move'));
});

test('after a wave stops, settling then a full stationary hold enters galaxy', () => {
  const app = controller();
  run(app.interpreter, 0, 600, (time) => [naturalHand({ offsetX: time / 5000 })]);
  assert.deepEqual(app.events.modes, []);
  run(app.interpreter, 650, 2200, () => [naturalHand({ offsetX: 0.12 })]);
  assert.deepEqual(app.events.modes, ['galaxy']);
});

test('pinch stays single-shot, does not scatter, releases smoothly, and keeps brief dropout', () => {
  const app = controller();
  run(app.interpreter, 0, 900, () => [pinchHand()]);
  assert.equal(app.events.pinches.length, 1);
  assert.deepEqual(app.events.modes, []);
  assert.equal(app.interpreter.diagnostics.pose, 'pinch');
  app.interpreter.process([], 950);
  assert.equal(app.events.releases.length, 0);
  app.interpreter.process([pinchHand()], 1000);
  run(app.interpreter, 1050, 1150, () => [naturalHand()]);
  assert.equal(app.events.releases.length, 1);
  assert.equal(app.events.pinches.length, 1);
});

test('fist returns galaxy to tree and close thumb/index never select a photo', () => {
  const app = controller('galaxy');
  assert.equal(describeHand(fistHand()).fist, true);
  run(app.interpreter, 0, 700, () => [fistHand()]);
  assert.deepEqual(app.events.modes, ['tree']);
  assert.equal(app.events.pinches.length, 0);
  assert(app.events.feedback.some((value) => value.pose === 'fist' && value.progress === 1));
});

test('two open hands retain zoom priority, bounded smoothing, and current scale on reacquisition', () => {
  const app = controller();
  run(app.interpreter, 0, 800, (time) => [naturalHand({ offsetX: -0.18 - time / 5000 }), naturalHand({ offsetX: 0.18 + time / 5000 })]);
  assert.deepEqual(app.events.modes, []);
  assert.equal(app.events.pinches.length, 0);
  assert(app.scale > 1.2 && app.scale <= 1.65);
  assert.equal(app.interpreter.diagnostics.pose, 'zoom');
  const before = app.scale;
  app.interpreter.reset();
  run(app.interpreter, 1500, 1700, () => [naturalHand({ offsetX: -0.18 }), naturalHand({ offsetX: 0.18 })]);
  assert.equal(app.scale, before);
});

test('held poses trigger once even when the consuming scene has delayed its mode update', () => {
  const app = controller('tree', false);
  run(app.interpreter, 0, 5000, () => [naturalHand()]);
  assert.deepEqual(app.events.modes, ['galaxy']);
  run(app.interpreter, 5050, 5300, () => [curlFinger(naturalHand(), 17)]);
  run(app.interpreter, 5350, 5950, () => [naturalHand()]);
  assert.deepEqual(app.events.modes, ['galaxy', 'galaxy'], 'a deliberate release permits a new hold');
});

test('reset releases focus and feedback/diagnostics do not expose mutable internal state', () => {
  const app = controller();
  run(app.interpreter, 0, 150, () => [pinchHand()]);
  app.interpreter.reset();
  assert.equal(app.events.releases.length, 1);
  assert.equal(app.interpreter.lastGesture, 'none');
  assert.deepEqual(app.events.feedback.at(-1), { pose: 'none', progress: 0, handCount: 0 });
  const snapshot = app.interpreter.diagnostics;
  snapshot.pose = 'zoom';
  assert.equal(app.interpreter.diagnostics.pose, 'none');
});


test('15FPS time-based tremor survives camera scheduling rather than alternating test frames', () => {
  for (const drift of [0.015, 0.022]) {
    const app = controller();
    for (let frame = 0; frame <= 27; frame++) {
      const time = frame * 1000 / 15;
      app.interpreter.process([naturalHand({
        offsetX: time / 1000 * drift + Math.sin(frame) * 0.009,
        offsetY: Math.cos(frame) * 0.004,
      })], time, 4 / 3);
    }
    assert.deepEqual(app.events.modes, ['galaxy'], `15FPS periodic drift ${drift}`);
    assert.equal(app.events.rotations.length, 0);
  }
});

test('representative seeded camera noise works across mobile inference frame rates', () => {
  for (const fps of [15, 18, 24, 30]) {
    for (const seed of [5, 18, 50, 77]) {
      let state = seed;
      const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
      const app = controller();
      for (let frame = 0; frame <= Math.ceil(fps * 1.6); frame++) {
        const time = frame * 1000 / fps;
        app.interpreter.process([naturalHand({
          offsetX: time / 1000 * 0.015 + (random() * 2 - 1) * 0.009,
          offsetY: (random() * 2 - 1) * 0.004,
        })], time, 4 / 3);
      }
      assert.deepEqual(app.events.modes, ['galaxy'], `FPS ${fps}, seed ${seed}`);
      assert.equal(app.events.rotations.length, 0);
    }
  }
});

test('a slow deliberate wave with camera tremor keeps rotation priority at 15FPS', () => {
  const app = controller();
  for (let frame = 0; frame <= 60; frame++) {
    const time = frame * 1000 / 15;
    app.interpreter.process([naturalHand({
      offsetX: time / 1000 * 0.06 + Math.sin(frame) * 0.003,
      offsetY: Math.cos(frame) * 0.002,
    })], time, 4 / 3);
  }
  assert.deepEqual(app.events.modes, []);
  assert(app.events.rotations.some((speed) => speed < 0));
});

test('uncertain motion cannot keep an old hold alive through a long invalid pose', () => {
  const app = controller();
  run(app.interpreter, 0, 400, () => [naturalHand()]);
  for (let frame = 0; frame < 15; frame++) {
    const time = 450 + frame * 1000 / 15;
    const invalid = curlFinger(naturalHand({
      offsetX: Math.sin(frame) * 0.009 + frame * 0.0015,
      offsetY: Math.cos(frame) * 0.004,
    }), 17);
    app.interpreter.process([invalid], time, 4 / 3);
  }
  assert.deepEqual(app.events.modes, []);
  const held = naturalHand({ offsetX: 0.020 });
  run(app.interpreter, 1450, 1900, () => [held], 4 / 3);
  assert.deepEqual(app.events.modes, [], 'long invalid pose must discard the old 400ms progress');
  run(app.interpreter, 1950, 2200, () => [held], 4 / 3);
  assert.deepEqual(app.events.modes, ['galaxy']);
});
