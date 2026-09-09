import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  MessageSquare,
  MessageSquarePlus,
  Settings,
  SunMoon,
  X,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/shared/ui';
import { useTheme } from '@/shared/context/ThemeContext';
import { SETTINGS_MAIN_TABS } from '@/shared/constants';
import { taskMasterUiEnabled } from '@/shared/utils';
import type { AppTab, Project } from '@/shared/types';
import { useSessionsSource } from '@/modules/command-palette/hooks/useSessionsSource';
import { useSessionMessageSearch } from '@/modules/command-palette/hooks/useSessionMessageSearch';
import { isManagedIdentityRestricted, useAuth } from '@/modules/auth';
import { useDeploymentPolicy } from '@/shared/context/DeploymentPolicyContext';

type Page = 'actions' | 'sessions';

const PAGE_LABELS: Record<Page, string> = {
  actions: 'Actions',
  sessions: 'Sessions',
};

type CommandPaletteProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
};

const NAV_TABS: Array<{ id: AppTab; label: string; keywords: string }> = [
  { id: 'chat', label: 'Go to Chat', keywords: 'chat messages conversation' },
  { id: 'guide', label: 'Go to Guide', keywords: 'guide readme instructions documentation' },
  { id: 'shell', label: 'Go to Shell', keywords: 'shell terminal console' },
  { id: 'tasks', label: 'Go to Tasks', keywords: 'tasks taskmaster' },
];

const baseVisibleNavTabs = taskMasterUiEnabled
  ? NAV_TABS
  : NAV_TABS.filter(({ id }) => id !== 'tasks');

const visibleSettingsMainTabs = taskMasterUiEnabled
  ? SETTINGS_MAIN_TABS
  : SETTINGS_MAIN_TABS.filter(({ id }) => id !== 'tasks');

/** Rendered by the project-workspace module to search sessions and run workspace actions. */
function CommandPalette({
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
}: CommandPaletteProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode } = useTheme();
  const { authMode, user, canManageSettings: authCanManageSettings } = useAuth();
  const { can, isReadOnly } = useDeploymentPolicy();
  const managedIdentityRestricted = isManagedIdentityRestricted(authMode, user);
  const canManageSettings = authCanManageSettings
    && can('settings.write')
    && !isReadOnly
    && !managedIdentityRestricted;
  // Shell navigation is an execution affordance.  Check the deployment's
  // explicit read-only bit as well as individual capabilities so an
  // inconsistent/stale capability map cannot expose the terminal entry.
  const canUseTerminal = !isReadOnly
    && !managedIdentityRestricted
    && (can('terminal.interactive') || can('shell.exec'));
  const visibleNavTabs = React.useMemo(
    () => baseVisibleNavTabs.filter(({ id }) => id !== 'shell' || canUseTerminal),
    [canUseTerminal],
  );
  const navigate = useNavigate();

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';

  const sessions = useSessionsSource(projectId, open && showSessions);
  const messageMatches = useSessionMessageSearch(projectId, search, open && showSessions);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    type Row = { id: string; label: string; provider?: string; snippet?: string };
    const byId = new Map<string, Row>();
    for (const s of sessions) {
      byId.set(s.id, { id: s.id, label: s.label, provider: s.provider });
    }
    for (const m of messageMatches) {
      const existing = byId.get(m.sessionId);
      if (existing) {
        existing.snippet = m.snippet;
      } else {
        byId.set(m.sessionId, {
          id: m.sessionId,
          label: m.label,
          provider: m.provider,
          snippet: m.snippet,
        });
      }
    }
    return Array.from(byId.values());
  }, [sessions, messageMatches, showSessions]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const startNewChatDisabled = !selectedProject
    || !can('session.write')
    || managedIdentityRestricted;
  const browseLimit = 5;
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>Command palette</DialogTitle>
        <Command label="Command palette" onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {PAGE_LABELS[page]}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label="Back to all"
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">Backspace to go back</span>
            </div>
          )}
          <CommandInput
            placeholder={page ? `Search ${PAGE_LABELS[page].toLowerCase()}…` : 'Type to search anything…'}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            {showActions && (
              <CommandGroup heading="Actions">
                <CommandItem
                  value="Start new chat"
                  disabled={startNewChatDisabled}
                  onSelect={() => {
                    if (!selectedProject) return;
                    run(() => onStartNewChat(selectedProject));
                  }}
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Start new chat</span>
                  {startNewChatDisabled && (
                    <span className="text-xs text-muted-foreground">Select a project first</span>
                  )}
                </CommandItem>
                {canManageSettings && (
                  <CommandItem value="Open settings" onSelect={() => run(() => onOpenSettings())}>
                    <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">Open settings</span>
                  </CommandItem>
                )}
                <CommandItem value="Toggle theme dark light mode" onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Toggle theme</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading="Navigate">
                {visibleNavTabs.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${tab.label} ${tab.keywords}`}
                    onSelect={() => run(() => {
                      // Keep the callback guarded too: a policy transition can
                      // happen after the item was rendered but before it is
                      // selected from the command palette.
                      if (tab.id === 'shell' && !canUseTerminal) {
                        return;
                      }
                      onShowTab?.(tab.id);
                    })}
                  >
                    <span className="flex-1">{tab.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && canManageSettings && (
              <CommandGroup heading="Settings">
                {visibleSettingsMainTabs.map(({ id, label, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`Settings ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">Settings: {label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSessions && projectId && sessionsShown.length > 0 && (
              <CommandGroup heading="Sessions">
                {sessionsShown.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.label} ${s.snippet ?? ''} ${s.id}`.trim()}
                    onSelect={() => run(() => navigate(`/session/${s.id}`))}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{s.label}</span>
                      {s.snippet && (
                        <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                      )}
                    </div>
                    {s.provider && (
                      <span className="text-xs text-muted-foreground">{s.provider}</span>
                    )}
                  </CommandItem>
                ))}
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={`Browse all sessions (${sessionRows.length})`} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}

          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export default React.memo(CommandPalette);

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}
