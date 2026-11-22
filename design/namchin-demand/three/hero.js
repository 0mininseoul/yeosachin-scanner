import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  Shape,
  Vector3,
} from 'three';
import {
  BRAND,
  COLORS,
  DIGITS,
  FONT,
  canvasPlane,
  clamp,
  createRenderer,
  drawPicture,
  easeInCubic,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  easeOutExpo,
  fitFont,
  glowTexture,
  kakaoIcon,
  loadPicture,
  mix,
  roundRect,
  runLoop,
  span,
  stagePixelRatio,
  waitForFonts,
  wrapText,
} from './shared.js';

// One cycle per account: the count (0 to LEAD), then the story, whose times below start at 0.
const LEAD = 1.4;
const CYCLE = LEAD + 9.6;
const COUNT = { in: [0, 0.4], roll: [0.6, 0.86], plus: [0.8, 1.06], out: [LEAD - 0.24, LEAD + 0.06], fly: [LEAD - 0.06, LEAD + 0.6] };
// No Instagram profile was visible for these handles when checked signed out (2026-11-22). Check any new handle too.
// The film plays one report after another; his following count goes up by one each time.
// Tags and summary say who she is (what she likes, what she posts, what she is like), never a specific job.
const PEOPLE = [
  {
    from: 230,
    handle: '@seoa.ondo_',
    name: '박서아',
    photos: 'seoa',
    stats: [['팔로워', 320], ['팔로잉', 306], ['게시물', 6]],
    tags: ['대학생', '감성 일상', '잘 웃는 타입', '전시 덕후', '과제 기록', '셀카 장인'],
    summary: '전시와 그림을 좋아하는 대학생이에요. 과제 기록과 전시 후기를 자주 올리고, 잘 웃는 차분한 느낌의 여성분이에요.',
    keywords: ['대학생', '과제', '전시', '차분한', '느낌'],
  },
  {
    from: 231,
    handle: '@rina.wknd_',
    name: '리나',
    photos: 'rina',
    stats: [['팔로워', 1312], ['팔로잉', 503], ['게시물', 20]],
    tags: ['운동 인증', '인싸 타입', '여행 좋아함', '데일리룩', '럭셔리 취향', '밤 약속 많음'],
    summary: '운동과 여행을 좋아하는 직장인이에요. 운동 인증과 데일리룩을 자주 올리고, 밤 약속이 많은 활발한 인싸예요.',
    keywords: ['직장인', '운동', '데일리룩', '활발한', '인싸'],
  },
];
const DURATION = CYCLE * PEOPLE.length;

// Act 1 (the phone), then the cut to the report.
const T = {
  phoneIn: [0, 0.6],
  push: [0.5, 0.95],
  finger: [1.15, 1.6],
  tap: 1.64,
  expand: [1.76, 2.16],
  dive: [1.72, 2.2],
  cut: 2.18,
  fadeOut: [9.1, 9.55],
};

// Act 2, always in two parts: the profile with its numbers, one scroll, then the photos with the summary.
const R = {
  header: [2.25, 2.7],
  profile: [2.28, 2.95],
  scan: [2.6, 3.7],
  stats: [2.7, 3.3],
  count: [2.95, 4.0],
  open: [3.45, 3.95],
  scroll: [4.8, 5.65],
  thumbs: 5.0,
  tags: 5.6,
  summary: [6.45, 6.95],
  typing: [6.7, 7.9],
};

const HIM = '/namchin/assets/hero/maru-profile.jpg';

async function loadPhotos({ photos }) {
  const names = ['profile', ...[1, 2, 3, 4, 5, 6].map((index) => `post-${index}`)];
  const [her, ...posts] = await Promise.all(names.map((name) => loadPicture(`/namchin/assets/hero/${photos}-${name}.jpg`)));
  return { her, posts };
}

/* ---------- 2D drawing: following count ---------- */

function drawCount(ctx, w, h, { roll = 0, from = 230, him = null } = {}) {
  const size = h * 0.8;
  const top = (h - size) / 2;
  drawPicture(ctx, him, top, top, size, size, size / 2, '#3a1820');
  ctx.strokeStyle = COLORS.cherry;
  ctx.lineWidth = h * 0.035;
  ctx.beginPath();
  ctx.arc(top + size / 2, h / 2, size / 2 + h * 0.055, 0, Math.PI * 2);
  ctx.stroke();

  const x = top + size + h * 0.26;
  ctx.fillStyle = '#ffc2c9';
  ctx.font = `800 ${h * 0.165}px ${FONT}`;
  ctx.fillText('남친 팔로잉', x, h * 0.27);

  const digit = h * 0.74;
  const baseline = h * 0.9;
  ctx.font = `700 ${digit}px ${DIGITS}`;
  ctx.fillStyle = '#fff4f1';
  const before = String(from);
  ctx.fillText(before.slice(0, -1), x, baseline);
  const last = x + ctx.measureText(before.slice(0, -1)).width;
  const slot = ctx.measureText('0').width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(last, baseline - digit * 0.8, slot, digit * 0.9);
  ctx.clip();
  ctx.textAlign = 'center';
  const shift = easeOutBack(clamp(roll)) * digit;
  ctx.fillText(before.slice(-1), last + slot / 2, baseline - shift);
  ctx.fillStyle = '#ff6b80';
  ctx.fillText(String(from + 1).slice(-1), last + slot / 2, baseline + digit - shift);
  ctx.restore();
}

