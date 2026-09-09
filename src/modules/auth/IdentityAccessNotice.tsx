import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth/context/AuthContext';
import type { CollaborationActorSummary } from '@/shared/types';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type RestrictedIdentityStatus = 'configured' | 'pending' | 'ambiguous';

const isRestrictedIdentityStatus = (status: unknown): status is RestrictedIdentityStatus =>
  status === 'configured' || status === 'pending' || status === 'ambiguous';

/** Rendered by ProtectedRoute to explain automatic attribution without blocking chat. */
export default function IdentityAccessNotice() {
  const { user } = useAuth();
  const { t } = useTranslation('common');
  const actor = user?.actor as Partial<CollaborationActorSummary> | undefined;
  const identityStatus = actor?.identityStatus;
  const restrictedStatus = isRestrictedIdentityStatus(identityStatus)
    ? identityStatus
    : null;
  const noticeKey = restrictedStatus
    ? `${String(user?.id ?? user?.username ?? 'dingtalk-user')}:${restrictedStatus}`
    : null;
  // Remembers which actor/status notice was acknowledged so an identity change
  // opens a fresh warning without repeatedly interrupting the same workspace.
  const [dismissedNoticeKey, setDismissedNoticeKey] = useState<string | null>(null);

  if (!restrictedStatus || !noticeKey) {
    return null;
  }

  const isAmbiguous = restrictedStatus === 'ambiguous';
  const isConfigured = restrictedStatus === 'configured';
  const title = isAmbiguous
    ? t('identityAccess.ambiguousTitle', { defaultValue: '需要确认钉钉身份' })
    : t('identityAccess.pendingTitle', { defaultValue: '正在自动识别身份' });
  const reason = isAmbiguous
    ? t('identityAccess.ambiguousReason', {
        defaultValue: '当前钉钉身份匹配到多个项目成员，暂时无法确定唯一身份。',
      })
    : isConfigured
      ? t('identityAccess.configuredReason', {
          defaultValue: '当前钉钉身份已配置，但尚未完成项目身份验证。',
        })
      : t('identityAccess.pendingReason', {
          defaultValue: '当前钉钉身份将在登录后自动匹配项目人员。',
        });
  const closeNotice = () => setDismissedNoticeKey(noticeKey);

  return (
    <Dialog
      open={dismissedNoticeKey !== noticeKey}
      onOpenChange={(open) => {
        if (!open) closeNotice();
      }}
    >
      <DialogContent
        aria-label={title}
        className="w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-2xl border-amber-500/30 bg-popover p-0 shadow-2xl"
      >
        <DialogTitle>{title}</DialogTitle>
        <div className="p-6">
          <div className="mb-4 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-foreground" aria-hidden="true">
                {title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{reason}</p>
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-border/70 bg-muted/40 p-4 text-sm leading-relaxed text-foreground">
            <p>
              {t('identityAccess.readOnlyScope', {
                defaultValue: '身份映射不影响普通会话；映射完成前，仅代码提交和其他需要实名归因的操作不可用。',
              })}
            </p>
            <p className="font-medium">
              {t('identityAccess.contactAdmin', {
                defaultValue: '如果重新登录后仍未识别，请确认姓名已登记且不存在同名人员。',
              })}
            </p>
          </div>

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={closeNotice}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('identityAccess.acknowledge', { defaultValue: '知道了' })}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
