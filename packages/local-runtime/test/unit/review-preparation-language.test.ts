import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReviewPreferencesService } from '../../src/review/preferences.js';
import {
  ReviewPreparationService,
  type ReviewPromptTemplates,
} from '../../src/review/preparation.js';

const templates: ReviewPromptTemplates = {
  reviewer: 'REVIEWER SYSTEM',
  candidates: 'CANDIDATE RULES',
};

let workspace: string;
let dataDir: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'review-language-workspace-'));
  dataDir = mkdtempSync(join(tmpdir(), 'review-language-data-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function prepare(config: { review?: Record<string, unknown> }, region: 'cn' | 'en') {
  return new ReviewPreparationService({
    preferences: new ReviewPreferencesService(dataDir),
    configGetter: () => config,
    regionGetter: () => region,
  }).prepare(
    { workspace, trigger: 'slash', request: 'review the local changes' },
    templates,
  );
}

describe('ReviewPreparationService response language', () => {
  it('defaults to zh-CN when the runtime region is cn', async () => {
    const prepared = await prepare({}, 'cn');
    expect(prepared.responseLanguage).toBe('zh-CN');
    expect(prepared.context.responseLanguage).toBe('zh-CN');
    expect(prepared.reviewPrompt).toContain('## Required response language');
    expect(prepared.reviewPrompt).toContain('简体中文');
  });

  it('defaults to en when the runtime region is en', async () => {
    const prepared = await prepare({}, 'en');
    expect(prepared.responseLanguage).toBe('en');
    expect(prepared.reviewPrompt).toContain('must be written in English');
  });

  it('lets review.language override the cn region default', async () => {
    const prepared = await prepare({ review: { language: 'en' } }, 'cn');
    expect(prepared.responseLanguage).toBe('en');
    expect(prepared.reviewPrompt).toContain('must be written in English');
    expect(prepared.reviewPrompt).not.toContain('简体中文');
  });

  it('supports ja output regardless of region', async () => {
    for (const region of ['cn', 'en'] as const) {
      const prepared = await prepare({ review: { language: 'ja' } }, region);
      expect(prepared.responseLanguage).toBe('ja');
      expect(prepared.reviewPrompt).toContain('日本語');
    }
  });

  it('ignores invalid language values and falls back to the region', async () => {
    const prepared = await prepare({ review: { language: 'fr' } }, 'cn');
    expect(prepared.responseLanguage).toBe('zh-CN');
  });
});
