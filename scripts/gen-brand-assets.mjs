// 조준경(reticle) 브랜드 마크로 파비콘/앱아이콘/OG 이미지를 생성한다.
// 실행: node scripts/gen-brand-assets.mjs
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const INK = '#0c0a0b';
const FG = '#f3efea';
const BLOOD = '#e4132a';
const DIM = '#8c827b';

// components/case-ui.tsx 의 BrandMark(24 viewBox)를 그대로 스케일해서 사용
function reticle(cx, cy, scale) {
  return `<g transform="translate(${cx},${cy}) scale(${scale}) translate(-12,-12)" fill="none" stroke="${FG}" stroke-width="1.4" stroke-linecap="round">
    <circle cx="12" cy="12" r="9.25" opacity="0.55"/>
    <circle cx="12" cy="12" r="4.4"/>
    <path d="M12 1.5v4.2M12 18.3v4.2M1.5 12h4.2M18.3 12h4.2"/>
    <circle cx="12" cy="12" r="1.7" fill="${BLOOD}" stroke="none"/>
  </g>`;
}

// 앱 아이콘 (다크 정사각 배경 + 조준경)
const iconSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="${INK}"/>
  ${reticle(256, 256, 18)}
</svg>`;

const KRFONT = 'Apple SD Gothic Neo, Noto Sans KR, Malgun Gothic, sans-serif';

// OG 이미지 (1200x630, 마크 + 워드마크 + 태그라인)
const ogSvg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0%" stop-color="${BLOOD}" stop-opacity="0.14"/>
      <stop offset="60%" stop-color="${BLOOD}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="${INK}"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  ${reticle(600, 205, 8)}
  <text x="600" y="410" text-anchor="middle" font-family="${KRFONT}" font-size="78" font-weight="800" fill="${FG}">위장여사친 판독기</text>
  <text x="600" y="478" text-anchor="middle" font-family="${KRFONT}" font-size="34" fill="${DIM}">내 남친이 맞팔 중인 여자들, 누가 제일 위험할까?</text>
  <text x="600" y="552" text-anchor="middle" font-family="${KRFONT}" font-size="22" font-weight="600" letter-spacing="4" fill="${BLOOD}">국내 유일 위장여사친 판독 서비스</text>
</svg>`;

async function png(svg, w, h, out) {
  await sharp(Buffer.from(svg)).resize(w, h).png().toFile(out);
  console.log('wrote', out, `${w}x${h}`);
}

await mkdir('app', { recursive: true });
await mkdir('public', { recursive: true });

// PWA / 로고
await png(iconSvg, 512, 512, 'public/icon-512.png');
await png(iconSvg, 192, 192, 'public/icon-192.png');
await png(iconSvg, 512, 512, 'public/logo.png');
// Next App Router 파일 컨벤션 (파비콘 / 애플 터치)
await png(iconSvg, 48, 48, 'app/icon.png');
await png(iconSvg, 180, 180, 'app/apple-icon.png');
// OG
await png(ogSvg, 1200, 630, 'public/og.png');

console.log('done');
