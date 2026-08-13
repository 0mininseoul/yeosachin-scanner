'use client';

import { useEffect, useRef } from 'react';

/* ============================================================
   Precheckout immersive preview — four-stage relationship-read demo.

   Ported from the approved prototype
   (.superpowers/brainstorm/27823-1786421000/content/precheckout-immersive-samples.html),
   engines ORBIT / CONSTELLATION / SIGNAL / CLUSTER, unchanged timings and geometry.
   Built imperatively against a host <div> ref rather than a charting library, per the
   approved brief — the lowest-risk way to port hand-tuned SVG from a static prototype.
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
    for (const key of Object.keys(attrs)) {
        el.setAttribute(key, String(attrs[key]));
    }
    return el;
}

/** Seeded PRNG (mulberry-ish LCG) so every render lays out the same "approved" scene. */
function rnd(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}
function clamp01(t: number): number {
    return t < 0 ? 0 : t > 1 ? 1 : t;
}
function settle(t: number): number {
    const c = clamp01(t);
    return c >= 1 ? 1 : 1 - Math.pow(2, -10 * c);
}
function outCubic(t: number): number {
    const c = clamp01(t);
    return 1 - Math.pow(1 - c, 3);
}
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

interface StageEngine {
    svg: SVGSVGElement;
    draw: (p: number) => void;
}

function createStageSvg(host: HTMLElement): SVGSVGElement {
    const svg = svgEl('svg', { viewBox: '0 0 300 220', preserveAspectRatio: 'xMidYMid meet' });
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.opacity = '0';
    // Reduced-motion clamps every transition-duration globally (app/globals.css), so this
    // one-time opacity swap is automatically instant for those users without special-casing it.
    svg.style.transition = 'opacity 220ms linear';
    host.appendChild(svg);
    return svg;
}

/* ============================================================
   ENGINE 1 — orbital / radial network
   ============================================================ */
