import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  dereferenceJsonSchema,
  readConfiguredToken,
  sanitizeMcpToolSchemas,
} from '@/modules/providers/list/claude/thinkingdata-mcp-compat-proxy.js';

const restoreEnvironmentValue = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

test('dereferenceJsonSchema inlines local definitions and removes gateway-incompatible keywords', () => {
  const schema = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      FilterOperator: {
        type: 'string',
        enum: ['eq', 'neq'],
      },
      Filter: {
        type: 'object',
        properties: {
          operator: { $ref: '#/$defs/FilterOperator' },
        },
        required: ['operator'],
      },
    },
    properties: {
      filter: {
        $ref: '#/$defs/Filter',
        description: 'The filter selected by the caller.',
      },
    },
  };

  const result = dereferenceJsonSchema(schema);
  assert.deepEqual(result, {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: {
          operator: {
            type: 'string',
            enum: ['eq', 'neq'],
          },
        },
        required: ['operator'],
        description: 'The filter selected by the caller.',
      },
    },
  });
  assert.equal(JSON.stringify(result).includes('$ref'), false);
  assert.equal(JSON.stringify(result).includes('$defs'), false);
  assert.equal(JSON.stringify(result).includes('$schema'), false);
});

test('dereferenceJsonSchema bounds recursive definitions while preserving the recursive object shape', () => {
  const schema = {
    type: 'object',
    $defs: {
      ConditionGroup: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group: { $ref: '#/$defs/ConditionGroup' },
              },
            },
          },
        },
      },
    },
    properties: {
      conditions: { $ref: '#/$defs/ConditionGroup' },
    },
  };

  const result = dereferenceJsonSchema(schema);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('$ref'), false);
  assert.equal(encoded.includes('$defs'), false);
  assert.ok(encoded.length < 20_000, 'recursive schema expansion must stay bounded');

  const conditions = (result.properties as Record<string, unknown>).conditions as Record<string, unknown>;
  assert.equal(conditions.type, 'object');
  const items = (conditions.properties as Record<string, unknown>).items as Record<string, unknown>;
  const item = items.items as Record<string, unknown>;
  const recursiveGroup = (item.properties as Record<string, unknown>).group as Record<string, unknown>;
  assert.equal(recursiveGroup.type, 'object');
});

test('sanitizeMcpToolSchemas supports both MCP schema key spellings and keeps tool metadata', () => {
  const tools = [
    {
      name: 'camel',
      description: 'camel schema',
      inputSchema: {
        type: 'object',
        $defs: { Value: { type: 'string' } },
        properties: { value: { $ref: '#/$defs/Value' } },
      },
    },
    {
      name: 'snake',
      description: 'snake schema',
      input_schema: {
        type: 'object',
        $defs: { Value: { type: 'integer' } },
        properties: { value: { $ref: '#/$defs/Value' } },
      },
    },
    { name: 'without-schema', description: 'unchanged' },
  ];

  const result = sanitizeMcpToolSchemas(tools) as Array<Record<string, unknown>>;
  assert.equal(result[0].name, 'camel');
  assert.equal(result[0].description, 'camel schema');
  assert.deepEqual(
    (result[0].inputSchema as Record<string, unknown>).properties,
    { value: { type: 'string' } },
  );
  assert.deepEqual(
    (result[1].input_schema as Record<string, unknown>).properties,
    { value: { type: 'integer' } },
  );
  assert.deepEqual(result[2], tools[2]);
});

test('sanitizeMcpToolSchemas normalizes both schema spellings when a tool contains both', () => {
  const result = sanitizeMcpToolSchemas([{
    name: 'dual-schema',
    inputSchema: {
      type: 'object',
      $defs: { Value: { type: 'string' } },
      properties: { value: { $ref: '#/$defs/Value' } },
    },
    input_schema: {
      type: 'object',
      definitions: { Count: { type: 'integer' } },
      properties: { count: { $ref: '#/definitions/Count' } },
    },
  }]) as Array<Record<string, unknown>>;

  const encoded = JSON.stringify(result[0]);
  assert.equal(encoded.includes('$ref'), false);
  assert.equal(encoded.includes('$defs'), false);
  assert.equal(encoded.includes('definitions'), false);
  assert.deepEqual(
    (result[0].inputSchema as Record<string, unknown>).properties,
    { value: { type: 'string' } },
  );
  assert.deepEqual(
    (result[0].input_schema as Record<string, unknown>).properties,
    { count: { type: 'integer' } },
  );
});

test('readConfiguredToken prefers a protected token file and falls back to the environment', {
  concurrency: false,
}, async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-te-token-'));
  const tokenFilePath = path.join(temporaryDirectory, 'token');
  const originalTokenFilePath = process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE;
  const originalTokenEnvironmentName = process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV;
  const originalToken = process.env.TE_MCP_TOKEN;

  try {
    await fs.writeFile(tokenFilePath, 'file-token\n', { mode: 0o600 });
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE = tokenFilePath;
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV = 'TE_MCP_TOKEN';
    process.env.TE_MCP_TOKEN = 'environment-token';

    assert.equal(readConfiguredToken(), 'file-token');

    await fs.rm(tokenFilePath);
    assert.equal(readConfiguredToken(), 'environment-token');
  } finally {
    restoreEnvironmentValue(
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
      originalTokenFilePath,
    );
    restoreEnvironmentValue(
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV',
      originalTokenEnvironmentName,
    );
    restoreEnvironmentValue('TE_MCP_TOKEN', originalToken);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('readConfiguredToken does not fall back to an unrelated Dataverse model credential', {
  concurrency: false,
}, () => {
  const originalTokenFilePath = process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE;
  const originalTokenEnvironmentName = process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV;
  const originalToken = process.env.TE_MCP_TOKEN;
  const originalDataverseToken = process.env.COMIC_DATAVERSE_TOKEN;

  try {
    delete process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE;
    process.env.CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV = 'TE_MCP_TOKEN';
    delete process.env.TE_MCP_TOKEN;
    process.env.COMIC_DATAVERSE_TOKEN = 'model-api-key-must-not-be-used';

    assert.throws(
      () => readConfiguredToken(),
      /ThinkingData MCP credentials are unavailable/,
    );
  } finally {
    restoreEnvironmentValue(
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_FILE',
      originalTokenFilePath,
    );
    restoreEnvironmentValue(
      'CLOUDCLI_THINKINGDATA_MCP_TOKEN_ENV',
      originalTokenEnvironmentName,
    );
    restoreEnvironmentValue('TE_MCP_TOKEN', originalToken);
    restoreEnvironmentValue('COMIC_DATAVERSE_TOKEN', originalDataverseToken);
  }
});
