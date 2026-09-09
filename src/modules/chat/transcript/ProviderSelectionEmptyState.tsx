import React, { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
} from "@/shared/types";
import { COMIC_RUNTIME_PROVIDERS } from '@/shared/constants';
import { comicRuntimeOnly } from '@/shared/utils';
import { NextTaskBanner } from "@/modules/task-master";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
  Badge,
  Button,
  LLMProviderLogo,
} from "@/shared/ui";
import ModelGroupList, { type ModelGroup } from "@/modules/chat/composer/ModelGroupList";
import ModelLibraryPanel from "@/modules/chat/modals/ModelLibraryPanel";
import { writeSelectedProvider } from '@/shared/selectedProvider';

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
];

const RUNTIME_PROVIDER_META = PROVIDER_META.filter((provider) => (
  COMIC_RUNTIME_PROVIDERS.includes(provider.id)
));

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  /** Records the pick as this provider's default and persists it. */
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  /** Server-authorized provider catalog mutation capability. */
  canManageProviderModels?: boolean;
  /** Whether the active session can accept a new chat turn. */
  canSendMessages?: boolean;
  /** Human-readable reason shown when a new turn is unavailable. */
  sendDisabledReason?: string | null;
  /** Restricts the selector to runtimes with a proven read-only contract. */
  readOnly?: boolean;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return comicRuntimeOnly ? "Claude Code" : "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "opencode") return "OpenCode";
  return "Claude";
}

/**
 * Rendered by chat's ChatMessagesPane when a session has no messages yet, so
 * the user can pick a runtime (and, in the standard build, its model) before
 * their first turn.
 */
