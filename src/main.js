import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { echo, COLORS, createDust, setRelief, setListen, pomScale } from './echo.js';
import { AudioEngine } from './audio.js';
import { Level } from './level.js';
import { Player } from './player.js';
import { Monster } from './monster.js';
import { INTRO, NOTES, TIPS, CAVE_ENDING } from './story.js';
import { Siege, SIEGE_TIME } from './siege.js';
import { ViewModel } from './viewmodel.js';
import { Extras } from './extras.js';
import { front } from './frontend.js';
import { createCrtInterface } from './crt-interface.js';
import { GeneratorSequence, FUSE_ACTIONS } from './interaction-sequence.js';
import { GeneratorProps } from './work-props.js';
import { RoomVisibility } from './room-visibility.js';
import { createTouchControls } from './touch-controls.js';
import { CaveLevel } from './cave-level.js';
import { CaveChapter } from './cave-chapter.js';
import { MouseLook } from './mouse-look.js';
import { LIFT_OFFSET } from './lift-asset.js';

const $ = (id) => document.getElementById(id);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Install progress callbacks before constructing anything that requests textures.
const failedTextures = [];
let menuReady = false;
THREE.DefaultLoadingManager.onProgress = (_url, done, total) => {
  front.progress('Загрузка материалов', done / total, `Материалы: ${done} / ${total}`);
};
THREE.DefaultLoadingManager.onError = (url) => failedTextures.push(url);
THREE.DefaultLoadingManager.onLoad = () => {
  if (failedTextures.length) {
    front.fail('Некоторые материалы не загрузились. Проверьте соединение и повторите загрузку.', () => location.reload());
  } else {
    menuReady = true;
    front.saveAvailable(!!loadSave());
    let restarting = false;
    try {
      restarting = sessionStorage.getItem('echo.new-session') === '1';
      sessionStorage.removeItem('echo.new-session');
    } catch (_) {}
    if (restarting) boot(false);
    else front.assetsReady();
  }
};

// ------------------------------------------------------------------ render
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000);
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 120);
camera.rotation.order = 'YXZ';

const composer = new EffectComposer(renderer);
const worldPass = new RenderPass(scene, camera);
composer.addPass(worldPass);
// contact shadows in corners, under furniture, in the folds of bodies
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.output = GTAOPass.OUTPUT.Default;
// walls are single faces seen from either side, and their winding doesn't always
// agree with their normals: draw every face, with the normal turned toward the
// eye — otherwise AO "sees" the rooms behind a wall, or blackens the wall itself
gtao.normalMaterial = new THREE.ShaderMaterial({
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vV;
    void main() { vec3 n = normalize(vN); if (dot(n, vV) < 0.0) n = -n; gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); }`,
  side: THREE.DoubleSide,
  blending: THREE.NoBlending,
});
gtao.blendIntensity = 0.85;
gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
// AO is soft by nature: compute it at half resolution (the denoiser hides the difference)
{
  const setSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  gtao.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
}
composer.addPass(gtao);
// view-model (hands + cane) drawn on top so it never clips into walls
const vm = new ViewModel();
const vmPass = new RenderPass(vm.scene, camera);
vmPass.clear = false;
vmPass.clearDepth = true;
// the implant lags: images linger and smear as they fade (the world only —
// your own hands are drawn after it and stay crisp)
const afterimage = new AfterimagePass(0.42);
// psychosis: as it builds, every lingering copy loses its green and blue a little
// each frame, so the older the trail the redder it bleeds
afterimage.uniforms.uRed = { value: 0 };
afterimage.compFsMaterial.fragmentShader = `
  uniform float damp; uniform float uRed;
  uniform sampler2D tOld; uniform sampler2D tNew;
  varying vec2 vUv;
  vec4 when_gt(vec4 x, float y) { return max(sign(x - y), 0.0); }
  void main() {
    vec4 texelOld = texture2D(tOld, vUv);
    vec4 texelNew = texture2D(tNew, vUv);
    // the picture here is dim (linear values mostly under 0.1), so the cut-off that
    // ends a trail works on brightness, low enough for trails to show at all
    float lo0 = dot(texelOld.rgb, vec3(0.3, 0.55, 0.15));
    texelOld *= damp * step(0.035, lo0);
    // the copy shows where it is brighter than what is there now — the trail —
    // judged by its red (which it keeps), and drawn as it is, tint and all
    float lo = max(texelOld.r, dot(texelOld.rgb, vec3(0.3, 0.55, 0.15))), ln = dot(texelNew.rgb, vec3(0.3, 0.55, 0.15));
    texelOld.gb *= 1.0 - uRed;
    gl_FragColor = vec4(lo > ln ? texelOld.rgb : texelNew.rgb, 1.0);
  }`;
afterimage.compFsMaterial.needsUpdate = true;
composer.addPass(afterimage);
// (distance haze is drawn by the echo shader itself, where the distance is known)
composer.addPass(vmPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.26, 0.6, 0.3);
// the glow is a blur anyway: half resolution costs half and looks the same
{
  const setSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  bloom.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
}
composer.addPass(bloom);
const fx = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uInterface: { value: 0 },
    uGlitch: { value: 0 },
    uWhite: { value: 0 },
    uFear: { value: 0 },
    uFlash: { value: 0 },
    uRes: { value: new THREE.Vector2(innerWidth, innerHeight) },
    uBlur: { value: new THREE.Vector2() },
    uGlassOffset: { value: new THREE.Vector2() },
    uExposure: { value: 1 },
    uSmear: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uInterface; uniform float uTime, uFear, uFlash, uGlitch, uWhite; uniform vec2 uRes; uniform vec2 uBlur; uniform vec2 uGlassOffset; uniform float uExposure; uniform float uSmear; varying vec2 vUv;
    float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      // wide body-camera lens: strong barrel, rescaled so the frame stays filled
      float kb = 0.3 + uFear * 0.12;
      vec2 uv = 0.5 + c * (1.0 + kb * dot(c, c)) / (1.0 + kb * 0.25);
      uv.x += sin(uv.y * 40.0 + uTime * 30.0) * 0.0015 * uFear * uFear;
      float band = floor(uv.y * 34.0) + floor(uTime * 24.0) * 7.0;
      uv.x += (rand(vec2(band, 1.0)) - 0.5) * 0.12 * uGlitch * step(0.62, rand(vec2(band, 2.0)));
      uv.y += (rand(vec2(floor(uTime * 24.0), 3.0)) - 0.5) * 0.03 * uGlitch;
      // cheap-lens fringing, growing toward the edges; motion smear along the camera's swing
      vec2 ca = c * (0.0015 + dot(c, c) * (0.021 + uSmear * uSmear * 0.03) + uFear * 0.006 + uGlitch * 0.03); // the fringe tears wider in a psychosis
      ca *= mix(1.0, 0.08, uInterface);
      vec3 col;
      if (dot(uBlur, uBlur) < 1e-7) col = vec3(texture2D(tDiffuse, uv + ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - ca).b);
      else {
        col = vec3(0.0);
        for (int i = 0; i < 7; i++) {
          vec2 o = uBlur * (float(i) / 6.0 - 0.5);
          col += vec3(texture2D(tDiffuse, uv + o + ca).r, texture2D(tDiffuse, uv + o).g, texture2D(tDiffuse, uv + o - ca).b);
        }
        col /= 7.0;
      }
      col *= uExposure;
      // phosphor bleed: the beam spreads a little along the scanline
      vec2 px = vec2(1.0 / uRes.x, 0.0);
      vec3 bleed = (texture2D(tDiffuse, uv + px * 1.5).rgb + texture2D(tDiffuse, uv - px * 1.5).rgb) * 0.5;
      bleed += (texture2D(tDiffuse, uv + px * 4.0).rgb + texture2D(tDiffuse, uv - px * 4.0).rgb) * 0.25;
      col = col + max(bleed - col, 0.0) * 0.45;
      // halation: bright light picks up a warm fringe
      float hl = max(max(bleed.r, bleed.g), bleed.b);
      col += vec3(0.07, 0.025, 0.01) * smoothstep(0.25, 0.9, hl);
      float vig = mix(1.0, smoothstep(0.92, 0.12, length(c - uGlassOffset) * (1.0 + uFear * 0.6)), 0.85);
      col *= vig;
      // filmic shoulder before the tube eats its share of the light
      col = col * (1.0 + col * 0.15) / (1.0 + col * 0.6);
      col *= 1.02;
      // lift the mid-greys (black stays black: silence stays dark)
      col = pow(max(col, 0.0), vec3(0.84));
      // high-res CRT: scanlines, aperture-grille phosphors, slow refresh bar, faint interlace
      float sl = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.5);
      float slDepth = mix(0.38, 0.24, smoothstep(0.1, 0.7, dot(col, vec3(0.33))));
      slDepth *= mix(1.0, 0.55, uInterface);
      col *= ((1.0 - slDepth) + slDepth * 2.0 * sl * 0.92) * (1.0 + slDepth * 0.25);
      float m3 = mod(gl_FragCoord.x, 3.0);
      vec3 mask = m3 < 1.0 ? vec3(1.0, 0.84, 0.84) : m3 < 2.0 ? vec3(0.84, 1.0, 0.84) : vec3(0.84, 0.84, 1.0);
      col *= mix(vec3(1.0), mask, 0.8) * 1.08;
      float bar = smoothstep(0.14, 0.0, abs(fract(vUv.y * 0.6 - uTime * 0.07) - 0.5));
      col *= 1.0 + bar * 0.08;
      col *= 1.0 - 0.025 * step(0.5, fract(gl_FragCoord.y * 0.25 + floor(uTime * 30.0) * 0.5));
      col += (rand(vUv * uRes + fract(uTime * 7.13)) - 0.5) * (0.016 + uFear * 0.04) * mix(1.0, 0.22, uInterface);
      // tube corners and the dark glass at the very edge
      // The glass lip sits closer than the vignette; the outer bezel stays fixed.
      vec2 cc = abs(uv - 0.5 - uGlassOffset * 0.45) * 2.0;
      float corner = smoothstep(1.0, 0.93, max(cc.x, cc.y) + pow(min(cc.x, cc.y), 6.0) * 0.06);
      float rim = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      corner *= smoothstep(0.0, 0.012, rim);
      col *= corner;
      // grade: drained and cold in the shadows, near-neutral in the light;
      // blood keeps its colour while everything else is drained
      float gl = dot(col, vec3(0.3, 0.55, 0.15));
      float redness = smoothstep(0.015, 0.09, col.r - max(col.g, col.b));
      col = mix(vec3(gl), col, mix(0.42, 1.15, redness));
      vec3 shadowT = vec3(0.86, 0.97, 1.08), lightT = vec3(1.03, 1.0, 0.95);
      col *= mix(shadowT, lightT, smoothstep(0.05, 0.6, gl));
      // soft toe: deep shadow keeps a trace of shape instead of crushing to black
      col = col * 1.02 + vec3(0.004) * smoothstep(0.0, 0.03, dot(col, vec3(0.33)));
      float lum = max(max(col.r, col.g), col.b);
      col = mix(col, vec3(lum * 1.4 + 0.25, 0.0, 0.0), uFlash * 0.8);
      col = mix(col, vec3(1.0, 0.92, 0.9) - col * 0.6, uWhite);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
// anti-alias the scene first, then lay the CRT over it (so the mask stays sharp)
const smaa = new SMAAPass(Math.max(1, innerWidth * renderer.getPixelRatio()), Math.max(1, innerHeight * renderer.getPixelRatio()));
composer.addPass(smaa);
// UI is composited BEFORE the lens/CRT pass so the whole screen shares its
// convex glass, phosphor mask, scanlines, fringing and vignette.
const menuBackground = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const crtInterface = createCrtInterface(() => 0.3 + (game.state === 'menu' ? 0 : fx.uniforms.uFear.value * 0.12));
const uiPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uInterface: { value: null }, uBackground: { value: null }, uCachedBackground: { value: 0 }, uShowInterface: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D uInterface; uniform sampler2D uBackground; uniform float uCachedBackground; uniform float uShowInterface; varying vec2 vUv;
    void main() {
      vec4 world = uCachedBackground > 0.5 ? texture2D(uBackground, vUv) : texture2D(tDiffuse, vUv);
      vec4 ui = texture2D(uInterface, vUv);
      ui.a *= uShowInterface;
      // Blend DOM scrims in display space, then return to the linear pipeline.
      vec3 displayWorld = pow(max(world.rgb, vec3(0.0)), vec3(1.0 / 2.2));
      vec3 displayUI = pow(max(ui.rgb, vec3(0.0)), vec3(1.0 / 2.2));
      gl_FragColor = vec4(pow(mix(displayWorld, displayUI, ui.a), vec3(2.2)), 1.0);
    }`,
});
uiPass.uniforms.uInterface.value = crtInterface.texture;
uiPass.uniforms.uBackground.value = menuBackground.texture;
uiPass.enabled = false;
composer.addPass(uiPass);
composer.addPass(fx);
composer.addPass(new OutputPass());
// The menu keeps a CSS-resolution postprocess chain. Retina game buffers and
// gameplay passes stay allocated and unchanged, so returning to play is cheap.
const menuComposer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, depthBuffer: false }));
menuComposer.setPixelRatio(1);
menuComposer.addPass(uiPass);
menuComposer.addPass(fx);
menuComposer.addPass(new OutputPass());

