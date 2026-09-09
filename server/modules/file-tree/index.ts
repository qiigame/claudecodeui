// fileTreeRoutes: used by the server entrypoint to mount the complete authenticated File Tree API at `/api/file-tree`.
// createFileTreeModule: composition helper for deployments that inject a
// capability policy (for example the product/QA read-only profile).
export {
  createFileTreeModule,
  fileTreeRoutes,
} from '@/modules/file-tree/file-tree.module.js';
export { createFileTreeRouter } from './file-tree.routes.js';
