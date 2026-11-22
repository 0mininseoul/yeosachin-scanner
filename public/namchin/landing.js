import { campaignClosesAt } from './campaign.mjs';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The opening runs on CSS alone; any tap, key or scroll goes straight to the page.
const openingOver = new Promise((resolve) => {
  const root = document.documentElement;
  const intro = document.querySelector('[data-intro]');
  if (!root.classList.contains('intro-on')) {
    resolve();
    return;
  }
  const skipEvents = ['click', 'keydown', 'wheel', 'touchmove'];
  const finish = () => {
    for (const name of skipEvents) window.removeEventListener(name, skip);
    intro.remove(); // .intro-on stays: the hero entrance takes its delay from it
  };
  const skip = () => {
    if (root.classList.contains('intro-skip')) return;
    root.classList.add('intro-skip');
    // Skipping drops the entrance delay, so play the hero entrance from its first frame.
    for (const area of document.querySelectorAll('.site-header, .hero')) {
      for (const animation of area.getAnimations({ subtree: true })) animation.currentTime = 0;
    }
    resolve();
    setTimeout(finish, 260);
  };
  for (const name of skipEvents) window.addEventListener(name, skip, { once: true, passive: true });
  intro.addEventListener('animationend', ({ animationName }) => {
    if (animationName !== 'intro-iris') return;
    resolve();
    finish();
  });
  if (getComputedStyle(intro).visibility === 'hidden') {
    resolve();
    finish();
  }
});

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));

function showTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    panel.hidden = !selected;
  }
  if (focus) tab.focus({ preventScroll: true });
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => showTab(tab));
  tab.addEventListener('keydown', (event) => {
    const next = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    showTab(tabs[next], true);
  });
}

document.querySelector('[data-show-report]').addEventListener('click', () => showTab(tabs[1], true));

// Reveal sections as they scroll in. Anything already on screen is shown immediately so nothing flashes.
if ('IntersectionObserver' in window && !prefersReducedMotion) {
  const targets = Array.from(document.querySelectorAll('[data-reveal]'));
  for (const target of targets) {
    if (target.getBoundingClientRect().top < window.innerHeight * 0.92) target.classList.add('is-revealed');
  }
  document.documentElement.classList.add('reveal-ready');
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed');
      revealer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  for (const target of targets) if (!target.classList.contains('is-revealed')) revealer.observe(target);
}

// Load the three.js scenes only when WebGL works and the stage is about to be seen.
function canUseWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

function mountWhenNear(stage, load, onUnavailable) {
  if (!('IntersectionObserver' in window) || !canUseWebGL()) {
    onUnavailable?.();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.at(-1).isIntersecting) return;
    observer.disconnect();
    // Keep the static fallback when the 3D bundle cannot load.
    load().catch(() => onUnavailable?.());
  }, { rootMargin: '300px 0px' });
  observer.observe(stage);
}

// The film starts once the stage has finished its own entrance.
const heroStage = document.querySelector('[data-hero-stage]');
const stageLanded = openingOver.then(() => Promise.allSettled(heroStage.getAnimations().map((animation) => animation.finished)));
mountWhenNear(heroStage, async () => (await import('./3d/hero.js')).mountHero(heroStage, { startWhen: stageLanded }));
// The flow stage has no still version: without 3D, its written steps stand alone.
const flowStage = document.querySelector('[data-flow-stage]');
mountWhenNear(flowStage, async () => (await import('./3d/trust.js')).mountTrust(flowStage), () => { flowStage.hidden = true; });

const form = document.querySelector('#interest-form');
const submit = document.querySelector('#submit');
const error = document.querySelector('#form-error');
const success = document.querySelector('#form-success');
const successTitle = document.querySelector('#success-title');
const closedPanel = document.querySelector('#reservation-closed');
const closedTitle = document.querySelector('#closed-title');
const closedCopy = document.querySelector('#closed-copy');
const emailInput = document.querySelector('#email');
const phoneInput = document.querySelector('#phone');
const waitlistTitle = document.querySelector('#waitlist-title');
const pass = document.querySelector('[data-pass]');
const passEmail = pass.querySelector('[data-pass-email]');
const passPhone = pass.querySelector('[data-pass-phone]');
const dock = document.querySelector('[data-dock]');
const dockTimer = document.querySelector('[data-dock-timer]');
let reservationsClosed = false;
let reservationDone = false;