addEventListener('resize', () => {
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  menuComposer.setSize(innerWidth, innerHeight);
  fx.uniforms.uRes.value.set(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ world
const audio = new AudioEngine();
const level = new Level(scene);
const generatorProps = new GeneratorProps(scene);
const staticBatches=[];
scene.traverse(o=>{if(o.userData.staticBatch)staticBatches.push(o);});
let roomVisibility=new RoomVisibility(level,staticBatches);
const dust = createDust();
scene.add(dust);
audio.occlusion = (pos) => player.level.occlusion(camera.position, pos);

let roomK = 1; // 0.55 in a cupboard of a room .. 1 in corridors and halls
const game = {
  state: 'menu', // menu | play | paused | note | dying | dead | end
  flags: {},
  time: 0,
  deaths: 0,
  checkpoint: null,
  fear: 0,
  psychosis: 0,
  noise(pos, o) {
    const soft = o.source === 'player' ? roomK : 1;
    echo.emit(pos, { radius: o.visual ?? o.radius, speed: o.speed ?? 11, strength: (o.strength ?? 1) * soft, decay: o.decay ?? 0.8, color: o.color ?? COLORS.player });
    if (o.source && monster.active) monster.hear(pos, o.radius, o.source, o.kind, player.pos);
    // "it doesn't repeat. It answers": now and then your tap comes back from where it is
    if (o.source === 'player' && o.kind === 'click' && monster.active && !siege.active && monster.state !== 'chase') {
      const md = monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z));
      if (md > 6 && md < 28 && Math.random() < 0.35) {
        later(0.4 + Math.random() * 0.35, () => {
          if (!monster.active) return;
          audio.monsterClick(monster.headWorld);
          echo.emit(monster.headWorld.clone(), { radius: 8, speed: 13, strength: 0.9, decay: 0.6, color: COLORS.monster });
          if (!game.flags.answerHint) {
            game.flags.answerHint = true;
            later(1.2, () => game.hint('Твой щелчок вернулся. Не оттуда, откуда должен. [V] — вслушайся.', 4.5));
          }
        });
      }
    }
    if (o.source === 'player' && siege && siege.active) siege.heard(o.radius);
  },
  hint(text, dur = 4.5, urgent = false) {
    if (urgent) {
      hintQueue.length = 0;
      hintT = 0;
      $('hint').textContent = text;
      $('hint').style.opacity = 1;
      hintT = dur;
      return;
    }
    hintQueue.push({ text, dur });
  },
};

// timers that run on game time (frozen while paused or dead)
const timers = [];
const later = (sec, fn) => timers.push({ t: sec, fn });
function updateTimers(dt) {
  for (let i = timers.length - 1; i >= 0; i--) {
    timers[i].t -= dt;
    if (timers[i].t <= 0) {
      const f = timers[i].fn;
      timers.splice(i, 1);
      f();
    }
  }
}

const player = new Player(camera, level, audio, game);
player.vm = vm;
let touchCd = 0;
vm.onTouch = (p) => {
  if (touchCd > 0) return;
  touchCd = 1.2;
  // palm on cold plaster: a soft slap you can almost see
  audio.play('flesh', p, { gain: 0.2, rate: 1.9, wet: 0.2, vary: 0.1 });
  echo.emit(p, { radius: 1.3, speed: 4, strength: 0.7, decay: 1.4, color: COLORS.player });
};
const monster = new Monster(scene, level, audio);
monster.onKill = () => die();
monster.onWise = () => {
  if (game.flags.wiseHint) return;
  game.flags.wiseHint = true;
  game.hint('Оно больше не идёт на камни. Оно идёт туда, откуда их бросают.', 4.5, true);
};
const extras = new Extras({ level, audio, game, player, scene });
extras.build();
extras.monster = monster;
const hospitalObjects=[...scene.children];
const caveRoot=new THREE.Group();caveRoot.visible=false;scene.add(caveRoot);
const caveLevel=new CaveLevel(caveRoot);
caveLevel.bindOriginalLift(level);
const caveBatches=[];caveRoot.traverse(o=>{if(o.userData.staticBatch)caveBatches.push(o);});
const caveVisibility=new RoomVisibility(caveLevel,caveBatches);
// Open caverns have wide cyclic sightlines; the hospital's cell portal solver
// is intended for narrow corridors. Mesh frustum culling still applies here.
caveVisibility.enabled=false;
caveVisibility.stats.visible=caveBatches.length;
const chapter=new CaveChapter({level:caveLevel,root:caveRoot,game,player,monster,audio,vm,save:saveCaveCheckpoint,complete:finishCave,hide:toggleHiding});
function startCave(saved=null,entry=null){
  cancelWork();timers.length=0;hintQueue.length=0;resetObjective();
  siege.stop();
  for(const obj of hospitalObjects)if(obj!==monster.obj&&obj!==dust)obj.visible=false;
  monster.despawn();
  for(const loop of [waterLoop,generator,lift,drone])if(loop)loop.setGain(0,.1);
  roomVisibility=caveVisibility;echo.clear();chapter.start(saved,entry);
  psyMem=psyFlare=smear=glitchT=0;
  $('location').textContent='';$('location').style.opacity=0;
  $('hud').classList.remove('hidden');$('slits').classList.add('hidden');
}
function saveCaveCheckpoint(){
  game.cpDeaths=0;applyAssist(); // a new checkpoint lifts the easing, as in chapter I
  const data={v:1,chapter:'cave',cave:chapter.snapshot(),time:game.time,deaths:game.deaths};
  game.checkpoint=data;
  try{localStorage.setItem('echo.save',JSON.stringify(data));}catch(_){}
}
function finishCave(){
  game.state='end';player.frozen=true;vm.work=null;
  clearSave();$('fade').style.opacity=1;
  if(document.pointerLockElement)document.exitPointerLock();
  $('hud').classList.add('hidden');$('end').classList.remove('hidden');
  $('end-text').innerHTML=CAVE_ENDING.map((text,i)=>`<p style="animation-delay:${i*1.8}s">${text}</p>`).join('');
  $('end-stats').textContent=`ГОРИЗОНТ −11 ПРОЙДЕН · смертей: ${game.deaths}`;
}
let chaseHinted = false;
monster.onChase = (on) => {
  if (on) {
    player.shake = Math.max(player.shake || 0, 0.8);
    if (!chaseHinted) {
      chaseHinted = true;
      game.hint('Оно гонится. Беги [Shift], захлопни дверь, спрячься в шкафчик или уйди в вентканал.', 5, true);
    }
  }
};
monster.onBash = (d) => {
  player.shake = Math.max(player.shake || 0, Math.max(0, 1 - d.center.distanceTo(camera.position) / 9));
};

// ---- lift hall siege
const radarCtx = () => document.getElementById('radar-c').getContext('2d');
let radarT = 0, radarNode = null;
const siegeUI = {
  show(v) {
    $('hud').classList.toggle('siege-active', v);
    $('siege').classList.toggle('hidden', !v);
    $('brief').classList.toggle('hidden', !v);
    if (v) later(14, () => $('brief').classList.add('hidden'));
    if (!v) $('radar').classList.add('hidden');
  },
  update(sg) {
    const lowered = ['A', 'B', 'C'].find(k => sg.shut[k]);
    const p = Math.min(1, sg.t / SIEGE_TIME);
    $('sg-lift').style.width = `${p * 100}%`;
    $('sg-floor').textContent = sg.arrived ? 'ЗДЕСЬ' : sg.stalled ? 'СТОП' : `${Math.ceil(sg.remaining)} с`;
    const hpOf = (k) => (sg.broken[k] > 0 ? 'ВЫРВАНА' : `${Math.ceil(sg.hp[k])}%`);
    $('sg-power').style.width = `${lowered ? sg.hp[lowered] : 0}%`;
    $('sg-power').classList.toggle('low', lowered && sg.hp[lowered] < 30);
    $('sg-pw').textContent = lowered === 'A' ? 'ДВЕРЬ' : lowered === 'B' ? 'ЛЮК' : lowered === 'C' ? 'СЛЕВА' : '—';
    $('sg-charge').style.width = `${sg.power}%`;
    $('sg-charge').classList.toggle('low', sg.power < 25);
    $('sg-charge-value').textContent = sg.powerLocked ? '—' : `${Math.ceil(sg.power)}%`;
    for (const [i, k] of ['A', 'B', 'C'].entries()) {
      $(`sg-${k}`).textContent = `${['ДВЕРЬ', 'ЛЮК', 'СЛЕВА'][i]} ${sg.shut[k] ? '▼' : '▲'} ${hpOf(k)} [${i + 1}]`;
      $(`sg-${k}`).classList.toggle('shut', sg.shut[k]);
    }
    $('sg-warn').textContent = sg.phase === 'inside' && sg.monsterInHall ? 'ОНО В ХОЛЛЕ' : sg.phase === 'squeeze' ? 'ЛЕЗЕТ ВНУТРЬ' : sg.stalled ? 'ЛИФТ ВСТАЛ · КНОПКА ВЫЗОВА' : sg.powerLocked ? 'ПРИВОД ОСТЫВАЕТ' : sg.bracing ? 'ПОДПИРАЕШЬ ЗАСЛОНКУ' : sg.phase === 'ram' ? (sg.route === 'A' ? 'БЬЁТСЯ В ДВЕРЬ' : sg.route === 'B' ? 'БЬЁТСЯ В ЛЮК' : 'БЬЁТСЯ СЛЕВА') : '';
  },
};
function drawRadar(node) {
  const c = radarCtx();
  c.clearRect(0, 0, 240, 240);
  // map x 2..32, z -2..20 onto the dial
  const X = (x) => 20 + ((x - 2) / 30) * 200, Y = (z) => 40 + ((z + 1) / 21) * 160;
  c.strokeStyle = '#2c4';
  c.lineWidth = 1.5;
  c.strokeRect(X(4), Y(3), X(13) - X(4), Y(13) - Y(3)); // hall
  c.strokeRect(X(13), Y(7), X(22) - X(13), Y(10) - Y(7)); // corridor
  c.strokeRect(X(22), Y(3), X(32) - X(22), Y(14) - Y(3)); // generator room
  c.strokeRect(X(1), Y(7), X(3) - X(1), Y(16) - Y(7)); // west service passage
  c.strokeRect(X(3), Y(7), X(4) - X(3), Y(10) - Y(7));
  c.strokeRect(X(3), Y(14), X(7) - X(3), Y(16) - Y(14));
  c.setLineDash([4, 3]);
  c.strokeRect(X(7.05), Y(13), X(7.95) - X(7.05), Y(19) - Y(13)); // duct
  c.setLineDash([]);
  c.fillStyle = '#2c4';
  c.beginPath();
  c.arc(X(player.pos.x), Y(player.pos.z), 3, 0, 7);
  c.fill();
  if (node) {
    c.fillStyle = '#f33';
    c.shadowColor = '#f33';
    c.shadowBlur = 12;
    c.beginPath();
    c.arc(X(node.pos.x), Y(node.pos.z), 6, 0, 7);
    c.fill();
    c.shadowBlur = 0;
  }
}
let siege = null;
siege = new Siege({ audio, level, game, player, monster, ui: siegeUI });
game.onLiftArrived = () => liftArrive();
game.onLiftStall = () => { if (lift) lift.setGain(0, 0.15); };
game.onLiftRestart = () => { if (lift) lift.setGain(1, 0.4); };
level.onShutter = (d, closed) => {
  const p = d.obj.position.clone();
  audio.play('door', p, { gain: 0.7, rate: closed ? 1.15 : 1.3, wet: 0.5 });
  later(closed ? 0.95 : 0.7, () => audio.play('slam', p, { gain: closed ? 0.6 : 0.3, rate: 1.2, wet: 0.6 }));
};

// ------------------------------------------------------------------ input
let sens = +$('sens').value;
let pointerLocked = false;
const mouseLook = new MouseLook((dx,dy,sensitivity)=>player.look(dx,dy,sensitivity));
const canvas = renderer.domElement;

addEventListener('keydown', (e) => {
  if (e.code === 'Tab' && (game.state === 'play' || game.state === 'note')) e.preventDefault();
  if (game.state === 'play') player.keys.add(e.code);
  if (e.repeat) return;
  if (game.state === 'play') {
    if (e.code === 'Escape') { pause(); return; }
    if (player.fallT > 0) return;
    if (e.code === 'KeyF' && !vm.work) player.click();
    if (e.code === 'KeyC' && !(player.crouch && player.level.ceilAt(Math.floor(player.pos.x), Math.floor(player.pos.z)) < 1.7)) player.crouch = !player.crouch;
    if (e.code === 'KeyE') interact();
    if (e.code === 'KeyG' && !vm.work && extras.throwClock(camera)) vm.throw('clock');
    if (siege && siege.active && ['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) {
      $('brief').classList.add('hidden');
      const gate = { Digit1: 'A', Digit2: 'B', Digit3: 'C' }[e.code];
      if (gate) {
        const it = level.items.find((i) => i.type === `shutter${gate}`);
        if (it && it.pos.distanceTo(camera.position) < 3) vm.act('press', it.pos);
        siege.toggle(gate);
      }
      if (e.code === 'Digit4') {
        const n = siege.ping();
        if (n) {
          radarNode = n;
          radarT = 3;
          $('radar').classList.remove('hidden');
        }
      }
    }
  } else if (game.state === 'note' && (e.code === 'KeyE' || e.code === 'Escape')) closeNote();
});
addEventListener('keyup', (e) => player.keys.delete(e.code));
addEventListener('blur', () => {player.keys.clear();mouseLook.reset();});
document.addEventListener('visibilitychange', () => {if(document.hidden)mouseLook.reset();});

canvas.addEventListener('mousedown', (e) => {
  if (game.state !== 'play' && game.state !== 'note') return;
  if (player.fallT > 0) return;
  if (!pointerLocked) {
    mouseLook.beginDrag(e.clientX,e.clientY);
    lock();
  }
  if (e.button === 0 && game.state === 'play' && pointerLocked && !vm.work) {
    if (player.stones > 0 && !player.frozen) vm.throw();
    player.throwStone(scene);
  }
  if (e.button === 2) player.keys.add('Mouse2');
});
addEventListener('mouseup', (e) => {
  if (e.button === 2) player.keys.delete('Mouse2');
  mouseLook.endDrag();
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (game.state !== 'play' && game.state !== 'note') return;
  mouseLook.move(e,0.0012*sens);
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  mouseLook.setLocked(pointerLocked);
  if (!pointerLocked && (game.state === 'play' || game.state === 'note')) pause();
});

function lock() {
  if (touchControls?.enabled) return;
  try {
    const r = canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  } catch (_) {}
}

$('sens').addEventListener('input', (e) => (sens = +e.target.value));

// ---- graphics quality
const QUALITY = {
  high: { pr: 1.5, smaa: true, dust: true, bloom: true, ao: true },
  mid: { pr: 1.0, smaa: true, dust: true, bloom: true, ao: true },
  low: { pr: 0.75, smaa: false, dust: false, bloom: false, ao: false },
};
function applyQuality(q) {
  const Q = QUALITY[q] || QUALITY.high;
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr));
  composer.setPixelRatio ? composer.setPixelRatio(Math.min(devicePixelRatio, Q.pr)) : null;
  composer.setSize(innerWidth, innerHeight);
  smaa.enabled = Q.smaa;
  bloom.enabled = Q.bloom;
  gtao.enabled = Q.ao;
  setRelief(Q.ao ? 1 : 0); // parallax relief on mid and high
  dust.visible = Q.dust;
  document.querySelectorAll('.quality').forEach((el) => (el.value = q));
  try { localStorage.setItem('echo.quality', q); } catch (_) {}
}
let savedQ = 'high';
try { savedQ = localStorage.getItem('echo.quality') || 'high'; } catch (_) {}
document.querySelectorAll('.quality').forEach((el) => el.addEventListener('change', (e) => applyQuality(e.target.value)));

