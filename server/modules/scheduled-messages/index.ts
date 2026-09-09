// The HTTP surface for scheduling a message to a session, mounted by the app.
export {
  createScheduledMessagesRouter,
  default as scheduledMessagesRoutes,
} from './scheduled-messages.routes.js';
export type { ScheduledMessagesRouterOptions } from './scheduled-messages.routes.js';

// The timer that sends them, started and stopped with the server.
export {
  initializeScheduledMessageDispatcher,
  closeScheduledMessageDispatcher,
} from './services/scheduled-message-dispatcher.service.js';
