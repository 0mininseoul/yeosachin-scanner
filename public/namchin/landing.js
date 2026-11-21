import { campaignClosesAt } from './campaign.mjs';

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

const form = document.querySelector('#interest-form');
const submit = document.querySelector('#submit');
const error = document.querySelector('#form-error');
const success = document.querySelector('#form-success');
const successTitle = document.querySelector('#success-title');
const closedPanel = document.querySelector('#reservation-closed');
const closedTitle = document.querySelector('#closed-title');
const closedCopy = document.querySelector('#closed-copy');
let reservationsClosed = false;

function closeReservations() {
  const focusWasInForm = form.contains(document.activeElement);
  reservationsClosed = true;
  submit.disabled = true;
  form.hidden = true;
  for (const item of document.querySelectorAll('[data-while-open]')) item.hidden = true;
  for (const badge of document.querySelectorAll('[data-reservation-badge]')) badge.textContent = '사전 예약 마감';
  for (const cta of document.querySelectorAll('[data-reservation-cta]')) cta.textContent = '마감 안내 보기';
  closedCopy.textContent = '11월 30일 사전 예약 기간이 끝났어요.';
  if (success.hidden) {
    closedPanel.hidden = false;
    if (focusWasInForm) closedTitle.focus();
  }
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function startCountdown(clockOffset) {
  const template = document.querySelector('#countdown-template');
  const clocks = Array.from(document.querySelectorAll('[data-countdown]'), (clock) => {
    clock.append(template.content.cloneNode(true));
    clock.hidden = false;
    return { face: clock.querySelector('[role="timer"]'), digits: clock.querySelectorAll('strong') };
  });
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
    for (const [index, value] of values.entries()) {
      if (value === previous[index]) continue;
      const formatted = String(value).padStart(index === 4 ? 3 : 2, '0');
      for (const { digits } of clocks) digits[index].textContent = formatted;
    }
    if (values.some((value, index) => index < 4 && value !== previous[index])) {
      for (const { face } of clocks) {
        face.setAttribute('aria-label', `사전 예약 마감까지 ${values[0]}일 ${values[1]}시간 ${values[2]}분 ${values[3]}초`);
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