$('vol').addEventListener('input', (e) => { if (audio.ctx && audio.master) audio.setMaster(+e.target.value, 0.05); });

// ------------------------------------------------------------------ UI
const hintQueue = [];
let hintT = 0;
function updateHint(dt) {
  hintT -= dt;
  if (hintT <= 0) {
    $('hint').style.opacity = 0;
    if (hintT < -0.8 && hintQueue.length) {
      const h = hintQueue.shift();
      $('hint').textContent = h.text;
      $('hint').style.opacity = 1;
      hintT = h.dur;
    }
  }
}

let lastRoom = null;
let locT = 0;
function updateLocation(dt) {
  const r = level.roomAt(player.pos.x, player.pos.z);
  if (r && r !== lastRoom) {
    lastRoom = r;
    if (!visited.has(r.name)) {
      $('location').textContent = r.name.toUpperCase();
      $('location').style.opacity = 1;
      locT = 2.5;
    }
    onEnterRoom(r.name);
  }
  locT -= dt;
  if (locT <= 0) $('location').style.opacity = 0;
}

function objective() {
  if(chapter.active)return chapter.objective();
  const f = game.flags;
  if (f.arrived) return 'Войди в лифт.';
  if (siege?.stalled) return 'Лифт встал. Удерживай [E] у кнопки вызова, чтобы перезапустить.';
  if (f.called) return 'Дождись лифта. Не дай ему войти в холл.';
  if (f.powered) return 'Лифтовый холл, запад от генераторной: вызвать лифт.';
  if (f.fuseA && f.fuseB) return 'Генераторная, север от атриума: поставить ПН-2 и запустить.';
  if (!f.readMap && !f.fuseA) return 'Выйти из медблока. Коридор — на север.';
  if (!f.fuseA) return 'ПН-2 — шкаф на дальней стене архива (запад).';
  if (!f.card && !f.labOpen) return 'Карта доступа — кабинет 9, за затопленным переходом (восток).';
  if (!f.fuseB) return 'Второй ПН-2 — бокс № 2 безэхового блока.';
  return '';
}

// where the player is heading next (the creature uses it to lie in wait)
function objectivePos() {
  const f = game.flags;
  if (f.called) return null;
  if (f.powered) return V(9.5, 0, 6);
  if (f.fuseA && f.fuseB) return V(32, 0, 9.6);
  if (!f.fuseA) return V(2.5, 0, 18);
  if (!f.card && !f.labOpen) return V(54.5, 0, 34);
  if (!f.fuseB) return V(53, 0, 8);
  return null;
}

let lastObjective = null, objectiveUntil = 0, objectivePending = false;
function resetObjective() {
  lastObjective = null;
  objectiveUntil = 0;
  objectivePending = false;
  const element = $('objective');
  element.style.transition = 'none';
  element.classList.remove('visible');
  element.setAttribute('aria-hidden', 'true');
  void element.offsetWidth;
  element.style.transition = '';
}
function updateObjective() {
  const text = objective();
  if (text !== lastObjective) {
    // The initial goal stays quiet. Later changes appear once, after a note
    // closes, so a plot update is never spent behind the paper overlay.
    objectivePending = lastObjective !== null && !!text;
    lastObjective = text;
    $('objective-text').textContent = text;
  }
  if (game.state === 'play' && objectivePending) {
    objectiveUntil = game.time + 6;
    objectivePending = false;
  }
  const recall = player.keys.has('Tab');
  const visible = game.state === 'play' && !!text && (recall || game.time < objectiveUntil);
  const caption = recall ? 'Вспомнить' : 'Новая цель';
  if ($('objective-caption').textContent !== caption) $('objective-caption').textContent = caption;
  $('objective').classList.toggle('visible', visible);
  if ($('objective').getAttribute('aria-hidden') !== String(!visible)) $('objective').setAttribute('aria-hidden', String(!visible));
}

function updateHUD() {
  updateObjective();
  const bm = $('m-breath');
  bm.querySelector('i').style.width = `${player.breathCap * 100}%`;
  bm.classList.toggle('holding', player.holding);
  bm.classList.toggle('low', player.breathCap < 0.25);
  bm.style.opacity = player.holding || player.breathCap < 0.99 ? 1 : 0.25;
  const sm = $('m-stamina');
  sm.querySelector('i').style.width = `${player.stamina * 100}%`;
  sm.style.opacity = player.stamina < 0.99 ? 1 : 0.25;
  $('stones').textContent = [player.stones ? `КАМНИ: ${player.stones}` : '', extras.held.length ? `БУДИЛЬНИКИ: ${extras.held.length}` : ''].filter(Boolean).join('   ');
  $('stance').textContent = player.listening ? 'ВСЛУШИВАЕШЬСЯ' : player.holding ? 'НЕ ДЫШИШЬ' : player.hidden ? (player.hidden.low ? 'ПОД КРОВАТЬЮ' : 'В ШКАФЧИКЕ') : player.crouch ? 'КРАДЁШЬСЯ' : '';
}

// ------------------------------------------------------------------ interaction
let focus = null;
const LAB_DOOR = V(54, 1.3, 24.6);