function buildOrbitalEngine(host: HTMLElement): StageEngine {
    const svg = createStageSvg(host);
    const R = rnd(20260811);
    const CX = 150;
    const CY = 110;
    const rings = [46, 78, 108];

    const gRing = svgEl('g');
    const gSweep = svgEl('g');
    const gEdge = svgEl('g');
    const gNode = svgEl('g');
    const gCore = svgEl('g');
    svg.append(gRing, gSweep, gEdge, gNode, gCore);

    const ringEls = rings.map(r => {
        const c = svgEl('circle', {
            cx: CX, cy: CY, r, fill: 'none', stroke: 'var(--color-line-2)',
            'stroke-width': 1, 'stroke-dasharray': '2 5',
        });
        gRing.appendChild(c);
        return c;
    });

    const gradId = `precheckout-orbit-sweep-${Math.random().toString(36).slice(2, 8)}`;
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 1, y2: 0 });
    grad.appendChild(svgEl('stop', { offset: 0, 'stop-color': 'var(--color-blood)', 'stop-opacity': 0 }));
    grad.appendChild(svgEl('stop', { offset: 1, 'stop-color': 'var(--color-blood)', 'stop-opacity': 0.38 }));
    defs.appendChild(grad);
    svg.insertBefore(defs, gRing);

    const wedge = svgEl('path', {
        d: `M ${CX} ${CY} L ${CX + 118} ${CY - 30} A 118 118 0 0 1 ${CX + 118} ${CY + 30} Z`,
        fill: `url(#${gradId})`,
    });
    const sweepLine = svgEl('line', {
        x1: CX, y1: CY, x2: CX + 118, y2: CY, stroke: 'var(--color-blood)', 'stroke-width': 1, 'stroke-opacity': 0.6,
    });
    gSweep.append(wedge, sweepLine);

    interface OrbitalNode {
        ring: number;
        ang: number;
        hot: boolean;
        sx: number;
        sy: number;
        delay: number;
        el: SVGCircleElement;
        halo?: SVGCircleElement;
        spoke?: SVGLineElement;
    }
    const N = 34;
    const nodes: OrbitalNode[] = [];
    for (let i = 0; i < N; i++) {
        const ring = i % 3;
        const ang = (i / N) * Math.PI * 2 + ring * 0.6;
        const hot = i === 7 || i === 22;
        const sx = 20 + R() * 260;
        const sy = 14 + R() * 192;
        const delay = R() * 0.34;
        const r = hot ? 3.6 : ring === 0 ? 2.9 : 2.2;
        const el = svgEl('circle', { cx: sx, cy: sy, r, fill: hot ? 'var(--color-blood)' : 'var(--color-fg-dim)', 'fill-opacity': 0 });
        gNode.appendChild(el);
        const node: OrbitalNode = { ring, ang, hot, sx, sy, delay, el };
        if (hot) {
            node.halo = svgEl('circle', { cx: sx, cy: sy, r: 8, fill: 'none', stroke: 'var(--color-blood)', 'stroke-width': 1, 'stroke-opacity': 0 });
            gNode.appendChild(node.halo);
            node.spoke = svgEl('line', { x1: CX, y1: CY, x2: sx, y2: sy, stroke: 'var(--color-blood)', 'stroke-width': 1, 'stroke-opacity': 0 });
            gEdge.appendChild(node.spoke);
        }
        nodes.push(node);
    }

    const core1 = svgEl('circle', { cx: CX, cy: CY, r: 15, fill: 'none', stroke: 'var(--color-fg-mute)', 'stroke-width': 1 });
    const core2 = svgEl('circle', { cx: CX, cy: CY, r: 7.5, fill: 'none', stroke: 'var(--color-fg-dim)', 'stroke-width': 1.2 });
    const coreDot = svgEl('circle', { cx: CX, cy: CY, r: 2.6, fill: 'var(--color-blood)' });
    const tick = svgEl('path', {
        d: `M${CX} ${CY - 22}v6M${CX} ${CY + 16}v6M${CX - 22} ${CY}h6M${CX + 16} ${CY}h6`,
        stroke: 'var(--color-fg-dim)', 'stroke-width': 1.2,
    });
    gCore.append(core1, core2, tick, coreDot);

    return {
        svg,
        draw(p: number) {
            const ce = settle(clamp01(p / 0.2));
            gCore.setAttribute('opacity', String(ce));
            gCore.setAttribute('transform', `translate(${CX},${CY}) scale(${lerp(0.6, 1, ce)}) translate(${-CX},${-CY})`);
            ringEls.forEach((c, i) => {
                const t = settle(clamp01((p - 0.06 - i * 0.05) / 0.3));
                c.setAttribute('opacity', String(t * 0.9));
                c.setAttribute('stroke-dashoffset', String((1 - t) * 90));
            });
            nodes.forEach(o => {
                const t = outCubic(clamp01((p - o.delay) / 0.5));
                const ang = o.ang + p * 0.9;
                const tx = CX + Math.cos(ang) * rings[o.ring];
                const ty = CY + Math.sin(ang) * rings[o.ring];
                const x = lerp(o.sx, tx, t);
                const y = lerp(o.sy, ty, t);
                o.el.setAttribute('cx', String(x));
                o.el.setAttribute('cy', String(y));
                o.el.setAttribute('fill-opacity', String(o.hot ? 0.35 + 0.65 * t : 0.18 + 0.5 * t));
                if (o.hot && o.halo && o.spoke) {
                    const h = settle(clamp01((p - 0.58) / 0.3));
                    o.halo.setAttribute('cx', String(x));
                    o.halo.setAttribute('cy', String(y));
                    o.halo.setAttribute('r', String(lerp(14, 7.5, h)));
                    o.halo.setAttribute('stroke-opacity', String(h * 0.85));
                    o.spoke.setAttribute('x2', String(x));
                    o.spoke.setAttribute('y2', String(y));
                    o.spoke.setAttribute('stroke-opacity', String(h * 0.35));
                }
            });
            const sw = clamp01((p - 0.05) / 0.95);
            gSweep.setAttribute('opacity', String(p < 0.05 ? 0 : p > 0.88 ? clamp01((1 - p) / 0.12) : 1));
            gSweep.setAttribute('transform', `rotate(${sw * 400 - 90} ${CX} ${CY})`);
        },
    };
}

/* ============================================================
   ENGINE 2 — forensic constellation network

   Stays dense and active across the whole canvas: four simultaneous clusters lock on,
   cross-links stitch them together, and pulses keep firing in different regions while
   this stage is on screen. Coordinates are static so each frame only touches
   opacity/radius/dash — cheap enough to animate ~200 elements smoothly.
   ============================================================ */
