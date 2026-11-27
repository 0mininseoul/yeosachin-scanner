'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CHERRY_THREADS_CONSOLE_PATH, NAMCHIN_ADMIN_CONSOLE_PATH } from '@/lib/contracts/admin-console';
import { THEMES, themeNames, type Correction, type DraftBatch, type Theme } from '@/lib/contracts/cherry-threads';
import { Card, ErrorNotice, Loading } from './console-ui';
import { ConsoleWorkspaceSwitch } from './console-workspace-switch';
import styles from './cherry-threads-console.module.css';

type Post = {
    id: string; batch_id: string; body: string; reply: string | null; version: number; state: string;
    scheduled_at: string | null; published_at: string | null; reply_state: string; permalink: string | null;
    views: number | null; reader_replies: number | null; measured_at: string | null; error_code: string | null;
};
type Preferences = { automatic_drafts: boolean; draft_hour: number; draft_minute: number; draft_count: number };
type ConsoleData = {
    batches: DraftBatch[]; posts: Post[]; observed: Post[]; corrections: Correction[];
    connection: { expires_at: string } | null; today: string; preferences: Preferences;
    metaConfigured: boolean; aiConfigured: boolean; serverPublishing: boolean;
};
type Editor = { id: string; version: number; body: string; reply: string; reason: string; removed: boolean };

const endpoint = '/api/admin/cherry/threads';
const kst = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short',
});
const statusText: Record<string, string> = {
    queued: '작성 대기', generating: '작성 중', ready: '검토 중', failed: '작성 실패',
    draft: '승인 대기', scheduled: '예약됨', publishing: '게시 중', published: '게시됨',
    review: '확인 필요', cancelled: '삭제 기록',
};
const errors: Record<string, string> = {
    ai_not_configured: '서버에 OpenAI 프로젝트 키가 필요해요.',
    ai_credits: '연결한 API 조직의 크레딧 잔액을 확인해 주세요.',
    ai_unavailable: '초안 생성 요청에 실패했어요.',
    ai_invalid_output: '응답에서 요청한 편수의 문안을 읽지 못했어요.',
    ai_interrupted: '초안 작성이 중단됐어요.',
    schedule_expired: '회차가 끝났어요. 문안을 다음 회차에 사용해 주세요.',
    publish_unconfirmed: 'Threads에서 원글이 올라갔는지 확인해 주세요.',
    reply_unconfirmed: 'Threads에서 첫 답글이 올라갔는지 확인해 주세요.',
    container_retry: '다음 슬롯에 다시 시도해요.',
    reply_container_retry: '다음 주기에 첫 답글을 다시 준비해요.',
};

function formatDate(value: string | null) {
    return value ? kst.format(new Date(value)) : '—';
}

function plannedSlots(date: string, hour: string, posts: Post[]) {
    const start = Date.parse(`${date}T${hour}:00+09:00`);
    if (!Number.isFinite(start)) return [];
    let offset = 0;
    return posts.map((row, index) => {
        if (index) offset += index % 3 === 0 ? 40 : 20;
        return { id: row.id, version: row.version, slot: new Date(start + offset * 60_000).toISOString() };
    });
}

