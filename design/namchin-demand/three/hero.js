import {
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Line,
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
  Sprite,
  SpriteMaterial,
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
  waitForFonts,
  wrapText,
} from './shared.js';

// The clock has two parts: the count (0 to LEAD), then the story, whose times below start at 0.
const LEAD = 1.4;
const DURATION = LEAD + 8.35;
const COUNT = { in: [0, 0.4], roll: [0.6, 0.86], plus: [0.8, 1.06], out: [LEAD - 0.24, LEAD + 0.06], fly: [LEAD - 0.06, LEAD + 0.6] };
const HANDLE = '@sample_seoa';
const SUMMARY = '캠퍼스, 카페, 전시회 사진이 많아요. 벚꽃과 한강 나들이 셀카를 자주 올리는 계정이에요.';
const KEYWORDS = ['캠퍼스', '카페', '전시회', '벚꽃과', '한강'];
const STATS = [['팔로워', 1284], ['팔로잉', 612], ['게시물', 94]];
const TAGS = ['캠퍼스', '카페', '한강', '전시회', '도서관', '벚꽃'];
const FACTS = [['성별', '여성'], ['확인 시각', '오전 9:07']];

// Act 1 is shared; the report timeline differs per layout (see `timeline`).
const T = {
  phoneIn: [0, 0.6],
  push: [0.5, 0.95],
  finger: [1.15, 1.6],
  tap: 1.64,
  expand: [1.76, 2.16],
  dive: [1.72, 2.2],
  cut: 2.18,
  fadeOut: [7.85, 8.3],
};

/* `stack` (square stages) keeps every panel on screen; `beats` (wide, short
   stages such as phones) gives each step the full right-hand side in turn. */
const timeline = {
  stack: {
    header: [2.25, 2.7],
    profile: [2.28, 2.95],
    scan: [2.7, 3.95],
    stats: [2.62, 3.2], count: [2.85, 3.95],
    thumbs: 3.55, tags: 4.1,
    links: [4.75, 5.35],
    summary: [4.95, 5.5], typing: [5.25, 6.55],
    out: {},
  },
  beats: {
    header: [2.25, 2.7],
    profile: [2.28, 2.95],
    scan: [2.7, 3.9],
    stats: [2.55, 3.05], count: [2.7, 3.55],
    thumbs: 3.85, tags: 4.35,
    links: null,
    summary: [5.5, 5.95], typing: [5.7, 6.95],
    out: { stats: [3.7, 4.05], posts: [5.3, 5.65] },
  },
};

const media = {
  him: ['/namchin/assets/hero/maru-profile.jpg'],
  her: ['/namchin/assets/hero/seoa-profile.jpg'],
  posts: [1, 2, 3, 4, 5, 6].map((index) => [`/namchin/assets/hero/seoa-post-${index}.jpg`]),
};

/* ---------- 2D drawing: following count ---------- */

function drawCount(ctx, w, h, { roll = 0, him = null } = {}) {
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
  ctx.fillText('23', x, baseline);
  const last = x + ctx.measureText('23').width;
  const slot = ctx.measureText('0').width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(last, baseline - digit * 0.8, slot, digit * 0.9);
  ctx.clip();
  ctx.textAlign = 'center';
  const shift = easeOutBack(clamp(roll)) * digit;
  ctx.fillText('0', last + slot / 2, baseline - shift);
  ctx.fillStyle = '#ff6b80';
  ctx.fillText('1', last + slot / 2, baseline + digit - shift);
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

function panelBase(ctx, w, h, unit, frame = 1) {
  const r = unit * 0.16;
  ctx.fillStyle = 'rgba(38, 18, 23, 0.94)';
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.fill();
  const sheen = ctx.createLinearGradient(0, 0, w, h);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.09)');
  sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 214, 219, 0.18)';
  ctx.lineWidth = Math.max(1, unit * 0.012);
  ctx.stroke();
  corners(ctx, w, h, unit * 0.2, unit * 0.022, frame);
}

// Bracket marks that travel in to the panel corners.
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

