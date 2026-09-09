// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
// createAssetsRouter lets the composition root inject the immutable deployment
// policy; the default router remains available for standalone consumers/tests.
export { createAssetsRouter, default as assetsRoutes } from './assets.routes.js';
