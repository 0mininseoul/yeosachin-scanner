const slot = document.querySelector('[data-slot]');
const buttons = Array.from(document.querySelectorAll('[data-intro]'));
const frame = document.querySelector('.page');
const length = { a: 3100, b: 3250, c: 3400 };
let timer = 0;

function end() {
  clearTimeout(timer);
  slot.replaceChildren();
}

async function play(name) {
  end();
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.intro === name));
  const fragment = document.querySelector(`#intro-${name}`).content.cloneNode(true);
  // Photos must be ready before the reel starts spinning.
  await Promise.allSettled(Array.from(fragment.querySelectorAll('img'), (image) => image.decode()));
  frame.contentWindow?.scrollTo(0, 0);
  slot.replaceChildren(fragment);
  slot.firstElementChild.addEventListener('click', end);
  timer = setTimeout(end, length[name]);
}

for (const button of buttons) button.addEventListener('click', () => play(button.dataset.intro));

const requested = new URLSearchParams(location.search);
const first = ['a', 'b', 'c'].includes(requested.get('v')) ? requested.get('v') : 'a';
await document.fonts?.ready;
await play(first);

// `?at=1.8` freezes the chosen intro at that second for review screenshots.
const at = requested.get('at');
if (at !== null && Number.isFinite(Number(at))) {
  clearTimeout(timer);
  for (const animation of document.getAnimations()) {
    if (!slot.contains(animation.effect?.target)) continue;
    animation.pause();
    animation.currentTime = Number(at) * 1000;
  }
}