function drawHeader(ctx, w, h, { steps = [0, 0, 0], p = 1 } = {}) {
  ctx.globalAlpha = clamp(p);
  fitFont(ctx, 800, h * 0.5, '맞팔 리포트', w * 0.4);
  ctx.fillStyle = '#fff0ee';
  ctx.fillText('맞팔 리포트', h * 0.04, h * 0.64);
  const names = ['프로필', '게시물', '요약'];
  const gap = h * 0.22;
  const segment = Math.min(h * 1.5, (w * 0.54 - gap * 2) / 3);
  const start = w - segment * 3 - gap * 2;
  names.forEach((name, index) => {
    const x = start + index * (segment + gap);
    const value = clamp(steps[index]);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundRect(ctx, x, h * 0.74, segment, h * 0.1, h * 0.05);
    ctx.fill();
    if (value > 0) {
      ctx.fillStyle = COLORS.cherry;
      roundRect(ctx, x, h * 0.74, segment * value, h * 0.1, h * 0.05);
      ctx.fill();
    }
    ctx.fillStyle = value >= 1 ? '#fff0ee' : 'rgba(255, 230, 228, 0.55)';
    fitFont(ctx, value >= 1 ? 800 : 400, h * 0.36, name, segment);
    ctx.fillText(name, x, h * 0.56);
  });
  ctx.globalAlpha = 1;
}