function buildConstellationEngine(host: HTMLElement): StageEngine {
    const svg = createStageSvg(host);
    const R = rnd(77315);
    const gDust = svgEl('g');
    const gEdge = svgEl('g');
    const gCross = svgEl('g');
    const gPulse = svgEl('g');
    const gNode = svgEl('g');
    const gLock = svgEl('g');
    svg.append(gDust, gEdge, gCross, gPulse, gNode, gLock);

    for (let d = 0; d < 120; d++) {
        const cx = 4 + R() * 292;
        const cy = 4 + R() * 212;
        const r = R() * 0.9 + 0.25;
        const fillOpacity = (0.08 + R() * 0.26).toFixed(2);
        gDust.appendChild(svgEl('circle', { cx, cy, r, fill: 'var(--color-fg-mute)', 'fill-opacity': fillOpacity }));
    }

    interface LatticePoint {
        x: number;
        y: number;
        base: number;
        tw: number;
        delay: number;
        hot: number | undefined;
        el: SVGCircleElement;
    }
    const COLS = 11;
    const ROWS = 7;
    const pts: LatticePoint[] = [];
    for (let r0 = 0; r0 < ROWS; r0++) {
        for (let c0 = 0; c0 < COLS; c0++) {
            const jitter = 9;
            const x = 16 + c0 * (268 / (COLS - 1)) + (R() - 0.5) * jitter * 2;
            const y = 20 + r0 * (180 / (ROWS - 1)) + (R() - 0.5) * jitter * 2;
            const base = 1.1 + R() * 2.4;
            const tw = R() * 6.28;
            const delay = R() * 0.26;
            const el = svgEl('circle', { cx: x, cy: y, r: base, fill: 'var(--color-fg-dim)', 'fill-opacity': 0 });
            gNode.appendChild(el);
            pts.push({ x, y, base, tw, delay, hot: undefined, el });
        }
    }
    const M = pts.length;

    const COLORS = ['var(--color-blood)', 'var(--color-amber)', 'var(--color-blood)', 'var(--color-jade)'];
    const seeds = [9, 30, 48, 68].map(i => Math.min(i, M - 1));

    interface ClusterInfo {
        seed: number;
        color: string;
        t0: number;
        lock: SVGGElement;
        lx: number;
        ly: number;
    }
    const clusters: ClusterInfo[] = seeds.map((si, k) => {
        const seed = pts[si];
        const members = pts
            .map((pt, i) => ({ i, d: Math.hypot(pt.x - seed.x, pt.y - seed.y) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 7)
            .map(o => o.i);
        members.forEach(i => {
            pts[i].hot = k;
            pts[i].el.setAttribute('fill', COLORS[k]);
        });
        return { seed: si, color: COLORS[k], t0: 0.3 + k * 0.1, lock: svgEl('g', { opacity: 0 }), lx: seed.x, ly: seed.y };
    });

    interface EdgeInfo {
        a: number;
        b: number;
        d: number;
        hot: boolean;
        el?: SVGLineElement;
        len: number;
        t0: number;
    }
    let edges: EdgeInfo[] = [];
    for (let a = 0; a < M; a++) {
        for (let b = a + 1; b < M; b++) {
            const dx = pts[a].x - pts[b].x;
            const dy = pts[a].y - pts[b].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 34) {
                const aHot = pts[a].hot;
                const hot = aHot !== undefined && aHot === pts[b].hot;
                edges.push({ a, b, d: dist, hot, len: 0, t0: 0 });
            }
        }
    }
    // Shortest links draw first, matching the approved prototype.
    edges.sort((x, y) => x.d - y.d);
    if (edges.length > 150) edges = edges.slice(0, 150);
    edges.forEach((e, i) => {
        const pa = pts[e.a];
        const pb = pts[e.b];
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        const col = e.hot ? COLORS[pts[e.a].hot as number] : 'var(--color-line-2)';
        const el = svgEl('line', {
            x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, stroke: col,
            'stroke-width': e.hot ? 1 : 0.85, 'stroke-opacity': 0,
            'stroke-dasharray': len.toFixed(1), 'stroke-dashoffset': len.toFixed(1),
        });
        e.el = el;
        e.len = len;
        e.t0 = 0.1 + (i / edges.length) * 0.46;
        gEdge.appendChild(el);
    });

    interface CrossInfo { el: SVGLineElement; len: number; t0: number; }
    const cross: CrossInfo[] = [];
    const crossPairs: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [0, 3], [0, 2], [1, 3]];
    crossPairs.forEach((pair, i) => {
        const pa = pts[clusters[pair[0]].seed];
        const pb = pts[clusters[pair[1]].seed];
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        const el = svgEl('line', {
            x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, stroke: 'var(--color-blood)',
            'stroke-width': 0.9, 'stroke-opacity': 0, 'stroke-dasharray': '4 5',
            'stroke-dashoffset': len.toFixed(1),
        });
        gCross.appendChild(el);
        cross.push({ el, len, t0: 0.52 + i * 0.05 });
    });

    interface PulseInfo { el: SVGCircleElement; phase: number; }
    const pulses: PulseInfo[] = clusters.map((c, k) => {
        const el = svgEl('circle', {
            cx: pts[c.seed].x, cy: pts[c.seed].y, r: 6, fill: 'none',
            stroke: c.color, 'stroke-width': 1, 'stroke-opacity': 0,
        });
        gPulse.appendChild(el);
        return { el, phase: k * 0.25 };
    });

    function bracket(x: number, y: number, size: number, color: string): SVGGElement {
        const g = svgEl('g', { opacity: 0 });
        const h = size / 2;
        const arm = size * 0.3;
        const quads: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        quads.forEach(q => {
            const px = x + q[0] * h;
            const py = y + q[1] * h;
            g.appendChild(svgEl('path', {
                d: `M${px - q[0] * arm} ${py}H${px}V${py - q[1] * arm}`,
                stroke: color, 'stroke-width': 1.1, fill: 'none',
            }));
        });
        gLock.appendChild(g);
        return g;
    }
    clusters.forEach(c => {
        const p = pts[c.seed];
        c.lock = bracket(p.x, p.y, 26, c.color);
        c.lx = p.x;
        c.ly = p.y;
    });

    return {
        svg,
        draw(p: number) {
            for (let i = 0; i < M; i++) {
                const o = pts[i];
                const t = settle(clamp01((p - o.delay) / 0.32));
                const tw = 1 + Math.sin(p * 9 + o.tw) * 0.16;
                o.el.setAttribute('r', String((o.hot !== undefined ? o.base * 1.35 : o.base) * tw));
                o.el.setAttribute('fill-opacity', String(o.hot !== undefined ? 0.35 + 0.6 * t : 0.16 + 0.5 * t));
            }
            for (let j = 0; j < edges.length; j++) {
                const e = edges[j];
                const et = outCubic(clamp01((p - e.t0) / 0.15));
                e.el?.setAttribute('stroke-dashoffset', (e.len * (1 - et)).toFixed(1));
                e.el?.setAttribute('stroke-opacity', String(et * (e.hot ? 0.75 : 0.42)));
            }
            for (let k = 0; k < cross.length; k++) {
                const c2 = cross[k];
                const ct = outCubic(clamp01((p - c2.t0) / 0.2));
                c2.el.setAttribute('stroke-dashoffset', (c2.len * (1 - ct)).toFixed(1));
                c2.el.setAttribute('stroke-opacity', String(ct * 0.45));
            }
            clusters.forEach(c => {
                const l = settle(clamp01((p - c.t0) / 0.24));
                const sc = lerp(1.8, 1, l);
                c.lock.setAttribute('opacity', String(l * 0.95));
                c.lock.setAttribute('transform', `translate(${c.lx},${c.ly}) scale(${sc}) translate(${-c.lx},${-c.ly})`);
            });
            pulses.forEach(pu => {
                const ph = (p * 2.1 + pu.phase) % 1;
                pu.el.setAttribute('r', String(6 + ph * 26));
                pu.el.setAttribute('stroke-opacity', String(p < 0.12 ? 0 : (1 - ph) * 0.5));
            });
        },
    };
}