function drawPlus(ctx, w, h) {
  ctx.fillStyle = COLORS.cherry;
  roundRect(ctx, 0, 0, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `700 ${h * 0.74}px ${DIGITS}`;
  ctx.fillText('+1', w / 2, h * 0.76);
  ctx.textAlign = 'left';
}

/* ---------- 2D drawing: lock screen ---------- */

const today = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

function drawScreen(ctx, w, h, { push = 0, pressed = 0, expand = 0 } = {}) {
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#6b1226');
  wall.addColorStop(0.5, '#2b0a12');
  wall.addColorStop(1, '#120709');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.82, h * 0.04, 0, w * 0.82, h * 0.04, w * 1.15);
  glow.addColorStop(0, 'rgba(255, 96, 118, 0.6)');
  glow.addColorStop(1, 'rgba(255, 96, 118, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255, 240, 238, 0.84)';
  ctx.font = `800 ${w * 0.046}px ${FONT}`;
  ctx.fillText(today, w / 2, h * 0.105);
  ctx.fillStyle = '#fff4f1';
  ctx.font = `700 ${w * 0.27}px ${DIGITS}`;
  ctx.fillText('9:07', w / 2, h * 0.215);
  ctx.textAlign = 'left';

  const nx = w * 0.045;
  const nw = w - nx * 2;
  const nh = h * 0.1;
  const ny = mix(-h * 0.16, h * 0.262, easeOutBack(clamp(push)));
  if (push > 0) {
    ctx.save();
    const scale = 1 - pressed * 0.05;
    ctx.translate(w / 2, ny + nh / 2);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -(ny + nh / 2));
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = w * 0.05;
    ctx.shadowOffsetY = w * 0.015;
    ctx.fillStyle = `rgba(255, 250, 246, ${0.96 - pressed * 0.1})`;
    roundRect(ctx, nx, ny, nw, nh, w * 0.06);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    const icon = w * 0.135;
    kakaoIcon(ctx, nx + w * 0.04, ny + (nh - icon) / 2, icon);
    const tx = nx + w * 0.215;
    ctx.fillStyle = COLORS.ink;
    ctx.font = `800 ${w * 0.058}px ${FONT}`;
    ctx.fillText(BRAND, tx, ny + nh * 0.43);
    ctx.font = `400 ${w * 0.052}px ${FONT}`;
    ctx.fillText('새 소식이 도착했어요', tx, ny + nh * 0.76);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 ${w * 0.037}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText('지금', nx + nw - w * 0.05, ny + nh * 0.39);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  if (expand > 0) {
    const e = easeInOutCubic(clamp(expand));
    ctx.fillStyle = mixHex(expand);
    roundRect(ctx, mix(nx, 0, e), mix(ny, 0, e), mix(nw, w, e), mix(nh, h, e), mix(w * 0.06, 0, e));
    ctx.fill();
  }

  ctx.fillStyle = '#050304';
  roundRect(ctx, w * 0.35, h * 0.014, w * 0.3, h * 0.026, h * 0.013);
  ctx.fill();
}

// The opening notification turns from paper through cherry into the dark report background.
function mixHex(t) {
  const k = easeInOutCubic(clamp(t)) * 2;
  const [from, to] = k < 1 ? [[255, 250, 246], [192, 24, 54]] : [[192, 24, 54], [26, 12, 16]];
  const part = k < 1 ? k : k - 1;
  return `rgb(${from.map((channel, index) => Math.round(mix(channel, to[index], part))).join(', ')})`;
}

function drawFinger(ctx, w, h) {
  const r = w * 0.34;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(224, 52, 75, 0.75)';
  ctx.lineWidth = w * 0.04;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, r * 1.28, 0, Math.PI * 2);
  ctx.stroke();
}

/* ---------- 2D drawing: report ---------- */

