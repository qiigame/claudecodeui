import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthenticatedUserMenu } from '@/modules/auth';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { cn } from '@/shared/utils';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceTabs from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  canReadFiles: boolean;
  canReadGit: boolean;
  canUseTerminal: boolean;
  canReadBrowser: boolean;
  canReadPlugins: boolean;
  canUsePlugins: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain to show the workspace title alongside the scrollable tab bar. */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  canReadFiles,
  canReadGit,
  canUseTerminal,
  canReadBrowser,
  canReadPlugins,
  canUsePlugins,
  isMobile,
  onMenuClick,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const hasOverflow = canScrollLeft || canScrollRight;

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();

    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);

    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canMove = event.deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < maxScrollLeft;
      if (!canMove) return;

      event.preventDefault();
      const lineMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
      el.scrollBy({ left: event.deltaY * lineMultiplier, behavior: 'auto' });
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const activeTabElement = scrollRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      activeTabElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      updateScrollState();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(180, el.clientWidth * 0.65), behavior: 'smooth' });
  };

  return (
    <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(12rem,24rem)_minmax(0,1fr)_auto] sm:gap-3">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <WorkspaceTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>

        <div className="col-span-2 col-start-1 row-start-2 -mx-3 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:mx-0">
          <div className="relative ml-auto w-fit max-w-full">
            {canScrollLeft && (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background via-background/90 to-transparent" />
            )}
            <div
              ref={scrollRef}
              onScroll={updateScrollState}
              className={cn(
                'scrollbar-hide max-w-full scroll-smooth overflow-x-auto overscroll-x-contain px-3 [-webkit-overflow-scrolling:touch]',
                hasOverflow ? 'sm:px-9' : 'sm:pl-3 sm:pr-0',
              )}
            >
              <WorkspaceTabs
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                shouldShowTasksTab={shouldShowTasksTab}
                shouldShowBrowserTab={shouldShowBrowserTab}
                canReadFiles={canReadFiles}
                canReadGit={canReadGit}
                canUseTerminal={canUseTerminal}
                canReadBrowser={canReadBrowser}
                canReadPlugins={canReadPlugins}
                canUsePlugins={canUsePlugins}
              />
            </div>
            {canScrollRight && (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background via-background/90 to-transparent" />
            )}

            {canScrollLeft && (
              <button
                type="button"
                onClick={() => scrollTabs(-1)}
                aria-label={t('navigation.scrollTabsLeft', { defaultValue: 'Scroll tabs left' })}
                className="absolute left-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {canScrollRight && (
              <button
                type="button"
                onClick={() => scrollTabs(1)}
                aria-label={t('navigation.scrollTabsRight', { defaultValue: 'Scroll tabs right' })}
                className="absolute right-1 top-1/2 z-20 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/70 bg-background/95 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60 sm:flex"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="col-start-2 row-start-1 min-w-0 justify-self-end sm:col-start-3">
          <AuthenticatedUserMenu />
        </div>
      </div>
    </header>
  );
}
