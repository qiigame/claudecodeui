import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { ccSwitchConfigService } from '@/modules/runtime-bridge/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  closeProviderTranscriptReadHandle,
  openValidatedProviderTranscript,
  resolveClaudeConfigDirectory,
  type ProviderTranscriptPathValidationInput,
  validateProviderTranscriptPath,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/**
 * Claude Code stamps locally-synthesized rows (API-error placeholders and the
 * like) with `model: "<synthetic>"`. Angle-bracketed values are placeholders,
 * never real model ids, and must not be surfaced as the session's model.
 */
const isPlaceholderModel = (model: string): boolean => model.startsWith('<') && model.endsWith('>');

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderModel(messageModel) ? messageModel : null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromContent = (
  sessionId: string,
  content: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

/** Filesystem seams used to validate Claude model lookups and isolated tests. */
export type ClaudeProviderModelsDependencies = {
  getClaudeConfigDirectory?: () => string;
  validateTranscriptPath?: (
    input: ProviderTranscriptPathValidationInput,
  ) => Promise<string | null>;
};

export class ClaudeProviderModels implements IProviderModels {
  private readonly dependencies: Required<ClaudeProviderModelsDependencies>;

  constructor(dependencyOverrides: ClaudeProviderModelsDependencies = {}) {
    this.dependencies = {
      getClaudeConfigDirectory: dependencyOverrides.getClaudeConfigDirectory
        ?? resolveClaudeConfigDirectory,
      validateTranscriptPath: dependencyOverrides.validateTranscriptPath
        ?? validateProviderTranscriptPath,
    };
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    if (!['1', 'true', 'yes'].includes(process.env.COMIC_CC_SWITCH_SYNC?.trim().toLowerCase() ?? '')) {
      return CLAUDE_PREDEFINED_MODELS;
    }

    const configuration = await ccSwitchConfigService.readClaudeConfiguration();
    const configuredModel = configuration?.model;
    if (!configuredModel) {
      return CLAUDE_PREDEFINED_MODELS;
    }

    const hasConfiguredModel = CLAUDE_PREDEFINED_MODELS.OPTIONS.some(
      (option) => option.value === configuredModel,
    );
    return {
      OPTIONS: hasConfiguredModel
        ? CLAUDE_PREDEFINED_MODELS.OPTIONS
        : [
          {
            value: configuredModel,
            label: configuredModel,
            description: 'Current CC-Switch Claude provider model.',
            effort: {
              default: 'high',
              values: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'xhigh' },
                { value: 'max' },
                ULTRACODE_EFFORT_OPTION,
              ],
            },
          },
          ...CLAUDE_PREDEFINED_MODELS.OPTIONS,
        ],
      DEFAULT: configuredModel,
    };
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const session = sessionsDb.getSessionById(sessionId);
      // A known app row without a native id is still pending its first run;
      // its opaque app id must never be used as a Claude transcript key. A row
      // owned by another provider is likewise not a valid Claude session.
      if (session && session.provider !== 'claude') {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }
      const providerSessionId = session ? session.provider_session_id : sessionId;
      if (!providerSessionId) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }
      // `project_path` remains the source/sidebar owner, while isolated
      // sessions run in `runtime_path`. Bind the transcript lookup to that
      // effective cwd so a stale source path cannot report another model as
      // this session's active model.
      const expectedProjectPath = typeof session?.runtime_path === 'string' && session.runtime_path.trim()
        ? session.runtime_path.trim()
        : typeof session?.project_path === 'string' && session.project_path.trim()
          ? session.project_path.trim()
          : null;
      const jsonlPath = session?.jsonl_path
        ? session.jsonl_path
        : null;
      let activeModel: ProviderCurrentActiveModel | null = null;
      if (jsonlPath) {
        const rootPath = path.join(this.dependencies.getClaudeConfigDirectory(), 'projects');
        if (this.dependencies.validateTranscriptPath === validateProviderTranscriptPath) {
          const authenticated = await openValidatedProviderTranscript({
            provider: 'claude',
            candidatePath: jsonlPath,
            rootPath,
            providerSessionId,
            expectedProjectPath,
          });
          if (authenticated) {
            try {
              const content = await authenticated.handle.readFile({ encoding: 'utf8' });
              activeModel = readClaudeSessionModelFromContent(providerSessionId, content);
            } finally {
              await closeProviderTranscriptReadHandle(authenticated.handle);
            }
          }
        } else {
          // Test/adapter seams may intentionally bypass the deployment root.
          const validated = await this.dependencies.validateTranscriptPath({
            provider: 'claude',
            candidatePath: jsonlPath,
            rootPath,
            providerSessionId,
            expectedProjectPath,
          });
          activeModel = validated
            ? readClaudeSessionModelFromContent(providerSessionId, await readFile(validated, 'utf8'))
            : null;
        }
      }
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
