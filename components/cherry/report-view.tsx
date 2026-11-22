import type { MemberReport } from '@/lib/services/cherry/member';
import type { CherryEventRow } from '@/lib/services/cherry/store';
import { koreanTime } from './format';

const won = new Intl.NumberFormat('ko-KR');
const reportDay = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' });
const GENDER = { female: '여성', male: '남성', unknown: '미확인' } as const;

function CherryPerson({ event, imagePath }: { event: CherryEventRow; imagePath(index: number): string }) {
    const portrait = event.images.findIndex(image => image.role === 'profile');
    const posts = event.images.map((image, index) => ({ ...image, index })).filter(image => image.role === 'post');
    return <article className="ch-person">
        <div className="ch-person-top">
            <div className="ch-portrait">
                {portrait >= 0
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={imagePath(portrait)} alt={`${event.username} 프로필 사진`} />
                    : <span aria-hidden="true">{event.username.slice(0, 1).toUpperCase()}</span>}
            </div>
            {event.profile ? <dl className="ch-stats">
                <div><dt>팔로워</dt><dd>{won.format(event.profile.followersCount)}</dd></div>
                <div><dt>팔로잉</dt><dd>{won.format(event.profile.followingCount)}</dd></div>
                <div><dt>게시물</dt><dd>{won.format(event.profile.postsCount)}</dd></div>
            </dl> : null}
        </div>
        <h2>@{event.username}</h2>
        {event.full_name ? <p className="ch-note">{event.full_name}</p> : null}
        {event.certainty === 'possible' ? <p className="ch-possible">앞선 목록에서 빠졌던 계정일 수 있어요. 예전부터 맞팔이었을 가능성이 있어요.</p> : null}
        <dl className="ch-facts-grid">
            {event.summary?.interest ? <div><dt>관심사</dt><dd>{event.summary.interest}</dd></div> : null}
            <div><dt>성별</dt><dd>{GENDER[event.summary?.gender ?? 'unknown']}</dd></div>
            {event.summary?.posts ? <div><dt>주로 올리는 글</dt><dd>{event.summary.posts}</dd></div> : null}
            <div><dt>확인 시각</dt><dd>{koreanTime(event.detected_at)}</dd></div>
        </dl>
        {event.is_private ? <p className="ch-possible">비공개 계정이라 게시물은 볼 수 없어요.</p> : null}
        {posts.length > 0 ? <div className="ch-posts">{posts.map(image =>
            // eslint-disable-next-line @next/next/no-img-element
            <img key={image.key} src={imagePath(image.index)} alt="최근 게시물" loading="lazy" />)}</div> : null}
        {event.summary ? <>
            <p className="ch-summary">{event.summary.headline} {event.summary.description}</p>
            <p className="ch-note">공개 프로필과 최근 게시물을 AI가 요약했어요. 사실과 다를 수 있어요.</p>
            {event.summary.tags.length > 0 ? <ul className="ch-tags">{event.summary.tags.map(tag => <li key={tag}>{tag}</li>)}</ul> : null}
        </> : null}
        {event.detail_status === 'failed' ? <p className="ch-note" style={{ marginTop: 16 }}>상세 정보를 불러오지 못했어요. 인스타그램에서 확인해 주세요.</p> : null}
        <a className="ch-open" href={`https://www.instagram.com/${encodeURIComponent(event.username)}/`} target="_blank" rel="noreferrer noopener">인스타그램에서 보기</a>
    </article>;
}

export function CherryReportView({ data, imagePath }: {
    data: MemberReport; imagePath(eventId: string, index: number): string;
}) {
    return <>
        <h1 className="ch-title">새 맞팔 {data.report.new_count}명을 확인했어요</h1>
        <p className="ch-lead">@{data.targetUsername}, {reportDay.format(new Date(`${data.report.report_date}T00:00:00Z`))}</p>
        {data.events.map(event => <CherryPerson key={event.id} event={event} imagePath={index => imagePath(event.id, index)} />)}
        <p className="ch-note" style={{ marginTop: 40 }}>사진은 확인한 날부터 30일 동안 볼 수 있어요.</p>
    </>;
}
