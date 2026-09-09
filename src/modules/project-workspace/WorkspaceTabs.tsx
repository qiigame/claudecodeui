import {
  BookOpen,
  ClipboardCheck,
  Folder,
  GitBranch,
  MessageSquare,
  MonitorPlay,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { isProductQaReadOnlyPlugin, PluginIcon, usePlugins } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  /** Server-authorized read capability for the file browser. */
  canReadFiles?: boolean;
  /** Server-authorized read capability for source-control metadata. */
  canReadGit?: boolean;
  /** Interactive terminals are intentionally absent from product/QA deployments. */
  canUseTerminal?: boolean;
  /** Server-authorized read capability for browser/plugin panes. */
  canReadBrowser?: boolean;
  canReadPlugins?: boolean;
  /** Executing third-party plugin code requires a separate server grant. */
  canUsePlugins?: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const CHAT_AND_GUIDE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'guide', labelKey: 'tabs.guide', icon: BookOpen },
];

const SHELL_TAB: BuiltInTab = { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal };
const FILES_TAB: BuiltInTab = { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder };
const GIT_TAB: BuiltInTab = { kind: 'builtin', id: 'git', labelKey: 'tabs.git', icon: GitBranch };

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Rendered by WorkspaceHeader to show the built-in workspace tabs plus any enabled plugin tabs. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  canReadFiles = false,
  canReadGit = false,
  canUseTerminal = false,
  canReadBrowser = false,
  canReadPlugins = false,
  canUsePlugins = false,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInTabs: BuiltInTab[] = [
    ...CHAT_AND_GUIDE_TABS,
    ...(canUseTerminal ? [SHELL_TAB] : []),
    ...(canReadFiles ? [FILES_TAB] : []),
    ...(canReadGit ? [GIT_TAB] : []),
    ...(shouldShowBrowserTab && canReadBrowser ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    // Generic plugin bundles still require plugin.use. Product/QA exposes only
    // the operator-installed coordination mirror, whose backend RPC is GET-only.
    .filter((p) => p.enabled
      && canReadPlugins
      && (canUsePlugins || isProductQaReadOnlyPlugin(p)))
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInTabs.length && pluginTabs.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className="h-8 max-w-44 px-2.5 py-[5px]"
              >
                {tab.kind === 'builtin' ? (
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                ) : (
                  <PluginIcon
                    pluginName={tab.pluginName}
                    iconFile={tab.iconFile}
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                  />
                )}
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
  );
}
