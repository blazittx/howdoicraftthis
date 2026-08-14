/**
 * Optional post-optimize advisor hook.
 * Call after optimizeCraft — never feeds invented numbers back into ranking.
 */
export {
  llmAdvise,
  loadAdvisorSettings,
  saveAdvisorSettings,
  DEFAULT_MODEL,
  SYSTEM_PROMPT_ID,
  SYSTEM_PROMPT_VERSION,
} from './advisor.js';
export { validateAdvice, collectInvariants } from './schema.js';
export {
  SYSTEM_PROMPT,
  buildAdvisePayload,
  summarizeAdvisePayload,
} from './prompt.js';
