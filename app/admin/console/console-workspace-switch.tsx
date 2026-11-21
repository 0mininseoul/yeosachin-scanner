import Link from 'next/link';
import { ADMIN_CONSOLE_PATH, NAMCHIN_ADMIN_CONSOLE_PATH } from '@/lib/contracts/admin-console';

const workspaces = [
    { id: 'yeosachin', label: '여사친 판독기', name: '위장여사친판독기', href: ADMIN_CONSOLE_PATH },
    { id: 'namchin', label: '맞팔 알리미', name: '남친 맞팔 알리미', href: NAMCHIN_ADMIN_CONSOLE_PATH },
] as const;

export function ConsoleWorkspaceSwitch({ active }: { active: typeof workspaces[number]['id'] }) {
    return <nav className="ac-workspaces" aria-label="운영 콘솔 서비스 전환">
        <p>서비스 전환</p>
        <div className="ac-workspace-options">
            {workspaces.map(workspace => <Link
                key={workspace.id}
                href={workspace.href}
                className={`ac-workspace-option is-${workspace.id}`}
                aria-label={workspace.name}
                aria-current={active === workspace.id ? 'page' : undefined}
                prefetch={false}
            >{workspace.label}</Link>)}
        </div>
    </nav>;
}
