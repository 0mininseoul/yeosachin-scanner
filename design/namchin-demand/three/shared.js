import {
  CanvasTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

export const BRAND = '체리';
export const FONT = 'Paperlogy, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
export const DIGITS = '"Barlow Condensed", Paperlogy, sans-serif';
export const COLORS = {
  ink: '#251b17',
  paper: '#fffaf4',
  cherry: '#e0344b',
  cherryDeep: '#a8142c',
  orange: '#ad3617',
  muted: '#7a6458',
  kakao: '#fee500',
  night: '#160e0c',
};

export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const span = (t, start, end) => clamp((t - start) / (end - start));
export const mix = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeInCubic = (t) => t * t * t;
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export async function waitForFonts() {
  if (!document.fonts?.load) return;
  await Promise.allSettled([
    document.fonts.load(`800 40px ${FONT}`, '체리맞팔'),
    document.fonts.load(`400 40px ${FONT}`, '체리맞팔'),
    document.fonts.load(`700 40px ${DIGITS}`, '0123456789'),
  ]);
}

export function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/** Loads the first image that exists; `fallback` is { src, crop: [sx, sy, sw, sh] } for sprite sheets. */
export async function loadPicture(src, fallback) {
  const image = await loadImage(src);
  if (image) return { image, crop: [0, 0, image.naturalWidth, image.naturalHeight] };
  if (!fallback) return null;
  const sheet = await loadImage(fallback.src);
  return sheet ? { image: sheet, crop: fallback.crop } : null;
}

export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Draws a picture with object-fit: cover into the given rect, clipped to a rounded rect or circle. */
export function drawPicture(ctx, picture, x, y, w, h, radius = 0, fallbackColor = '#e9d6c8') {
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.fillStyle = fallbackColor;
  ctx.fillRect(x, y, w, h);
  if (picture) {
    const [sx, sy, sw, sh] = picture.crop;
    const scale = Math.max(w / sw, h / sh);
    const cw = w / scale;
    const ch = h / scale;
    ctx.drawImage(picture.image, sx + (sw - cw) / 2, sy + (sh - ch) / 2, cw, ch, x, y, w, h);
  }
  ctx.restore();
}

/** Sets the largest font up to `size` that keeps `text` inside `maxWidth`. */
export function fitFont(ctx, weight, size, text, maxWidth) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) ctx.font = `${weight} ${size * (maxWidth / width)}px ${FONT}`;
}

export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Kakao symbol (speech bubble only) on the brand yellow, in an 18x18 coordinate space.
const kakaoBubble = new Path2D('M9 .6C4.029.6 0 3.713 0 7.552c0 2.388 1.558 4.493 3.932 5.745l-.999 3.647c-.088.322.28.579.563.392l4.377-2.888c.37.036.745.056 1.127.056 4.97 0 9-3.113 9-6.952S13.970.6 9 .6');

export function kakaoIcon(ctx, x, y, size) {
  ctx.fillStyle = COLORS.kakao;
  roundRect(ctx, x, y, size, size, size * 0.235);
  ctx.fill();
  const scale = (size * 0.617) / 18;
  ctx.save();
  ctx.translate(x + size * 0.1915, y + size * 0.1915);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#000';
  ctx.fill(kakaoBubble);
  ctx.restore();
}

/**
 * A plane whose texture is drawn with the 2D canvas API.
 * `draw(ctx, w, h, state)` is called on `redraw(state)`.
 */
export function canvasPlane({ width, height, pixels = 512, draw, renderer }) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pixels * (width >= height ? 1 : width / height));
  canvas.height = Math.round(pixels * (height > width ? 1 : height / width));
  const ctx = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  if (renderer) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  const redraw = (state) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height, state);
    texture.needsUpdate = true;
  };
  redraw();
  return { mesh, canvas, ctx, texture, material, redraw };
}

/** A soft round sprite texture used for glows and particles. */
export function glowTexture(color = '255, 120, 90', size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${color}, 1)`);
  gradient.addColorStop(0.35, `rgba(${color}, 0.55)`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function createRenderer(container) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement);
  return renderer;
}

export function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Runs `render(seconds)` in a loop of `duration` seconds while the container is on screen.
 * With reduced motion, renders a single still at `stillAt`.
 * `startWhen` holds the first frame until it resolves.
 * Returns the second it is frozen at (null when playing) and `refresh`, which redraws the picture while the loop is not running.
 */
export function runLoop({ container, renderer, camera, duration, render, stillAt: defaultStill, onResize, startWhen }) {
  // `?scene-t=5.2` freezes every scene at that second, for design review screenshots.
  const frozen = new URLSearchParams(window.location.search).get('scene-t');
  const stillAt = frozen !== null && Number.isFinite(Number(frozen)) ? ((Number(frozen) % duration) + duration) % duration : defaultStill;
  const reduceMotion = frozen !== null || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let visible = false;
  let held = Boolean(startWhen);
  let frame = 0;
  let clockStart = performance.now();
  let pausedAt = 0;

  const refresh = (before) => {
    if (!reduceMotion && !held && visible) return;
    before?.();
    render(reduceMotion ? stillAt : pausedAt);
  };

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    onResize?.(width, height);
    camera.updateProjectionMatrix();
    refresh();
  };

  const tick = (now) => {
    // A frame's timestamp can be slightly older than the clock it is measured against.
    const seconds = (Math.max(0, now - clockStart) / 1000) % duration;
    pausedAt = seconds;
    render(seconds);
    frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (reduceMotion || held || frame) return;
    clockStart = performance.now() - pausedAt * 1000;
    frame = requestAnimationFrame(tick);
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  new ResizeObserver(resize).observe(container);
  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible && !document.hidden) start();
    else stop();
  }, { threshold: 0.05 }).observe(container);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (visible) start();
  });
  startWhen?.then(() => {
    held = false;
    if (visible && !document.hidden) start();
  });
  resize();
  render(reduceMotion ? stillAt : 0);
  return { still: reduceMotion ? stillAt : null, refresh };
}