/* ============================================================
   ENGINE 3 — signal accumulation (collection-progress axis)
   ============================================================ */
function buildWaveformEngine(host: HTMLElement): StageEngine {
    const svg = createStageSvg(host);
    const R = rnd(51219);
    const X0 = 76;
    const X1 = 286;

    interface Lane {
        color: string;
        base: SVGLineElement;
        lab: SVGTextElement;
        path: SVGPathElement;
        len: number;
        spikes: Array<[number, number]>;
    }
    const laneDefs = [
        { y: 52, label: '좋아요 방향', color: 'var(--color-blood)' },
        { y: 110, label: '댓글 친밀도', color: 'var(--color-amber)' },
        { y: 168, label: '맞팔 발견', color: 'var(--color-fg-dim)' },
    ];

    const gAxis = svgEl('g');
    const gWave = svgEl('g');
    const gMark = svgEl('g');
    const gLab = svgEl('g');
    svg.append(gAxis, gWave, gMark, gLab);

    for (let v = 0; v < 7; v++) {
        gAxis.appendChild(svgEl('line', { x1: X0 + v * 35, y1: 26, x2: X0 + v * 35, y2: 196, stroke: 'var(--color-line)', 'stroke-width': 1 }));
    }

    const K = 64;
    const lanes: Lane[] = laneDefs.map((def, li) => {
        const base = svgEl('line', { x1: X0, y1: def.y, x2: X1, y2: def.y, stroke: 'var(--color-line)', 'stroke-width': 1 });
        gAxis.appendChild(base);
        const lab = svgEl('text', {
            x: X0 - 9, y: def.y + 3, fill: 'var(--color-fg-dim)', 'font-size': 8.5,
            'font-family': 'Paperlogy,sans-serif', 'text-anchor': 'end', 'font-weight': 700,
        });
        lab.textContent = def.label;
        gLab.appendChild(lab);

        const points: Array<[number, number]> = [];
        const spikes: Array<[number, number]> = [];
        for (let i = 0; i < K; i++) {
            const xx = X0 + (i / (K - 1)) * (X1 - X0);
            const noise = (R() - 0.5) * 9 + Math.sin(i * 0.9 + li) * 2.2;
            let burst = 0;
            if (li === 0 && i > 33 && i < 48) burst = -Math.sin(((i - 33) / 15) * Math.PI) * 21;
            if (li === 1 && i > 35 && i < 49) burst = -Math.sin(((i - 35) / 14) * Math.PI) * 15;
            if (li === 2 && (i === 12 || i === 25 || i === 40 || i === 44)) burst = -11;
            const py = def.y + noise * 0.55 + burst;
            points.push([xx, py]);
            if (burst < -8) spikes.push([xx, def.y + burst]);
        }
        const d = `M${points.map(q => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(' L')}`;
        const path = svgEl('path', {
            d, fill: 'none', stroke: def.color,
            'stroke-width': li === 2 ? 1 : 1.3, 'stroke-opacity': li === 2 ? 0.5 : 0.85,
            'stroke-linejoin': 'round',
        });
        gWave.appendChild(path);
        const len = 1200;
        path.setAttribute('stroke-dasharray', String(len));
        path.setAttribute('stroke-dashoffset', String(len));

        return { color: def.color, base, lab, path, len, spikes };
    });

    const HX0 = X0 + (33 / 63) * (X1 - X0);
    const HX1 = X0 + (49 / 63) * (X1 - X0);
    const band = svgEl('rect', { x: HX0, y: 26, width: HX1 - HX0, height: 170, fill: 'var(--color-blood)', 'fill-opacity': 0 });
    gMark.appendChild(band);

    const bk = svgEl('g', { opacity: 0 });
    const bkPoints: Array<[number, number, number]> = [[HX0, 26, 1], [HX1, 26, -1], [HX0, 196, 1], [HX1, 196, -1]];
    bkPoints.forEach((q, i) => {
        const vy = i < 2 ? 1 : -1;
        bk.appendChild(svgEl('path', {
            d: `M${q[0] + q[2] * 7} ${q[1]}H${q[0]}V${q[1] + vy * 7}`,
            stroke: 'var(--color-blood)', 'stroke-width': 1.1, fill: 'none',
        }));
    });
    gMark.appendChild(bk);

    const blab = svgEl('text', {
        x: (HX0 + HX1) / 2, y: 18, fill: 'var(--color-blood-2)', 'font-size': 8.5,
        'font-family': 'Paperlogy,sans-serif', 'text-anchor': 'middle', 'font-weight': 700, opacity: 0,
    });
    blab.textContent = '반복 구간';
    gMark.appendChild(blab);

    const axl = svgEl('text', {
        x: X1, y: 212, fill: 'var(--color-fg-dim)', 'font-size': 8.5,
        'font-family': 'Paperlogy,sans-serif', 'text-anchor': 'end', 'font-weight': 700,
    });
    // Exact axis wording required by the brief — collection progress, never "activity time".
    axl.textContent = '수집 진행 축';
    gLab.appendChild(axl);

    const clipId = `precheckout-waveform-clip-${Math.random().toString(36).slice(2, 7)}`;
    const clip = svgEl('clipPath', { id: clipId });
    const crect = svgEl('rect', { x: X0, y: 0, width: 0, height: 220 });
    clip.appendChild(crect);
    svg.appendChild(clip);
    gWave.setAttribute('clip-path', `url(#${clipId})`);

    interface Dot { el: SVGCircleElement; x: number; }
    const dots: Dot[] = [];
    lanes.forEach(lane => {
        lane.spikes.forEach(sp => {
            const el = svgEl('circle', { cx: sp[0], cy: sp[1], r: 2.2, fill: lane.color, 'fill-opacity': 0 });
            gMark.appendChild(el);
            dots.push({ el, x: sp[0] });
        });
    });

    return {
        svg,
        draw(p: number) {
            const w = outCubic(clamp01(p / 0.78)) * (X1 - X0);
            crect.setAttribute('width', String(w));
            lanes.forEach((lane, i) => {
                lane.path.setAttribute('stroke-dashoffset', String(lane.len * (1 - clamp01(p / 0.78))));
                lane.lab.setAttribute('opacity', String(settle(clamp01((p - i * 0.05) / 0.25))));
            });
            dots.forEach(dot => {
                dot.el.setAttribute('fill-opacity', String(X0 + w > dot.x + 2 ? 0.9 : 0));
            });
            const b = clamp01((p - 0.66) / 0.22);
            band.setAttribute('fill-opacity', String(b * 0.07));
            bk.setAttribute('opacity', String(b));
            blab.setAttribute('opacity', String(clamp01((p - 0.76) / 0.18)));
            axl.setAttribute('opacity', String(clamp01((p - 0.3) / 0.3) * 0.9));
        },
    };
}

