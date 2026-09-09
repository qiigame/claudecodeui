import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ExistingPrdFile } from '@/shared/types';
import { ensurePrdExtension } from '@/modules/prd-editor/utils/fileName';

type SavePrdInput = {
  content: string;
  fileName: string;
  allowOverwrite?: boolean;
};

type SavePrdResult =
  | { status: 'saved'; fileName: string }
  | { status: 'needs-overwrite'; fileName: string }
  | { status: 'failed'; message: string };

type UsePrdSaveArgs = {
  // DB primary key of the project (post migration).
  projectId?: string;
  existingPrds: ExistingPrdFile[];
  isExistingFile: boolean;
  /** Server-authorized capability for writing PRD/task-master files. */
  canMutate?: boolean;
  onAfterSave?: () => Promise<void>;
};

type UsePrdSaveResult = {
  savePrd: (input: SavePrdInput) => Promise<SavePrdResult>;
  saving: boolean;
  saveSuccess: boolean;
};

export function usePrdSave({
  projectId,
  existingPrds,
  isExistingFile,
  // Mutation hooks fail closed when a caller has not supplied an explicit
  // server-authorized capability. The normal PRDEditor path passes the
  // developer/managed policy result; omitted callers must not regain write
  // access merely because they mounted this hook directly.
  canMutate = false,
  onAfterSave,
}: UsePrdSaveArgs): UsePrdSaveResult {
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  const savePrd = useCallback(
    async ({ content, fileName, allowOverwrite = false }: SavePrdInput): Promise<SavePrdResult> => {
      // Keep this guard at the API boundary as well as in PRDEditor's UI. A
      // delayed keyboard shortcut or stale callback must not turn a read-only
      // TaskMaster/QA view into a write request after policy changes.
      if (!canMutate) {
        return { status: 'failed', message: 'PRD editing is disabled in this deployment.' };
      }

      if (!content.trim()) {
        return { status: 'failed', message: 'Please add content before saving.' };
      }

      if (!fileName.trim()) {
        return { status: 'failed', message: 'Please provide a filename for the PRD.' };
      }

      if (!projectId) {
        return { status: 'failed', message: 'No project selected. Please reopen the editor.' };
      }

      const finalFileName = ensurePrdExtension(fileName.trim());
      const hasConflict = existingPrds.some((prd) => prd.name === finalFileName);

      // Overwrite confirmation is only required when creating a brand-new PRD.
      if (hasConflict && !allowOverwrite && !isExistingFile) {
        return { status: 'needs-overwrite', fileName: finalFileName };
      }

      setSaving(true);

      try {
        const response = await api.taskmaster.savePrd(projectId, {
          fileName: finalFileName,
          content,
        });

        if (!response.ok) {
          const fallbackMessage = `Save failed: ${response.status}`;

          try {
            const errorData = (await response.json()) as { message?: string };
            return { status: 'failed', message: errorData.message || fallbackMessage };
          } catch {
            return { status: 'failed', message: fallbackMessage };
          }
        }

        if (saveSuccessTimeoutRef.current) {
          clearTimeout(saveSuccessTimeoutRef.current);
        }

        setSaveSuccess(true);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          setSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2000);

        if (onAfterSave) {
          await onAfterSave();
        }

        return { status: 'saved', fileName: finalFileName };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { status: 'failed', message: `Error saving PRD: ${message}` };
      } finally {
        setSaving(false);
      }
    },
    [canMutate, existingPrds, isExistingFile, onAfterSave, projectId],
  );

  return {
    savePrd,
    saving,
    saveSuccess,
  };
}
