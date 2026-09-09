import PluginTabContent from '@/modules/plugins/PluginTabContent';

const COORDINATION_PLUGIN_NAME = 'comic-coordination';

/** Used by App to expose the coordination plugin as a full-screen authenticated page. */
export default function CoordinationStandalonePage() {
  return (
    <main
      className="h-screen min-h-0 w-full overflow-hidden bg-background text-foreground"
      data-testid="coordination-standalone-page"
    >
      <PluginTabContent
        pluginName={COORDINATION_PLUGIN_NAME}
        selectedProject={null}
        selectedSession={null}
      />
    </main>
  );
}
