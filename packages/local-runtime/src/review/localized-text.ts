import type { ReviewResponseLanguage } from '@mavis/config';

/** Pick the localized variant for a review response language. All variants are required so adding a language fails type-checking instead of silently falling back. */
export function pickReviewLanguageText<T>(
  language: ReviewResponseLanguage,
  variants: Record<ReviewResponseLanguage, T>,
): T {
  return variants[language];
}
