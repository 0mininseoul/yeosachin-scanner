'use client';

import { useState } from 'react';
import type {
    PipelineBandId,
    PipelineEdge,
    PipelineMap,
    PipelineNode,
    PipelineNodeKind,
} from '@/lib/services/admin/pipeline-map';

const PAD_X = 24;
const CARD_W = 150;
const COL_GAP = 48;
const BAND_HEAD = 44;
const BAND_FOOT = 28;
const BAND_GAP = 24;
const ROW_PITCH = 112;
const WIDTH = PAD_X * 2 + CARD_W * 4 + COL_GAP * 3;

const KIND_LABEL: Record<PipelineNodeKind, string> = {
    infra: '결제·인프라',
    collect: '수집',
    ai: 'AI · Gemini',
    join: '조인·계산',
};

type Box = { x: number; y: number; w: number; h: number };
type Layout = {
    height: number;
    bands: { id: PipelineBandId; title: string; top: number; height: number }[];
    boxes: Map<string, Box>;
    cell: (band: PipelineBandId, col: number, row: number) => Box;
};

function layout(map: PipelineMap): Layout {
    let top = 0;
    const bands = map.bands.map(band => {
        const singleRow = band.rows === 1;
        const cardH = singleRow ? 76 : 64;
        const height = BAND_HEAD + cardH + (band.rows - 1) * ROW_PITCH + BAND_FOOT;
        const entry = { id: band.id, title: band.title, top, height, cardH };
        top += height + BAND_GAP;
        return entry;
    });
    const byId = new Map(bands.map(band => [band.id, band]));
    const cell = (bandId: PipelineBandId, col: number, row: number): Box => {
        const band = byId.get(bandId)!;
        return {
            x: PAD_X + col * (CARD_W + COL_GAP),
            y: band.top + BAND_HEAD + row * ROW_PITCH,
            w: CARD_W,
            h: band.cardH,
        };
    };
    const boxes = new Map(map.nodes.map(node => [node.id, cell(node.band, node.col, node.row)]));
    return { height: top - BAND_GAP, bands, boxes, cell };
}

const cx = (box: Box) => box.x + box.w / 2;
const cy = (box: Box) => box.y + box.h / 2;

/** Orthogonal connector between two cards; the tip stops 1px short of the target. */
function edgePath(edge: PipelineEdge, from: Box, to: Box): string {
    const route = edge.route;
    if (route === 'elbow-h') {
        // Out of the side, along the source row, then down into the target's top.
        const startX = cx(to) > cx(from) ? from.x + from.w : from.x;
        return `M ${startX} ${cy(from)} L ${cx(to)} ${cy(from)} L ${cx(to)} ${to.y - 1}`;
    }
    if (route === 'elbow-v') {
        // Down out of the bottom, then across into the target's facing side.
        const endX = cx(to) > cx(from) ? to.x - 1 : to.x + to.w + 1;
        return `M ${cx(from)} ${from.y + from.h} L ${cx(from)} ${cy(to)} L ${endX} ${cy(to)}`;
    }
    if (route === 'bus') {
        const midY = (from.y + from.h + to.y) / 2;
        return `M ${cx(from)} ${from.y + from.h} L ${cx(from)} ${midY} L ${cx(to)} ${midY} L ${cx(to)} ${to.y - 1}`;
    }
    if (Math.abs(cy(from) - cy(to)) < 1) {
        return cx(to) > cx(from)
            ? `M ${from.x + from.w} ${cy(from)} L ${to.x - 1} ${cy(to)}`
            : `M ${from.x} ${cy(from)} L ${to.x + to.w + 1} ${cy(to)}`;
    }
    return `M ${cx(from)} ${from.y + from.h} L ${cx(to)} ${to.y - 1}`;
}

