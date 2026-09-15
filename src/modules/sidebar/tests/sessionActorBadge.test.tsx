import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SessionActorBadge from '@/modules/sidebar/SessionActorBadge';

describe('SessionActorBadge', () => {
  it('shows the last trusted actor and hides when attribution is absent', () => {
    const { rerender } = render(<SessionActorBadge attribution={{
      createdBy: {
        actorId: 1,
        userId: 1,
        displayName: '张三',
        badge: '张',
        provider: 'dingtalk',
        providerName: '漫剧团队',
      },
      lastActor: {
        actorId: 2,
        userId: 2,
        displayName: '李四',
        badge: '李',
        provider: 'dingtalk',
        providerName: '漫剧团队',
      },
      participantCount: 2,
      lastAction: 'send',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }} />);

    expect(screen.getByLabelText('最后操作人：李四').textContent).toBe('李');
    rerender(<SessionActorBadge />);
    expect(screen.queryByLabelText('最后操作人：李四')).toBeNull();
  });

  it('shows the current operator when imported history has no known creator', () => {
    render(<SessionActorBadge attribution={{
      createdBy: null,
      lastActor: {
        actorId: 2, userId: 2, displayName: '李四', badge: '李',
        provider: 'dingtalk', providerName: '漫剧团队',
      },
      participantCount: 1,
      lastAction: 'send',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }} />);
    expect(screen.getByLabelText('最后操作人：李四').textContent).toBe('李');
  });

});
