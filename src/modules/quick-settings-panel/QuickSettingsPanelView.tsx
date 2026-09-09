import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useTheme } from '@/shared/context/ThemeContext';
import { isManagedIdentityRestricted, useAuth } from '@/modules/auth';
import { useDeploymentPolicy } from '@/shared/context/DeploymentPolicyContext';
import { useQuickSettingsDrag } from '@/modules/quick-settings-panel/hooks/useQuickSettingsDrag';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '@/shared/types';
import QuickSettingsContent from '@/modules/quick-settings-panel/QuickSettingsContent';
import QuickSettingsHandle from '@/modules/quick-settings-panel/QuickSettingsHandle';
import QuickSettingsPanelHeader from '@/modules/quick-settings-panel/QuickSettingsPanelHeader';

/** Exported as QuickSettingsPanel and rendered by the project-workspace module as its slide-out quick settings drawer. */
function QuickSettingsPanelView() {
  const [isOpen, setIsOpen] = useState(false);
  const { authMode, user } = useAuth();
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDarkMode } = useTheme();
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  // Pending/ambiguous managed actors may read the workspace but the server
  // rejects all authenticated mutation requests until identity enrollment is
  // complete. Quick settings persist through that same preference endpoint;
  // remove the handle entirely instead of presenting toggles that can only
  // fail with IDENTITY_ENROLLMENT_REQUIRED. Verified DingTalk and local
  // developer sessions retain the existing panel.
  const managedIdentityRestricted = isManagedIdentityRestricted(authMode, user);
  const { can, status: deploymentPolicyStatus } = useDeploymentPolicy();
  // Personal UI preferences use the user/session mutation boundary. They are
  // intentionally available to verified product/QA actors even though the
  // deployment remains read-only for source, Git, Shell, and admin settings.
  const canWritePreferences = deploymentPolicyStatus === 'ready'
    && can('session.write')
    && !managedIdentityRestricted;
  const {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  } = useQuickSettingsDrag({ isMobile });

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
    voiceEnabled: preferences.voiceEnabled,
  }), [
    preferences.sendByCtrlEnter,
    preferences.showRawParameters,
    preferences.showThinking,
    preferences.voiceEnabled,
  ]);

  const handlePreferenceChange = useCallback(
    (key: PreferenceToggleKey, value: boolean) => {
      if (!canWritePreferences) {
        return;
      }
      setPreference(key, value);
    },
    [canWritePreferences, setPreference],
  );

  const handleToggleFromHandle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A drag releases a click event as well; this guard prevents accidental toggles.
      if (consumeSuppressedClick()) {
        event.preventDefault();
        return;
      }

      if (!canWritePreferences) {
        event.preventDefault();
        return;
      }

      setIsOpen((previous) => !previous);
    },
    [canWritePreferences, consumeSuppressedClick],
  );

  useEffect(() => {
    if (!canWritePreferences) {
      setIsOpen(false);
    }
  }, [canWritePreferences]);

  if (!canWritePreferences) {
    return null;
  }

  return (
    <>
      <QuickSettingsHandle
        isOpen={isOpen}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggleFromHandle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />

      <div
        className={`fixed right-0 top-0 z-[9999] h-full w-64 transform border-l border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'} ${isMobile ? 'h-screen' : ''}`}
      >
        <div className="flex h-full flex-col">
          <QuickSettingsPanelHeader />
          <QuickSettingsContent
            isDarkMode={isDarkMode}
            preferences={quickSettingsPreferences}
            onPreferenceChange={handlePreferenceChange}
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-[9998] bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}

export default memo(QuickSettingsPanelView);
