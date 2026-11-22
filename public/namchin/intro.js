// Blocking on purpose: decides before the first paint, so the page never flashes ahead of the opening.
// Plays once per browser session. CSS runs it to the end on its own; landing.js only adds skipping.
(() => {
  try {
    const key = 'namchin:intro-seen:v1';
    if (window.location.hash || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, '1');
    document.documentElement.classList.add('intro-on');
  } catch {
    // Storage is blocked: skip it rather than replay it on every visit.
  }
})();
