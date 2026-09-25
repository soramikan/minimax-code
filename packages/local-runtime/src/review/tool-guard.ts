import type { PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';

import { pickReviewLanguageText } from './localized-text.js';
import type { ReviewTurnState } from './turn-state.js';

// Bash retains ordinary permission checks; Review adds no argument policy.
const REVIEW_ALLOWED_TOOLS = new Set(['read', 'grep', 'glob', 'skill', 'bash']);
// Native controls enforce session ownership in the task service. Review must
// retain them when an allowed Bash call runs in the background.
const REVIEW_TASK_CONTROLS = new Set(['task_query', 'task_output', 'task_stop']);

export function createReviewToolGuard(state: ReviewTurnState): {
  beforeToolCall: PiBeforeToolCallHook;
} {
  return {
    beforeToolCall(toolContext) {
      if (!state.isReviewActivated()) return undefined;

      const toolName = toolContext.toolCall.name;
      if (toolName === 'code_review') {
        return {
          block: true,
          reason: buildRepeatedCodeReviewReason(state.prepared),
        };
      }
      if (toolName === 'skill' && readSkillName(toolContext.args) === 'code-review') {
        return {
          block: true,
          reason: buildRepeatedCodeReviewSkillReason(state.prepared),
        };
      }
      const source = readToolSource(toolContext.toolCall);
      if (source !== 'configured' && REVIEW_ALLOWED_TOOLS.has(toolName)) return undefined;
      if ((source === undefined || source === 'builtin') && REVIEW_TASK_CONTROLS.has(toolName)) {
        return undefined;
      }

      return {
        block: true,
        reason: `Code Review tool policy denied "${toolName}".`,
      };
    },
  };
}

function readSkillName(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const name = (input as { name?: unknown }).name;
  return typeof name === 'string' ? name.trim().toLowerCase() : undefined;
}

function buildRepeatedCodeReviewSkillReason(prepared: ReviewTurnState['prepared']): string {
  return pickReviewLanguageText(prepared?.responseLanguage ?? 'en', {
    'zh-CN':
      '当前结构化 Review 已经激活，不要再读取 code-review Skill；请使用允许的只读工具继续审查。',
    ja: '構造化 Review はすでに有効です。code-review Skill を再度読み込まないでください。許可された読み取り専用ツールでレビューを続けてください。',
    en: 'Structured Review is already active. Do not load the code-review Skill; continue with the allowed read-only tools.',
  });
}

function buildRepeatedCodeReviewReason(prepared: ReviewTurnState['prepared']): string {
  const isSlash = prepared?.trigger === 'slash';
  return pickReviewLanguageText(prepared?.responseLanguage ?? 'en', {
    'zh-CN': isSlash
      ? '当前 Review 已由 Slash 请求激活，不能再次调用 code_review。请直接使用允许的只读工具检查当前改动，并返回 Review 结果。'
      : '当前 Turn 的 Review 已经激活，不能再次调用 code_review。请直接使用允许的只读工具继续检查，并返回 Review 结果。',
    ja: isSlash
      ? 'この Slash リクエストの Review はすでに有効です。code_review を再度呼び出さないでください。許可された読み取り専用ツールで現在の変更を直接確認し、Review 結果を返してください。'
      : 'この Turn の Review はすでに有効です。code_review を再度呼び出さないでください。許可された読み取り専用ツールで確認を続け、Review 結果を直接返してください。',
    en: isSlash
      ? 'Code Review is already active for this Slash request. Do not call code_review again. Inspect the current changes with the allowed read-only tools and return the Review result directly.'
      : 'Code Review is already active for this turn. Do not call code_review again. Continue with the allowed read-only tools and return the Review result directly.',
  });
}

function readToolSource(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  return (toolCall as { source?: unknown }).source;
}
