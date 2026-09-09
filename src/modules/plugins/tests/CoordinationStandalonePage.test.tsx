import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CoordinationStandalonePage from '@/modules/plugins/CoordinationStandalonePage';

vi.mock('@/modules/plugins/PluginTabContent', () => ({
  default: ({
    pluginName,
    selectedProject,
    selectedSession,
  }: {
    pluginName: string;
    selectedProject: unknown;
    selectedSession: unknown;
  }) => (
    <div
      data-testid="plugin-tab-content"
      data-plugin-name={pluginName}
      data-project-is-null={String(selectedProject === null)}
      data-session-is-null={String(selectedSession === null)}
    />
  ),
}));

describe('CoordinationStandalonePage', () => {
  it('renders the coordination plugin without project or session coupling', () => {
    render(<CoordinationStandalonePage />);

    expect(screen.getByTestId('coordination-standalone-page')).not.toBeNull();
    expect(screen.getByTestId('plugin-tab-content').getAttribute('data-plugin-name')).toBe(
      'comic-coordination',
    );
    expect(screen.getByTestId('plugin-tab-content').getAttribute('data-project-is-null')).toBe('true');
    expect(screen.getByTestId('plugin-tab-content').getAttribute('data-session-is-null')).toBe('true');
  });
});