// Floating reservation button: visible after the hero buttons scroll away, hidden near the form.
const dockState = { heroVisible: true, waitlistVisible: false };

function updateDock() {
  const show = !reservationsClosed && !reservationDone && !dockState.heroVisible && !dockState.waitlistVisible;
  dock.classList.toggle('is-visible', show);
  dock.inert = !show;
}

if ('IntersectionObserver' in window) {
  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target.id === 'waitlist') dockState.waitlistVisible = entry.isIntersecting;
      else dockState.heroVisible = entry.isIntersecting;
    }
    updateDock();
  });
  watcher.observe(document.querySelector('.hero-actions'));
  watcher.observe(document.querySelector('#waitlist'));
}

function closeReservations() {
  const focusWasInForm = form.contains(document.activeElement);
  reservationsClosed = true;
  submit.disabled = true;
  form.hidden = true;
  for (const item of document.querySelectorAll('[data-while-open]')) item.hidden = true;
  for (const badge of document.querySelectorAll('[data-reservation-badge]')) badge.textContent = '사전 예약 마감';
  for (const cta of document.querySelectorAll('[data-reservation-cta]')) cta.textContent = '마감 안내 보기';
  closedCopy.textContent = '11월 30일 사전 예약 기간이 끝났어요.';
  if (!reservationDone) waitlistTitle.textContent = '이번 초대는\n마감됐어요.';
  updateDock();
  if (success.hidden) {
    closedPanel.hidden = false;
    if (focusWasInForm) closedTitle.focus();
  }
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function restartTick(tile) {
  tile.classList.remove('is-tick');
  void tile.offsetWidth;
  tile.classList.add('is-tick');
}

function startCountdown(clockOffset) {
  const template = document.querySelector('#countdown-template');
  const clocks = Array.from(document.querySelectorAll('[data-countdown]'), (clock) => {
    clock.append(template.content.cloneNode(true));
    clock.hidden = false;
    // Join the hero entrance already under way instead of starting its delay now.
    for (const animation of clock.getAnimations()) animation.currentTime = document.timeline.currentTime;
    return {
      face: clock.querySelector('[role="timer"]'),
      digits: clock.querySelectorAll('strong'),
      tiles: clock.querySelectorAll('.led'),
    };
  });
  // The floating button shows the same LED readout without its own screen-reader label.
  clocks.push({ face: null, digits: dockTimer.querySelectorAll('strong'), tiles: dockTimer.querySelectorAll('.led') });
  dock.hidden = false;
  updateDock();
  let previous = [];

  function tick() {
    if (reservationsClosed) return;
    const remaining = campaignClosesAt - (Date.now() + clockOffset);
    if (remaining <= 0) {
      closeReservations();
      return;
    }

    const seconds = Math.floor(remaining / 1_000);
    const values = [
      Math.floor(seconds / 86_400),
      Math.floor(seconds / 3_600) % 24,
      Math.floor(seconds / 60) % 60,
      seconds % 60,
      remaining % 1_000,
    ];
    const isFirstFrame = previous.length === 0;
    for (const [index, value] of values.entries()) {
      if (value === previous[index]) continue;
      const formatted = String(value).padStart(index === 4 ? 3 : 2, '0');
      for (const { digits, tiles } of clocks) {
        digits[index].textContent = formatted;
        if (index < 4 && !isFirstFrame && !prefersReducedMotion) restartTick(tiles[index]);
      }
    }
    if (values.some((value, index) => index < 4 && value !== previous[index])) {
      for (const { face } of clocks) {
        face?.setAttribute('aria-label', `사전 예약 마감까지 ${values[0]}일 ${values[1]}시간 ${values[2]}분 ${values[3]}초`);
      }
    }
    previous = values;
    requestAnimationFrame(tick);
  }

  tick();
}

async function initializeReservationForm() {
  let clockOffset = 0;
  try {
    const response = await fetch(form.action, { signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      const { status, serverTime } = await response.json();
      if (status === 'closed') {
        closeReservations();
        return;
      }
      if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
    }
  } catch {
    // Fall back to the device clock when the status request is unavailable.
  }
  startCountdown(clockOffset);
  submit.disabled = reservationsClosed;
}

void initializeReservationForm();

// Format Korean mobile numbers as they are typed (010-1234-5678) without moving a mid-text caret.
phoneInput.addEventListener('input', (event) => {
  const { value, selectionStart } = phoneInput;
  if (event.inputType?.startsWith('delete') || selectionStart !== value.length || value.trim().startsWith('+')) return;
  const digits = value.replace(/\D/g, '');
  if (!digits.startsWith('01') || digits.length > 11) return; // too long: leave it for validation, never cut digits
  const formatted = digits.length <= 3
    ? digits
    : digits.length <= 7
      ? `${digits.slice(0, 3)}-${digits.slice(3)}`
      : digits.length <= 10
        ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
        : `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (formatted !== value) phoneInput.value = formatted;
});

// The invitation shows a masked copy of what is being typed. Nothing leaves the page here.
function fillPass() {
  const email = emailInput.value.trim();
  const at = email.indexOf('@');
  const digits = phoneInput.value.replace(/\D/g, '').replace(/^82/, '0').replace(/^00/, '0');
  const entries = [
    [passEmail, email && `${email[0]}•••${at > 0 ? email.slice(at) : ''}`],
    [passPhone, digits && `${digits.slice(0, 3)}-••••${digits.length >= 10 ? `-${digits.slice(-4)}` : ''}`],
  ];
  for (const [field, text] of entries) {
    field.textContent = text || '등록 전';
    field.classList.toggle('is-filled', Boolean(text));
  }
}

form.addEventListener('input', fillPass);
fillPass();

if (!prefersReducedMotion && window.matchMedia('(hover: hover)').matches) {
  const face = pass.firstElementChild;
  pass.addEventListener('pointermove', (event) => {
    const box = pass.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    face.style.setProperty('--shine-x', `${x * 100}%`);
    face.style.setProperty('--shine-y', `${y * 100}%`);
    face.style.setProperty('--tilt-x', `${(0.5 - y) * 10}deg`);
    face.style.setProperty('--tilt-y', `${(x - 0.5) * 12}deg`);
  });
  pass.addEventListener('pointerleave', () => {
    for (const name of ['--shine-x', '--shine-y', '--tilt-x', '--tilt-y']) face.style.removeProperty(name);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;

  error.hidden = true;
  const fields = new FormData(form);
  submit.disabled = true;
  form.setAttribute('aria-busy', 'true');

  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: fields.get('email'),
        phone: fields.get('phone'),
        consent: fields.has('consent'),
        privateAck: fields.has('private_ack'),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 410) {
      closeReservations();
      return;
    }
    if (response.status === 400) {
      showError('이메일, 국내 휴대폰 번호와 체크박스 두 개를 확인해 주세요.');
      return;
    }
    if (!response.ok) {
      showError('등록을 완료하지 못했어요. 입력 내용을 확인하고 다시 시도해 주세요.');
      return;
    }

    reservationDone = true;
    updateDock();
    pass.classList.add('is-registered');
    for (const item of document.querySelectorAll('[data-until-registered]')) item.hidden = true;
    waitlistTitle.textContent = '초대장 등록을\n마쳤어요.';
    form.hidden = true;
    closedPanel.hidden = true;
    success.hidden = false;
    successTitle.focus();
  } catch {
    showError('서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
  } finally {
    submit.disabled = reservationsClosed;
    form.removeAttribute('aria-busy');
  }
});