function findFocus() {
  if (player.hidden) return player.hidden;
  const cam = camera.position;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  let best = null, bestScore = 0;
  for (const it of level.items) {
    if (it.taken) continue;
    const to = it.pos.clone().sub(cam);
    const d = to.length();
    if (d > 1.9) continue;
    const dot = to.normalize().dot(dir);
    const score = dot - d * 0.1;
    if ((dot > 0.82 || d < 0.75) && score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  const dl = level.door('lab');
  if (!best && dl.closed && cam.distanceTo(LAB_DOOR) < 2.0) best = { type: 'labdoor' };
  return best;
}

function promptFor(it) {
  if (!it) return '';
  const f = game.flags;
  switch (it.type) {
    case 'note': return '[E] Прочитать';
    case 'stone': return player.stones >= 5 ? 'Больше не унести' : '[E] Подобрать камень';
    case 'fuseA': return itemAction?.it === it ? 'Выкручиваешь предохранитель…' : '[E] Выкрутить ПН-2';
    case 'fuseB': case 'card': return `[E] Взять: ${it.name}`;
    case 'panel': {
      if (f.powered) return '';
      if (!f.fuseA || !f.fuseB) return 'Щиток генератора. Не хватает предохранителей.';
      const frame=hold?.it===it?hold.generator?.frame:null;
      if (!frame) return '[держи E] Подготовить и запустить генератор';
      if (frame.kind==='insertFuse') return `Устанавливаешь ПН-2 · ${frame.slot+1} / 2`;
      if (frame.kind==='uncap') return 'Открываешь канистру…';
      if (frame.kind==='pour') return `Заливаешь топливо · ${Math.round(frame.k*100)}%`;
      if (frame.kind==='recap') return 'Закрываешь канистру…';
      return `Подкачка · ${Math.min(5,Math.floor(frame.time)+1)} / 5 — громко`;
    }
    case 'call': return siege.stalled ? hold?.it === it ? `Перезапуск · ${Math.min(100, Math.round(hold.t / 2 * 100))}%` : '[держи E] Перезапустить лифт' : f.called ? '' : f.powered ? '[E] Вызвать лифт' : 'Кнопка вызова. Нет питания.';
    case 'cab': return f.arrived ? hold?.it === it ? 'Закрываешь двери… Держи E' : '[держи E] Закрыть двери и запустить лифт' : '';
    case 'labdoor': return f.card ? (hold && hold.it.type === 'labdoor' ? `Открываешь медленно… ${Math.round((hold.t / 2.5) * 100)}%` : '[держи E] Приложить карту и открыть тихо') : 'Шлюз заперт. Нужна карта доступа.';
    case 'locked': return '[E] Дёрнуть ручку';
    case 'slam': { const d = level.door(it.door); return d.broken ? 'Дверь выбита.' : d.closed ? '[E] Открыть дверь' : '[E] Захлопнуть дверь (громко)'; }
    case 'locker': return it.low ? (player.hidden ? '[E] Вылезти' : '[E] Залезть под кровать') : player.hidden ? '[E] Выйти' : '[E] Спрятаться в шкафчик';
    case 'shutterA': return siege.active ? siege.powerLocked ? 'Привод остывает…' : `[E] ${siege.shut.A ? 'Поднять' : 'Опустить'} заслонку двери` : 'Пульт заслонки. Без питания.';
    case 'shutterB': return siege.active ? siege.powerLocked ? 'Привод остывает…' : `[E] ${siege.shut.B ? 'Открыть' : 'Закрыть'} люк вентиляции` : 'Пульт люка вентиляции. Без питания.';
    case 'shutterC': return siege.active ? siege.powerLocked ? 'Привод остывает…' : `[E] ${siege.shut.C ? 'Поднять' : 'Опустить'} заслонку служебной двери` : 'Пульт служебной двери. Без питания.';
    case 'seismo': return siege.active ? siege.pingCooldown > 0 ? `Датчик заряжается · ${Math.ceil(siege.pingCooldown)} с` : '[E] Сейсмодатчик (−8% питания)' : 'Сейсмодатчик. Экран мёртв.';
  }
  return extras.prompt(it) || '';
}

function toggleHiding(it) {
  const f=game.flags;
  if(player.hidden){
    player.unhide();
    $('slits').classList.add('hidden');
    if(it.low)return;
    audio.play('door',it.pos,{gain:.35,rate:1.6,wet:.4});
    game.noise(it.pos.clone(),{radius:2.5,visual:2,source:'player',kind:'door',color:COLORS.player,strength:.5});
    return;
  }
  player.hide(it);
  if(it.low){
    audio.play('creak',it.pos,{gain:.25,rate:1.4,wet:.3});
    game.noise(it.pos.clone(),{radius:1.8,visual:1.5,source:'player',kind:'crouch',color:COLORS.player,strength:.4});
    if(!f.bedHint){
      f.bedHint=true;
      game.hint('Под кроватью тебя не видно. Но дыхание слышно — если оно встанет рядом, не дыши.',5);
    }
    return;
  }
  $('slits').classList.remove('hidden');
  audio.play('door',it.pos,{gain:.3,rate:1.7,wet:.4});
  game.noise(it.pos.clone(),{radius:2.2,visual:2,source:'player',kind:'door',color:COLORS.player,strength:.5});
  if(!f.lockerHint){
    f.lockerHint=true;
    game.hint('В шкафчике дыхание глуше. Но если оно встанет вплотную — не дыши.',5);
  }
}

function take(it) {
  it.taken = true;
  it.obj.visible = false;
  audio.pickup();
  game.noise(it.pos.clone(), { radius: 1.6, visual: 1.5, source: 'player', kind: 'item', color: COLORS.item, strength: 0.6 });
}

// actions that take time: hold E
let hold = null;
let itemAction = null;
let pouringLoop = null;
let pouringActive = false;
const HOLD = {
  call: { need: 2, ok: () => siege.stalled },
  cab: { need: 1.6, ok: () => game.flags.arrived },
  panel: { ok: () => !game.flags.powered && game.flags.fuseA && game.flags.fuseB },
  labdoor: { need: 2.5, ok: () => game.flags.card },
};
function cancelWork() {
  if (itemAction && !itemAction.committed) itemAction.it.obj.visible = true;
  itemAction = hold = null;
  vm.work = null;
  player.actionLean = 0;
  if (pouringLoop) pouringLoop.setGain(0,0.08);
  pouringActive = false;
  generatorProps.sync(game.flags);
}
function beginFuse(it) {
  const kind=it.type==='fuseA'?'unscrew':'pickupFuse';
  itemAction={it,kind,t:0,committed:false,...FUSE_ACTIONS[kind]};
  vm.actT=vm.throwT=0;
  vm.work={kind,k:0,target:it.pos.clone(),normal:V(1,0,0)};
}
function completeFuse(it) {
  take(it);
  game.flags[it.type]=true;
  if(it.type==='fuseA') releaseMonster();
  else {
    later(1.6, () => {
      if (!monster.active || game.state !== 'play') return;
      const drop=V(53,0,15.5);
      audio.crash(V(53,4.3,15.5));
      echo.emit(V(53,4.3,15.5),{radius:16,speed:12,strength:1.4,color:COLORS.monster});
      monster.spawn(drop,'wander');monster.startChase();
      game.hint('Сверху. Шлюз — и вниз, в вентканал за моргом.',4,true);
    });
    game.hint('Оба ПН-2. Генераторная — к северу от атриума.');
    saveCheckpoint();
  }
}
function updateItemAction(dt) {
  if(!itemAction)return;
  const a=itemAction;
  if(game.state!=='play'||player.hidden||Math.hypot(player.pos.x-a.it.pos.x,player.pos.z-a.it.pos.z)>1.8){cancelWork();return;}
  const before=a.t/a.duration;
  a.t=Math.min(a.duration,a.t+dt);const k=a.t/a.duration;
  vm.work={kind:a.kind,k,target:a.it.pos.clone(),normal:V(1,0,0)};
  if(k>=a.grip)a.it.obj.visible=false;
  if(a.kind==='unscrew')for(const mark of [.35,.51,.63])if(before<mark&&k>=mark){
    audio.play('creak',a.it.pos,{gain:.2,rate:1.4,wet:.35});
    game.noise(a.it.pos.clone(),{radius:2.3,visual:2.4,source:'player',kind:'item',color:COLORS.item,strength:.35});
  }
  if(!a.committed&&k>=a.commit){a.committed=true;completeFuse(a.it);}
  if(k>=1){itemAction=null;vm.work=null;}
}
function updateHold(dt) {
  if (!hold) return;
  if (player.fallT > 0) { cancelWork(); return; }
  if (game.state !== 'play') { cancelWork(); return; }
  if (focus !== hold.it && !(focus && hold.it.type === 'labdoor' && focus.type === 'labdoor')) {
    cancelWork();
    return;
  }
  if (!player.keys.has('KeyE')) {
    cancelWork();
    return;
  }
  hold.t += dt;
  if (hold.it.type === 'call' || hold.it.type === 'cab') {
    hold.tick -= dt;
    if (hold.tick <= 0) {
      hold.tick = 0.55;
      vm.act('press', hold.it.pos);
      audio.play('tick', hold.it.pos, { gain: 0.25, rate: 0.8, wet: 0.3 });
    }
    if (hold.t >= HOLD[hold.it.type].need) {
      const type = hold.it.type;
      cancelWork();
      if (type === 'call') siege.restartLift();
      else ending();
    }
    return;
  }
  if (hold.generator) {
    for(const event of hold.generator.advance(dt)){
      if(event.event==='insert'){
        game.flags.genInstalled=Math.max(game.flags.genInstalled||0,event.slot+1);
        audio.play('click',generatorProps.sockets[event.slot],{gain:.45,rate:.75,wet:.4});
        game.noise(generatorProps.sockets[event.slot].clone(),{radius:2.2,visual:2.6,source:'player',kind:'item',color:COLORS.item,strength:.45});
      }else if(event.event==='fuel')game.flags.genFueled=true;
      else if(event.event==='capOpen'||event.event==='capClose')audio.play('click',generatorProps.funnel,{gain:.25,rate:event.event==='capOpen'?.7:.9,wet:.25});
      else if(event.event==='liquid')game.noise(generatorProps.funnel.clone(),{radius:3,visual:2.5,source:'player',kind:'item',color:COLORS.machine,strength:.3});
      else if(event.event==='pump'){
        audio.play('metal_heavy',GEN_POS,{gain:.8,rate:.9+Math.random()*.2,wet:.9});
        game.noise(GEN_POS.clone(),{radius:7,visual:6,source:'player',kind:'door',color:COLORS.machine,strength:.8});
      }
    }
    const frame=hold.generator.frame;
    generatorProps.sync(game.flags,frame);
    const target=frame.kind==='insertFuse'?generatorProps.sockets[frame.slot]:frame.kind==='prime'?generatorProps.knob.getWorldPosition(V(0,0,0)):generatorProps.funnel;
    vm.work={...frame,target:target.clone(),normal:V(0,0,1)};
    const flowing=frame.kind==='pour'&&frame.k>.2&&frame.k<.86;
    if(flowing!==pouringActive){
      if(flowing&&!pouringLoop)pouringLoop=audio.createLoop('loop_water',generatorProps.funnel,.16,{rate:1.5,ref:.6,roll:1.5});
      if(pouringLoop)pouringLoop.setGain(flowing?1:0,.1);
      pouringActive=flowing;
    }
    if(hold.generator.done){cancelWork();startGenerator();}
    return;
  }
  hold.tick -= dt;
  if (hold.tick <= 0) {
    hold.tick = 0.9;
    vm.act('push', LAB_DOOR);
    audio.play('door', LAB_DOOR, { gain: 0.18, rate: 0.7, wet: 0.4 });
    game.noise(LAB_DOOR.clone(), { radius: 2.2, visual: 2.5, source: 'player', kind: 'door', color: COLORS.player, strength: 0.4 });
  }
  if (hold.t >= HOLD[hold.it.type].need) {
    hold = null;
    level.setDoor('lab', true);
    game.flags.labOpen = true;
    audio.play('door', LAB_DOOR, { gain: 0.4, rate: 0.75, wet: 0.5 });
  }
}

// what the hand visibly does for each kind of thing
function actFor(it) {
  const t = it.type;
  if (t === 'stone') return ['take', it.pos, 'stone'];
  if (t === 'fuseA' || t === 'fuseB') return ['take', it.pos, 'fuse'];
  if (t === 'card') return ['take', it.pos, 'card'];
  if (t === 'clock') return ['take', it.pos, 'clock'];
  if (t === 'phone') return ['take', it.pos];
  if (t === 'note') return ['read', it.pos];
  if (t === 'locked') return ['rattle', it.pos];
  if (t === 'panel' && HOLD.panel.ok()) return ['pump', it.pos];
  if (['door', 'slam', 'locker', 'labdoor', 'cab'].includes(t)) return ['push', it.pos];
  return ['press', it.pos];
}

function interact() {
  if(chapter.active){chapter.interact(camera);return;}
  if (player.fallT > 0) return;
  const it = focus;
  if (!it || it.taken || itemAction || hold) return;
  if(['fuseA','fuseB','panel'].includes(it.type)&&Math.hypot(player.pos.x-it.pos.x,player.pos.z-it.pos.z)>1.15){game.hint('Подойди ближе.',2);return;}
  if(it.type==='fuseA'||it.type==='fuseB'){beginFuse(it);return;}
  if (HOLD[it.type] && HOLD[it.type].ok()) {
    hold = { it, t: 0, tick: 0.25 };
    if(it.type==='panel'){
      hold.generator=new GeneratorSequence({installed:game.flags.genInstalled||0,fueled:!!game.flags.genFueled});
      vm.actT=vm.throwT=0;
      const frame=hold.generator.frame;
      vm.work={...frame,target:(frame.kind==='insertFuse'?generatorProps.sockets[frame.slot]:generatorProps.funnel).clone(),normal:V(0,0,1)};
    }else vm.act(...actFor(it));
    return;
  }
  vm.act(...actFor(it));
  const f = game.flags;
  switch (it.type) {
    case 'note':
      (game.flags.notes ||= {})[it.note] = true;
      openNote(it.note);
      if (it.note === 1) f.readMap = true;
      break;
    case 'stone':
      if (player.stones >= 5) return;
      it.taken = true;
      it.obj.visible = false;
      player.stones++;
      audio.impact(it.pos, 0.15);
      if (!f.stoneHint) {
        f.stoneHint = true;
        game.hint('Камень. [ЛКМ] — бросить туда, где ты не стоишь.');
      }
      break;
    case 'card':
      take(it);
      f.card = true;
      // it was waiting for that: it comes down the flooded passage
      later(3.2, () => {
        if (!monster.active || game.state !== 'play') return;
        if (monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z)) > 10) {
          monster.spawn(V(43.2, 0, 27.5), 'wander');
          audio.crash(V(43, 2.5, 27.5));
        }
        monster.startChase();
        game.hint('Оно в переходе. Кабинет — тупик. Прячься.', 4, true);
      });
      game.hint('Карта. Шлюз безэхового блока — в конце затопленного перехода.');
      saveCheckpoint();
      break;
    case 'panel':
      if (!f.powered && f.fuseA && f.fuseB) startGenerator();
      break;
    case 'call':
      // Let the fingertip reach the button before the motor and briefing start.
      if (f.powered && !f.called) later(0.23, () => { if (game.state === 'play') callElevator(); });
      break;
    case 'cab':
      if (f.arrived) ending();
      break;
    case 'slam': {
      const closed = level.toggleSlam(it.door);
      if (closed === null) break;
      if (closed) {
        audio.play('slam', it.pos, { gain: 1.0, rate: 1.1, wet: 0.8 });
        game.noise(it.pos.clone(), { radius: 7, visual: 6, source: 'player', kind: 'door', color: COLORS.player, strength: 1 });
        if (!f.slamHint) {
          f.slamHint = true;
          game.hint('Дверь задержит его на пару секунд. Не больше.', 4);
        }
      } else {
        audio.play('door', it.pos, { gain: 0.4, rate: 1.4, wet: 0.5 });
        game.noise(it.pos.clone(), { radius: 2.5, visual: 2, source: 'player', kind: 'door', color: COLORS.player, strength: 0.5 });
      }
      break;
    }
    case 'locker':
      toggleHiding(it);
      break;
    case 'shutterA':
    case 'shutterB':
    case 'shutterC':
      if (siege.active) siege.toggle(it.type.slice(-1));
      break;
    case 'seismo':
      if (siege.active) {
        const n = siege.ping();
        if (n) {
          radarNode = n;
          radarT = 3;
          $('radar').classList.remove('hidden');
        }
      }
      break;

    case 'clock':
    case 'phone':
      extras.interact(it);
      break;
    case 'locked':
      level.rattle(it.door);
      audio.rattle(it.pos);
      game.noise(it.pos.clone(), { radius: 5.5, visual: 3.5, source: 'player', kind: 'door', color: COLORS.player, strength: 0.8 });
      if (!f.lockedHint) {
        f.lockedHint = true;
        game.hint('Заперто. Ручка грохнула на весь коридор.');
      }
      break;
    case 'labdoor':
      if (f.card) {
        level.setDoor('lab', true);
        f.labOpen = true;
        audio.door(LAB_DOOR);
        game.noise(LAB_DOOR.clone(), { radius: 9, visual: 10, source: 'player', kind: 'door', color: COLORS.machine });
      } else {
        audio.impact(LAB_DOOR, 0.3);
      }
      break;
  }
}

