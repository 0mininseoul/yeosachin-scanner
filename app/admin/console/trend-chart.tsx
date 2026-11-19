'use client';

import { useId, useState } from 'react';

export type TrendSeries = Readonly<{
    name: string;
    color: string;
    fill: string;
    /** null = unknown for that period; drawn as a gap, never as zero. */
    values: readonly (number | null)[];
}>;

const WIDTH = 300;
const HEIGHT = 120;
const TOP_PAD = 8;

function buildPaths(series: readonly TrendSeries[]) {
    const length = series[0]?.values.length ?? 0;
    const stacked: (number | null)[][] = [];
    series.forEach((item, index) => {
        stacked.push(item.values.map((value, i) => {
            const below = index === 0 ? 0 : stacked[index - 1]![i];
            return value === null || below === null ? null : value + below;
        }));
    });
    const top = stacked[stacked.length - 1] ?? [];
    const max = Math.max(1e-9, ...top.filter((value): value is number => value !== null)) * 1.08;
    const x = (i: number) => (length <= 1 ? WIDTH / 2 : (i / (length - 1)) * WIDTH);
    const y = (value: number) => HEIGHT - (value / max) * (HEIGHT - TOP_PAD);

    const segments = (values: readonly (number | null)[]) => {
        const runs: number[][] = [];
        let current: number[] = [];
        values.forEach((value, i) => {
            if (value === null) { if (current.length) runs.push(current); current = []; return; }
            current.push(i);
        });
        if (current.length) runs.push(current);
        return runs;
    };

    const layers = series.map((item, index) => {
        const upper = stacked[index]!;
        const lower = index === 0 ? upper.map(value => (value === null ? null : 0)) : stacked[index - 1]!;
        const runs = segments(upper.map((value, i) => (value === null || lower[i] === null ? null : value)));
        const line = runs.map(run => run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(upper[i]!).toFixed(1)}`).join(' ')).join(' ');
        const area = runs.map(run => {
            const forward = run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(upper[i]!).toFixed(1)}`).join(' ');
            const back = [...run].reverse().map(i => `L${x(i).toFixed(1)} ${y(lower[i]!).toFixed(1)}`).join(' ');
            return `${forward} ${back} Z`;
        }).join(' ');
        return { item, line, area };
    });
    return { layers, top, max, length, x, y };
}

export function TrendChart({ title, total, totalNote, labels, tooltipLabels, series, format, note }: {
    title: string;
    total: string;
    totalNote: string;
    labels: readonly string[];
    tooltipLabels: readonly string[];
    series: readonly TrendSeries[];
    format: (value: number) => string;
    note: string;
}) {
    const [hover, setHover] = useState<number | null>(null);
    const titleId = useId();
    const { layers, top, max, length } = buildPaths(series);
    const segment = length > 1 ? 100 / (length - 1) : 100;
    const active = hover !== null && hover < length ? hover : null;
    const activeTop = active === null ? null : top[active] ?? null;
    const shift = active === null ? '-50%' : active <= 1 ? '0%' : active >= length - 2 ? '-100%' : '-50%';

    return <figure className="ac-chart" aria-labelledby={titleId}>
        <figcaption>
            <div id={titleId} className="ac-chart-t">{title}</div>
            <div className="ac-chart-v">{total}<small>{totalNote}</small></div>
        </figcaption>
        <div className="ac-legend">
            {series.map(item => <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>)}
        </div>
        <div className="ac-plot" onMouseLeave={() => setHover(null)}>
            <svg className="ac-area" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} stroke="var(--ac-line-soft)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                <line x1="0" y1={HEIGHT - 0.5} x2={WIDTH} y2={HEIGHT - 0.5} stroke="var(--ac-line)" vectorEffect="non-scaling-stroke" />
                {[...layers].reverse().map(layer => <path key={`a-${layer.item.name}`} d={layer.area} fill={layer.item.fill} />)}
                {[...layers].reverse().map(layer => <path key={`l-${layer.item.name}`} d={layer.line} fill="none" stroke={layer.item.color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
            </svg>
            {active !== null ? <>
                <div className="ac-guide" style={{ left: `${active * segment}%` }} />
                {activeTop !== null ? <div className="ac-dot" style={{
                    left: `${active * segment}%`,
                    top: `${100 - (activeTop / max) * ((HEIGHT - TOP_PAD) / HEIGHT) * 100}%`,
                    borderColor: series[series.length - 1]?.color,
                }} /> : null}
                <div className="ac-tip" role="status" style={{ left: `${active * segment}%`, transform: `translate(${shift}, -100%)` }}>
                    <div className="ac-tip-date">{tooltipLabels[active]}</div>
                    {[...series].reverse().map(item => <div key={item.name} className="ac-tip-row">
                        <i style={{ background: item.color }} /><span>{item.name}</span>
                        <b>{item.values[active] === null ? '미상' : format(item.values[active]!)}</b>
                    </div>)}
                    {series.length > 1 ? <div className="ac-tip-total"><span>합계</span><b>{activeTop === null ? '미상' : format(activeTop)}</b></div> : null}
                </div>
            </> : null}
            <div className="ac-hits" style={{ left: `-${segment / 2}%`, right: `-${segment / 2}%` }}>
                {labels.map((_, i) => <button
                    key={i}
                    type="button"
                    className="ac-hit"
                    aria-label={`${tooltipLabels[i]} ${title} ${top[i] === null ? '미상' : format(top[i]!)}`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    onClick={() => setHover(i)}
                />)}
            </div>
        </div>
        <div className="ac-xlabels" aria-hidden="true">{labels.map((label, i) => <span key={i}>{label}</span>)}</div>
        <p className="ac-meta">{note}</p>
    </figure>;
}