export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  // Capability props fail closed for direct mounts and stale callers. The
  // application composition root passes the server-authorized values.
  canManageProviderModels = false,
  canSendMessages = false,
  sendDisabledReason = null,
  readOnly = false,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const runtimeSelectorOnly = comicRuntimeOnly || readOnly;
  // A session row pins its provider even when the transcript is still empty.
  // In a read-only deployment an old Cursor/OpenCode row is readable, but it
  // cannot be continued; do not render the task shortcut that would otherwise
  // populate a disabled composer and imply that a turn can be started.
  const sessionProvider = selectedSession?.__provider ?? selectedSession?.provider;
  const canContinueSession = !readOnly
    || !selectedSession
    || (sessionProvider !== undefined && COMIC_RUNTIME_PROVIDERS.includes(sessionProvider));
  const canStartConversation = canSendMessages && canContinueSession;
  const unavailableReason = sendDisabledReason
    ?? (!canContinueSession
      ? t("input.providerReadOnlyUnsupported", {
          provider: getProviderDisplayName(sessionProvider ?? provider),
          defaultValue: "This provider session cannot be continued in the current read-only deployment.",
        })
      : !canSendMessages
        ? t("input.sendUnavailable", {
            defaultValue: "Sending is unavailable in this deployment.",
          })
        : null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);

  const visibleProviderGroups = useMemo<ModelGroup[]>(() => {
    const providerMeta = runtimeSelectorOnly
      ? RUNTIME_PROVIDER_META
      : PROVIDER_META;
    return providerMeta.map((p) => ({
      key: p.id,
      provider: p.id,
      name: p.name,
      models: providerModelCatalog[p.id]?.OPTIONS ?? [],
    }));
  }, [providerModelCatalog, runtimeSelectorOnly]);

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = providerModels[provider];

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (runtimeSelectorOnly || !canManageProviderModels) {
        return;
      }
      setProvider(providerId);
      writeSelectedProvider(providerId);
      setProviderModel(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [canManageProviderModels, runtimeSelectorOnly, setProvider, setProviderModel, textareaRef],
  );

  const handleRuntimeSelect = useCallback(
    (providerId: LLMProvider) => {
      setProvider(providerId);
      writeSelectedProvider(providerId);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, textareaRef],
  );

  const openModelLibrary = () => {
    setDialogOpen(false);
    setModelLibraryOpen(true);
  };

  const closeModelLibrary = () => {
    setModelLibraryOpen(false);
    setDialogOpen(true);
  };

  const renderUnavailableState = (title: string) => (
    <div className="flex h-full items-center justify-center px-4">
      <div
        className="w-full max-w-[34.25rem] rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-6 text-center"
        role="status"
        aria-live="polite"
      >
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {unavailableReason}
        </p>
      </div>
    </div>
  );

  if (!selectedSession && !currentSessionId) {
    if (!canStartConversation) {
      return renderUnavailableState(
        t("providerSelection.unavailableTitle", {
          defaultValue: "Chat is currently unavailable",
        }),
      );
    }

    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-[34.25rem]">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <LLMProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      {!runtimeSelectorOnly && (
                        <>
                          <span className="text-xs text-muted-foreground">·</span>
                          <span className="truncate text-xs text-foreground">
                            {currentModelLabel}
                          </span>
                        </>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {runtimeSelectorOnly
                        ? t("providerSelection.runtimeOnly.clickToChange", {
                            defaultValue: "Click to change Runtime",
                          })
                        : t("providerSelection.clickToChange", {
                            defaultValue: "Click to change model",
                          })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>
                {runtimeSelectorOnly
                  ? t("providerSelection.runtimeOnly.dialogTitle", { defaultValue: "Runtime Selector" })
                  : "Model Selector"}
              </DialogTitle>
              {runtimeSelectorOnly ? (
                <>
                  <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">
                      {t("providerSelection.runtimeOnly.choose", { defaultValue: "Choose a Runtime" })}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.runtimeOnly.description", {
                        defaultValue: "The server manages each Runtime's model configuration.",
                      })}
                    </p>
                  </div>
                  <Command>
                    <CommandList className="max-h-[350px] p-2">
                      {RUNTIME_PROVIDER_META.map((runtime) => (
                        <CommandItem
                          key={runtime.id}
                          value={getProviderDisplayName(runtime.id)}
                          onSelect={() => handleRuntimeSelect(runtime.id)}
                          className="rounded-lg px-3 py-3"
                        >
                          <LLMProviderLogo provider={runtime.id} className="h-5 w-5 shrink-0" />
                          <span className="font-medium">{getProviderDisplayName(runtime.id)}</span>
                          {provider === runtime.id && (
                            <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                          )}
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {t("providerSelection.chooseModel", {
                          defaultValue: "Choose a model",
                        })}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {t("providerSelection.chooseModelDescription", {
                          defaultValue: "Built-in and custom models in one list",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={openModelLibrary}
                      className="h-8 shrink-0 rounded-lg px-2.5 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("providerSelection.addModel", { defaultValue: "Add model" })}
                    </Button>
                  </div>
                  <Command filter={modelSearchFilter}>
                    <CommandInput
                      placeholder={t("providerSelection.searchModels", {
                        defaultValue: "Search models...",
                      })}
                    />
                    <CommandList className="max-h-[350px]">
                      <CommandEmpty>
                        {t("providerSelection.noModelsFound", {
                          defaultValue: "No models found.",
                        })}
                      </CommandEmpty>
                      {visibleProviderGroups.map((group, idx) => (
                        <CommandGroup
                          key={group.key}
                          className={
                            idx > 0
                              ? "border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                              : "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                          }
                          heading={
                            <span className="flex items-center gap-1.5">
                              <LLMProviderLogo provider={group.provider} className="h-3.5 w-3.5 shrink-0" />
                              {group.name}
                            </span>
                          }
                        >
                          {group.models.length === 0 && providerModelsLoading ? (
                            <CommandItem disabled className="ml-4 border-l border-border/40 pl-4 text-muted-foreground">
                              {t("providerSelection.loadingModels", { defaultValue: "Loading models…" })}
                            </CommandItem>
                          ) : null}
                          {group.models.map((model) => {
                            const isSelected = provider === group.provider && currentModel === model.value;
                            return (
                              <CommandItem
                                key={`${group.key}-${model.value}`}
                                value={`${group.name} ${model.label} ${model.description || ''}`}
                                onSelect={() => handleModelSelect(group.provider, model.value)}
                                className="ml-4 border-l border-border/40 pl-4"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="truncate">{model.label}</span>
                                    {model.isCustom && (
                                      <Badge className="h-4 shrink-0 rounded-full px-1.5 text-[8px]">Custom</Badge>
                                    )}
                                  </div>
                                  {model.label !== model.value && (
                                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                                      {model.value}
                                    </div>
                                  )}
                                </div>
                                {isSelected && (
                                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                                )}
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      ))}
                    </CommandList>
                  </Command>
                </>
              )}
            </DialogContent>
          </Dialog>

          {!runtimeSelectorOnly && canManageProviderModels && (
            <Dialog
              open={modelLibraryOpen}
              onOpenChange={(open) => {
                if (open) {
                  setModelLibraryOpen(true);
                } else {
                  closeModelLibrary();
                }
              }}
            >
              <DialogContent className="flex h-[min(90dvh,46rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-3xl p-4 sm:p-5">
                <DialogTitle>
                  {t("providerSelection.manageModels", {
                    defaultValue: "Manage models",
                  })}
                </DialogTitle>
                <ModelLibraryPanel
                  initialProvider={provider}
                  providerModelCatalog={providerModelCatalog}
                  actions={providerModelActions}
                  onDone={closeModelLibrary}
                />
              </DialogContent>
            </Dialog>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {runtimeSelectorOnly
              ? t("providerSelection.runtimeOnly.ready", {
                  runtime: getProviderDisplayName(provider),
                  defaultValue: "{{runtime}} Runtime is ready. Start typing below.",
                })
              :
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: providerModels.claude,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: providerModels.cursor,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: providerModels.codex,
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: providerModels.opencode,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
              }[provider]}
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
            <Trans
              ns="chat"
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>

          {provider && canContinueSession && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    if (!canStartConversation) {
      return renderUnavailableState(
        t("providerSelection.readOnlyTitle", {
          defaultValue: "This conversation is read-only",
        }),
      );
    }

    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {canContinueSession && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