function openNote(i) {
  audio.paper();
  $('note-title').textContent = NOTES[i].title;
  $('note-body').textContent = NOTES[i].body;
  $('note').classList.remove('hidden');
  game.state = 'note';
  player.frozen = true;
}
function closeNote() {
  $('note').classList.add('hidden');
  game.state = 'play';
  player.frozen = false;
  audio.paper();
}

// ------------------------------------------------------------------ story beats
const visited = new Set();
function onEnterRoom(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const f = game.flags;
  if (name === 'Коридор Б' && !f.fuseA) {
    // something crawls in the ceiling above
    for (let i = 0; i < 6; i++)
      later((2500 + i * 650) / 1000, () => {
        if (game.state !== 'play') return;
        const p = V(31.5, 3.6, 36 + i * 1.1);
        audio.monsterStep(p, 0.4);
        echo.emit(p, { radius: 2.5, speed: 6, strength: 0.35, color: COLORS.monster });
      });
  }
  if (name === 'Морг' && !f.fuseA) {
    later(1.8, () => {
      const p = V(42.2, 1.2, 37.5);
      audio.slam(p);
      echo.emit(p, { radius: 9, speed: 10, strength: 1.3, color: COLORS.white });
    });
  }
  if (name === 'Атриум' && !f.readMap) {
    game.hint('Высокий зал. На стойке регистрации — бумаги.');
    later(3.0, () => audio.groan(V(32, 6, 10)));
  }
  if (name === 'Архив' && !f.fuseA) later(2.5, () => audio.whisper(V(3, 1.6, 20)));
  if (name === 'Затопленный коридор' && !f.waterHint) {
    f.waterHint = true;
    game.hint('Вода. Каждый шаг слышно вдвое дальше.');
  }
  if (name === 'Безэховый блок') game.hint('Боксы. Второй открыт изнутри.');
  if (name === 'Вентканал') game.hint('Вентканал. Только ползком — зато оно сюда не пролезет.', 5);
}

function releaseMonster() {
  game.hint('ПН-2, первый. Теперь — карта Ореховой.', 3.5);
  later(2.6, () => {
    const vent = V(28, 4.8, 25);
    audio.crash(vent);
    audio.monsterRoar(vent);
    echo.emit(vent, { radius: 34, speed: 13, strength: 1.4, decay: 0.5, color: COLORS.monster });
    monster.spawn(V(28, 0, 25.6), 'investigate');
    monster.goTo(V(7.5, 0, 27.5), 'hunt');
    game.hint('В атриуме что-то сорвалось с вентиляции. Тяжёлое. Живое.', 6);
    later(6.0, () => game.hint('Оно знает только звук. Подойдёт — замри и не дыши [Q].', 5));
    later(12.0, () => game.hint('[V] — вслушаться: замри и услышь, откуда оно идёт.', 5));
    saveCheckpoint();
  });
}

let generator = null;
let genPulseT = 0;
let genNoiseT = 0;
const GEN_POS = V(32, 1.5, 8.6);

function startGenerator() {
  const f = game.flags;
  f.powered = true;
  audio.door(GEN_POS);
  if (!generator) generator = audio.createMachine(GEN_POS, { type: 'generator', gain: 1.0 });
  generator.setGain(1, 1.5);
  generator.spinUp(3.5);
  game.noise(GEN_POS.clone(), { radius: 30, visual: 26, source: 'machine', kind: 'machine', color: COLORS.machine, strength: 1.4 });
  monster.forcedTarget = V(30, 0, 11);
  if (monster.active && monster.state !== 'chase') monster.goTo(level.randomWalkable(V(30, 0, 10), 3) || V(30, 0, 11), 'hunt');
  game.hint('Генератор ожил. Девяносто децибел. Лифтовый холл — на запад.', 6);
  saveCheckpoint();
}

let lift = null;
const LIFT_POS = V(7.5, 1.4, 1.5);
function callElevator() {
  const f = game.flags;
  if (f.called) return;
  f.called = true;
  audio.ding(V(9.55, 1.3, 3.1));
  if (!lift) lift = audio.createMachine(LIFT_POS, { type: 'motor', gain: 0.3 });
  lift.setGain(1, 2);
  monster.forcedTarget = null;
  saveCheckpoint();
  siege.start();
  game.hint('Лифт тронулся. Где-то внизу, очень глубоко.', 4, true);
}

function liftArrive() {
  const f = game.flags;
  f.arrived = true;
  level.setDoor('lift', true);
  audio.ding(V(7.5, 2.4, 3.2));
  if (lift) lift.setGain(0.15, 1);
  game.noise(V(7.5, 1.5, 3.3), { radius: 22, visual: 18, source: 'machine', kind: 'machine', color: COLORS.machine, strength: 1.3 });
  game.hint('Лифт здесь. В кабину — держи [E] на кнопке, пока двери не закроются.', 5, true);
}

function ending() {
  startCave(null,{pos:player.pos.clone().add(LIFT_OFFSET),yaw:player.yaw,pitch:player.pitch});
}

// ------------------------------------------------------------------ checkpoints & death
function saveCheckpoint() {
  if(chapter.active){saveCaveCheckpoint();return;}
  game.cpDeaths = 0;
  applyAssist();
  game.checkpoint = {
    pos: player.pos.clone(),
    yaw: player.yaw,
    flags: JSON.parse(JSON.stringify(game.flags)),
    stones: player.stones,
    taken: level.items.map((it) => it.taken),
    monster: monster.active ? { pos: monster.pos.clone() } : null,
    forced: monster.forcedTarget ? monster.forcedTarget.clone() : null,
  };
  const c = game.checkpoint;
  try {
    localStorage.setItem('echo.save', JSON.stringify({
      v: 1, pos: { x: c.pos.x, z: c.pos.z }, yaw: c.yaw, flags: c.flags, stones: c.stones, taken: c.taken,
      monster: c.monster ? { x: c.monster.pos.x, z: c.monster.pos.z } : null,
      forced: c.forced ? { x: c.forced.x, z: c.forced.z } : null, time: game.time, deaths: game.deaths,
    }));
  } catch (_) {}
}

let scare = null;
function applyAssist() {
  // after the 2nd death at the same spot the creature listens and moves a little worse
  const d = game.cpDeaths || 0;
  const k = d >= 4 ? 0.75 : d >= 2 ? 0.88 : 1;
  monster.assist.hear = k;
  monster.assist.speed = 0.5 + k * 0.5;
  siege.assist = k;
}

function die(cause = 'monster') {
  if (game.state !== 'play' && game.state !== 'note') return;
  if (player.pitFall && cause !== 'pit') return;
  game.cpDeaths = (game.cpDeaths || 0) + 1;
  applyAssist();
  $('slits').classList.add('hidden');
  if (siege.active) siege.stop();
  game.state = 'dying';
  setListen(1); // the last thing you see is its echo
  game.deaths++;
  player.frozen = true;
  player.holding = false;
  if (cause === 'pit') {
    scare = { kind: 'pit', t: 0, baseFov: camera.fov, cut: false };
    player.lookTarget = null;
    audio.bodyFall(player.pos.clone(), player.level.floorAt(player.pos.x, player.pos.z));
    echo.emit(player.pos.clone(), { radius: 8, speed: 20, strength: 1.3, decay: 1, color: COLORS.player });
    return;
  }
  monster.startScare(camera);
  scare = { t: 0, baseFov: camera.fov, cut: false };
  audio.scream();
  echo.emit(camera.position.clone(), { radius: 6, speed: 40, strength: 2.5, decay: 0.4, color: COLORS.monster });
}

