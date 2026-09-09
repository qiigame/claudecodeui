import { useCallback, useState } from 'react';

import { api } from '@/shared/api';
import type { GitOperationResponse } from '@/shared/types';

type UseRevertLocalCommitOptions = {
  // DB primary key for the project; forwarded to the git API via the
  // `project` body param.
  projectId: string | null;
  /** Server-authorized Git mutation capability. */
  canMutate?: boolean;
  onSuccess?: () => void;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function useRevertLocalCommit({ projectId, canMutate = false, onSuccess }: UseRevertLocalCommitOptions) {
  const [isRevertingLocalCommit, setIsRevertingLocalCommit] = useState(false);

  const revertLatestLocalCommit = useCallback(async () => {
    // Keep the capability check in the hook so a stale confirmation callback
    // cannot issue a destructive Git request after the deployment policy
    // changes to read-only.
    if (!canMutate || !projectId) {
      return;
    }

    setIsRevertingLocalCommit(true);
    try {
      const response = await api.git.revertLocalCommit(projectId);
      const data = await readJson<GitOperationResponse>(response);

      if (!data.success) {
        console.error('Revert local commit failed:', data.error || data.details || 'Unknown error');
        return;
      }

      onSuccess?.();
    } catch (error) {
      console.error('Error reverting local commit:', error);
    } finally {
      setIsRevertingLocalCommit(false);
    }
  }, [canMutate, onSuccess, projectId]);

  return {
    isRevertingLocalCommit,
    revertLatestLocalCommit,
  };
}
