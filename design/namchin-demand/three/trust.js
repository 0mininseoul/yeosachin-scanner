import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TubeGeometry,
  Vector3,
} from 'three';
import {
  BRAND,
  COLORS,
  FONT,
  canvasPlane,
  clamp,
  createRenderer,
  drawPicture,
  glowTexture,
  kakaoIcon,
  loadPicture,
  mix,
  roundRect,
  runLoop,
  waitForFonts,
  TARGET,
} from './shared.js';

const DURATION = 6;
const PACKETS = 18;

function nodeCard(ctx, w, h, { title, lines, accent = COLORS.ink, icon = 'avatar', glow = 0, picture = null }) {
  const m = w * 0.07;
  ctx.save();
  ctx.shadowColor = glow > 0 ? `rgba(255, 70, 95, ${0.35 + glow * 0.5})` : 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = m * (1.2 + glow * 1.4);
  ctx.fillStyle = '#fffaf4';
  roundRect(ctx, m, m, w - m * 2, h - m * 2, w * 0.1);
  ctx.fill();
  ctx.restore();
  const cx = w / 2;
  const iy = h * 0.3;
  const size = w * 0.3;
  if (picture) {
    drawPicture(ctx, picture, cx - size / 2, iy - size / 2, size, size, size / 2);
  } else if (icon === 'avatar') {
    ctx.fillStyle = '#dfe8d4';
    ctx.beginPath();
    ctx.arc(cx, iy, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3c5431';
    ctx.font = `800 ${size * 0.42}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', cx, iy + size * 0.03);
  } else {
    kakaoIcon(ctx, cx - size / 2, iy - size / 2, size);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 ${w * 0.1}px ${FONT}`;
  ctx.fillText(title, cx, h * 0.6);
  lines.forEach((line, index) => {
    ctx.fillStyle = index === lines.length - 1 ? accent : COLORS.muted;
    ctx.font = `${index === lines.length - 1 ? 800 : 400} ${w * 0.078}px ${FONT}`;
    ctx.fillText(line, cx, h * (0.73 + index * 0.1));
  });
  ctx.textAlign = 'left';
}

function pill(ctx, w, h, text, bg, fg) {
  const m = h * 0.12;
  ctx.fillStyle = bg;
  roundRect(ctx, m, m, w - m * 2, h - m * 2, (h - m * 2) / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = `800 ${h * 0.36}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + h * 0.02);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export async function mountTrust(container) {
  await waitForFonts();
  const him = await loadPicture('/cherry/assets/hero/maru-profile.jpg');
  const renderer = createRenderer(container);
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  const glow = glowTexture('255, 96, 116');
  const softGlow = glowTexture('255, 200, 180');
  const plane = (options) => canvasPlane({ renderer, ...options });
  const world = new Group();
  scene.add(world);

  const source = plane({
    width: 1.6, height: 2.0, pixels: 640,
    draw: (ctx, w, h) => nodeCard(ctx, w, h, { title: TARGET.full, lines: ['인스타 프로필', '아무것도 몰라요'], accent: '#5b8a4a', picture: him }),
  });
  const target = plane({
    width: 1.6, height: 2.0, pixels: 640,
    draw: (ctx, w, h, state = {}) => nodeCard(ctx, w, h, { title: '내 카카오톡', lines: [BRAND, '새 소식 도착'], accent: COLORS.cherry, icon: 'talk', glow: state.glow ?? 0 }),
  });
  world.add(source.mesh, target.mesh);

  const readOnly = plane({ width: 1.3, height: 0.36, pixels: 480, draw: (ctx, w, h) => pill(ctx, w, h, '읽기만 해요', '#ffffff1f', '#ffe6dc') });
  const filterLabel = plane({ width: 1.5, height: 0.36, pixels: 540, draw: (ctx, w, h) => pill(ctx, w, h, `${BRAND} · 새 맞팔만`, COLORS.cherry, '#fff') });
  const noReturn = plane({ width: 1.7, height: 0.36, pixels: 600, draw: (ctx, w, h) => pill(ctx, w, h, `${TARGET.short}은 모르게`, '#ffffff24', '#ffe6e6') });
  world.add(readOnly.mesh, filterLabel.mesh, noReturn.mesh);

  // One-way valve next to the source.
  const valve = new Group();
  const valveRing = new Mesh(new RingGeometry(0.42, 0.47, 64), new MeshBasicMaterial({ color: '#ff5d73', transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
  const valveDisc = new Mesh(new RingGeometry(0, 0.42, 64), new MeshBasicMaterial({ color: '#ff5d73', transparent: true, opacity: 0.08, blending: AdditiveBlending, depthWrite: false }));
  valve.add(valveRing, valveDisc);
  world.add(valve);

  // Core that filters the data.
  const core = new Group();
  const shell = new Mesh(new IcosahedronGeometry(0.62, 1), new MeshBasicMaterial({ color: '#ff8c9b', wireframe: true, transparent: true, opacity: 0.55 }));
  const heart = new Mesh(new SphereGeometry(0.26, 32, 16), new MeshBasicMaterial({ color: '#ff3d58', toneMapped: false }));
  const halo = new Sprite(new SpriteMaterial({ map: glow, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
  halo.scale.setScalar(2.2);
  core.add(shell, heart, halo);
  world.add(core);

  // Tunnels.
  const tunnelMaterial = new MeshBasicMaterial({ color: '#ff9aa8', transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false });
  const lineMaterial = new MeshBasicMaterial({ color: '#ff6b7f', transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
  let curveIn;
  let curveOut;
  const tunnelMeshes = [];

  const packetGeometry = new BufferGeometry();
  packetGeometry.setAttribute('position', new BufferAttribute(new Float32Array(PACKETS * 2 * 3), 3));
  const packets = new Points(packetGeometry, new PointsMaterial({ map: softGlow, size: 0.32, transparent: true, depthWrite: false, blending: AdditiveBlending, color: '#ffd6cc' }));
  packets.frustumCulled = false;
  const chosenGeometry = new BufferGeometry();
  chosenGeometry.setAttribute('position', new BufferAttribute(new Float32Array(PACKETS * 3), 3));
  const chosen = new Points(chosenGeometry, new PointsMaterial({ map: glow, size: 0.5, transparent: true, depthWrite: false, blending: AdditiveBlending, color: '#ff3d58' }));
  chosen.frustumCulled = false;
  world.add(packets, chosen);

  let vertical = false;
  let distance = 12;

  function layout() {
    for (const mesh of tunnelMeshes) {
      world.remove(mesh);
      mesh.geometry.dispose();
    }
    tunnelMeshes.length = 0;
    const a = vertical ? new Vector3(0, 2.45, 0) : new Vector3(-2.55, 0, 0);
    const b = vertical ? new Vector3(0, -2.45, 0) : new Vector3(2.55, 0, 0);
    source.mesh.position.copy(a);
    target.mesh.position.copy(b);
    const scale = vertical ? 1.3 : 1;
    for (const mesh of [source.mesh, target.mesh]) mesh.scale.setScalar(scale);
    for (const mesh of [readOnly.mesh, filterLabel.mesh, noReturn.mesh]) mesh.scale.setScalar(vertical ? 1.45 : 1);
    source.mesh.rotation.set(vertical ? 0.25 : 0, vertical ? 0 : 0.38, 0);
    target.mesh.rotation.set(vertical ? -0.25 : 0, vertical ? 0 : -0.38, 0);
    const valvePoint = vertical ? new Vector3(0, 1.15, 0.2) : new Vector3(-1.55, 0, 0.2);
    valve.position.copy(valvePoint);
    valve.rotation.set(vertical ? Math.PI / 2 : 0, vertical ? 0 : Math.PI / 2, 0);
    curveIn = new CatmullRomCurve3(vertical
      ? [new Vector3(0, 1.45, 0.25), new Vector3(0.25, 0.75, 0.45), new Vector3(0, 0, 0)]
      : [new Vector3(-1.8, 0, 0.25), new Vector3(-0.9, 0.35, 0.45), new Vector3(0, 0, 0)]);
    curveOut = new CatmullRomCurve3(vertical
      ? [new Vector3(0, 0, 0), new Vector3(-0.25, -0.75, 0.45), new Vector3(0, -1.45, 0.25)]
      : [new Vector3(0, 0, 0), new Vector3(0.9, -0.35, 0.45), new Vector3(1.8, 0, 0.25)]);
    for (const curve of [curveIn, curveOut]) {
      const tube = new Mesh(new TubeGeometry(curve, 60, 0.2, 16, false), tunnelMaterial);
      const line = new Mesh(new TubeGeometry(curve, 60, 0.012, 6, false), lineMaterial);
      tunnelMeshes.push(tube, line);
      world.add(tube, line);
    }
    readOnly.mesh.position.copy(vertical ? new Vector3(1.25, 1.0, 0.6) : new Vector3(-0.95, 0.95, 0.5));
    filterLabel.mesh.position.copy(vertical ? new Vector3(1.2, -0.45, 0.7) : new Vector3(0, -1.05, 0.6));
    noReturn.mesh.position.copy(vertical ? new Vector3(-1.25, 0.95, 0.6) : new Vector3(-2.55, -1.38, 0.3));
  }

  const onResize = (width, height) => {
    const aspect = width / height;
    const nextVertical = aspect < 0.95;
    if (nextVertical !== vertical || !curveIn) {
      vertical = nextVertical;
      layout();
    }
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    distance = vertical ? Math.max(3.9 / tan, 3.2 / (tan * aspect)) : Math.max(1.8 / tan, 3.45 / (tan * aspect));
  };

  const targetKey = { value: '' };

  function render(t) {
    if (!curveIn) return;
    const phase = (t / DURATION) * Math.PI * 2;
    camera.position.set(Math.sin(phase) * 0.6, 0.35 + Math.cos(phase) * 0.15, distance);
    camera.lookAt(0, 0, 0);

    source.mesh.position.z = Math.sin(phase) * 0.04;
    shell.rotation.set(t * 0.4, t * 0.6, 0);
    const beat = 1 + Math.max(0, Math.sin(t * 3.2)) * 0.12;
    heart.scale.setScalar(beat);
    halo.material.opacity = 0.6 + Math.max(0, Math.sin(t * 3.2)) * 0.35;
    valveRing.material.opacity = 0.65 + Math.sin(t * 4) * 0.25;

    // Every packet flows in; every third one is a "new follow" that continues to my phone.
    const inPositions = packetGeometry.attributes.position.array;
    const outPositions = chosenGeometry.attributes.position.array;
    let arrival = 0;
    for (let i = 0; i < PACKETS; i += 1) {
      const p = ((t / DURATION) * 3 + i / PACKETS) % 1;
      const point = curveIn.getPoint(clamp(p * 2));
      inPositions.set(p < 0.5 ? [point.x, point.y, point.z] : [0, 0, -50], i * 3);
      const isChosen = i % 3 === 0;
      if (isChosen && p >= 0.5) {
        const q = (p - 0.5) * 2;
        const outPoint = curveOut.getPoint(q);
        outPositions.set([outPoint.x, outPoint.y, outPoint.z], i * 3);
        if (q > 0.85) arrival = Math.max(arrival, (q - 0.85) / 0.15);
      } else {
        outPositions.set([0, 0, -50], i * 3);
      }
    }
    packetGeometry.attributes.position.needsUpdate = true;
    chosenGeometry.attributes.position.needsUpdate = true;

    const glowLevel = Math.round(mix(0, 1, arrival) * 10) / 10;
    if (targetKey.value !== String(glowLevel)) {
      targetKey.value = String(glowLevel);
      target.redraw({ glow: glowLevel });
    }

    renderer.render(scene, camera);
  }

  runLoop({ container, renderer, camera, duration: DURATION, stillAt: 2.2, render, onResize });
  container.classList.add('is-live');
}