// Bracket marks that travel in to the corners.
function corners(ctx, w, h, length, weight, progress) {
  if (progress <= 0) return;
  const inset = weight + (1 - progress) * length;
  ctx.strokeStyle = `rgba(255, 107, 125, ${0.9 * progress})`;
  ctx.lineWidth = weight;
  ctx.lineCap = 'square';
  for (const [x, y, sx, sy] of [[inset, inset, 1, 1], [w - inset, inset, -1, 1], [inset, h - inset, 1, -1], [w - inset, h - inset, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x + sx * length, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * length);
    ctx.stroke();
  }
}

function label(ctx, text, x, y, size, color = '#ff9dab') {
  ctx.fillStyle = color;
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.fillText(text, x, y);
}

function drawHeader(ctx, w, h) {
  label(ctx, '새 맞팔 리포트', 0, h * 0.72, h * 0.7, '#fff0ee');
}

function drawProfile(ctx, w, h, { zoom = 1, scan = 0, frame = 1, her = null, handle = '', name = '', unit = 100 } = {}) {
  const r = unit * 0.22;
  ctx.save();
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.clip();
  const grow = 1 + (1 - easeOutCubic(clamp(zoom))) * 0.4;
  drawPicture(ctx, her, -(w * (grow - 1)) / 2, -(h * (grow - 1)) / 2, w * grow, h * grow, 0, '#3a1820');

  const active = scan > 0 && scan < 1;
  if (active) {
    const ly = h * (0.5 - 0.5 * Math.cos(scan * Math.PI * 3));
    const band = ctx.createLinearGradient(0, ly - h * 0.16, 0, ly + h * 0.02);
    band.addColorStop(0, 'rgba(224, 52, 75, 0)');
    band.addColorStop(1, 'rgba(224, 52, 75, 0.5)');
    ctx.fillStyle = band;
    ctx.fillRect(0, ly - h * 0.16, w, h * 0.18);
    ctx.fillStyle = '#ff8597';
    ctx.fillRect(0, ly, w, Math.max(2, unit * 0.015));
  }

  const shade = ctx.createLinearGradient(0, h * 0.52, 0, h);
  shade.addColorStop(0, 'rgba(20, 8, 11, 0)');
  shade.addColorStop(1, 'rgba(20, 8, 11, 0.9)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, h * 0.5, w, h * 0.5);
  ctx.restore();

  // Reticle settling on the portrait
  const reticle = easeOutCubic(clamp(scan * 2.4));
  if (reticle > 0 && scan < 1) {
    const size = Math.min(w, h) * mix(0.95, 0.6, reticle);
    ctx.save();
    ctx.translate(w / 2 - size / 2, Math.min(h * 0.4, w * 0.5) - size / 2);
    corners(ctx, size, size, size * 0.14, Math.max(2, unit * 0.022), reticle);
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(255, 214, 219, 0.16)';
  ctx.lineWidth = Math.max(1, unit * 0.012);
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.stroke();

  const done = scan >= 1;
  const chip = done ? '분석 완료' : `분석 ${String(Math.round(scan * 100)).padStart(2, '0')}%`;
  const cs = unit * 0.15;
  ctx.font = `800 ${cs}px ${FONT}`;
  const cw = ctx.measureText(chip).width + cs * 1.5;
  ctx.fillStyle = done ? COLORS.cherry : 'rgba(18, 8, 10, 0.74)';
  roundRect(ctx, unit * 0.12, unit * 0.12, cw, cs * 1.9, cs);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(chip, unit * 0.12 + cs * 0.75, unit * 0.12 + cs * 1.3);

  ctx.globalAlpha = clamp(frame);
  ctx.fillStyle = '#fff4f1';
  fitFont(ctx, 800, unit * 0.25, handle, w - unit * 0.28);
  ctx.fillText(handle, unit * 0.14, h - unit * 0.36);
  ctx.fillStyle = 'rgba(255, 232, 230, 0.78)';
  fitFont(ctx, 400, unit * 0.175, name, w - unit * 0.28);
  ctx.fillText(name, unit * 0.14, h - unit * 0.14);
  ctx.globalAlpha = 1;
}

// No box: the numbers stand in open space, label above value.
function drawStats(ctx, w, h, { count = 0, unit = 100, stats = [] } = {}) {
  const row = h / 3;
  stats.forEach(([name, value], index) => {
    const local = easeOutCubic(clamp(count * 1.5 - index * 0.22));
    const y = row * index;
    ctx.globalAlpha = clamp(count * 5 - index * 0.8);
    ctx.fillStyle = 'rgba(255, 232, 230, 0.66)';
    ctx.font = `400 ${unit * 0.2}px ${FONT}`;
    ctx.fillText(name, 0, y + row * 0.3);
    ctx.fillStyle = index === 0 ? '#ff7d90' : '#fff4f1';
    // Sized for the final number, so counting up never changes the scale.
    let size = Math.min(row * 0.56, unit * (index === 0 ? 0.7 : 0.54));
    ctx.font = `700 ${size}px ${DIGITS}`;
    const width = ctx.measureText(value.toLocaleString('ko-KR')).width;
    if (width > w) size *= w / width;
    ctx.font = `700 ${size}px ${DIGITS}`;
    ctx.fillText(Math.round(value * local).toLocaleString('ko-KR'), 0, y + row * 0.3 + size * 0.92);
    ctx.globalAlpha = 1;
  });
}

// The way to her profile: a button with a plain camera mark.
function drawOpen(ctx, w, h) {
  ctx.fillStyle = '#fff4f1';
  roundRect(ctx, 0, 0, w, h, h * 0.36);
  ctx.fill();
  const text = '인스타그램에서 보기';
  const size = h * 0.38;
  const mark = h * 0.42;
  fitFont(ctx, 800, size, text, w - mark - h);
  const total = mark + h * 0.2 + ctx.measureText(text).width;
  const x = (w - total) / 2;
  const y = (h - mark) / 2;
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = mark * 0.1;
  roundRect(ctx, x, y, mark, mark, mark * 0.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + mark / 2, y + mark / 2, mark * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  ctx.arc(x + mark * 0.76, y + mark * 0.24, mark * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText(text, x + mark + h * 0.2, h / 2 + size * 0.36);
}

function drawThumb(ctx, w, h, { picture = null } = {}) {
  drawPicture(ctx, picture, 0, 0, w, h, w * 0.13, '#3a1820');
}

function drawTag(ctx, w, h, { text = '' } = {}) {
  fitFont(ctx, 800, h * 0.54, text, w - h * 0.9);
  const width = ctx.measureText(text).width + h * 0.9;
  ctx.fillStyle = COLORS.cherry;
  roundRect(ctx, (w - width) / 2, 0, width, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h * 0.7);
  ctx.textAlign = 'left';
}

function drawSummary(ctx, w, h, { typed = 0, unit = 100, text = 0.23, summary = '', keywords = [] } = {}) {
  let size = unit * text;
  let lines = [];
  // Shrink until the last line stays inside the plane.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    ctx.font = `800 ${size}px ${FONT}`;
    lines = wrapText(ctx, summary, w);
    if (size * (1.5 + 1.52 * lines.length) <= h) break;
    size *= 0.94;
  }
  const leading = size * 1.52;
  label(ctx, 'AI 요약', 0, size * 0.85, size * 0.82);
  let left = Math.round(summary.length * clamp(typed));
  let y = size * 0.95 + leading;
  let caret = null;
  for (const line of lines) {
    let x = 0;
    for (const word of line.split(' ')) {
      if (left <= 0) break;
      // A keyword lights up without its particle: 대학생 in 대학생이에요.
      const stem = keywords.find((keyword) => word.startsWith(keyword)) ?? '';
      const part = word.slice(0, left);
      for (const [text, hit] of [[part.slice(0, stem.length), true], [part.slice(stem.length), false]]) {
        ctx.font = `${hit ? 800 : 400} ${size}px ${FONT}`;
        ctx.fillStyle = hit ? '#ff9dab' : '#fff0ee';
        ctx.fillText(text, x, y);
        x += ctx.measureText(text).width;
      }
      caret = [x, y];
      left -= word.length + 1;
      ctx.font = `400 ${size}px ${FONT}`;
      x += ctx.measureText(' ').width;
    }
    y += leading;
  }
  if (typed > 0 && typed < 1 && caret) {
    ctx.fillStyle = COLORS.cherry;
    ctx.fillRect(caret[0] + size * 0.12, caret[1] - size * 0.82, Math.max(2, size * 0.1), size);
  }
}

/* ---------- 3D helpers ---------- */

function roundedRectShape(w, h, r) {
  const shape = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}

function disposeTree(group) {
  group.traverse((item) => {
    item.geometry?.dispose();
    for (const material of [item.material].flat().filter(Boolean)) {
      material.map?.dispose();
      material.dispose();
    }
  });
  group.removeFromParent();
}

/* ---------- Scene ---------- */

const VIEW = 5; // visible world height during the report
const TAN = Math.tan((30 * Math.PI) / 360);
const REPORT_DISTANCE = VIEW / (2 * TAN);

/** `startWhen` (optional) holds the first frame until the page is ready for the film. */
export async function mountHero(container, { startWhen } = {}) {
  await waitForFonts();
  const [him, first] = await Promise.all([loadPicture(HIM), loadPhotos(PEOPLE[0])]);

  const renderer = createRenderer(container);
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.02, 100);
  scene.add(camera);
  scene.add(new AmbientLight('#ffe9e6', 0.7));
  const key = new DirectionalLight('#fff3f0', 2.4);
  key.position.set(2.5, 3, 5);
  scene.add(key);
  const rim = new PointLight('#ff3355', 40, 0, 2);
  rim.position.set(-3, 1.5, 1.5);
  scene.add(rim);
  const glow = glowTexture('255, 90, 110');
  const plane = (options) => canvasPlane({ renderer, ...options });

  /* Opening beat: his following count, pinned to the camera in front of everything */
  const HUD = 4;
  const hudHeight = 2 * HUD * TAN;
  const hud = new Group();
  hud.position.z = -HUD;
  camera.add(hud);
  const count = plane({ width: 2.72, height: 1, pixels: 1300, draw: (ctx, w, h, state) => drawCount(ctx, w, h, { him, ...state }) });
  const plus = plane({ width: 0.44, height: 0.26, pixels: 260, draw: drawPlus });
  const countRing = new Mesh(new RingGeometry(1.0, 1.02, 96), new MeshBasicMaterial({ color: '#ff4d64', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, depthTest: false }));
  for (const item of [count, plus]) {
    item.material.depthTest = false;
    item.mesh.renderOrder = 6;
    hud.add(item.mesh);
  }
  hud.add(countRing);

  /* Act 1: the phone */
  const act1 = new Group();
  scene.add(act1);
  const phone = new Group();
  act1.add(phone);
  const depth = 0.1;
  const bevel = 0.035;
  const bodyGeometry = new ExtrudeGeometry(roundedRectShape(1.62, 3.32, 0.27), { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 24 });
  bodyGeometry.center();
  phone.add(new Mesh(bodyGeometry, new MeshStandardMaterial({ color: '#241216', metalness: 0.75, roughness: 0.32 })));
  const screen = plane({ width: 1.5, height: 3.2, pixels: 1800, draw: drawScreen });
  screen.mesh.position.z = depth / 2 + bevel + 0.003;
  phone.add(screen.mesh);
  const finger = plane({ width: 0.4, height: 0.4, pixels: 220, draw: drawFinger });
  finger.mesh.position.z = screen.mesh.position.z + 0.05;
  phone.add(finger.mesh);
  const rings = [0, 1, 2].map(() => {
    const ring = new Mesh(new RingGeometry(1.0, 1.04, 96), new MeshBasicMaterial({ color: '#ff4d64', transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    ring.position.z = -0.25;
    act1.add(ring);
    return ring;
  });

  /* Act 2: the report */
  const act2 = new Group();
  scene.add(act2);
  const dustCount = 140;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) dustPositions.set([(Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8, -3 + Math.random() * 4.5], i * 3);
  const dustGeometry = new BufferGeometry();
  dustGeometry.setAttribute('position', new BufferAttribute(dustPositions, 3));
  const dust = new Points(dustGeometry, new PointsMaterial({ map: glow, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, color: '#ff9aa8' }));
  act2.add(dust);

  const gridPoints = [];
  for (let i = -8; i <= 8; i += 1) gridPoints.push(i, -8, 0, i, 8, 0, -8, i, 0, 8, i, 0);
  const gridGeometry = new BufferGeometry();
  gridGeometry.setAttribute('position', new BufferAttribute(new Float32Array(gridPoints), 3));
  const grid = new LineSegments(gridGeometry, new LineBasicMaterial({ color: '#ff8c9b', transparent: true, opacity: 0.07, depthWrite: false }));
  grid.position.z = -1.6;
  act2.add(grid);

  const flash = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ color: '#ff5a70', transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false, blending: AdditiveBlending }));
  flash.position.z = -0.4;
  flash.renderOrder = 10;
  camera.add(flash);

  let layout = null;
  let layouts = [];

  function panel(group, { x, y, z = 0, width, height, draw, unitPixels, extra = {} }) {
    const item = plane({ width, height, pixels: Math.min(1500, Math.round(Math.max(width, height) * unitPixels)), draw: (ctx, w, h, state) => draw(ctx, w, h, { unit: w / width, ...extra, ...state }) });
    item.home = { x, y, z };
    item.key = '';
    item.mesh.position.set(x, y, z);
    group.add(item.mesh);
    return item;
  }

  function buildLayout(viewWidth, unitPixels, person, { her, posts }) {
    const group = new Group();
    act2.add(group);
    const inner = Math.min(viewWidth - 0.76, 4.3);
    const left = -inner / 2;

    const gap = 0.36;
    const side = inner * 0.57;
    const rowHeight = Math.min(2.6, side * 1.3);
    const openH = 0.46;
    const headerY = (0.36 + 0.28 + rowHeight + 0.26 + openH) / 2 - 0.18;
    const rowY = headerY - 0.18 - 0.28 - rowHeight / 2;
    const statsW = inner - side - gap;
    const header = panel(group, { x: left + 1, y: headerY, width: 2, height: 0.36, draw: drawHeader, unitPixels });
    const profile = panel(group, { x: left + side / 2, y: rowY, width: side, height: rowHeight, draw: drawProfile, unitPixels, extra: { her, handle: person.handle, name: person.name } });
    const stats = panel(group, { x: inner / 2 - statsW / 2, y: rowY - 0.04, width: statsW, height: rowHeight * 0.9, draw: drawStats, unitPixels, extra: { stats: person.stats } });

    const open = panel(group, { x: 0, y: rowY - rowHeight / 2 - 0.26 - openH / 2, width: inner, height: openH, draw: drawOpen, unitPixels });

    // The second part hangs `travel` below the first.
    const gutter = 0.2;
    const size = Math.min((inner - gutter * 2) / 3, 1.0);
    const pitch = size + 0.32;
    const span0 = size * 3 + gutter * 2;
    const summaryH = 1.55;
    const block = size + pitch + 0.54 + summaryH;
    const travel = 4.7;
    const top = block / 2 - travel;
    const tagH = size * 0.25;
    const thumbs = [];
    const tags = [];
    posts.forEach((picture, index) => {
      const x = -span0 / 2 + size / 2 + (index % 3) * (size + gutter);
      const y = top - size / 2 - Math.floor(index / 3) * pitch;
      thumbs.push(panel(group, { x, y, width: size, height: size, draw: drawThumb, unitPixels, extra: { picture } }));
      tags.push(panel(group, { x, y: y - size * 0.5 + tagH * 0.18, z: 0.16, width: size * 1.1, height: tagH, draw: drawTag, unitPixels: unitPixels * 1.4, extra: { text: person.tags[index] } }));
    });
    const summary = panel(group, { x: 0, y: top - block + summaryH / 2, width: span0, height: summaryH, draw: drawSummary, unitPixels, extra: { summary: person.summary, keywords: person.keywords, text: Math.min(0.25, span0 * 0.068) } });
    return { group, travel, header, profile, stats, open, thumbs, tags, summary };
  }

  // The second report's photos arrive while the first one plays; until then the first one repeats.
  const people = [{ person: PEOPLE[0], pictures: first }];
  let frame = null;
  const buildFor = ({ person, pictures }) => buildLayout(frame.viewWidth, frame.unitPixels, person, pictures);

  let aspect = 1;
  const onResize = (width, height) => {
    aspect = width / height;
    const viewWidth = VIEW * aspect;
    if (frame && Math.abs(frame.viewWidth - viewWidth) < 0.02) return;
    const unitPixels = Math.max(150, (height / VIEW) * stagePixelRatio() * 1.3);
    frame = { viewWidth, unitPixels };
    for (const item of layouts) disposeTree(item.group);
    layouts = people.map(buildFor);
    layout = layouts[0];
    screenKey = '';
  };

  let screenKey = '';
  const canvas = renderer.domElement;

  function redraw(item, state) {
    const id = Object.values(state).flat().map((value) => (typeof value === 'number' ? value.toFixed(3) : value)).join('|');
    if (item.key === id) return;
    item.key = id;
    item.redraw(state);
  }

  // Panels hinge open towards the viewer; `lit` dims what is not the point right now.
  function place(item, p, hinge = 'x', lit = 1) {
    item.mesh.visible = p > 0;
    if (!item.mesh.visible) return false;
    const e = easeOutExpo(p);
    const { x, y, z } = item.home;
    item.mesh.position.set(x, y + (hinge === 'x' ? (1 - e) * -0.35 : 0), z + (1 - e) * 1.3);
    item.mesh.rotation.set(hinge === 'x' ? (1 - e) * -1.25 : 0, hinge === 'y' ? (1 - e) * 1.35 : 0, 0);
    item.material.opacity = clamp(p * 3) * lit;
    return true;
  }

  let countKey = '';
  const pushPoint = new Vector3();

  function renderCount(t, from) {
    const out = easeInCubic(span(t, ...COUNT.out));
    const fly = span(t, ...COUNT.fly);
    hud.visible = fly < 1;
    if (!hud.visible) return;
    if (t < LEAD) {
      camera.fov = 30;
      camera.position.set(0, 0, REPORT_DISTANCE);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
    }

    const enter = easeOutExpo(span(t, ...COUNT.in));
    const hit = t > COUNT.roll[1] - 0.06 ? Math.exp(-(t - COUNT.roll[1] + 0.06) * 7) : 0;
    const base = Math.min(hudHeight * 0.4, (hudHeight * aspect * 0.76) / 2.72);
    const size = base * mix(1.35, 1, enter) * (1 + hit * 0.12) * mix(1, 0.72, out);
    const shake = Math.sin(t * 95) * hit * 0.02;
    count.mesh.scale.setScalar(size);
    count.mesh.position.set(shake, out * hudHeight * 0.42, 0);
    count.material.opacity = Math.min(enter, 1 - out);
    const roll = span(t, ...COUNT.roll);
    const id = `${from}|${roll.toFixed(3)}`;
    if (countKey !== id) {
      countKey = id;
      count.redraw({ roll, from });
    }

    const ring = span(t, COUNT.roll[1] - 0.06, COUNT.roll[1] + 0.8);
    countRing.scale.setScalar(base * mix(0.6, 2.6, easeOutCubic(ring)));
    countRing.material.opacity = ring > 0 && ring < 1 ? 0.7 * (1 - ring) : 0;

    // The +1 lands on the phone and turns into the notification.
    pushPoint.set(0, 0.6, 0.1);
    phone.localToWorld(pushPoint);
    camera.worldToLocal(pushPoint);
    const reach = HUD / Math.max(0.1, -pushPoint.z);
    const travel = easeInOutCubic(fly);
    const pop = easeOutBack(span(t, ...COUNT.plus));
    plus.mesh.visible = pop > 0;
    plus.mesh.scale.setScalar(Math.max(0.01, base * pop * mix(1, 1.25, Math.sin(travel * Math.PI))));
    plus.mesh.position.set(
      mix(base, pushPoint.x * reach, travel),
      mix(base * 0.27, pushPoint.y * reach, travel) + Math.sin(travel * Math.PI) * hudHeight * 0.08,
      0,
    );
    plus.material.opacity = 1 - span(fly, 0.86, 1);
  }

  function renderPhone(t) {
    const enter = easeOutExpo(span(t, ...T.phoneIn));
    const wide = aspect > 1.12;
    // Frame by width on wide stages so the notification stays readable.
    const far = wide ? 1.62 / 0.7 / (2 * TAN * aspect) : Math.max(3.75 / (2 * TAN), 1.62 / 0.62 / (2 * TAN * aspect));
    const near = wide ? far * 0.88 : far * 0.62;
    const focus = easeInOutCubic(span(t, T.push[0], T.push[0] + 0.8));
    const dive = easeInCubic(span(t, ...T.dive));
    const restY = wide ? 0.86 : 0.05;
    const focusY = wide ? 0.82 : 0.5;
    const lookY = mix(mix(restY, focusY, focus), 0.2, dive);
    const distance = mix(mix(far, near, focus), 0.5, dive);
    camera.fov = 30;
    camera.position.set(Math.sin(t * 0.9) * 0.1 * (1 - dive), lookY + 0.04, distance);
    camera.lookAt(0, lookY, 0);

    const buzz = t > T.push[0] && t < T.push[1] + 0.35 ? Math.sin(t * 100) * 0.03 * (1 - span(t, T.push[0], T.push[1] + 0.35)) : 0;
    phone.position.set(buzz * 0.5, mix(-1.1, 0, enter), mix(-1.6, 0, enter));
    phone.rotation.set(mix(0.5, 0.05, enter) * (1 - dive), (mix(0.7, -0.13, enter) + Math.sin(t * 1.1) * 0.03) * (1 - dive), buzz);

    rings.forEach((ring, index) => {
      const start = T.push[0] + 0.1 + index * 0.18;
      const p = span(t, start, start + 0.9);
      ring.scale.setScalar(mix(0.9, 2.6, easeOutCubic(p)));
      ring.position.y = 0.4;
      ring.material.opacity = p > 0 && p < 1 ? 0.8 * (1 - p) : 0;
    });

    const fingerIn = easeInOutCubic(span(t, ...T.finger));
    const tapped = span(t, T.tap, T.tap + 0.16);
    finger.mesh.visible = t > T.finger[0] && t < T.expand[1];
    finger.mesh.position.x = mix(0.75, 0.32, fingerIn);
    finger.mesh.position.y = mix(-0.2, 0.6, fingerIn);
    finger.mesh.scale.setScalar(1 - Math.sin(tapped * Math.PI) * 0.28);
    finger.material.opacity = Math.min(span(t, T.finger[0], T.finger[0] + 0.15), 1 - span(t, T.expand[0], T.expand[0] + 0.2));

    const state = {
      push: span(t, ...T.push),
      pressed: t >= T.tap ? Math.sin(tapped * Math.PI * 0.5) : 0,
      expand: span(t, ...T.expand),
    };
    const id = Object.values(state).map((value) => value.toFixed(3)).join('|');
    if (id !== screenKey) {
      screenKey = id;
      screen.redraw(state);
    }
  }

  function renderReport(t) {
    const local = t - T.cut;
    const settle = easeOutExpo(span(t, T.cut, T.cut + 0.9));
    const kick = [R.stats[0], R.summary[0]].reduce((sum, at) => sum + (t > at ? Math.exp(-(t - at) * 5) * 0.1 : 0), 0);
    camera.fov = mix(48, 30, settle);
    camera.position.set(Math.sin(local * 0.75) * 0.24, Math.cos(local * 0.6) * 0.1, REPORT_DISTANCE - kick);
    camera.lookAt(0, 0, 0);
    dust.rotation.z = local * 0.02;

    const moved = easeInOutCubic(span(t, ...R.scroll));
    layout.group.position.y = moved * layout.travel;
    grid.position.y = (local * 0.12 + moved * 1.2) % 1;

    const firstPart = 1 - span(moved, 0.35, 0.8);
    place(layout.header, span(t, ...R.header), 'x', firstPart);
    if (place(layout.profile, span(t, ...R.profile), 'y', firstPart)) {
      redraw(layout.profile, { zoom: span(t, R.profile[0], R.scan[1]), scan: span(t, ...R.scan), frame: span(t, R.profile[0] + 0.3, R.profile[1] + 0.2) });
    }
    if (place(layout.stats, span(t, ...R.stats), 'x', firstPart)) redraw(layout.stats, { count: span(t, ...R.count) });
    place(layout.open, span(t, ...R.open), 'x', firstPart);

    // The photos step back a little while the summary is being written.
    const writing = Math.min(span(t, R.summary[0], R.summary[0] + 0.5), 1 - span(t, R.typing[1] + 0.1, R.typing[1] + 0.6));
    const photoLit = mix(1, 0.42, easeInOutCubic(writing));
    layout.thumbs.forEach((thumb, index) => {
      const start = R.thumbs + index * 0.085;
      const p = span(t, start, start + 0.6);
      const tagStart = R.tags + index * 0.13;
      // Each photo leans forward as its tag lands.
      const lean = Math.sin(span(t, tagStart, tagStart + 0.5) * Math.PI) * 0.22;
      thumb.mesh.visible = p > 0;
      if (thumb.mesh.visible) {
        const e = easeOutExpo(p);
        const spin = (index % 2 ? 1 : -1) * (1 - e);
        thumb.mesh.position.set(mix(thumb.home.x * 2.2 + spin, thumb.home.x, e), mix(thumb.home.y + 1.4, thumb.home.y, e), (1 - e) * 3 + lean);
        thumb.mesh.rotation.set((1 - e) * 0.9, spin * 1.2, spin * 0.5);
        thumb.material.opacity = clamp(p * 4) * photoLit;
      }
      const tag = layout.tags[index];
      const tp = span(t, tagStart, tagStart + 0.3);
      tag.mesh.visible = tp > 0;
      if (tag.mesh.visible) {
        tag.mesh.position.set(tag.home.x, tag.home.y, tag.home.z + lean + (1 - easeOutCubic(tp)) * 0.5);
        tag.mesh.scale.setScalar(Math.max(0.01, easeOutBack(tp)));
        tag.material.opacity = Math.min(tp * 2, 1) * photoLit;
      }
    });

    if (place(layout.summary, span(t, ...R.summary))) redraw(layout.summary, { typed: span(t, ...R.typing) });
  }

  let cycle = -1;
  let shown = 0;

  function render(seconds) {
    if (!layout) return;
    // Chosen once per cycle, so the count and the report stay with one account even if photos arrive midway.
    const set = Math.floor(seconds / CYCLE) % PEOPLE.length;
    if (set !== cycle) {
      cycle = set;
      shown = layouts[set] ? set : 0;
    }
    const t = seconds % CYCLE;
    layout = layouts[shown];
    for (const item of layouts) item.group.visible = item === layout;
    canvas.style.opacity = String(Math.min(span(t, 0, 0.25), 1 - span(t - LEAD, ...T.fadeOut)));
    const story = t - LEAD;
    const phoneVisible = story < T.cut;
    act1.visible = phoneVisible && story >= 0;
    act2.visible = !phoneVisible;
    if (act1.visible) renderPhone(story);
    else if (!phoneVisible) renderReport(story);
    camera.updateMatrixWorld();
    renderCount(t, PEOPLE[shown].from);
    flash.material.opacity = Math.min(span(story, T.cut - 0.16, T.cut), 1 - span(story, T.cut, T.cut + 0.45)) * 0.5;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }

  const loop = runLoop({ container, renderer, camera, duration: DURATION, stillAt: LEAD + 4.2, render, onResize, startWhen });
  container.classList.add('is-live');

  for (const [index, person] of PEOPLE.entries()) {
    // A still picture needs only the account it shows.
    if (index === 0 || (loop.still !== null && Math.floor(loop.still / CYCLE) !== index)) continue;
    const entry = { person, pictures: await loadPhotos(person) };
    people.push(entry);
    if (!frame) continue;
    const added = buildFor(entry);
    added.group.visible = false;
    layouts.push(added);
    loop.refresh(() => {
      cycle = -1;
    });
  }
}