function updateScare(dt) {
  if (!scare) return;
  scare.t += dt;
  const t = scare.t;
  if (scare.kind === 'pit') {
    camera.position.y += Math.sin(t * 55) * Math.max(0, 0.12 - t * 0.5);
    if (t > 0.12 && !scare.cut) {
      scare.cut = true;
      audio.cut();
      $('fade').style.transition = 'opacity .3s';
      $('fade').style.opacity = 1;
    }
    if (t > 1.4) finishDeath('Ты упал в разлом. Держись каменных обходов по краям зала.');
    return;
  }
  player.lookTarget = (monster.mouthWorld || monster.headWorld).clone();
  // zoom punch into the face + violent shake
  camera.fov = THREE.MathUtils.lerp(camera.fov, t < 0.9 ? 46 : scare.baseFov, Math.min(1, dt * 18));
  camera.updateProjectionMatrix();
  const k = t < 0.9 ? 0.06 : 0;
  camera.position.add(V((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k));
  camera.rotateZ((Math.random() - 0.5) * k * 2);
  // the creature is fully lit for a split second, strobing
  const strobe = Math.floor(t * 18) % 2 === 0;
  const lit = t < 0.9 ? (strobe ? 1.4 : 0.35) : 0;
  monster.body.mats[0].uniforms.uLit.value = lit;
  monster.body.mats[1].uniforms.uLit.value = lit * 0.6;
  fx.uniforms.uGlitch.value = t < 0.9 ? (strobe ? 0.9 : 0.25) : 0;
  fx.uniforms.uWhite.value = t < 0.07 ? 1 : 0;
  flash = t < 0.9 ? (strobe ? 0.9 : 0.2) : 0;
  // hard cut: black + silence
  if (t > 0.9 && !scare.cut) {
    scare.cut = true;
    audio.cut();
    $('fade').style.transition = 'none';
    $('fade').style.opacity = 1;
  }
  if (t > 2.3) {
    finishDeath(TIPS[Math.floor(Math.random() * TIPS.length)]);
  }
}

function finishDeath(tip) {
  scare = null;
  game.state = 'dead';
  camera.fov = 80;
  camera.updateProjectionMatrix();
  fx.uniforms.uGlitch.value = fx.uniforms.uWhite.value = 0;
  $('tip').textContent = tip;
  $('death').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  audio.setMaster(0.15, 0.3);
}

function loadSave() {
  try {
    const d = JSON.parse(localStorage.getItem('echo.save') || 'null');
    if(d?.v===1&&d.chapter==='cave'&&d.cave?.sequence&&Number.isFinite(d.cave.pos?.x)&&Number.isFinite(d.cave.pos?.z))return d;
    if (!d || d.v !== 1 || d.taken.length !== level.items.length) return null;
    return {
      pos: V(d.pos.x, 0, d.pos.z), yaw: d.yaw, flags: d.flags, stones: d.stones, taken: d.taken,
      monster: d.monster ? { pos: V(d.monster.x, 0, d.monster.z) } : null,
      forced: d.forced ? V(d.forced.x, 0, d.forced.z) : null, time: d.time || 0, deaths: d.deaths || 0,
    };
  } catch (_) {
    return null;
  }
}
const clearSave = () => {
  try { localStorage.removeItem('echo.save'); } catch (_) {}
};

function restoreCheckpoint() {
  const c = game.checkpoint;
  if(c?.chapter==='cave'){
    scare=null;camera.fov=80;camera.updateProjectionMatrix();
    fx.uniforms.uGlitch.value=fx.uniforms.uWhite.value=0;
    $('death').classList.add('hidden');$('pause').classList.add('hidden');
    audio.setMaster(+$('vol').value,1);startCave(c.cave);lock();return;
  }
  cancelWork();
  resetObjective();
  timers.length = 0;
  scare = null;
  camera.fov = 80;
  camera.updateProjectionMatrix();
  fx.uniforms.uGlitch.value = 0;
  fx.uniforms.uWhite.value = 0;
  game.flags = JSON.parse(JSON.stringify(c.flags));
  generatorProps.sync(game.flags);
  player.reset(c.pos, c.yaw);
  player.stones = c.stones;
  level.items.forEach((it, i) => {
    it.taken = c.taken[i];
    it.obj.visible = !it.taken;
  });
  extras.reset();
  for (const d of level.doors) if (d.kind === 'slam') Object.assign(d, { closed: false, t: 1, hp: 3, broken: false, box: null });
  level.setDoor('lab', !!game.flags.labOpen);
  level.setDoor('lift', !!game.flags.arrived);
  monster.forcedTarget = c.forced ? c.forced.clone() : null;
  monster.lures = []; // stones thrown before the death don't count against the retry
  if (c.monster) {
    // put it somewhere far from the player
    let p = level.randomWalkable(player.pos, 28, 16) || c.monster.pos;
    if (game.flags.called) p = level.randomWalkable(V(32, 0, 9), 4) || p;
    monster.spawn(p, 'wander');
    monster.idleT = 3;
  } else monster.despawn();
  if (game.flags.powered && !generator) generator = audio.createMachine(GEN_POS, { type: 'generator', gain: 1.0 });
  if (game.flags.called && !lift) lift = audio.createMachine(LIFT_POS, { type: 'motor', gain: 0.3 });
  if (generator) generator.setGain(game.flags.powered ? 1 : 0, 0.5);
  if (lift) lift.setGain(game.flags.called ? 1 : 0, 0.5);
  siege.stop();
  level.setShutter('A', false);
  level.setShutter('B', false);
  level.setShutter('C', false);
  if (game.flags.called && !game.flags.arrived) {
    monster.despawn();
    siege.start();
  }
  echo.clear();
  game.fear = 0;
  game.psychosis = 0;
  psyMem = 0;
  psyFlare = 0;
  flash = 0;
  lastRoom = null;
  $('death').classList.add('hidden');
  $('fade').style.opacity = 0;
  setTimeout(() => ($('fade').style.transition = ''), 50);
  audio.setMaster(+$('vol').value, 1);
  game.state = 'play';
  lock();
  setTimeout(() => player.click(), 400);
}

$('retry').addEventListener('click', restoreCheckpoint);

// ------------------------------------------------------------------ menus
function pause() {
  if (game.state === 'note') closeNote();
  if (game.state !== 'play') return;
  game.state = 'paused';
  player.keys.clear();
  mouseLook.reset();
  $('pause').classList.remove('hidden');
  $('resume').focus();
  if (document.pointerLockElement) document.exitPointerLock();
  if (audio.ctx) audio.ctx.suspend();
}
function resume() {
  front.hide();
  player.keys.clear();
  $('pause').classList.add('hidden');
  game.state = 'play';
  if (audio.ctx) audio.ctx.resume();
  lock();
}
$('resume').addEventListener('click', resume);

$('intro').innerHTML = INTRO.map((l) => `<p>${l}</p>`).join('');

let booting = false;
async function boot(fromSave) {
  if (booting) return;
  booting = true;
  front.loading('Загрузка звука', 'Загрузка и обработка звуковых файлов.');
  // Give the loading UI a frame before baking the procedural sound bank.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
    if (!audio.ready) {
      await audio.init((p, done, total) => front.progress('Загрузка звука', p, `Звуковые записи: ${done} / ${total}`));
    }
    audio.setMaster(+$('vol').value, 0.01);
    await audio.ctx.suspend();
    front.briefing(() => {
      if (!fromSave) clearSave();
      startGame(fromSave);
    }, fromSave);
  } catch (error) {
    console.error('Audio initialization failed', error);
    if (audio.ctx) await audio.ctx.close().catch(() => {});
    audio.ctx = null;
    audio.ready = false;
    front.fail('Звук не загрузился. Он необходим, чтобы ориентироваться в темноте. Проверьте соединение и попробуйте ещё раз.', () => boot(fromSave));
  } finally {
    booting = false;
  }
}
function restartSession() {
  clearSave();
  try { sessionStorage.setItem('echo.new-session', '1'); } catch (_) {}
  location.reload();
}
front.bind({
  newGame: () => game.checkpoint ? restartSession() : boot(false),
  continue: () => boot(true),
  restart: restartSession,
  returnMenu: () => {
    $('pause').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('note').classList.add('hidden');
    $('slits').classList.add('hidden');
    player.keys.clear();
    game.state = 'menu';
    front.saveAvailable(!!loadSave());
    front.menu();
  },
});
$('again').addEventListener('click', () => { clearSave(); location.reload(); });

let waterLoop = null;
let requestedChapter=false;
$('chapter-two').addEventListener('click',()=>{requestedChapter=true;boot(false);});
function startGame(fromSave = false) {
  cancelWork();
  resetObjective();
  if (!waterLoop) {
    waterLoop = audio.createLoop('loop_water', V(49.6, 1.6, 26.8), 0.55, { ref: 1.5, roll: 1.2 });
    waterLoop.setGain(1, 2);
  }
  audio.ctx.resume();
  front.hide();
  $('pause').classList.add('hidden');
  player.keys.clear();
  $('hud').classList.remove('hidden');
  if(requestedChapter){requestedChapter=false;game.time=0;game.deaths=0;startCave();lock();return;}
  const saved = fromSave ? loadSave() : null;
  if (saved) {
    game.checkpoint = saved;
    game.time = saved.time;
    game.deaths = saved.deaths;
    restoreCheckpoint();
    game.hint('Ты снова здесь. Ничего не изменилось.', 4, true);
    return;
  }
  echo.clear();
  player.reset(V(34.9, 0, 50.6), 0.55);
  game.state = 'play';
  game.time = 0;
  saveCheckpoint();
  lock();
  const tut = [
    ['Темно. Как всегда.', 3.5],
    ['[F] — стук тростью. Звук ляжет на стены.', 5],
    ['Шаги тоже рисуют — и тоже слышны. [WASD]', 5],
    ['На кровати рядом — лист бумаги. [E]', 5],
    ['Забыл, куда идти? Удерживай [TAB] — вспомнить цель.', 5],
    ['[C] — красться: тише, но и мир меньше.', 5],
  ];
  tut.forEach(([t, d]) => game.hint(t, d));
}

// ------------------------------------------------------------------ ambient world
let sightCd = 0, sightT = 0, glitchT = 0;
let stalkT = 75;
let directorT = 45;
let closeT = 0;
// a narrow spot 9-18 m ahead on the way to the next goal, reachable for the
// creature without walking past the player
function planAmbush(goal) {
  const path = level.findPath(player.pos, goal);
  if (!path || path.length < 2) return false;
  let acc = 0, spot = null, fallback = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const seg = a.distanceTo(b);
    for (let t = 0; t < seg; t += 0.5) {
      const p = a.clone().lerp(b, t / seg);
      const dd = acc + t;
      if (dd > 9 && dd < 18) {
        if (!fallback && dd > 12) fallback = p;
        if (level.clearance(p.x, p.z) < 1.15) { spot = p; break; }
      }
    }
    if (spot) break;
    acc += seg;
    if (acc > 18) break;
  }
  spot = spot || fallback;
  if (!spot) return false;
  const route = level.findPath(monster.pos, spot);
  if (!route) return false;
  // don't stroll right past the player on the way there
  if (route.some((q) => Math.hypot(q.x - player.pos.x, q.z - player.pos.z) < 6)) return false;
  monster.ambush(spot);
  return true;
}
let drone = null;
function updateDread(dt) {
  // catching sight of it: lit by your own echo, in view, nothing in between
  sightCd -= dt;
  sightT -= dt;
  glitchT = Math.max(0, glitchT - dt);
  if (monster.active && sightCd <= 0 && sightT <= 0 && !siege.active) {
    sightT = 0.25;
    const hp = monster.headWorld;
    const d = hp.distanceTo(camera.position);
    if (d < 11 && echo.litAt(hp) > 0.22) {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const to = hp.clone().sub(camera.position).normalize();
      if (dir.dot(to) > 0.8 && level.occlusion(camera.position, hp) < 0.35) {
        sightCd = 25;
        glitchT = 0.4;
        audio.stinger('high', 0.75);
        player.shake = Math.max(player.shake || 0, 0.7);
        game.fear = Math.min(1.5, game.fear + 0.5);
      }
    }
  }
  // the director: it never stays away for long
  // the director: keeps it a presence. Far and idle for a while -> it comes to
  // stalk you, or goes ahead to lie in wait on your way; close for too long
  // without anything happening -> it drifts away, so the fear has a rhythm
  directorT -= dt;
  if (monster.active && !siege.active && game.state === 'play') {
    const d = monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z));
    const idle = monster.state === 'wander' || monster.state === 'search';
    if (d < 10 && monster.state !== 'chase') closeT += dt;
    else closeT = Math.max(0, closeT - dt * 0.5);
    if (closeT > 55 && idle) {
      closeT = 0;
      const far = level.randomWalkable(monster.pos, 26, 16);
      if (far) monster.goTo(far, 'wander');
      directorT = 25;
    }
    if (directorT <= 0) {
      directorT = 20 + Math.random() * 15;
      if (idle && d > 15) {
        const r = Math.random();
        const goal = objectivePos();
        let ambushed = false;
        if (r < 0.32 && goal) ambushed = planAmbush(goal);
        if (!ambushed) {
          if (r < 0.75) monster.stalk(32 + Math.random() * 18);
          else {
            const t = level.randomWalkable(player.pos, 8, 3);
            if (t) monster.goTo(t, 'investigate');
          }
        }
      }
    }
  }
  // footsteps behind you, when it is nowhere near
  stalkT -= dt;
  if (stalkT <= 0 && !siege.active) {
    stalkT = 70 + Math.random() * 60;
    const far = !monster.active || monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z)) > 20;
    if (far) {
      const fx = Math.sin(player.yaw), fz = Math.cos(player.yaw);
      for (let i = 0; i < 4; i++)
        later(i * 0.75, () => {
          const p = V(player.pos.x + fx * (7 - i * 0.6), 0.2, player.pos.z + fz * (7 - i * 0.6));
          audio.play('flesh', p, { gain: 0.35, rate: 0.66, wet: 0.7, vary: 0.05 });
          audio.play('tick', p, { gain: 0.12, rate: 1.7, wet: 0.5, delay: 0.04 });
        });
    }
  }
  // a low pressure in the ears as it gets close
  if (audio.ready) {
    if (!drone) {
      drone = audio.createLoop('amb_hell', camera.position, 0.5, { ref: 1, roll: 0 });
      drone.setGain(0, 0.1);
    }
    drone.setPos(camera.position);
    drone.setGain(Math.min(1, Math.max(0, game.fear - 0.25)) * 0.9, 0.6);
  }
}

