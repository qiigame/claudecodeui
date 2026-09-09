import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBrowserUseMcpApiUrl } from '../browser-use-mcp-url.service.js';

test('Browser MCP callback URL follows concrete and wildcard server bindings', () => {
  const cases = [
    {
      name: 'concrete IPv4',
      environment: { HOST: '192.168.0.78', SERVER_PORT: '3090' },
      expected: 'http://192.168.0.78:3090/api/browser-use-mcp',
    },
    {
      name: 'IPv4 wildcard',
      environment: { HOST: '0.0.0.0', SERVER_PORT: '3090' },
      expected: 'http://127.0.0.1:3090/api/browser-use-mcp',
    },
    {
      name: 'IPv6 wildcard',
      environment: { HOST: '::', SERVER_PORT: '3090' },
      expected: 'http://[::1]:3090/api/browser-use-mcp',
    },
    {
      name: 'expanded IPv6 wildcard',
      environment: { HOST: '0:0:0:0:0:0:0:0', SERVER_PORT: '3090' },
      expected: 'http://[::1]:3090/api/browser-use-mcp',
    },
    {
      name: 'concrete IPv6',
      environment: { HOST: '2001:db8::78', SERVER_PORT: '3090' },
      expected: 'http://[2001:db8::78]:3090/api/browser-use-mcp',
    },
    {
      name: 'bracketed concrete IPv6',
      environment: { HOST: '[2001:db8::78]', PORT: '3090' },
      expected: 'http://[2001:db8::78]:3090/api/browser-use-mcp',
    },
  ];

  for (const testCase of cases) {
    assert.equal(
      resolveBrowserUseMcpApiUrl(testCase.environment),
      testCase.expected,
      testCase.name,
    );
  }
});

test('Browser MCP callback URL accepts only an exact same-origin override', () => {
  assert.equal(
    resolveBrowserUseMcpApiUrl({
      CLOUDCLI_BROWSER_USE_API_URL: ' http://192.168.0.78:3090/api/browser-use-mcp/ ',
      HOST: '192.168.0.78',
      SERVER_PORT: '3090',
    }),
    'http://192.168.0.78:3090/api/browser-use-mcp',
  );
});

test('Browser MCP callback URL rejects overrides that could exfiltrate its bearer token', () => {
  const invalidOverrides = [
    'https://attacker.example/api/browser-use-mcp',
    'http://192.168.0.78:8080/api/browser-use-mcp',
    'https://192.168.0.78:3090/api/browser-use-mcp',
    'http://user@192.168.0.78:3090/api/browser-use-mcp',
    'http://192.168.0.78:3090/not-the-browser-bridge',
    'http://192.168.0.78:3090/api/browser-use-mcp?forward=attacker.example',
    'not-an-absolute-url',
  ];

  for (const configuredUrl of invalidOverrides) {
    assert.throws(
      () => resolveBrowserUseMcpApiUrl({
        CLOUDCLI_BROWSER_USE_API_URL: configuredUrl,
        HOST: '192.168.0.78',
        SERVER_PORT: '3090',
      }),
      /CLOUDCLI_BROWSER_USE_API_URL/,
      configuredUrl,
    );
  }
});

test('Browser MCP callback URL rejects invalid server ports and hosts', () => {
  assert.throws(
    () => resolveBrowserUseMcpApiUrl({ HOST: '192.168.0.78', SERVER_PORT: '0' }),
    /Invalid Browser MCP server port/,
  );
  assert.throws(
    () => resolveBrowserUseMcpApiUrl({ HOST: '192.168.0.78', SERVER_PORT: '3e3' }),
    /Invalid Browser MCP server port/,
  );
  assert.throws(
    () => resolveBrowserUseMcpApiUrl({ HOST: 'https:\/\/attacker.example', SERVER_PORT: '3090' }),
    /Invalid Browser MCP server host/,
  );
  assert.throws(
    () => resolveBrowserUseMcpApiUrl({ HOST: 'local@attacker.example', SERVER_PORT: '3090' }),
    /Invalid Browser MCP server host/,
  );
});
