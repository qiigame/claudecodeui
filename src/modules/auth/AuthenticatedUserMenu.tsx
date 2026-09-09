import { LogOut, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth/context/AuthContext';

/** Rendered by App so every authenticated workspace shows the DingTalk identity and logout action. */
export default function AuthenticatedUserMenu() {
  const { user, logout } = useAuth();
  const { t } = useTranslation('common');

  if (!user) return null;

  const displayName = user.username.trim() || '钉钉用户';
  const actor = user.actor as {
    identityStatus?: string;
    personId?: string | null;
  } | undefined;
  const identityPending = Boolean(
    actor?.identityStatus
    && actor.identityStatus !== 'verified'
    && actor.identityStatus !== 'legacy',
  );
  const logoutLabel = t('navigation.logout', { defaultValue: '退出登录' });

  return (
    <div
      data-authenticated-user-menu
      className="flex min-w-0 max-w-36 items-center gap-1 rounded-full border border-border/70 bg-muted/35 p-1 pl-2.5 text-foreground sm:max-w-56"
      aria-label={`当前登录用户：${displayName}${identityPending ? '（身份待登记，只读）' : ''}`}
      title={identityPending ? '项目身份待登记：当前为只读模式' : undefined}
    >
      <UserRound className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs font-medium sm:text-sm" title={displayName}>
        {displayName}
      </span>
      {identityPending && (
        <span
          className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
          title="请由项目负责人在协作库登记并确认钉钉身份后再进行写操作"
        >
          待登记
        </span>
      )}
      <button
        type="button"
        onClick={logout}
        className="ml-1 inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        aria-label={logoutLabel}
        title={logoutLabel}
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden lg:inline">{logoutLabel}</span>
      </button>
    </div>
  );
}