function DetailPanel({ node }: { node: PipelineNode }) {
    return <aside className="ac-card ac-pipe-detail" aria-live="polite">
        <div className="ac-pipe-detail-h">
            <div className="ac-row ac-row--wrap">
                <span className="ac-chip ac-t-none">{node.band === 'worker' ? '③ 분석 워커' : node.band === 'payment' ? '② 결제 · 실행 승인' : node.band === 'result' ? '④ 결과' : '① 결제 전'}</span>
                <span className={`ac-chip ac-pipe-k-${node.kind}`}>{KIND_LABEL[node.kind]}</span>
                {node.optional ? <span className="ac-chip ac-t-warn">설정으로 켜고 끔</span> : null}
            </div>
            <h2>{node.title}{node.batched ? ' ×N' : ''}</h2>
            {node.workerStage ? <code>{node.workerStage}</code> : null}
        </div>
        <div className="ac-pipe-detail-b">
            <section><h3>하는 일</h3><ul>{node.does.map(line => <li key={line}>{line}</li>)}</ul></section>
            <section><h3>외부 서비스</h3><p>{node.services}</p></section>
            {node.numbers.length > 0 ? <section><h3>코드 기준 값</h3><dl>
                {node.numbers.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
            </dl></section> : null}
            <section><h3>실패하면</h3><p>{node.failure}</p></section>
            <section><h3>코드 위치</h3>{node.code.map(path => <code key={path} className="ac-pipe-path">{path}</code>)}</section>
        </div>
        <p className="ac-pipe-detail-f">단계 목록과 숫자는 배포된 코드에서 바로 읽습니다. 워커 단계가 추가되거나 바뀌면 타입 검사가 이 화면의 업데이트를 요구합니다.</p>
    </aside>;
}

export function PipelineView({ map }: { map: PipelineMap }) {
    const [selected, setSelected] = useState<string>('profile_ai');
    const geometry = layout(map);
    const node = map.nodes.find(item => item.id === selected) ?? map.nodes[0];

    return <div className="ac-stack">
        <div className="ac-pipe-meta">
            <div className="ac-legend">
                {(Object.keys(KIND_LABEL) as PipelineNodeKind[]).map(kind => <span key={kind}><i className={`ac-pipe-k-${kind}`} />{KIND_LABEL[kind]}</span>)}
                <span><i className="ac-pipe-dash" />설정으로 켜고 끄는 단계</span>
            </div>
            <span className="ac-meta">{map.riskPolicyVersion} · 분석 단계 {map.workerStageCount}개{map.deployedCommit ? ` · 배포 커밋 ${map.deployedCommit}` : ''}</span>
        </div>
        <div className="ac-pipe">
            <div className="ac-pipe-scroll">
                <div className="ac-pipe-host" style={{ width: WIDTH, height: geometry.height }}>
                    {geometry.bands.map(band => <div key={band.id} className="ac-pipe-band" style={{ top: band.top, height: band.height, width: WIDTH }}>
                        <span>{band.title}</span>
                    </div>)}
                    <svg className="ac-pipe-edges" width={WIDTH} height={geometry.height} aria-hidden="true">
                        <defs>
                            <marker id="ac-pipe-head" orient="auto" markerWidth="5" markerHeight="5" refX="4" refY="2" overflow="visible">
                                <path d="M0 0 L4 2 L0 4 Z" fill="#8a94a3" />
                            </marker>
                        </defs>
                        {map.edges.map(edge => {
                            const from = geometry.boxes.get(edge.from);
                            const to = geometry.boxes.get(edge.to);
                            if (!from || !to) return null;
                            const active = edge.from === node.id || edge.to === node.id;
                            return <path
                                key={`${edge.from}-${edge.to}`}
                                d={edgePath(edge, from, to)}
                                className={`${edge.dashed ? 'is-dashed' : ''}${active ? ' is-active' : ''}`}
                                markerEnd="url(#ac-pipe-head)"
                            />;
                        })}
                    </svg>
                    {map.notes.map(note => {
                        const box = geometry.cell(note.band, note.col, note.row);
                        return <p key={note.text} className="ac-pipe-note" style={{ left: box.x, top: box.y, width: box.w }}>{note.text}</p>;
                    })}
                    {map.nodes.map(item => {
                        const box = geometry.boxes.get(item.id)!;
                        return <button
                            key={item.id}
                            type="button"
                            className={`ac-pipe-node ac-pipe-k-${item.kind}${item.batched ? ' is-batched' : ''}${item.optional ? ' is-optional' : ''}${item.id === node.id ? ' is-selected' : ''}`}
                            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                            aria-pressed={item.id === node.id}
                            onClick={() => setSelected(item.id)}
                        >
                            <span><b>{item.title}{item.batched ? ' ×N' : ''}</b><small>{item.subtitle}</small></span>
                        </button>;
                    })}
                </div>
            </div>
            <DetailPanel node={node} />
        </div>
    </div>;
}