// hold V: stand still and listen. The world hushes and you can tell where it is.
let listenK = 0;
function updateListen(dt) {
  const on = player.listening && game.state === 'play';
  listenK = THREE.MathUtils.lerp(listenK, on ? 1 : 0, Math.min(1, dt * 5));
  // the creature's red waves: shown only while listening (and when it gets you)
  setListen(game.state === 'dying' ? 1 : Math.min(1, listenK * 1.4));
  $('listen').classList.toggle('hidden', listenK < 0.05);
  if (audio.ready && !audio.muted && game.state === 'play') audio.master.gain.setTargetAtTime(+$('vol').value * (1 + listenK * 0.35), audio.t, 0.2);
  let src = null, loud = 0;
  if (monster.active) {
    src = monster.pos;
    const d = monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z));
    loud = Math.max(0, 1 - d / 30) * ((monster.curSpeed || 0) > 0.1 ? 1 : 0.45);
  }
  const mark = $('listen-mark');
  if (src && listenK > 0.05) {
    // angle relative to where you face (screen up = straight ahead)
    const a = Math.atan2(src.x - player.pos.x, src.z - player.pos.z) - Math.atan2(-Math.sin(player.yaw), -Math.cos(player.yaw));
    const r = 140;
    mark.style.transform = `translate(${Math.sin(a) * r}px, ${-Math.cos(a) * r}px) rotate(${a}rad)`;
    mark.style.opacity = (loud * listenK).toFixed(2);
  } else mark.style.opacity = 0;
}

let groanT = 20;
let loopT = 0;
function updateAmbient(dt, world=level) {
  const cp = camera.position;
  // keep loop occlusion in sync as the listener moves
  loopT -= dt;
  if (loopT <= 0) {
    loopT = 0.25;
    for (const l of [waterLoop, generator, lift,...(chapter.active?chapter.loops:[])]) if (l) l.update();
  }
  for (const d of world.drips) {
    d.t -= dt;
    if (d.t <= 0) {
      d.t = d.int * (0.7 + Math.random() * 0.6);
      const dist = d.pos.distanceTo(cp);
      if (dist < 22) {
        audio.drip(d.pos);
        echo.emit(V(d.pos.x, 0.02, d.pos.z), { radius: 2.4, speed: 3.5, strength: 0.55, decay: 1.4, color: COLORS.drip });
      }
    }
  }
  for (const s of world.sparks) {
    s.t -= dt;
    if (s.t <= 0) {
      s.t = s.int * (0.5 + Math.random());
      if (s.pos.distanceTo(cp) < 25) {
        audio.spark(s.pos);
        echo.emit(s.pos, { radius: 3.5, speed: 12, strength: 1.1, decay: 2.0, color: COLORS.spark });
      }
    }
  }
  // key items softly hum so they can be found
  for (const it of world.items) {
    if (it.taken || ['stone', 'locked', 'shutterA', 'shutterB', 'shutterC', 'seismo', 'locker', 'slam', 'clock', 'phone'].includes(it.type)) continue;
    it.hum = (it.hum ?? Math.random() * 4) - dt;
    if (it.hum <= 0) {
      it.hum = 3.5 + Math.random();
      if (it.pos.distanceTo(cp) < 7) echo.emit(it.pos, { radius: 1.1, speed: 2.5, strength: 0.5, decay: 1.5, color: COLORS.item });
    }
  }
  groanT -= dt;
  if (groanT <= 0) {
    groanT = 25 + Math.random() * 30;
    const p = world.randomWalkable(player.pos, 30, 15);
    if (p) {
      p.y = 2;
      if (Math.random() < 0.7) audio.groan(p);
      else audio.whisper(p);
    }
  }
  // machines
  if (game.flags.powered&&world===level) {
    genPulseT -= dt;
    if (genPulseT <= 0) {
      genPulseT = 1.4;
      echo.emit(GEN_POS, { radius: 13, speed: 9, strength: 0.7, decay: 1.2, color: COLORS.machine });
    }
    genNoiseT -= dt;
    if (genNoiseT <= 0) {
      genNoiseT = 9;
      if (monster.active && monster.state === 'wander') monster.hear(GEN_POS, 26, 'machine', 'machine', player.pos);
    }
  }
}

// ------------------------------------------------------------------ fear & heartbeat
let heartT = 0;
let flash = 0;
function updateFear(dt) {
  let target = 0;
  if (monster.active) {
    const d = monster.pos.distanceTo(V(player.pos.x, 0, player.pos.z));
    const st = monster.state;
    const k = st === 'chase' ? 1.5 : st === 'hunt' ? 1 : st === 'windup' || st === 'lunge' ? 1.4 : st === 'sniff' ? 1.2 : 0.75;
    target = Math.max(0, 1 - d / 15) * k;
  }
  if (game.state === 'dying') target = 1.5;
  game.fear += (Math.min(1.5, target) - game.fear) * Math.min(1, dt * 1.5);
  heartT -= dt;
  if (heartT <= 0 && game.fear > 0.12) {
    const bpm = 62 + game.fear * 95;
    heartT = 60 / bpm;
    audio.heartbeat(Math.min(1, game.fear));
  }
  if (heartT <= 0) heartT = 0.5;
  if (audio.ctx) audio.setAmbience(0.12 * (1 - Math.min(1, game.fear) * 0.6) * (1 - listenK * 0.8));
  flash = Math.max(0, flash - dt * 0.8);
  // how enclosed you are: in a tight room your own sounds light every wall at
  // once, so they are drawn softer there (corridors and halls are unchanged)
  eyeT -= dt;
  if (eyeT <= 0) {
    eyeT = 0.2;
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      let d = 0.25;
      while (d < 8 && player.level.open(Math.floor(player.pos.x + dx * d), Math.floor(player.pos.z + dz * d))) d += 0.25;
      sum += d;
    }
    roomK = THREE.MathUtils.clamp(sum / 8 / 3.6, 0.55, 1);
  }
  // shutter smear: how far the picture swung this frame (yaw/pitch and the bob)
  {
    const ry = camera.rotation.y, rx = camera.rotation.x, py = camera.position.y;
    let dy = ry - (blurPrev.y ?? ry);
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    const dx = rx - (blurPrev.x ?? rx), dh = py - (blurPrev.h ?? py);
    blurPrev.y = ry; blurPrev.x = rx; blurPrev.h = py;
    const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const k = 1.15 * Math.min(1, 1 / 60 / Math.max(dt, 1e-3)); // per 60 Hz frame
    const bx = THREE.MathUtils.clamp((-dy / hf) * k, -0.035, 0.035);
    const by = THREE.MathUtils.clamp((dx / vf + dh * 0.6) * k, -0.025, 0.025);
    const b = fx.uniforms.uBlur.value;
    b.x += (bx - b.x) * Math.min(1, dt * 25);
    b.y += (by - b.y) * Math.min(1, dt * 25);
  }
  fx.uniforms.uFear.value = Math.min(1.2, game.fear * 0.8 + (player.holding ? 0.15 : 0));
  fx.uniforms.uFlash.value = flash;
  if (game.state !== 'dying') fx.uniforms.uGlitch.value = glitchT > 0 ? 0.55 : 0;
  // the implant's lag ("smearing" — objects trailing copies of themselves):
  // barely there when calm, worse with fear, worst in a chase or when the air runs out
  const chaseK = monster.active && monster.state === 'chase' ? 1 : 0;
  const airK = player.holding ? THREE.MathUtils.smoothstep(1 - player.breathCap, 0.35, 0.95) : THREE.MathUtils.smoothstep(1 - player.breathCap, 0.6, 1.0) * 0.6;
  // aftershock: a chase leaves its mark. It fades over ~25 s, and while it lasts
  // the psychosis keeps flaring back up for a second or two at random
  if (chaseK) psyMem = 1;
  else psyMem = Math.max(0, psyMem - dt / 25);
  psyFlareT -= dt;
  if (psyFlareT <= 0) {
    psyFlareT = 3 + Math.random() * 5;
    if (psyMem > 0.15 && !chaseK) psyFlare = 1;
  }
  psyFlare = Math.max(0, psyFlare - dt * 0.7);
  const after = psyMem * 0.5 + psyFlare * psyMem * 0.45;
  const smearT = game.state === 'dying' ? 1 : Math.min(1, Math.max(chaseK, Math.min(1, game.fear) * 0.7, airK, after));
  smear += (smearT - smear) * Math.min(1, dt * (smearT > smear ? 2.5 : 0.35)); // lingers after the danger passes
  // per-frame decay, so it looks the same at any frame rate
  afterimage.uniforms.damp.value = Math.pow(THREE.MathUtils.lerp(0.5, 0.92, smear), Math.max(0.25, dt * 60));
  // trails go red only when it's bad (none while calm), per 60 Hz frame
  const redK = THREE.MathUtils.smoothstep(smear, 0.35, 1.0) * 0.12;
  afterimage.uniforms.uRed.value = 1 - Math.pow(1 - redK, Math.max(0.25, dt * 60));
  fx.uniforms.uSmear.value = smear;
  game.psychosis = smear;
}
let smear = 0;
let psyMem = 0, psyFlare = 0, psyFlareT = 4;
let eyeT = 0;
const blurPrev = {};

