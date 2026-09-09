import { Tooltip } from '@/shared/ui';
import type { SessionAttributionSummary } from '@/shared/types';

type SessionActorBadgeProps = {
  attribution?: SessionAttributionSummary;
};

/** Used by SidebarSessionItem to show who most recently acted in a shared session. */
export default function SessionActorBadge({ attribution }: SessionActorBadgeProps) {
  if (!attribution) {
    return null;
  }

  const actor = attribution.lastActor;
  return (
    <Tooltip
      content={`最后操作人：${actor.displayName} · ${attribution.participantCount} 位参与者`}
      position="top"
    >
      <span
        aria-label={`最后操作人：${actor.displayName}`}
        className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-semibold text-primary"
      >
        {actor.badge}
      </span>
    </Tooltip>
  );
}
