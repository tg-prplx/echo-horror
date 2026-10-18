import * as THREE from 'three';
import { FLOOR } from './level.js';
import { COLORS } from './echo.js';
import { findTripObstacle } from './trip-obstacle.js';
import { PitFall } from './pit-fall.js';

const SURF_MUL = { [FLOOR.TILE]: 1, [FLOOR.WATER]: 1.6, [FLOOR.GLASS]: 1.7, [FLOOR.METAL]: 1.3, [FLOOR.CARPET]: 0.65 };
const FALL_DURATION = 2.1;

export class Player {
  constructor(camera, level, audio, game) {
    this.camera = camera;
    this.level = level;
    this.audio = audio;
    this.game = game;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.touchMove = { x: 0, y: 0 };
    this.crouch = false;
    this.stamina = 1;
    this.breathCap = 1;
    this.holding = false;
    this.holdT = 0;
    this.breathT = 1;
    this.breathOut = true;
    this.stepAcc = 0;
    this.bob = 0;
    this.eye = 1.65;
    this.vel = new THREE.Vector3();
    this.clickCd = 0;
    this.clickStreak = 0;
    this.clickQuietT = 0;
    this.stones = 0;
    this.projectiles = [];
    this.frozen = false;
    this.moving = false;
    this.running = false;
    this.lookTarget = null;
    this.clearFall();
    this.pitFall = null;
    this.falls = 0;
  }

  clearFall() {
    this.fallT = this.fallK = this.tripCooldown = this.runDistance = 0;
    this.fallImpact = false;
    this.fallSide = 1;
  }

  trip(hit) {
    this.fallT = FALL_DURATION;
    this.tripCooldown = 6;
    this.runDistance = this.stepAcc = 0;
    this.fallImpact = false;
    const side = (hit.point.x - this.pos.x) * Math.cos(this.yaw) - (hit.point.z - this.pos.z) * Math.sin(this.yaw);
    this.fallSide = Math.sign(side) || ((this.steps || 0) % 2 ? -1 : 1);
    this.holding = this.running = this.listening = this.moving = false;
    this.stamina = Math.max(0, this.stamina - 0.16);
    this.falls++;
    if (!this.tripHinted) {
      this.tripHinted = true;
      this.game.hint('Споткнулся. Сбавь шаг у низких препятствий.', 4, true);
    }
  }

  updateFall(dt) {
    this.tripCooldown = Math.max(0, this.tripCooldown - dt);
    if (this.fallT <= 0) { this.fallK = 0; return; }
    this.fallT = Math.max(0, this.fallT - dt);
    const age = FALL_DURATION - this.fallT;
    this.fallK = THREE.MathUtils.smoothstep(age, 0, 0.3) * (1 - THREE.MathUtils.smoothstep(age, 0.85, FALL_DURATION));
    if (!this.fallImpact && age >= 0.32) {
      this.fallImpact = true;
      const surface = this.level.floorAt(this.pos.x, this.pos.z);
      const position = this.pos.clone().setY(0.15);
      this.audio.bodyFall(position, surface);
      this.game.noise(position, { radius: 12 * (SURF_MUL[surface] || 1), visual: 8, source: 'player', kind: 'fall', color: COLORS.player, strength: 1.1, speed: 11 });
      this.shake = Math.max(this.shake || 0, 0.65);
      this.breathT = 1;
    }
  }

  reset(pos, yaw) {
    this.pitFall = null;
    this.touchMove = { x: 0, y: 0 };
    this.braceContact = null;
    this.pos.set(pos.x, 0, pos.z);
    this.yaw = yaw;
    this.pitch = 0;
    this.stamina = 1;
    this.breathCap = 1;
    this.holding = false;
    this.crouch = false;
    this.vel.set(0, 0, 0);
    this.frozen = false;
    this.lookTarget = null;
    this.hidden = null;
    this.clickCd = 0;
    this.clickStreak = 0;
    this.clickQuietT = 0;
    this.clearFall();
    this.eye = 1.65;
    this.camera.position.set(this.pos.x, this.eye, this.pos.z);
    this.camera.rotation.set(0, yaw, 0, 'YXZ');
    for (const p of this.projectiles) p.mesh.removeFromParent();
    this.projectiles = [];
  }

