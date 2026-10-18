import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MouseLook } from '../src/mouse-look.js';
import { Player } from '../src/player.js';

function fixture() {
  const player = new Player(new THREE.PerspectiveCamera(), {
    ceilAt: () => 3, floorAt: () => 1, collide() {},
  }, { step() {}, breath() {}, gasp() {} }, {
    state: 'play', psychosis: 0, fear: 0, noise() {}, hint() {},
  });
  player.reset({ x: 10, z: 10 }, 0);
  const input = new MouseLook((...args) => player.look(...args));
  return { player, input };
}
const gain = .0012 * 1.4;
const packet = (movementX, movementY = 0) => ({ movementX, movementY });

for (const fps of [20, 30, 60, 144]) test(`walking and sprinting reject 180-degree warp packets at ${fps} fps`, () => {
  const { player: p, input } = fixture();
  input.setLocked(true);
  input.move(packet(Math.PI / gain), gain);
  assert.equal(p.yaw, 0, 'initial cursor recenter is not a camera turn');
  let expected = 0;
  const previous = p.camera.quaternion.clone();
  for (let n = 0; n < fps * 20; n++) {
    p.keys.add('KeyW');
    if (n % (fps * 4) < fps * 2) p.keys.add('ShiftLeft');
    else p.keys.delete('ShiftLeft');
    if (n % 31 === 0) {
      const yaw = p.yaw;
      input.move(packet((n % 2 ? -1 : 1) * Math.PI / gain), gain);
      assert.equal(p.yaw, yaw, 'an isolated warp is discarded');
    }
    const dx = n % 2 ? 2 : -3;
    input.move(packet(dx, 0), gain); expected -= dx * gain;
    p.update(1 / fps);
    assert.ok(Math.abs(p.yaw - expected) < 1e-10, 'ordinary mouse/trackpad motion stays exact');
    assert.ok(previous.angleTo(p.camera.quaternion) < .08, 'no camera cut while moving');
    previous.copy(p.camera.quaternion);
  }
});

test('unlocked dragging uses client coordinates, not inconsistent movementX', () => {
  const { player: p, input } = fixture();
  input.beginDrag(200, 100);
  input.move({ clientX: 206, clientY: 103, movementX: 4000, movementY: -4000 }, gain);
  assert.equal(p.yaw, -6 * gain); assert.equal(p.pitch, -3 * gain);
  input.endDrag();
  input.move({ clientX: 900, clientY: 600, movementX: 4000, movementY: 4000 }, gain);
  assert.equal(p.yaw, -6 * gain);
});

test('switching between dragging, pointer lock and focus never reuses a stale origin', () => {
  const { player: p, input } = fixture();
  input.beginDrag(100, 100); input.move({ clientX: 110, clientY: 100 }, gain);
  input.setLocked(true); input.move(packet(4000), gain);
  input.move(packet(10), gain); assert.equal(p.yaw, -20 * gain);
  input.reset(); input.move(packet(-4000), gain);
  input.move(packet(10), gain); assert.ok(Math.abs(p.yaw + 30 * gain) < 1e-12);
  input.setLocked(false); input.move({ clientX: 900, clientY: 100 }, gain);
  assert.ok(Math.abs(p.yaw + 30 * gain) < 1e-12);
  input.beginDrag(900, 100); input.move({ clientX: 910, clientY: 100 }, gain);
  assert.ok(Math.abs(p.yaw + 40 * gain) < 1e-12);
});

test('quick deliberate turns keep their full speed at every sensitivity setting', () => {
  for (const sensitivity of [.0006, .00168, .0036]) {
    const { player: p, input } = fixture(); input.setLocked(true); input.move(packet(0), sensitivity);
    for (let n = 0; n < 100; n++) input.move(packet(100), sensitivity);
    assert.ok(Math.abs(p.yaw + 10000 * sensitivity) < 1e-10);
  }
});

test('non-finite input and touch-generated mouse events cannot corrupt desktop look', () => {
  const { player: p, input } = fixture(); input.setLocked(true); input.move(packet(0), gain);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    input.move(packet(invalid), gain); input.move(packet(0, invalid), gain);
    p.look(invalid, 0, gain); p.look(0, invalid, gain); p.look(1, 0, invalid);
  }
  input.move({ ...packet(50), sourceCapabilities: { firesTouchEvents: true } }, gain);
  assert.equal(p.yaw, 0); assert.equal(p.pitch, 0);
  input.move(packet(10), gain); assert.equal(p.yaw, -10 * gain);
  p.update(1 / 60); assert.ok(p.camera.quaternion.toArray().every(Number.isFinite));
});

test('procedural pitch offsets cannot invert the view at the vertical look limits', () => {
  for (const direction of [-1, 1]) {
    const { player: p } = fixture(); p.pitch = direction * 1.45; p.nod = direction * .3;
    p.update(1 / 60);
    const horizontal = p.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    assert.ok(horizontal.dot(p.forward()) > .99);
    assert.ok(Math.abs(p.camera.rotation.x) < Math.PI / 2);
  }
});