/* ============================================================
   ENGINE 4 — clustered matrix + lens
   ============================================================ */
function buildMatrixEngine(host: HTMLElement): StageEngine {
    const svg = createStageSvg(host);
    const R = rnd(90211);
    const gCell = svgEl('g');
    const gClu = svgEl('g');
    const gLens = svgEl('g');
    svg.append(gCell, gClu, gLens);

    const COLS = 9;
    const ROWS = 6;
    const CW = 25;
    const CH = 25;
    const X0 = 38;
    const Y0 = 32;

    interface ClusterDef { cx: number; cy: number; color: string; label: string; lab: SVGTextElement; }
    // Exact labels required by the brief: 정상 / 주의 / 고위험 — never "예시".
    const clusters: ClusterDef[] = [
        { cx: 74, cy: 170, color: 'var(--color-jade)', label: '정상', lab: svgEl('text') },
        { cx: 150, cy: 96, color: 'var(--color-amber)', label: '주의', lab: svgEl('text') },
        { cx: 236, cy: 64, color: 'var(--color-blood)', label: '고위험', lab: svgEl('text') },
    ];

    interface CellInfo {
        x: number;
        y: number;
        band: number;
        dens: number;
        tx: number;
        ty: number;
        delay: number;
        el: SVGRectElement;
        cx: number;
        cy: number;
    }
    const cells: CellInfo[] = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const dens = R();
            const band = dens > 0.9 ? 2 : dens > 0.62 ? 1 : 0;
            const ang = R() * 6.28;
            const rad = band === 2 ? 6 + R() * 16 : band === 1 ? 8 + R() * 24 : 10 + R() * 34;
            const x = X0 + c * CW;
            const y = Y0 + r * CH;
            const tx = clusters[band].cx + Math.cos(ang) * rad - 8;
            const ty = clusters[band].cy + Math.sin(ang) * rad - 8;
            const delay = (c / COLS) * 0.22 + (r / ROWS) * 0.1;
            const el = svgEl('rect', { x, y, width: 16, height: 16, fill: 'var(--color-fg-dim)', 'fill-opacity': 0 });
            gCell.appendChild(el);
            cells.push({ x, y, band, dens, tx, ty, delay, el, cx: x, cy: y });
        }
    }
    const bandTwoCells = cells.filter(o => o.band === 2).sort((a, b) => b.dens - a.dens);
    const top = bandTwoCells.length > 0 ? bandTwoCells[0] : undefined;

    clusters.forEach(k => {
        const lab = svgEl('text', {
            x: k.cx, y: k.cy + 44, fill: k.color, 'font-size': 8.5,
            'font-family': 'Paperlogy,sans-serif', 'text-anchor': 'middle', 'font-weight': 700, opacity: 0,
        });
        lab.textContent = k.label;
        gClu.appendChild(lab);
        k.lab = lab;
    });

    const lensR = 26;
    const lens = svgEl('g', { opacity: 0 });
    lens.appendChild(svgEl('circle', { r: lensR, fill: 'none', stroke: 'var(--color-blood)', 'stroke-width': 1.2, 'stroke-opacity': 0.85 }));
    lens.appendChild(svgEl('circle', { r: lensR + 5, fill: 'none', stroke: 'var(--color-blood)', 'stroke-width': 0.8, 'stroke-opacity': 0.25 }));
    lens.appendChild(svgEl('path', {
        d: `M-${lensR + 9} 0h7M${lensR + 2} 0h7M0 -${lensR + 9}v7M0 ${lensR + 2}v7`,
        stroke: 'var(--color-blood)', 'stroke-width': 1.1,
    }));
    gLens.appendChild(lens);

    return {
        svg,
        draw(p: number) {
            const scatter = clamp01((p - 0.42) / 0.34);
            cells.forEach(o => {
                const fade = settle(clamp01((p - o.delay) / 0.3));
                const t = outCubic(scatter);
                const x = lerp(o.x, o.tx, t);
                const y = lerp(o.y, o.ty, t);
                const sz = lerp(16, o.band === 2 ? 11 : 9, t);
                o.el.setAttribute('x', String(x));
                o.el.setAttribute('y', String(y));
                o.el.setAttribute('width', String(sz));
                o.el.setAttribute('height', String(sz));
                o.el.setAttribute('fill', t > 0.15 ? clusters[o.band].color : 'var(--color-fg-dim)');
                o.el.setAttribute('fill-opacity', String(fade * (0.12 + o.dens * 0.5) * (1 - t * 0.15)));
                o.cx = x + sz / 2;
                o.cy = y + sz / 2;
            });
            clusters.forEach(k => k.lab.setAttribute('opacity', String(clamp01((p - 0.7) / 0.2))));

            const lp = clamp01((p - 0.5) / 0.44);
            if (lp <= 0) {
                lens.setAttribute('opacity', '0');
            } else {
                const e = outCubic(lp);
                const lx = lerp(48, top ? top.cx : 236, e);
                const ly = lerp(150, top ? top.cy : 64, e);
                lens.setAttribute('opacity', String(clamp01(lp / 0.15)));
                lens.setAttribute('transform', `translate(${lx},${ly}) scale(${lerp(1.35, 1, e)})`);
            }
        },
    };
}

