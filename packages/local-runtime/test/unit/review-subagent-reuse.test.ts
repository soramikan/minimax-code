import { describe, expect, it, vi } from 'vitest';

import { HostedReviewCapability } from '../../src/review/hosted-capability.js';
import type { PreparedReviewRead } from '../../src/review/prompt-preparation.js';

const ANNOTATION_RESULT = `<annotation-result version="2" source="code-review" review-run-id="r1" trigger="slash" mode="subagent" verdict="needs-changes">
<summary>ok</summary>
<annotations>
<annotation id="a1" kind="code-review" priority="P2">
<target type="file" path="a.ts"/>
<title>t</title><content>c</content>
</annotation>
</annotations>
</annotation-result>`;

const PARENT = {
  sessionId: 'parent-1',
  agentName: 'code',
  workspaceDir: '/repo',
  runLocation: 'local',
  appMode: 'coding',
  effectiveModel: 'model-a',
} as never;

const PREPARED = {
  prepared: {
    mode: 'subagent',
    request: 'review the diff',
    displayPrompt: '/review',
    reviewPrompt: 'reviewer system prompt',
    responseLanguage: 'en',
    context: {
      reviewRunId: 'run-1',
      responseLanguage: 'en',
      revisionStatus: { status: 'ok' },
      changedFiles: new Map(),
      warnings: [],
    },
  },
} as unknown as PreparedReviewRead;

function reviewChild(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'child-1',
    agentName: 'code',
    workspaceDir: '/repo',
    sessionType: 'branch',
    visibility: 'hidden',
    purpose: 'code-review:run-0',
    updatedAtMs: 1,
    ...overrides,
  };
}

function createHarness(children: Array<ReturnType<typeof reviewChild>> = []) {
  const listSessions = vi.fn(async () => children);
  const createSession = vi.fn(async () => reviewChild({ sessionId: 'child-new' }));
  const submitted: Array<Record<string, unknown>> = [];
  const submit = vi.fn(async (input: Record<string, unknown>) => {
    submitted.push(input);
    return {
      turnId: (input.requestedTurnId as string) ?? 'turn-1',
      completion: Promise.resolve({
        status: 'completed' as const,
        messages: [{ role: 'assistant', text: ANNOTATION_RESULT }],
      }),
    };
  });
  const capability = new HostedReviewCapability({
    reviewPromptDir: '/unused',
    configGetter: () => ({}) as never,
    conversation: {
      query: { listSessions },
      lifecycle: { createSession },
      ingress: { submit },
    } as never,
  });
  const executeSubagent = (
    capability as unknown as {
      executeSubagent(
        parent: unknown,
        preparedRead: PreparedReviewRead,
      ): Promise<{ status: string; finalText?: string }>;
    }
  ).executeSubagent.bind(capability);
  return { executeSubagent, listSessions, createSession, submit, submitted };
}

describe('HostedReviewCapability review-session reuse', () => {
  it('creates a hidden reviewer session when none exists', async () => {
    const { executeSubagent, listSessions, createSession, submitted } = createHarness([]);
    const result = await executeSubagent(PARENT, PREPARED);
    expect(result.status).toBe('succeeded');
    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-1',
        includeHidden: true,
        includePurposePrefix: 'code-review:',
      }),
    );
    expect(createSession).toHaveBeenCalledOnce();
    expect(submitted[0]?.sessionId).toBe('child-new');
  });

  it('reuses the newest existing code-review child instead of creating one', async () => {
    const { executeSubagent, createSession, submitted } = createHarness([
      reviewChild({ sessionId: 'child-old', updatedAtMs: 1 }),
      reviewChild({ sessionId: 'child-newest', updatedAtMs: 9 }),
      reviewChild({ sessionId: 'child-mid', updatedAtMs: 5 }),
    ]);
    const result = await executeSubagent(PARENT, PREPARED);
    expect(result.status).toBe('succeeded');
    expect(createSession).not.toHaveBeenCalled();
    expect(submitted[0]?.sessionId).toBe('child-newest');
  });

  it('keeps the code_review origin on reused sessions so each turn activates review', async () => {
    const { executeSubagent, submitted } = createHarness([reviewChild()]);
    await executeSubagent(PARENT, PREPARED);
    const message = submitted[0]?.message as Record<string, unknown> | undefined;
    expect(
      (message?.origin as Record<string, unknown> | undefined)?.review,
    ).toMatchObject({ trigger: 'subagent', scope: 'local_changes' });
    expect(submitted[0]?.source).toBe('code_review');
  });

  it('falls back to creating a session when listing fails', async () => {
    const { executeSubagent, listSessions, createSession, submitted } = createHarness();
    listSessions.mockRejectedValueOnce(new Error('store down'));
    const result = await executeSubagent(PARENT, PREPARED);
    expect(result.status).toBe('succeeded');
    expect(createSession).toHaveBeenCalledOnce();
    expect(submitted[0]?.sessionId).toBe('child-new');
  });
});
