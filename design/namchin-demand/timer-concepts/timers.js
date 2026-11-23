import { campaignClosesAt } from '/cherry/campaign.mjs';

const parts = ['d', 'h', 'm', 's', 'ms'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Flip-board timers render one card per digit.
for (const timer of document.querySelectorAll('[data-split]')) {
  for (const slot of timer.querySelectorAll('[data-part]')) {
    const width = slot.dataset.part === 'ms' ? 3 : 2;
    slot.replaceChildren(...Array.from({ length: width }, () => {
      const flap = document.createElement('span');
      flap.className = 'flap';
      flap.textContent = '0';
      return flap;
    }));
  }
}

const slots = Array.from(document.querySelectorAll('[data-timer] [data-part]'));
let previous = {};

function render() {
  const remaining = Math.max(0, campaignClosesAt - Date.now());
  const seconds = Math.floor(remaining / 1000);
  const values = {
    d: String(Math.floor(seconds / 86400)).padStart(2, '0'),
    h: String(Math.floor(seconds / 3600) % 24).padStart(2, '0'),
    m: String(Math.floor(seconds / 60) % 60).padStart(2, '0'),
    s: String(seconds % 60).padStart(2, '0'),
    ms: String(remaining % 1000).padStart(3, '0'),
  };

  for (const slot of slots) {
    const part = slot.dataset.part;
    const value = values[part];
    if (value === previous[part] && slot.dataset.ready) continue;
    slot.dataset.ready = '1';
    if (slot.children.length) {
      [...value].forEach((digit, index) => {
        const flap = slot.children[index];
        if (flap.textContent === digit) return;
        flap.textContent = digit;
        if (part !== 'ms' && !reduceMotion) {
          flap.classList.remove('is-flip');
          void flap.offsetWidth;
          flap.classList.add('is-flip');
        }
      });
    } else {
      slot.textContent = value;
    }
  }
  previous = values;
  if (remaining > 0) requestAnimationFrame(render);
}

for (const part of parts) previous[part] = null;
render();
