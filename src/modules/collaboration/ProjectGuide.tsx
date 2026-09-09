import { AlertCircle, BookOpen, FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import SafeMarkdown from '@/modules/collaboration/SafeMarkdown';
import { api } from '@/shared/api';
import type { Project, ProjectGuidePayload } from '@/shared/types';

type ProjectGuideProps = {
  project: Project;
};

type GuideLoadState =
  | { status: 'loading'; projectId: string }
  | { status: 'ready'; projectId: string; guide: ProjectGuidePayload }
  | { status: 'error'; projectId: string; message: string };

type GuideApiEnvelope = {
  success?: boolean;
  data?: ProjectGuidePayload;
  error?: string | { message?: string };
};

function readErrorMessage(payload: GuideApiEnvelope | null, fallback: string): string {
  if (typeof payload?.error === 'string') return payload.error;
  return payload?.error?.message || fallback;
}

/** Rendered by WorkspaceMain when a user opens the selected project's Guide tab. */
export default function ProjectGuide({ project }: ProjectGuideProps) {
  // This state owns the current project's network result so an old project
  // response can never be rendered as the newly selected project's guide.
  const [loadState, setLoadState] = useState<GuideLoadState>({
    status: 'loading',
    projectId: project.projectId,
  });
  // The selected filename is essential when a project exposes README plus
  // AGENTS/CLAUDE instructions; the first available document is the default.
  const [selectedDocument, setSelectedDocument] = useState<{
    projectId: string;
    name: string;
  } | null>(null);

  const currentLoadState: GuideLoadState = loadState.projectId === project.projectId
    ? loadState
    : { status: 'loading', projectId: project.projectId };
  const selectedDocumentName = selectedDocument?.projectId === project.projectId
    ? selectedDocument.name
    : null;

  useEffect(() => {
    const abortController = new AbortController();

    void api.projectGuide(project.projectId)
      .then(async (response) => {
        const payload = await response.json() as GuideApiEnvelope;
        if (!response.ok || !payload.data) {
          throw new Error(readErrorMessage(payload, 'Unable to load project guide.'));
        }
        if (!abortController.signal.aborted) {
          setLoadState({ status: 'ready', projectId: project.projectId, guide: payload.data });
          const firstDocumentName = payload.data.documents[0]?.name;
          setSelectedDocument(firstDocumentName
            ? { projectId: project.projectId, name: firstDocumentName }
            : null);
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setLoadState({
            status: 'error',
            projectId: project.projectId,
            message: error instanceof Error ? error.message : 'Unable to load project guide.',
          });
        }
      });

    return () => abortController.abort();
  }, [project.projectId]);

  const activeDocument = currentLoadState.status === 'ready'
    ? currentLoadState.guide.documents.find((document) => document.name === selectedDocumentName)
      ?? currentLoadState.guide.documents[0]
      ?? null
    : null;

  if (currentLoadState.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading project guide…
      </div>
    );
  }

  if (currentLoadState.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-center">
          <AlertCircle className="mx-auto mb-2 h-6 w-6 text-destructive" />
          <p className="text-sm text-foreground">{currentLoadState.message}</p>
        </div>
      </div>
    );
  }

  if (!activeDocument) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-lg">
          <BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">No project guide yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Add README.md, PROJECT_GUIDE.md, AGENTS.md, or CLAUDE.md to the project root.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {currentLoadState.guide.documents.length > 1 && (
        <nav className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-4 py-3" aria-label="Guide documents">
          {currentLoadState.guide.documents.map((document) => (
            <button
              key={document.name}
              type="button"
              onClick={() => setSelectedDocument({ projectId: project.projectId, name: document.name })}
              className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                document.name === activeDocument.name
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <FileText className="h-4 w-4" /> {document.name}
            </button>
          ))}
        </nav>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <article className="prose prose-slate mx-auto max-w-4xl px-5 py-8 text-foreground dark:prose-invert sm:px-8">
          <SafeMarkdown content={activeDocument.content} />
        </article>
      </main>
    </div>
  );
}