function drawProfile(ctx, w, h, { zoom = 1, scan = 0, frame = 1, her = null, unit = 100, type = 1 } = {}) {
  const r = unit * 0.16;
  ctx.save();
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.clip();
  const grow = 1 + (1 - easeOutCubic(clamp(zoom))) * 0.4;
  drawPicture(ctx, her, -(w * (grow - 1)) / 2, -(h * (grow - 1)) / 2, w * grow, h * grow, 0, '#3a1820');

  const active = scan > 0 && scan < 1;
  if (active) {
    ctx.strokeStyle = 'rgba(255, 190, 198, 0.22)';
    ctx.lineWidth = 1;
    const cell = w / 7;
    for (let x = cell; x < w; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = cell; y < h; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
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

  ctx.strokeStyle = 'rgba(255, 214, 219, 0.22)';
  ctx.lineWidth = Math.max(1, unit * 0.012);
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.stroke();

  const done = scan >= 1;
  const chip = done ? '분석 완료' : `분석 ${String(Math.round(scan * 100)).padStart(2, '0')}%`;
  const cs = unit * 0.15 * type;
  ctx.font = `800 ${cs}px ${FONT}`;
  const cw = ctx.measureText(chip).width + cs * 1.5;
  ctx.fillStyle = done ? COLORS.cherry : 'rgba(18, 8, 10, 0.74)';
  roundRect(ctx, unit * 0.12, unit * 0.12, cw, cs * 1.9, cs);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(chip, unit * 0.12 + cs * 0.75, unit * 0.12 + cs * 1.3);

  ctx.globalAlpha = clamp(frame);
  ctx.fillStyle = '#fff4f1';
  fitFont(ctx, 800, unit * 0.25 * type, HANDLE, w - unit * 0.28);
  ctx.fillText(HANDLE, unit * 0.14, h - unit * (0.12 + 0.24 * type));
  ctx.fillStyle = 'rgba(255, 232, 230, 0.78)';
  fitFont(ctx, 400, unit * 0.155 * type, '새로 맞팔한 공개 계정', w - unit * 0.28);
  ctx.fillText('새로 맞팔한 공개 계정', unit * 0.14, h - unit * 0.14);
  ctx.globalAlpha = 1;
}

function drawStats(ctx, w, h, { count = 0, frame = 1, unit = 100 } = {}) {
  panelBase(ctx, w, h, unit, frame);
  const pad = unit * 0.2;
  const title = h > unit * 3 ? unit * 0.24 : Math.min(unit * 0.17, h * 0.085);
  label(ctx, '계정 규모', pad, pad + title, title);
  const top = pad + title * 1.9;
  const row = (h - top - pad * 0.5) / 3;
  STATS.forEach(([name, value], index) => {
    const local = easeOutCubic(clamp(count * 1.5 - index * 0.22));
    const y = top + row * index;
    ctx.globalAlpha = clamp(count * 5 - index * 0.8);
    ctx.fillStyle = 'rgba(255, 232, 230, 0.7)';
    ctx.font = `400 ${Math.min(row * 0.28, unit * 0.27)}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(name, pad, y + row * 0.56);
    ctx.textAlign = 'right';
    ctx.fillStyle = index === 0 ? '#ff7d90' : '#fff4f1';
    ctx.font = `700 ${Math.min(row * 0.62, unit * 0.66)}px ${DIGITS}`;
    ctx.fillText(Math.round(value * local).toLocaleString('ko-KR'), w - pad, y + row * 0.62);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(pad, y + row * 0.8, w - pad * 2, Math.max(2, unit * 0.018));
    ctx.fillStyle = index === 0 ? COLORS.cherry : 'rgba(255, 214, 219, 0.55)';
    // Log scale, so the three magnitudes stay comparable.
    ctx.fillRect(pad, y + row * 0.8, (w - pad * 2) * (Math.log10(value) / 4) * local, Math.max(2, unit * 0.018));
    ctx.globalAlpha = 1;
  });
}

function drawThumb(ctx, w, h, { picture = null, lock = 0 } = {}) {
  drawPicture(ctx, picture, 0, 0, w, h, w * 0.11, '#3a1820');
  ctx.strokeStyle = 'rgba(255, 232, 230, 0.28)';
  ctx.lineWidth = Math.max(1, w * 0.012);
  roundRect(ctx, 1, 1, w - 2, h - 2, w * 0.11);
  ctx.stroke();
  if (lock > 0) corners(ctx, w, h, w * 0.2, w * 0.035, lock);
}

function drawTag(ctx, w, h, { text = '' } = {}) {
  ctx.font = `800 ${h * 0.54}px ${FONT}`;
  const width = Math.min(w, ctx.measureText(text).width + h * 0.9);
  ctx.fillStyle = COLORS.cherry;
  roundRect(ctx, (w - width) / 2, 0, width, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h * 0.7);
  ctx.textAlign = 'left';
}

function drawSummary(ctx, w, h, { typed = 0, frame = 1, unit = 100 } = {}) {
  panelBase(ctx, w, h, unit, frame);
  const pad = unit * 0.2;
  const tall = h > w * 0.6;
  const title = tall ? unit * 0.24 : unit * 0.16;
  label(ctx, 'AI 요약', pad, pad + title, title);

  let size = tall ? Math.min(unit * 0.31, w * 0.088) : unit * 0.185;
  let lines = [];
  // Narrow stages wrap to more lines, so shrink until the last one stays inside the panel.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    ctx.font = `400 ${size}px ${FONT}`;
    lines = wrapText(ctx, SUMMARY, w - pad * 2);
    if (tall || pad + title * 1.25 + size * 1.5 * lines.length <= h - pad * 0.5) break;
    size *= 0.94;
  }
  const leading = size * 1.5;
  let left = Math.round(SUMMARY.length * clamp(typed));
  let y = pad + title * 1.25 + leading;
  let caret = null;
  for (const line of lines) {
    let x = pad;
    for (const word of line.split(' ')) {
      if (left <= 0) break;
      const part = word.slice(0, left);
      const hit = KEYWORDS.includes(word) || KEYWORDS.includes(word.replace(',', ''));
      ctx.font = `${hit ? 800 : 400} ${size}px ${FONT}`;
      ctx.fillStyle = hit ? '#ff9dab' : '#fff0ee';
      ctx.fillText(part, x, y);
      x += ctx.measureText(part).width;
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

  if (!tall) return;
  // Wide, short stages have room under the text for the two facts.
  const shown = clamp(typed * 3 - 2);
  ctx.globalAlpha = shown;
  FACTS.forEach(([name, value], index) => {
    const x = pad + index * ((w - pad * 2) / 2);
    const fy = h - pad * 0.7;
    ctx.fillStyle = 'rgba(255, 232, 230, 0.62)';
    ctx.font = `400 ${unit * 0.21}px ${FONT}`;
    ctx.fillText(name, x, fy - unit * 0.34);
    ctx.fillStyle = '#fff4f1';
    ctx.font = `800 ${unit * 0.29}px ${FONT}`;
    ctx.fillText(value, x, fy);
  });
  ctx.globalAlpha = 1;
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
  const [him, her, ...posts] = await Promise.all([media.him, media.her, ...media.posts].map((entry) => loadPicture(...entry)));

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

  function panel(group, { x, y, z = 0, width, height, draw, unitPixels, extra = {} }) {
    const item = plane({ width, height, pixels: Math.min(1500, Math.round(Math.max(width, height) * unitPixels)), draw: (ctx, w, h, state) => draw(ctx, w, h, { unit: w / width, ...extra, ...state }) });
    item.home = { x, y, z };
    item.key = '';
    item.mesh.position.set(x, y, z);
    group.add(item.mesh);
    return item;
  }

  function buildLayout(mode, viewWidth, unitPixels) {
    const group = new Group();
    act2.add(group);
    const built = { mode, group, width: viewWidth };
    const thumbs = [];
    const tags = [];
    const addThumb = (index, x, y, size) => {
      thumbs.push(panel(group, { x, y, width: size, height: size, draw: drawThumb, unitPixels, extra: { picture: posts[index] } }));
      tags.push(panel(group, { x, y: y - size * 0.4, z: 0.16, width: size * 1.1, height: size * (mode === 'beats' ? 0.29 : 0.25), draw: drawTag, unitPixels: unitPixels * 1.4, extra: { text: TAGS[index] } }));
    };

    if (mode === 'stack') {
      const m = 0.26;
      const inner = viewWidth - m * 2;
      const gap = 0.16;
      built.header = panel(group, { x: 0, y: 2.1, width: inner, height: 0.4, draw: drawHeader, unitPixels });
      const side = Math.min(1.98, inner * 0.47);
      const rowY = 2.1 - 0.2 - 0.1 - 1.98 / 2;
      built.profile = panel(group, { x: -inner / 2 + side / 2, y: rowY, width: side, height: 1.98, draw: drawProfile, unitPixels, extra: { her } });
      const statsW = inner - side - gap;
      built.stats = panel(group, { x: inner / 2 - statsW / 2, y: rowY, width: statsW, height: 1.98, draw: drawStats, unitPixels });
      const size = (inner - 0.09 * 5) / 6;
      const thumbY = rowY - 0.99 - gap - size / 2;
      for (let i = 0; i < 6; i += 1) addThumb(i, -inner / 2 + size / 2 + i * (size + 0.09), thumbY, size);
      const summaryH = 1.12;
      const summaryY = thumbY - size / 2 - gap - 0.1 - summaryH / 2;
      built.summary = panel(group, { x: 0, y: summaryY, width: inner, height: summaryH, draw: drawSummary, unitPixels });
      built.links = thumbs.map((thumb) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
        const line = new Line(geometry, new LineBasicMaterial({ color: '#ff7d90', transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false }));
        const dot = new Sprite(new SpriteMaterial({ map: glow, transparent: true, depthWrite: false, blending: AdditiveBlending }));
        dot.scale.setScalar(0.2);
        group.add(line, dot);
        return { line, dot, from: [thumb.home.x, thumb.home.y - size * 0.54], to: [thumb.home.x * 0.8, summaryY + summaryH / 2] };
      });
    } else {
      const m = 0.3;
      const gap = 0.26;
      const side = Math.min(2.55, (viewWidth - m * 2) * 0.37);
      built.profile = panel(group, { x: -viewWidth / 2 + m + side / 2, y: 0, width: side, height: 4.4, draw: drawProfile, unitPixels, extra: { her, type: 1.35 } });
      const right = viewWidth - m * 2 - side - gap;
      const rx = viewWidth / 2 - m - right / 2;
      built.header = panel(group, { x: rx, y: 1.88, width: right, height: 0.64, draw: drawHeader, unitPixels });
      const areaH = 3.6;
      const areaY = -0.4;
      built.stats = panel(group, { x: rx, y: areaY, width: right, height: areaH, draw: drawStats, unitPixels });
      built.summary = panel(group, { x: rx, y: areaY, width: right, height: areaH, draw: drawSummary, unitPixels });
      const size = Math.min((right - 0.24) / 3, (areaH - 0.16) / 2);
      const rowGap = Math.min(0.16, areaH - size * 2);
      for (let i = 0; i < 6; i += 1) {
        addThumb(i, rx + ((i % 3) - 1) * (size + 0.12), areaY + (i < 3 ? 1 : -1) * (size + rowGap) / 2, size);
      }
      built.links = [];
    }
    built.thumbs = thumbs;
    built.tags = tags;
    return built;
  }

  let aspect = 1;
  const onResize = (width, height) => {
    aspect = width / height;
    const mode = aspect > 1.12 ? 'beats' : 'stack';
    const viewWidth = VIEW * aspect;
    if (layout && layout.mode === mode && Math.abs(layout.width - viewWidth) < 0.02) return;
    if (layout) disposeTree(layout.group);
    const unitPixels = Math.max(150, (height / VIEW) * Math.min(window.devicePixelRatio || 1, 2) * 1.15);
    layout = buildLayout(mode, viewWidth, unitPixels);
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

  // Panels hinge open towards the viewer; `exit` sweeps them away to the left.
  function place(item, p, exit = 0, hinge = 'x') {
    const on = p > 0 && exit < 1;
    item.mesh.visible = on;
    if (!on) return false;
    const e = easeOutExpo(p);
    const { x, y, z } = item.home;
    const x1 = easeInCubic(exit);
    item.mesh.position.set(x - x1 * 1.6, y + (hinge === 'x' ? (1 - e) * -0.35 : 0), z + (1 - e) * 1.3 - x1 * 0.8);
    item.mesh.rotation.set(hinge === 'x' ? (1 - e) * -1.25 : 0, (hinge === 'y' ? (1 - e) * 1.35 : 0) - x1 * 0.9, 0);
    item.material.opacity = Math.min(clamp(p * 3), 1 - exit);
    return true;
  }

  let countKey = '';
  const pushPoint = new Vector3();

  function renderCount(t) {
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
    if (countKey !== roll.toFixed(3)) {
      countKey = roll.toFixed(3);
      count.redraw({ roll });
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
    const time = timeline[layout.mode];
    const beats = layout.mode === 'beats';
    const local = t - T.cut;

    const settle = easeOutExpo(span(t, T.cut, T.cut + 0.9));
    const kick = [time.stats[0], time.thumbs, time.summary[0]].reduce((sum, at) => sum + (t > at ? Math.exp(-(t - at) * 5) * 0.14 : 0), 0);
    camera.fov = mix(48, 30, settle);
    camera.position.set(Math.sin(local * 0.75) * 0.32, Math.cos(local * 0.6) * 0.14, REPORT_DISTANCE - kick);
    camera.lookAt(0, 0, 0);
    grid.position.y = (local * 0.12) % 1;
    dust.rotation.z = local * 0.02;

    const scan = span(t, ...time.scan);
    const typed = span(t, ...time.typing);
    const headerP = span(t, ...time.header);
    if (place(layout.header, headerP)) {
      const tagged = span(t, time.thumbs, time.tags + 0.8);
      redraw(layout.header, { steps: [scan, tagged, typed], p: headerP });
    }

    const profileP = span(t, ...time.profile);
    if (place(layout.profile, profileP, 0, 'y')) redraw(layout.profile, { zoom: span(t, time.profile[0], time.scan[1]), scan, frame: span(t, time.profile[0] + 0.3, time.profile[1] + 0.2) });
    if (!beats) layout.profile.mesh.rotation.y += 0.05;

    const statsOut = time.out.stats ? span(t, ...time.out.stats) : 0;
    if (place(layout.stats, span(t, ...time.stats), statsOut)) {
      redraw(layout.stats, { count: span(t, ...time.count), frame: span(t, time.stats[0] + 0.2, time.stats[1] + 0.15) });
      if (!beats) layout.stats.mesh.rotation.y -= 0.05;
    }

    const postsOut = time.out.posts ? span(t, ...time.out.posts) : 0;
    layout.thumbs.forEach((thumb, index) => {
      const start = time.thumbs + index * 0.085;
      const p = span(t, start, start + 0.6);
      const exit = easeInCubic(clamp(postsOut * 1.3 - index * 0.06));
      thumb.mesh.visible = p > 0 && exit < 1;
      if (thumb.mesh.visible) {
        const e = easeOutExpo(p);
        const spin = (index % 2 ? 1 : -1) * (1 - e);
        thumb.mesh.position.set(mix(thumb.home.x * 2.2 + spin, thumb.home.x, e) - exit * 1.4, mix(thumb.home.y + 1.4, thumb.home.y, e), (1 - e) * 3 - exit);
        thumb.mesh.rotation.set((1 - e) * 0.9, spin * 1.2 - exit * 0.9, spin * 0.5);
        thumb.material.opacity = Math.min(clamp(p * 4), 1 - exit);
        redraw(thumb, { lock: easeOutCubic(span(t, time.tags + index * 0.12 - 0.12, time.tags + index * 0.12 + 0.15)) });
      }
      const tag = layout.tags[index];
      const tp = span(t, time.tags + index * 0.12, time.tags + index * 0.12 + 0.3);
      tag.mesh.visible = tp > 0 && exit < 1;
      if (tag.mesh.visible) {
        tag.mesh.position.set(tag.home.x - exit * 1.4, tag.home.y, tag.home.z + (1 - easeOutCubic(tp)) * 0.5);
        tag.mesh.scale.setScalar(Math.max(0.01, easeOutBack(tp)));
        tag.material.opacity = Math.min(tp * 2, 1) * (1 - exit);
        if (!tag.key) redraw(tag, {});
      }
    });

    layout.links.forEach(({ line, dot, from, to }, index) => {
      const p = easeInOutCubic(span(t, time.links[0] + index * 0.05, time.links[1] + index * 0.05));
      line.visible = p > 0;
      const positions = line.geometry.attributes.position.array;
      positions.set([from[0], from[1], 0.1, mix(from[0], to[0], p), mix(from[1], to[1], p), 0.1]);
      line.geometry.attributes.position.needsUpdate = true;
      const run = (local * 0.9 + index * 0.17) % 1;
      dot.visible = p >= 1;
      dot.position.set(mix(from[0], to[0], run), mix(from[1], to[1], run), 0.14);
      dot.material.opacity = Math.sin(run * Math.PI);
    });

    if (place(layout.summary, span(t, ...time.summary))) {
      redraw(layout.summary, { typed, frame: span(t, time.summary[0] + 0.2, time.summary[1] + 0.2) });
    }
  }

  function render(t) {
    if (!layout) return;
    canvas.style.opacity = String(Math.min(span(t, 0, 0.25), 1 - span(t - LEAD, ...T.fadeOut)));
    const story = t - LEAD;
    const phoneVisible = story < T.cut;
    act1.visible = phoneVisible && story >= 0;
    act2.visible = !phoneVisible;
    if (act1.visible) renderPhone(story);
    else if (!phoneVisible) renderReport(story);
    camera.updateMatrixWorld();
    renderCount(t);
    flash.material.opacity = Math.min(span(story, T.cut - 0.16, T.cut), 1 - span(story, T.cut, T.cut + 0.45)) * 0.5;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }

  runLoop({ container, renderer, camera, duration: DURATION, stillAt: LEAD + 7.4, render, onResize, startWhen });
  container.classList.add('is-live');
}