// The menu observes the actual level with its own camera. The player, monster,
// triggers, save state and game clock stay frozen while this camera is active.
const menuCamera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 120);
const menuAim = V(31.55, 1.35, 32.8);
const menuCold = new THREE.Color(0.48, 0.67, 0.74);
const menuWarm = new THREE.Color(0.8, 0.22, 0.13);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const crtPointer = new THREE.Vector2();
const crtMotion = new THREE.Vector2();
const crtLook = { yaw: null, pitch: null, playing: false };
addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  crtPointer.set(
    THREE.MathUtils.clamp(event.clientX / Math.max(1, innerWidth) * 2 - 1, -1, 1) * 0.028,
    THREE.MathUtils.clamp(1 - event.clientY / Math.max(1, innerHeight) * 2, -1, 1) * 0.02,
  );
});
function clearCrtPointer() { crtPointer.set(0, 0); }
addEventListener('blur', clearCrtPointer);
document.documentElement.addEventListener('pointerleave', clearCrtPointer);
function updateCrtParallax(dt) {
  const playing = game.state === 'play' || game.state === 'note';
  crtMotion.set(0, 0);
  if (playing && crtLook.playing && crtLook.yaw !== null) {
    const yaw = THREE.MathUtils.euclideanModulo(player.yaw - crtLook.yaw + Math.PI, Math.PI * 2) - Math.PI;
    crtMotion.set(
      THREE.MathUtils.clamp(-yaw / Math.max(dt, 1 / 240) * 0.012, -0.028, 0.028),
      THREE.MathUtils.clamp((player.pitch - crtLook.pitch) / Math.max(dt, 1 / 240) * 0.012, -0.02, 0.02),
    );
  }
  crtLook.yaw = player.yaw;
  crtLook.pitch = player.pitch;
  crtLook.playing = playing;
  const offset = fx.uniforms.uGlassOffset.value;
  if (reducedMotion.matches) offset.set(0, 0);
  else offset.lerp(playing ? crtMotion : crtPointer, 1 - Math.exp(-dt * 7));
}
let menuTime = 0;
let menuPulse = 0;
let menuWasActive = false;
let backgroundMode = null;
let backgroundUpdatedAt = -Infinity;
let backgroundDirty = true;
const menuPerformance = { worldFrames: 0, interfaceFrames: 0, lastWorldMs: 0 };
function sizeMenuCamera() {
  if (!innerWidth || !innerHeight) return;
  menuCamera.aspect = innerWidth / innerHeight;
  menuCamera.setViewOffset(innerWidth, innerHeight, -innerWidth * 0.13, 0, innerWidth, innerHeight);
  menuCamera.updateProjectionMatrix();
  // Only the background is downsampled. Text and the CRT stay at the user's
  // selected display resolution so low-cost scenery does not blur the UI.
  const scale = Math.min(1, 960 / innerWidth, 600 / innerHeight);
  menuBackground.setSize(Math.max(1, Math.round(innerWidth * scale)), Math.max(1, Math.round(innerHeight * scale)));
  backgroundDirty = true;
}
sizeMenuCamera();
addEventListener('resize', sizeMenuCamera);
function updateMenuBackground(dt) {
  if (!menuWasActive) {
    echo.clear();
    menuPulse = 0;
  }
  menuTime += dt;
  const drift = reducedMotion.matches ? 0 : Math.sin(menuTime * 0.075);
  menuCamera.position.set(30.75 + drift * 0.12, 1.58 + (reducedMotion.matches ? 0 : Math.sin(menuTime * 0.11) * 0.025), 42.1);
  menuCamera.lookAt(menuAim.x + drift * 0.22, menuAim.y, menuAim.z);
  menuPulse -= dt;
  if (menuPulse <= 0) {
    echo.emit(V(31.4, 1.7, 39.8), { radius: 26, speed: 8, strength: 1.8, decay: 0.22, color: menuCold });
    echo.emit(V(32.0, 1.5, 33.8), { radius: 16, speed: 5, strength: 1.2, decay: 0.28, color: menuWarm });
    if (!menuWasActive) echo.update(2.5); // reveal the composition on its first frame
    menuPulse = 5.5;
  }
  echo.update(dt);
  dust.material.uniforms.uCam.value.copy(menuCamera.position);
}
function updateCachedBackground(menu, now) {
  const mode = menu ? 'menu' : 'paused';
  if (backgroundMode !== mode) backgroundDirty = true;
  // Camera drift needs few world updates; the frozen pause scene needs one.
  if (!backgroundDirty && (!menu || now - backgroundUpdatedAt < 1000 / 15 - 1)) return;
  const target = renderer.getRenderTarget();
  const relief = pomScale;
  const autoClear = renderer.autoClear;
  const start = performance.now();
  try {
    roomVisibility.update(menu ? menuCamera : camera);
    setRelief(0);
    renderer.setRenderTarget(menuBackground);
    renderer.autoClear = true;
    renderer.render(scene, menu ? menuCamera : camera);
    if (!menu && vm.root.visible) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(vm.scene, camera);
    }
  } finally {
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(target);
    setRelief(relief);
  }
  backgroundMode = mode;
  backgroundDirty = false;
  backgroundUpdatedAt = now;
  menuPerformance.worldFrames++;
  menuPerformance.lastWorldMs = performance.now() - start;
}
function renderView(menu) {
  roomVisibility.update(menu ? menuCamera : camera);
  crtInterface.update(performance.now());
  fx.uniforms.uInterface.value = crtInterface.isMenu ? 1 : 0;
  const cached = menu || game.state === 'paused' || game.state === 'dead';
  if (cached) updateCachedBackground(menu, performance.now());
  else {
    backgroundMode = null;
    backgroundDirty = true;
  }
  worldPass.camera = menu ? menuCamera : camera;
  gtao.camera = menu ? menuCamera : camera;
  vmPass.enabled = !menu;
  afterimage.enabled = !menu;
  const worldPasses = [worldPass, gtao, vmPass, afterimage, bloom, smaa];
  const enabled = worldPasses.map((pass) => pass.enabled);
  if (cached) {
    worldPasses.forEach((pass) => { pass.enabled = false; });
    fx.uniforms.uBlur.value.set(0, 0);
  }
  uiPass.enabled = cached || crtInterface.visible;
  uiPass.uniforms.uCachedBackground.value = cached ? 1 : 0;
  uiPass.uniforms.uShowInterface.value = crtInterface.visible ? 1 : 0;
  // Menu pulses must not inherit the previous session's panic effects.
  const saved = {};
  if (menu) {
    for (const key of ['uFear', 'uFlash', 'uGlitch', 'uWhite', 'uSmear']) {
      saved[key] = fx.uniforms[key].value;
      fx.uniforms[key].value = 0;
    }
    fx.uniforms.uBlur.value.set(0, 0);
  } else if (menuWasActive) {
    const target = renderer.getRenderTarget();
    for (const buffer of [afterimage.textureOld, afterimage.textureComp]) {
      renderer.setRenderTarget(buffer);
      renderer.clear();
    }
    renderer.setRenderTarget(target);
  }
  try {
    (cached ? menuComposer : composer).render();
    if (cached) menuPerformance.interfaceFrames++;
  } finally {
    worldPasses.forEach((pass, index) => { pass.enabled = enabled[index]; });
    for (const key in saved) fx.uniforms[key].value = saved[key];
  }
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.05, clock.getDelta());
  if (document.hidden) return;
  const menu = game.state === 'menu';
  if (menu && menuReady) updateMenuBackground(rdt);
  if (!window.__freeze) tick(rdt);
  touchControls.update();
  if (innerWidth > 0 && innerHeight > 0 && (!menu || menuReady || crtInterface.visible)) renderView(menu);
  menuWasActive = menu && menuReady;
}
function tick(dt) {
  updateCrtParallax(dt);
  fx.uniforms.uTime.value += dt;
  const live = game.state === 'play' || game.state === 'note' || game.state === 'dying';
  if(chapter.active&&live){
    game.time+=dt;echo.update(dt);
    // The prompt is empty exactly when nothing is in focus; the crosshair follows it
    // (otherwise it keeps the highlight left by the lift button of chapter I).
    const prompt=game.state==='play'?chapter.update(dt,camera):'';
    if(game.state==='play')$('prompt').textContent=prompt;
    $('crosshair').classList.toggle('focus',!!prompt);
    player.update(dt,scene);camera.updateMatrixWorld(true);
    if(player.pitFall?.impacted&&game.state==='play')die('pit');
    vm.root.visible=game.state!=='dying'&&!player.pitFall&&!player.hidden;vm.update(dt,camera,player);
    monster.update(dt,player,game);
    if(game.state==='dying')updateScare(dt);
    updateAmbient(dt,player.level);updateFear(dt);updateListen(dt);updateHint(dt);updateHUD();
    updateTimers(dt);touchCd-=dt;
    dust.material.uniforms.uCam.value.copy(camera.position);audio.setListener(camera);
    return;
  }
  if (live) {
    game.time += dt;
    echo.update(dt);
    player.update(dt, scene);
    if (player.fallT > 0 && (itemAction || hold)) cancelWork();
    player.actionLean = itemAction?.kind==='pickupFuse' ? -Math.min(.8,Math.max(0,player.eye-.8)) * THREE.MathUtils.smoothstep(itemAction.t/itemAction.duration,0,.25) * (1-THREE.MathUtils.smoothstep(itemAction.t/itemAction.duration,.55,.9)) : 0;
    camera.position.y += player.actionLean;
    if(player.actionLean)camera.rotation.x += player.actionLean*.22;
    camera.updateMatrixWorld(true);
    updateItemAction(dt);
    updateHold(dt);
    if(chapter.active){
      camera.updateMatrixWorld(true);vm.update(dt,camera,player);audio.setListener(camera);return;
    }
    if(!hold?.generator)generatorProps.sync(game.flags);
    vm.root.visible = game.state !== 'dying' && !player.hidden;
    vm.update(dt, camera, player);
    monster.update(dt, player, game);
    if (game.state === 'dying') updateScare(dt);
    level.updateDoors(dt);
    updateAmbient(dt);
    updateFear(dt);
    updateDread(dt);
    updateListen(dt);
    updateTimers(dt);
    touchCd -= dt;
    if (siege.active) siege.update(dt);
    extras.update(dt);
    if (radarT > 0) {
      radarT -= dt;
      drawRadar(radarNode);
      if (radarT <= 0) $('radar').classList.add('hidden');
    }
    dust.material.uniforms.uCam.value.copy(camera.position);
    audio.setListener(camera);
    if (game.state === 'play' && player.fallT <= 0) {
      focus = findFocus();
      $('prompt').textContent = promptFor(focus);
      $('crosshair').classList.toggle('focus', !!focus);
    } else $('prompt').textContent = '';
    updateHint(dt);
    updateLocation(dt);
    updateHUD();
  } else if (game.state === 'end') {
    echo.update(dt);
  }
}
const touchControls=createTouchControls({
  player,game,siege,pause,closeNote,
  mapPoint: crtInterface.mapPoint,
  look:(dx,dy)=>player.look(dx,dy,0.0035*sens),
  throwItem:()=>{if(game.state!=='play'||vm.work||player.fallT>0)return;if(extras.held.length){if(extras.throwClock(camera))vm.throw('clock');}else{if(player.stones>0)vm.throw();player.throwStone(scene);}},
});
applyQuality(savedQ);
frame();

// debug handle
window.__siege = siege;
window.__game = {
  game, player, monster, level, echo, audio, camera, menuCamera, vm, gtao, composer, extras, crtInterface, menuPerformance, menuBackground, menuComposer, generatorProps, roomVisibility, chapter, caveLevel, startCave,
  tick(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) tick(dt);
  },
  use(it) {
    focus = it;
    interact();
  },
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) tick(dt);
    renderView(game.state === 'menu');
  },
};

// Compact browser verification hooks; world coordinates: +X east, +Z south.
window.render_game_to_text = () => JSON.stringify({
  screen: front.screen, mode: game.state,
  chapter: chapter.active?{id:2,...chapter.sequence.snapshot(),assets:caveLevel.assetStats}:{id:1},
  loading: { label: $('load-label').textContent, progress: +$('load-progress').getAttribute('aria-valuenow') },
  menuBackground: menuReady ? 'live-3d-level' : 'loading',
  crtInterface: crtInterface.ready,
  crtParallax: { x: +fx.uniforms.uGlassOffset.value.x.toFixed(4), y: +fx.uniforms.uGlassOffset.value.y.toFixed(4) },
  interfaceLayer: crtInterface.layer,
  playerMeters: document.body.classList.contains('show-player-meters'),
  touch: touchControls.enabled,
  rendering: { ratio: composer.renderer.getPixelRatio(), visibleBatches: roomVisibility.stats.visible, totalBatches: roomVisibility.stats.total },
  objective: { text: lastObjective, visible: $('objective').classList.contains('visible') },
  audioReady: audio.ready, checkpoint: !!loadSave(),
  player: { x: +player.pos.x.toFixed(2), y: +player.pos.y.toFixed(2), z: +player.pos.z.toFixed(2), crouching: player.crouch, stones: player.stones, falling: player.fallT > 0 || !!player.pitFall, pitFall: !!player.pitFall, recovery: +player.fallT.toFixed(2), falls: player.falls },
  psychosis: +game.psychosis.toFixed(2),
  cane: { streak: player.clickStreak, quietIn: +player.clickQuietT.toFixed(2) },
  hands: { leftVisible: vm.left.visible, pose: vm.leftHand.pose, contact: vm.contact?.type || null, point: vm.contact?.point.toArray(), normal: vm.contact?.normal.toArray() },
  interaction: vm.work ? { kind: vm.work.kind, progress: +vm.work.k.toFixed(3), slot: vm.work.slot, can: vm.workCan.visible, stream: vm.fuelStream.visible } : null,
  generator: { installed: game.flags.genInstalled||0, fueled: !!game.flags.genFueled, powered: !!game.flags.powered },
  monster: { active: monster.active, state: monster.state, x: +monster.pos.x.toFixed(2), z: +monster.pos.z.toFixed(2), suspicion: +monster.suspicion.toFixed(2) },
  siege: { active: siege.active, phase: siege.phase, stage: siege.stage, route: siege.route, power: +siege.power?.toFixed(1), stalled: siege.stalled, remaining: +siege.remaining.toFixed(1), bracing: siege.bracing, monsterInHall: siege.monsterInHall, warning: $('sg-warn').textContent },
  coordinates: '+X east, +Z south; metres',
});
window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < steps; i++) {
    if (game.state === 'menu' && menuReady) updateMenuBackground(1 / 60);
    tick(1 / 60);
  }
  renderView(game.state === 'menu');
};
