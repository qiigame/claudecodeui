import assert from 'node:assert/strict';

import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';

import SafeMarkdown from '@/modules/collaboration/SafeMarkdown';

test('safe markdown drops raw HTML, remote images and workspace-relative links', () => {
  const html = renderToStaticMarkup(
    <SafeMarkdown
      content={'<script>alert(1)</script>\n\n![tracker](https://example.com/pixel.png)\n\n[local](../../secret)\n\n[external](https://example.com/docs)'}
    />,
  );

  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('pixel.png'), false);
  assert.equal(html.includes('href="../../secret"'), false);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /Image omitted: tracker/);
});
