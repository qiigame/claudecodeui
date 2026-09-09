// voiceRoutes: used by standalone consumers/tests to mount authenticated STT/TTS endpoints.
// createVoiceModule: used by the server composition root to inject deployment capability guards.
export { createVoiceModule, voiceRoutes } from './voice.module.js';