  hide(locker) {
    this.hidden = locker;
    this.vel.set(0, 0, 0);
    this.pos.copy(locker.inside);
    this.yaw = locker.yaw;
    this.hideYaw = locker.yaw;
    this.pitch = 0;
    this.crouch = false;
  }

  unhide() {
    if (!this.hidden) return;
    this.pos.copy(this.hidden.front);
    this.hidden = null;
  }

  look(dx, dy, sens) {
    if (this.frozen || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(sens) || sens <= 0) return;
    if (this.hidden) {
      // inside a locker you can only lean your eye to the slits
      this.yaw = THREE.MathUtils.clamp(this.yaw - dx * sens, this.hideYaw - 0.45, this.hideYaw + 0.45);
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -0.35, 0.3);
      return;
    }
    this.yaw -= dx * sens;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * sens));
  }

  forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  click() {
    if (this.clickCd > 0 || this.frozen || this.fallT > 0) return;
    this.clickCd = 0.55;
    // Repeated taps carry a recognisable rhythm farther than a single knock.
    // Only actual taps count; three seconds of silence break the pattern.
    this.clickStreak = Math.min(5, this.clickStreak + 1);
    this.clickQuietT = 3;
    const radius = 5 + (this.clickStreak - 1) * 6;
    this.audio.click();
    // the cane taps the floor ahead: the echo starts at its tip
    let p = this.camera.position.clone();
    if (this.vm) {
      this.vm.tap();
      p = this.vm.tipWorld();
      p.y = Math.max(0.05, p.y);
    }
    this.game.noise(p, { radius, visual: 10, source: 'player', kind: 'click', color: COLORS.click, speed: 13, strength: 0.68, decay: 2.1 });
  }

  throwStone(scene) {
    if (this.stones <= 0 || this.frozen || this.fallT > 0) return;
    this.stones--;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), this.level.mat.item);
    mesh.position.copy(this.camera.position).addScaledVector(dir, 0.4);
    scene.add(mesh);
    this.projectiles.push({ mesh, vel: dir.multiplyScalar(11).add(new THREE.Vector3(0, 2.2, 0)), bounces: 0, life: 4 });
    this.audio.whoosh();
  }

  updatePitFall(dt) {
    const f = this.pitFall, drift = f.advance(dt);
    // Keep the falling body inside the shaft instead of drifting through its lip.
    const x = this.pos.x + drift.x, z = this.pos.z + drift.z;
    if (this.level.isPit(x, z)) { this.pos.x = x; this.pos.z = z; }
    this.pos.y = f.y;
    this.vel.set(0, f.vy, 0);
    this.camera.position.set(this.pos.x, this.eye + f.y, this.pos.z);
    const pitch = THREE.MathUtils.lerp(this.pitch, -0.85, 1 - Math.exp(-f.time * 3));
    this.camera.rotation.set(pitch, this.yaw, Math.sin(f.time * 7) * 0.08, 'YXZ');
    this.headOffset?.set(0, 0, 0);
    this.updateProjectiles(dt);
  }

  update(dt, scene) {
    if (this.pitFall) { this.updatePitFall(dt); return; }
    this.updateFall(dt);
    this.clickCd -= dt;
    this.clickQuietT = Math.max(0, this.clickQuietT - dt);
    if (this.clickQuietT === 0) this.clickStreak = 0;
    const k = this.keys;
    let mx = 0, mz = 0;
    if (!this.frozen && this.fallT <= 0) {
      mx += this.touchMove?.x || 0;
      mz += this.touchMove?.y || 0;
      if (k.has('KeyW') || k.has('ArrowUp')) mz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) mz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    }
    this.listening = !this.frozen && this.fallT <= 0 && !this.hidden && k.has('KeyV');
    if (this.hidden || this.listening) mx = mz = 0;
    const analog = Math.min(1, Math.hypot(mx, mz));
    const want = new THREE.Vector3(mx, 0, mz);
    this.moving = want.lengthSq() > 0;
    this.running = this.moving && (k.has('ShiftLeft') || k.has('ShiftRight')) && this.stamina > 0.05 && !this.crouch;
    if (this.moving) want.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const speed = this.crouch ? 1.25 : this.running ? 4.4 : 2.3;
    this.vel.lerp(want.multiplyScalar(speed * analog), Math.min(1, dt * 10));

    const before = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    if (this.running && !this.hidden && this.fallT <= 0 && this.tripCooldown <= 0 && (this.game.psychosis || 0) >= 0.55 && this.runDistance > 0.65 && this.vel.length() > 3) {
      const hit = findTripObstacle(this.level, before, this.pos);
      if (hit) this.trip(hit);
    }
    if (!this.hidden) (this.level.collidePlayer || this.level.collide).call(this.level, this.pos, 0.3);
    if (!this.hidden && this.game.state === 'play' && this.level.isPit?.(this.pos.x, this.pos.z)) {
      this.pitFall = new PitFall(this.vel.x, this.vel.z);
      this.frozen = true;
      this.holding = this.listening = this.running = this.moving = false;
      this.lookTarget = null;
      this.clearFall();
      this.audio.gasp();
      this.game.noise(this.pos.clone().setY(this.eye), { radius: 7, visual: 9, source: 'player', kind: 'gasp', color: COLORS.breath, strength: 0.7, speed: 13 });
      this.updatePitFall(dt);
      return;
    }
    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.runDistance = this.running && this.fallT <= 0 ? this.runDistance + moved : 0;

    // stamina
    if (this.running) this.stamina = Math.max(0, this.stamina - dt * 0.12);
    else this.stamina = Math.min(1, this.stamina + dt * (this.moving ? 0.06 : 0.13));

    // footsteps
    this.stepAcc += moved;
    const stride = (this.stride = this.crouch ? 0.55 : this.running ? 1.1 : 0.78);
    if (this.fallT <= 0 && this.stepAcc > stride) {
      this.steps = (this.steps || 0) + 1;
      this.stepAcc = 0;
      this.footstep();
    }

    // breath hold
    const wantHold = !this.frozen && this.fallT <= 0 && (k.has('KeyQ') || k.has('Mouse2'));
    if (wantHold && this.breathCap > 0.02 && !this.holding) {
      this.holding = true;
      this.holdT = 0;
    }
    if (this.holding) {
      this.holdT += dt;
      this.breathCap = Math.max(0, this.breathCap - dt * (0.085 + (1 - this.stamina) * 0.08));
      if (this.breathCap <= 0) {
        this.holding = false;
        this.audio.gasp();
        this.game.noise(this.camera.position.clone(), { radius: 7, visual: 4, source: 'player', kind: 'gasp', color: COLORS.breath, strength: 0.7 });
        this.game.hint('Воздух кончился. Вдох вышел громким.');
        this.breathT = 0.8;
      } else if (!wantHold) {
        this.holding = false;
        if (this.holdT > 4) {
          this.audio.breath(true, 1.4);
          this.game.noise(this.camera.position.clone(), { radius: 2.2, visual: 2, source: 'player', kind: 'breath', color: COLORS.breath, strength: 0.4 });
        }
        this.breathT = 0.6;
      }
    } else {
      this.breathCap = Math.min(1, this.breathCap + dt * 0.14);
    }

    // natural breathing
    if (!this.holding && !this.frozen) {
      this.breathT -= dt;
      if (this.breathT <= 0) {
        this.breathOut = !this.breathOut;
        const tired = 1 - this.stamina;
        const rate = 1.6 - tired * 1.0;
        this.breathT = rate * (this.breathOut ? 1.1 : 0.9);
        const strength = 0.4 + tired * 1.2;
        this.audio.breath(this.breathOut, strength);
        if (this.breathOut) {
          const r = (2.4 + tired * 2.8) * (this.hidden ? 0.5 : 1);
          this.game.noise(this.camera.position.clone(), { radius: r, visual: 0.9 + tired, source: 'player', kind: 'breath', color: COLORS.breath, strength: 0.25 + tired * 0.3, speed: 4 });
        }
      }
    }

    // camera: a body, not a dolly. Spring-damped head that takes a kick on
    // every footfall, sways with breathing, and shakes when something heavy walks near.
    const lowCeil = this.level.ceilAt(Math.floor(this.pos.x), Math.floor(this.pos.z)) < 1.7;
    if (lowCeil) this.crouch = true;
    const standingEye = this.hidden && this.hidden.low ? 0.27 : this.crouch ? 1.0 : 1.65;
    const targetEye = Math.max(0.25, standingEye - this.fallK * 1.36);
    this.eye += (targetEye - this.eye) * Math.min(1, dt * (this.fallT > 0 ? 12 : 7));
    const sp = Math.hypot(this.vel.x, this.vel.z);
    const walk = Math.min(1, sp / 2.3);
    this.bob += dt * sp * 3.4;
    this.time = (this.time || 0) + dt;
    const T = this.time;
    const fear = Math.min(1.2, this.game.fear || 0);
    const tired = 1 - this.stamina;
    const MU = THREE.MathUtils;
    // smooth pseudo-noise (sum of incommensurate sines): drift, not jitter
    const sn = (t, o) => Math.sin(t * 1.13 + o) * 0.5 + Math.sin(t * 2.71 + o * 1.7) * 0.3 + Math.sin(t * 4.37 + o * 2.3) * 0.2;

    // ---- gait: an inverted pendulum. The head is lowest as the heel lands
    // (a sharp dip) and rides over the planted foot in a smooth arc; the
    // weight rocks from foot to foot.
    const stepF = (this.steps || 0) + Math.min(1, this.stepAcc / (this.stride || 0.78));
    const frac = stepF - Math.floor(stepF);
    this.gaitK = MU.lerp(this.gaitK || 0, this.moving && !this.hidden ? 1 : 0, Math.min(1, dt * 5));
    const gk = this.gaitK * MU.smoothstep(sp, 0.2, 1.4);
    const ampY = this.crouch ? 0.008 : this.running ? 0.03 : 0.006 + 0.011 * walk;
    const ampX = (this.crouch ? 0.014 : this.running ? 0.024 : 0.012 + 0.006 * walk) * 1.75; // the camera rides the chest: the torso rocks it
    const gaitY = (-Math.cos(Math.PI * 2 * frac) * 0.8 + (2 * Math.sin(Math.PI * frac) - 1) * 0.2) * ampY * gk;
    const gaitX = Math.sin(stepF * Math.PI) * ampX * gk;
    // springs: vertical (footfalls, crouching, stopping) and a small nod at each heel strike
    this.headV = this.headV || 0;
    this.headY = this.headY || 0;
    this.headV += (-150 * this.headY - 15 * this.headV) * dt;
    this.headY += this.headV * dt;
    this.nodV = this.nodV || 0;
    this.nod = this.nod || 0;
    this.nodV += (-120 * this.nod - 13 * this.nodV) * dt;
    this.nod += this.nodV * dt;
    if ((this.steps || 0) !== this.lastStepN) {
      this.lastStepN = this.steps || 0;
      this.nodV -= this.crouch ? 0.065 : this.running ? 0.26 : 0.11;
    }
    if (this.crouch !== this.wasCrouch) {
      this.headV -= this.crouch ? 0.5 : -0.25;
      this.wasCrouch = this.crouch;
    }
    // ---- breathing: chest rises, head drifts a little forward and back
    const bRate = 1.7 + tired * 2.6 + fear * 0.9;
    const breathAmp = (0.004 + tired * 0.012 + fear * 0.006) * (this.holding ? 0.12 : 1);
    const breathY = Math.sin(T * bRate) * breathAmp;
    const breathZ = Math.sin(T * bRate - 0.6) * breathAmp * 0.6;
    // ---- external shake (its footsteps, impacts): fast but smooth
    this.shake = Math.max(0, (this.shake || 0) - dt * 2.5);
    const sh = this.shake * this.shake;
    const shX = sn(T * 17, 1) * 0.014 * sh, shY = sn(T * 19, 4) * 0.014 * sh;
    // ---- tremor: fear, and a breath held too long
    const trem = fear * fear * 0.0022 + (this.holding ? MU.smoothstep(this.holdT, 4, 9) * 0.0028 : 0);
    const trX = sn(T * 13, 7) * trem, trY = sn(T * 15, 9) * trem;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.camera.position.set(this.pos.x + fx * breathZ, this.eye + this.headY + breathY + gaitY + shY + trY, this.pos.z + fz * breathZ);
    this.camera.position.x += fx * this.fallK * 0.12;
    this.camera.position.z += fz * this.fallK * 0.12;
    const side = gaitX + shX + trX;
    this.camera.position.x += Math.cos(this.yaw) * side;
    this.camera.position.z -= Math.sin(this.yaw) * side;
    // what the head adds on top of the body (the hands use it to stay with the body)
    this.headOffset = this.headOffset || new THREE.Vector3();
    this.headOffset.set(side, this.headY + breathY + gaitY + shY + trY, -breathZ);

    // ---- turning: the body leans into a turn; the head lags a hair and settles
    let dyaw = this.yaw - (this.prevYaw ?? this.yaw);
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    this.prevYaw = this.yaw;
    const turnRate = MU.clamp(dyaw / Math.max(dt, 1e-3), -6, 6);
    this.turnLean = MU.lerp(this.turnLean || 0, turnRate * 0.008 * (0.5 + walk), Math.min(1, dt * 6));
    this.lagV = this.lagV || 0;
    this.lag = this.lag || 0;
    this.lagV += (-75 * this.lag - 8 * this.lagV - turnRate * 0.14) * dt;
    this.lag = MU.clamp(this.lag + this.lagV * dt, -0.042, 0.042);
    // ---- speeding up tips the head back, stopping throws it forward and down
    const acc = (sp - (this.prevSp ?? sp)) / Math.max(dt, 1e-3);
    this.prevSp = sp;
    this.accV = this.accV || 0;
    this.accP = this.accP || 0;
    this.accV += (-90 * this.accP - 12 * this.accV + MU.clamp(acc, -25, 25) * 0.05) * dt;
    this.accP += this.accV * dt;
    if (acc < -12) this.headV -= Math.min(0.15, -acc * 0.004) * dt * 60;
    // ---- stumbling when you run yourself out
    const stumble = this.running && this.stamina < 0.3 ? (0.3 - this.stamina) * 0.05 : 0;
    const stP = stumble * sn(T * 6, 3);
    // ---- rotation. The eyes keep the view steady: most of the bob is
    // translation, the gaze compensates for it (looking at a point ~6 m ahead)
    this.roll = MU.lerp(this.roll || 0, -mx * 0.03 * walk - gaitX * 0.85 + sn(T * 3.1, 11) * 0.006 * gk + this.turnLean + stP * 0.6 + (this.listening ? 0.075 : 0), Math.min(1, dt * 8));
    const runPitch = this.running ? -0.04 : this.crouch && this.moving ? -0.02 : 0;
    this.runPitch = MU.lerp(this.runPitch || 0, runPitch, Math.min(1, dt * 4));
    const idle = 1 - gk;
    const drift = 0.0034 * idle + 0.0026 * gk + fear * 0.006;
    const swayP = sn(T * 0.45, 0) * drift + sn(T * 2.3, 6) * 0.0045 * gk - gaitY / 9 + this.headY * 0.4 + this.nod - this.accP + stP + sh * sn(T * 23, 2) * 0.012;
    const swayY = sn(T * 0.37, 5) * drift - gaitX * 0.3 + this.lag;
    if (!this.lookTarget) {
      const fovT = 80 + (this.running ? 6 : 0) - (this.holding ? 3 : 0) - (this.listening ? 4 : 0);
      if (Math.abs(this.camera.fov - fovT) > 0.05) {
        this.camera.fov += (fovT - this.camera.fov) * Math.min(1, dt * 4);
        this.camera.updateProjectionMatrix();
      }
    }
    if (this.lookTarget) {
      const m = new THREE.Matrix4().lookAt(this.camera.position, this.lookTarget, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.camera.quaternion.slerp(q, Math.min(1, dt * 10));
    } else {
      const viewPitch = MU.lerp(this.pitch + swayP + this.runPitch, -1.25, this.fallK);
      // Gait and impact offsets must never tip the view past the vertical axis.
      this.camera.rotation.set(MU.clamp(viewPitch, -1.48, 1.45), this.yaw + swayY, this.roll + this.fallSide * this.fallK * 0.12, 'YXZ');
    }

    this.updateProjectiles(dt);
  }

  footstep() {
    this.headV = (this.headV || 0) - (this.crouch ? 0.04 : this.running ? 0.17 : 0.07);
    const surf = this.level.floorAt(this.pos.x, this.pos.z);
    const mul = SURF_MUL[surf] ?? 1;
    const base = this.crouch ? 1.1 : this.running ? 9 : 3.8;
    const radius = base * mul;
    const loud = this.crouch ? 0.15 : this.running ? 1.3 : 0.6;
    this.audio.step(surf, loud * Math.min(1.4, mul));
    const p = new THREE.Vector3(this.pos.x, 0.05, this.pos.z);
    this.game.noise(p, {
      radius, visual: Math.max(1.8, radius), source: 'player', kind: this.crouch ? 'crouch' : this.running ? 'run' : 'step',
      color: COLORS.player, strength: this.crouch ? 0.55 : 0.9, speed: this.running ? 12 : 9, decay: 0.9,
    });
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.vel.y -= 9.8 * dt;
      const m = p.mesh;
      const prev = m.position.clone();
      m.position.addScaledVector(p.vel, dt);
      m.rotation.x += dt * 9;
      m.rotation.z += dt * 7;
      const c = m.position;
      const room = this.level.open(Math.floor(c.x), Math.floor(c.z));
      const ceil = room ? this.level.ceilAt(Math.floor(c.x), Math.floor(c.z)) : 0;
      let hit = false;
      if (!room || c.y >= ceil) {
        // bounce off wall/ceiling
        m.position.copy(prev);
        if (!room) {
          p.vel.x *= -0.35;
          p.vel.z *= -0.35;
        } else p.vel.y *= -0.3;
        hit = true;
      } else if (c.y <= 0.06) {
        c.y = 0.06;
        p.vel.y *= -0.3;
        p.vel.x *= 0.5;
        p.vel.z *= 0.5;
        hit = true;
      } else if (c.y < 1.4 && this.level.blockedPoint(c.x, c.z, 0.05)) {
        m.position.copy(prev);
        p.vel.x *= -0.3;
        p.vel.z *= -0.3;
        hit = true;
      }
      if (hit && p.vel.length() > 1.2) {
        p.bounces++;
        const loud = p.bounces === 1 ? 1 : 0.5;
        this.audio.impact(m.position, loud);
        this.game.noise(m.position.clone(), { radius: 10 * loud, visual: 10 * loud, source: 'stone', kind: 'stone', color: COLORS.stone, strength: 1.2 * loud, speed: 12 });
      }
      if (p.life <= 0 || (p.bounces > 0 && p.vel.length() < 0.6)) {
        m.removeFromParent();
        this.projectiles.splice(i, 1);
      }
    }
  }
}