interface StageDef {
    no: string;
    tag: string;
    title: string;
    sub: string;
    dur: number;
    build: (host: HTMLElement) => StageEngine;
}

const STAGES: readonly StageDef[] = [
    { no: 'S1', tag: 'ORBIT', title: '관계 궤도 정렬', sub: '맞팔 후보를 대상 중심 궤도에 배치합니다', dur: 2600, build: buildOrbitalEngine },
    { no: 'S2', tag: 'CONSTELLATION', title: '성좌 교차 판독', sub: '화면 전체에서 겹치는 연결을 동시에 훑습니다', dur: 2700, build: buildConstellationEngine },
    { no: 'S3', tag: 'SIGNAL', title: '신호 누적 스캔', sub: '좋아요 방향·댓글 친밀도·맞팔을 누적합니다', dur: 2500, build: buildWaveformEngine },
    { no: 'S4', tag: 'CLUSTER', title: '군집 분류', sub: '후보를 정상·주의·고위험 군집으로 분리합니다', dur: 2600, build: buildMatrixEngine },
];
/** 2600 + 2700 + 2500 + 2600 + 1600 = 12000ms total, matching the approved prototype. */
const REVEAL_MS = 1600;
export const PRECHECKOUT_DEMO_STAGE_DURATIONS_MS = STAGES.map(stage => stage.dur);
export const PRECHECKOUT_DEMO_DURATION_MS = PRECHECKOUT_DEMO_STAGE_DURATIONS_MS.reduce(
    (sum, duration) => sum + duration,
    REVEAL_MS,
);
const TOTAL_MS = PRECHECKOUT_DEMO_DURATION_MS;