export function CherryThreadsConsole({ authResult }: { authResult?: 'failed' }) {
    const [data, setData] = useState<ConsoleData | null>(null);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [date, setDate] = useState('');
    const [theme, setTheme] = useState<Theme>('ex');
    const [count, setCount] = useState(8);
    const [selectedBatch, setSelectedBatch] = useState('');
    const [skipped, setSkipped] = useState<string[]>([]);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [hour, setHour] = useState('20:00');

    const load = useCallback(async () => {
        try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) throw new Error();
            const next = await response.json() as ConsoleData;
            setData(next);
            setDate(previous => previous || next.today);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);
    useEffect(() => {
        const initial = setTimeout(() => void load(), 0);
        return () => clearTimeout(initial);
    }, [load]);

    async function act(action: object, success: string) {
        if (busy) return false;
        setBusy(true);
        setMessage('');
        try {
            const response = await fetch(endpoint, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
            });
            if (response.status === 409) {
                setMessage('현재 상태에서는 처리할 수 없어요. 이미 저장된 회차, 승인 버전 또는 예약 시각을 확인해 주세요.');
                await load();
                return false;
            }
            if (!response.ok) throw new Error();
            setMessage(success);
            await load();
            return true;
        } catch {
            setMessage('저장 여부를 확인할 수 없어요. 새로고침하고 다시 확인해 주세요.');
            return false;
        } finally {
            setBusy(false);
        }
    }

    const batch = data?.batches.find(row => row.id === selectedBatch) || data?.batches[0];
    const posts = data?.posts.filter(row => row.batch_id === batch?.id) || [];
    const draftPosts = posts.filter(row => row.state === 'draft' && !skipped.includes(row.id));
    const proposed = batch ? plannedSlots(batch.run_date, hour, draftPosts) : [];
    const connect = data?.connection;
    const activeConnection = Boolean(connect && Date.parse(connect.expires_at) > Date.now());

    function beginEdit(post: Post, removed = false) {
        setEditor({ id: post.id, version: post.version, body: post.body, reply: post.reply || '', reason: '', removed });
    }

    async function saveEdit(event: FormEvent) {
        event.preventDefault();
        if (!editor) return;
        const { id, version, reason, removed, body, reply } = editor;
        const action = removed
            ? { action: 'record_removed', id, version, reason }
            : { action: 'correct', id, version, body, reply: reply.trim() || null, reason };
        if (await act(action, '교정을 저장했어요. 같은 관계의 다음 초안에서 참고해요.')) setEditor(null);
    }

    return <div className="ac-app ac-cherry">
        <aside className="ac-side">
            <Link className="ac-brand" href={CHERRY_THREADS_CONSOLE_PATH}><span><b>체리</b><small>운영 콘솔</small></span></Link>
            <nav className="ac-nav" aria-label="콘솔 메뉴">
                <Link className="ac-nav-btn" href={`${NAMCHIN_ADMIN_CONSOLE_PATH}&view=service`}>서비스 운영</Link>
                <Link className="ac-nav-btn" href={NAMCHIN_ADMIN_CONSOLE_PATH}>사전 예약 명단</Link>
                <Link className="ac-nav-btn is-active" href={CHERRY_THREADS_CONSOLE_PATH} aria-current="page">Threads</Link>
            </nav>
            <div className="ac-side-bottom"><ConsoleWorkspaceSwitch active="namchin" /></div>
        </aside>

        <main className={`ac-main ${styles.main}`}><div className={`ac-wrap ${styles.wrap}`}>
            <header className="ac-top">
                <div><h1>Threads 운영</h1><p>하루 한 관계의 문안을 검토하고 예약해요.</p></div>
                <button type="button" className="ac-btn" onClick={() => void load()}>새로고침</button>
            </header>
            <ErrorNotice message={failed ? '운영 정보를 불러오지 못했어요.' : null} onRetry={() => void load()} />
            {authResult === 'failed' && <p className="ac-alert" role="alert">연결에 실패했어요. 체리 계정과 Meta 설정을 확인해 주세요.</p>}
            <p className={styles.status} aria-live="polite">{message}</p>
            {!data && !failed && <Loading label="Threads 운영 정보를 불러오는 중…" />}
            {data && <>
                <Card title="체리 계정">
                    <div className={styles.actions}>
                        <span>@youlovecherry_ · {activeConnection ? '연결됨' : '연결 필요'}</span>
                        {data.metaConfigured && <a className="ac-btn" href={`${endpoint}/oauth?start=1`}>{connect ? '다시 연결' : 'Threads 연결'}</a>}
                        <button className="ac-btn" type="button" disabled={busy || !activeConnection}
                            onClick={() => void act({ action: 'sync' }, '기존 게시물을 가져왔어요. 나머지 지표는 서버가 순서대로 확인해요.')}>최근 게시물 가져오기</button>
                    </div>
                    {!data.aiConfigured && <p>서버에 OpenAI 프로젝트 키 설정이 필요해요.</p>}
                    {!data.serverPublishing && <p>게시 기능을 켜면 예약을 승인할 수 있어요.</p>}
                </Card>

                <Card title="회차 초안 만들기">
                    <form className={styles.form} onSubmit={event => {
                        event.preventDefault();
                        void act({ action: 'generate', date, theme, count }, '요청했어요. 다음 20분 주기에 초안을 만들어요.')
                            .then(ok => { if (ok) setSelectedBatch(''); });
                    }}>
                        <div className={styles.fields}>
                            <label>회차 날짜<input name="date" type="date" value={date} min={data.today} required
                                onChange={event => setDate(event.target.value)} /></label>
                            <label>관계 소재<select name="theme" value={theme} onChange={event => setTheme(event.target.value as Theme)}>
                                {THEMES.map(value => <option key={value} value={value}>{themeNames[value]}</option>)}
                            </select></label>
                            <label>글 수<input name="count" type="number" min="1" max="20" required value={count}
                                onChange={event => setCount(Number(event.target.value))} /></label>
                        </div>
                        <button className="ac-btn ac-btn--primary" disabled={busy || !data.aiConfigured}>초안 요청</button>
                    </form>
                </Card>

                {batch && <Card title="문안 검토">
                    <div className={styles.form}>
                        <label>회차<select value={batch.id} onChange={event => {
                            setSelectedBatch(event.target.value);
                            setSkipped([]);
                        }} disabled={Boolean(editor)}>
                            {data.batches.map(item => <option key={item.id} value={item.id}>
                                {item.run_date} · {themeNames[item.theme]} · {statusText[item.state]}
                            </option>)}
                        </select></label>
                        {batch.error_code && <p role="status">{errors[batch.error_code] || '초안을 확인해 주세요.'}</p>}
                        {batch.state === 'failed' && <button type="button" className="ac-btn" disabled={busy}
                            onClick={() => void act({ action: 'retry_drafts', batch: batch.id }, '초안 작성을 다시 요청했어요.')}>다시 요청</button>}
                        {batch.state !== 'ready' && batch.state !== 'failed' && <p>초안 작성이 끝나면 이 목록에 표시돼요.</p>}
                        {batch.correction_ids.length > 0 && <details className={styles.details}><summary>생성에 전달한 교정 {batch.correction_ids.length}건</summary>
                            {data.corrections.filter(c => batch.correction_ids.includes(c.id)).map(c =>
                                <blockquote key={c.id}>{c.after_text || c.before_text}<small>{c.reason}</small></blockquote>)}
                        </details>}
                    </div>
                    <div className={styles.posts}>{posts.map((post, index) =>
                        <article className={styles.post} key={post.id}>
                            <div className={styles.postHeader}><strong>{index + 1}번째 글</strong><span>{statusText[post.state]}</span></div>
                            {editor?.id === post.id ? <form className={styles.form} onSubmit={saveEdit}>
                                <details className={styles.details}><summary>교정 전 문안</summary><blockquote>{post.body}</blockquote></details>
                                {editor.removed ? <p>Threads에서 이미 삭제한 글의 이유를 기록해요.</p> : <>
                                    <label>본문<textarea rows={5} maxLength={500} required value={editor.body}
                                        onChange={event => setEditor({ ...editor, body: event.target.value })} /></label>
                                    <label>첫 답글<textarea rows={2} maxLength={500} value={editor.reply}
                                        onChange={event => setEditor({ ...editor, reply: event.target.value })} /></label>
                                </>}
                                <label>교정 이유<textarea rows={3} required maxLength={1000} value={editor.reason}
                                    onChange={event => setEditor({ ...editor, reason: event.target.value })}
                                    placeholder="예: 만나자고 하기보다 먼저 불러주길 바라는 마음으로" /></label>
                                <div className={styles.editorActions}>
                                    <button className="ac-btn ac-btn--primary" disabled={busy}>교정 저장</button>
                                    <button className="ac-btn" type="button" disabled={busy} onClick={() => setEditor(null)}>취소</button>
                                </div>
                            </form> : <>
                                <p className={styles.body}>{post.body}</p>
                                {post.reply && <p className={styles.reply}>첫 답글 · {post.reply}</p>}
                                {post.scheduled_at && <p className={styles.meta}>예약 {formatDate(post.scheduled_at)}</p>}
                                {post.published_at && <p className={styles.meta}>게시 {formatDate(post.published_at)} · 조회 {post.views ?? '—'} · 독자 답글 {post.reader_replies ?? '—'}</p>}
                                {post.error_code && <p role="status">{errors[post.error_code] || '게시 상태를 확인해 주세요.'}</p>}
                                <div className={styles.actions}>
                                    {post.state === 'draft' && <label className={styles.toggle}>
                                        <input type="checkbox" checked={!skipped.includes(post.id)} onChange={event => {
                                            setSkipped(event.target.checked ? skipped.filter(id => id !== post.id) : [...skipped, post.id]);
                                        }} /> 이번 예약에 포함
                                    </label>}
                                    {['draft', 'scheduled'].includes(post.state) && <button className="ac-btn" type="button" disabled={busy || Boolean(editor)}
                                        onClick={() => beginEdit(post)}>교정하기</button>}
                                    {(post.error_code === 'publish_unconfirmed' || post.error_code === 'reply_unconfirmed') && <button className="ac-btn" type="button" disabled={busy}
                                        onClick={() => void act({ action: 'verify', id: post.id }, 'Threads 상태를 확인하고 반영했어요.')}>Threads에서 게시 확인</button>}
                                    {post.permalink && <a className="ac-btn" href={post.permalink} target="_blank" rel="noreferrer">원글 열기</a>}
                                    {post.state === 'published' && <button className="ac-btn" type="button" disabled={busy || Boolean(editor)}
                                        onClick={() => beginEdit(post, true)}>삭제 이유 기록</button>}
                                </div>
                            </>}
                        </article>,
                    )}</div>
                    {proposed.length > 0 && <form className={styles.form} onSubmit={event => {
                        event.preventDefault();
                        void act({ action: 'approve', batch: batch.id, slots: proposed }, `${proposed.length}편을 예약했어요.`);
                    }}>
                        <label>첫 게시 시각 (한국시간)<input type="time" step={1200} required value={hour}
                            onChange={event => setHour(event.target.value)} /></label>
                        <p className={styles.meta}>{proposed.map(slot => kst.format(new Date(slot.slot)).split(' ').slice(-2).join(' ')).join(' · ')}</p>
                        <button className="ac-btn ac-btn--primary" disabled={busy || Boolean(editor) || !activeConnection || !data.serverPublishing}>
                            {proposed.length}편 승인하고 예약
                        </button>
                    </form>}
                </Card>}

                <Card title="저장된 교정">
                    {data.corrections.length ? data.corrections.map(c => <details className={styles.details} key={c.id}>
                        <summary>{themeNames[c.theme]} · {c.reason}</summary>
                        <blockquote>{c.before_text || '이전 답글 없음'}</blockquote>
                        <blockquote>{c.after_text || '삭제한 문안'}</blockquote>
                        <button className="ac-btn" type="button" disabled={busy} onClick={() => void act(
                            { action: 'correction_active', id: c.id, active: !c.active },
                            c.active ? '이 사례를 다음 초안의 참고에서 제외했어요.' : '이 사례를 다음 초안에 다시 사용해요.',
                        )}>{c.active ? '참고에서 제외' : '참고에 다시 포함'}</button>
                    </details>) : <p>저장된 교정이 없어요.</p>}
                </Card>

                <Card title="Threads에서 가져온 글">
                    {data.observed.length ? data.observed.map(post => <details className={styles.details} key={post.id}>
                        <summary>{post.body.slice(0, 55)} · 조회 {post.views ?? '—'} · 독자 답글 {post.reader_replies ?? '—'}</summary>
                        <blockquote>{post.body}</blockquote><p>{formatDate(post.measured_at)} 측정</p>
                        {post.permalink && <a className="ac-btn" href={post.permalink} target="_blank" rel="noreferrer">원글 열기</a>}
                    </details>) : <p>가져온 글이 없어요.</p>}
                </Card>

                <Card title="매일 초안 작성">
                    <form className={styles.form} onSubmit={event => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        const [startHour, minute] = String(form.get('time')).split(':').map(Number);
                        void act({ action: 'automation', enabled: form.has('enabled'), hour: startHour, minute, count: Number(form.get('count')) },
                            '매일 초안 작성 설정을 저장했어요.');
                    }}>
                        <label className={styles.toggle}><input type="checkbox" name="enabled" defaultChecked={data.preferences.automatic_drafts} /> 매일 초안 만들기</label>
                        <div className={styles.fields}>
                            <label>작성 시각 (한국시간)<input type="time" name="time" step={1200} required
                                defaultValue={`${String(data.preferences.draft_hour).padStart(2, '0')}:${String(data.preferences.draft_minute).padStart(2, '0')}`} /></label>
                            <label>글 수<input type="number" name="count" min="1" max="20" required defaultValue={data.preferences.draft_count} /></label>
                        </div>
                        <button className="ac-btn" disabled={busy || !data.aiConfigured}>설정 저장</button>
                    </form>
                </Card>
            </>}
        </div></main>
    </div>;
}
