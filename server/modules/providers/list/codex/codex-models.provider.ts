import { readFile } from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import { ccSwitchConfigService } from '@/modules/runtime-bridge/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  resolveCodexConfigPath,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'ultra',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!['1', 'true', 'yes'].includes(process.env.COMIC_CC_SWITCH_SYNC?.trim().toLowerCase() ?? '')) {
      return CODEX_PREDEFINED_MODELS;
    }

    const configuration = await ccSwitchConfigService.readCodexConfiguration();
    const configuredModel = configuration?.model;
    const configuredEffort = configuration?.reasoningEffort;
    const configuredOption = CODEX_PREDEFINED_MODELS.OPTIONS.find(
      (option) => option.value === configuredModel,
    );
    const hasConfiguredModel = Boolean(configuredOption);
    const configuredEfforts = configuredOption?.effort?.values.map((effort) => effort.value) ?? [];
    const defaultEffort = configuredEffort && configuredEfforts.includes(configuredEffort)
      ? configuredEffort
      : undefined;

    const options = CODEX_PREDEFINED_MODELS.OPTIONS.map((option) => {
      if (option.value !== configuredModel) {
        return option;
      }

      const supportedEfforts = option.effort?.values.map((effort) => effort.value) ?? [];
      return {
        ...option,
        label: configuration?.serviceTier === 'fast' ? `${option.label} · Fast` : option.label,
        ...(option.effort
          ? {
            effort: {
              ...option.effort,
              ...(configuredEffort && supportedEfforts.includes(configuredEffort)
                ? { default: configuredEffort }
                : {}),
            },
          }
          : {}),
      };
    });

    return {
      OPTIONS: options,
      DEFAULT: hasConfiguredModel && configuredModel
        ? configuredModel
        : CODEX_PREDEFINED_MODELS.DEFAULT,
      ...(defaultEffort ? { DEFAULT_EFFORT: defaultEffort } : {}),
      ...(configuration?.serviceTier ? { SERVICE_TIER: configuration.serviceTier } : {}),
    };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      // Resolve at request time so a long-lived server honors an isolated
      // CODEX_HOME or an explicit CC-Switch config selected for the current
      // runtime instance.
      const raw = await readFile(resolveCodexConfigPath(), 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