export interface PrecheckoutStageGraphsProps {
    /** Original demo start; every frame is derived from this absolute timeline. */
    startedAtMs: number;
    /** Mirrors the actual rendered stage, keeping accessible status text on the same clock. */
    onStageChange?: (index: number) => void;
    /** Reports renderer/asset/timer failures to the page-level fail-open owner. */
    onError?: () => void;
}

/**
 * Renders the four-stage sequence into one viewport plus its player. All four SVG engines are
 * built once on mount so switching stages is a pure opacity/attribute toggle — no remount, no
 * layout thrash. `prefers-reduced-motion` jumps the visual frame to the end while preserving the
 * same completion deadline.
 */
export function PrecheckoutStageGraphs({
    startedAtMs,
    onStageChange,
    onError,
}: PrecheckoutStageGraphsProps) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const noRef = useRef<HTMLSpanElement>(null);
    const titleRef = useRef<HTMLSpanElement>(null);
    const subRef = useRef<HTMLParagraphElement>(null);
    const vtagRef = useRef<HTMLSpanElement>(null);
    const railRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const onStageChangeRef = useRef(onStageChange);
    const onErrorRef = useRef(onError);
    const startedAtRef = useRef(startedAtMs);

    useEffect(() => {
        onStageChangeRef.current = onStageChange;
        onErrorRef.current = onError;
    }, [onStageChange, onError]);

    useEffect(() => {
        const host = viewportRef.current;
        if (!host) return undefined;

        if (!Number.isFinite(startedAtRef.current) || startedAtRef.current < 0) {
            try {
                onErrorRef.current?.();
            } catch {
                // The page-level error disposition must not become another renderer error.
            }
            return undefined;
        }

        const reportRendererError = () => {
            try {
                onErrorRef.current?.();
            } catch {
                // The page-level error disposition must not become another renderer error.
            }
        };

        let engines: StageEngine[] = [];
        let reduced = false;
        try {
            engines = STAGES.map(stage => stage.build(host));
            reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
            engines.forEach(engine => engine.svg.remove());
            reportRendererError();
            return undefined;
        }

        let activeIndex = -1;

        function applyStageMeta(index: number) {
            const stage = STAGES[index];
            if (noRef.current) noRef.current.textContent = stage.no;
            if (titleRef.current) titleRef.current.textContent = stage.title;
            if (subRef.current) subRef.current.textContent = stage.sub;
        }

        function setActive(index: number) {
            if (index === activeIndex) return;
            if (activeIndex >= 0) {
                engines[activeIndex].draw(1);
                engines[activeIndex].svg.style.opacity = '0';
                const prevBar = railRefs.current[activeIndex];
                if (prevBar) prevBar.style.width = '100%';
            }
            activeIndex = index;
            engines[index].svg.style.opacity = '1';
            applyStageMeta(index);
            onStageChangeRef.current?.(index);
        }

        function paint(elapsed: number) {
            let acc = 0;
            let active = STAGES.length - 1;
            let local = 1;
            for (let i = 0; i < STAGES.length; i++) {
                if (elapsed < acc + STAGES[i].dur) {
                    active = i;
                    local = (elapsed - acc) / STAGES[i].dur;
                    break;
                }
                acc += STAGES[i].dur;
            }
            const localClamped = clamp01(local);
            setActive(active);
            engines[active].draw(localClamped);
            const bar = railRefs.current[active];
            if (bar) bar.style.width = `${localClamped * 100}%`;
            if (vtagRef.current) {
                vtagRef.current.textContent = `${STAGES[active].tag} / ${String(Math.round(localClamped * 99)).padStart(2, '0')}`;
            }

        }

        if (reduced) {
            // Remove visual motion. PrecheckoutDemo owns the exact 12-second completion.
            try {
                const lastIndex = STAGES.length - 1;
                setActive(lastIndex);
                engines[lastIndex].draw(1);
                const bar = railRefs.current[lastIndex];
                if (bar) bar.style.width = '100%';
                if (vtagRef.current) {
                    vtagRef.current.textContent = `${STAGES[lastIndex].tag} / 99`;
                }
            } catch {
                reportRendererError();
            }
            return () => {
                engines.forEach(engine => engine.svg.remove());
            };
        }

        let rafId = 0;
        function frame() {
            try {
                const elapsed = Math.max(0, Date.now() - startedAtRef.current);
                paint(elapsed);
                if (elapsed < TOTAL_MS) rafId = requestAnimationFrame(frame);
            } catch {
                reportRendererError();
            }
        }
        try {
            rafId = requestAnimationFrame(frame);
        } catch {
            engines.forEach(engine => engine.svg.remove());
            reportRendererError();
            return undefined;
        }

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            engines.forEach(engine => engine.svg.remove());
        };
        // Intentionally mount-once: the original startedAtMs never changes on parent rerenders.
    }, []);

    return (
        <div className="precheckout-stage-graphs mt-5" aria-hidden="true">
            <div className="flex items-baseline gap-2">
                <span ref={noRef} className="num text-[10.5px] font-extrabold tracking-[0.1em] text-blood">S1</span>
                <span ref={titleRef} className="text-[14.5px] font-extrabold tracking-tight text-fg">관계 궤도 정렬</span>
            </div>
            <p ref={subRef} className="precheckout-stagesub mt-1 min-h-[17px] text-[11.5px] text-fg-dim">맞팔 후보를 대상 중심 궤도에 배치합니다</p>
            <div className="mt-2.5 flex gap-1">
                {STAGES.map((stage, i) => (
                    <i key={stage.no} className="relative h-0.5 flex-1 overflow-hidden bg-line-2 not-italic">
                        <span
                            ref={el => { railRefs.current[i] = el; }}
                            className="absolute inset-y-0 left-0 block w-0 bg-blood"
                        />
                    </i>
                ))}
            </div>
            <div
                ref={viewportRef}
                className="precheckout-viewport relative mt-3 overflow-hidden border border-line bg-[#0a0809]"
            >
                <span ref={vtagRef} className="num absolute left-[9px] top-2 z-[3] text-[9.5px] font-bold tracking-[0.1em] text-fg-mute">
                    ORBIT / 00
                </span>
            </div>
        </div>
    );
}
