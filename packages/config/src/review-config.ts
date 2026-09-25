import type { ReviewConfig, ReviewResponseLanguage } from './config.js';

const REVIEW_RESPONSE_LANGUAGES: readonly ReviewResponseLanguage[] = ['en', 'zh-CN', 'ja'];

function isReviewResponseLanguage(value: unknown): value is ReviewResponseLanguage {
  return (
    typeof value === 'string' &&
    (REVIEW_RESPONSE_LANGUAGES as readonly string[]).includes(value)
  );
}

/** Keep the default configuration reference; mark only valid user choices as explicit configuration. */
export function parseReviewConfig(raw: unknown, defaults: ReviewConfig): ReviewConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }
  const mode = Reflect.get(raw, 'mode');
  const language = Reflect.get(raw, 'language');
  return {
    mode: mode === 'inline' || mode === 'subagent' ? mode : defaults.mode,
    ...(isReviewResponseLanguage(language) ? { language } : {}),
    modeSource: mode === 'inline' || mode === 'subagent' ? 'explicit' : 'default',
  };
}
