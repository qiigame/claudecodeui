import { GitBranch, LockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { SessionWorkspacePlan } from '@/shared/types';

type SessionWorkspaceModalProps = {
  plan: SessionWorkspacePlan | null;
  selectedKeys: string[];
  onToggle: (repositoryKey: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

/** Repository selector shown only for a new multi-repository team session. */
export default function SessionWorkspaceModal({
  plan,
  selectedKeys,
  onToggle,
  onConfirm,
  onClose,
}: SessionWorkspaceModalProps) {
  const { t } = useTranslation('chat');

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg rounded-2xl border-border/70 bg-popover p-0 shadow-2xl">
        <div className="border-b border-border/60 px-5 py-4">
          <DialogTitle>
            {t('sessionWorkspace.title', { defaultValue: '选择本会话涉及的代码仓' })}
          </DialogTitle>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('sessionWorkspace.description', {
              defaultValue: '系统会从远端最新基线创建独立 worktree。其他会话不会看到本会话的未提交修改。',
            })}
          </p>
        </div>

        <div className="max-h-[55vh] space-y-2 overflow-y-auto px-5 py-4">
          {plan?.repositories.map((repository) => {
            const checked = selectedKeys.includes(repository.key);
            return (
              <label
                key={repository.key}
                className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                  repository.writable
                    ? 'cursor-pointer border-border/70 hover:border-primary/40 hover:bg-accent/40'
                    : 'cursor-not-allowed border-border/40 opacity-55'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-primary"
                  checked={checked}
                  disabled={!repository.writable}
                  onChange={() => onToggle(repository.key)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    {repository.displayName}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {repository.relativePath} · {repository.baseBranch}
                  </span>
                  {!repository.writable && (
                    <span className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-300">
                      <LockKeyhole className="h-3.5 w-3.5" />
                      {repository.unavailableReason || t('sessionWorkspace.readOnly', { defaultValue: '当前只读' })}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('sessionWorkspace.cancel', { defaultValue: '取消' })}
          </Button>
          <Button type="button" disabled={selectedKeys.length === 0} onClick={onConfirm}>
            {t('sessionWorkspace.create', { defaultValue: '创建隔离会话' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
