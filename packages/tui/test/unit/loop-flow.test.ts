import { describe, expect, it, vi } from 'vitest';

import {
  TuiLoopFlow,
  TUI_LOOP_MAX_ITERATIONS,
} from '../../src/tui/controller/product/loop-flow.js';
import type { TuiMessage } from '../../src/runtime/stream-events.js';
import type { TuiRuntimeEvent } from '../../src/types/runtime-events.js';

interface SubmitCall {
  content: string;
  options?: { reviewRequest?: { scope: string }; displayContent?: string };
}

function createHarness(messages: TuiMessage[] = []) {
  const submits: SubmitCall[] = [];
  const appended: Array<{ content: string; kind?: string }> = [];
  let session: { sessionId: string } | undefined = { sessionId: 'session-1' };
  let activeTurnId: string | undefined;
  const controller = {
    snapshot: () => ({
      session,
      status: 'idle' as const,
      activeTurnId,
    }),
    submit: vi.fn(async (content: string, options?: SubmitCall['options']) => {
      submits.push({ content, options });
      return 'succeeded' as const;
    }),
  };
  const runtime = {
    getMessages: vi.fn(async (_sessionId: string) => messages),
  };
  const flow = new TuiLoopFlow({
    controller: controller as never,
    runtime,
    append: (content, kind) => appended.push({ content, kind }),
    onChanged: () => undefined,
  });
  const finish = (sessionId = 'session-1'): TuiRuntimeEvent =>
    ({ type: 'session.finish', sessionId, turnId: 'turn-x' }) as TuiRuntimeEvent;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    flow,
    submits,
    appended,
    runtime,
    finish,
    flush,
    setSession(value: typeof session) {
      session = value;
    },
    setActiveTurn(value: string | undefined) {
      activeTurnId = value;
    },
  };
}

const needsChangesMessage = (content: string): TuiMessage =>
  ({
    role: 'assistant',
    content,
    origin: { reviewOutcome: 'needs_changes' },
  }) as TuiMessage;

const passMessage = (): TuiMessage =>
  ({ role: 'assistant', content: 'looks good', origin: { reviewOutcome: 'pass' } }) as TuiMessage;

const FINDINGS_XML = `<annotation-result version="2" source="code-review" review-run-id="r1" trigger="slash" mode="inline" verdict="needs-changes">
<summary>One issue found.</summary>
<annotations>
<annotation id="a1" kind="code-review" priority="P1">
<target type="line-range" path="src/app.ts" side="new" start-line="4" end-line="4"/>
<title>Null deref</title><content>Guard the value.</content>
</annotation>
</annotations>
</annotation-result>`;

describe('TuiLoopFlow', () => {
  it('submits the task, then a review request on work finish', async () => {
    const { flow, submits, finish, flush } = createHarness([passMessage()]);
    await flow.start('implement the widget');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.content).toBe('implement the widget');
    expect(submits[0]?.options?.reviewRequest).toBeUndefined();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits).toHaveLength(2);
    expect(submits[1]?.options?.reviewRequest).toEqual({ scope: 'local_changes' });
    expect(submits[1]?.options?.displayContent).toBe('/review');
  });

  it('stops after a passing review and reports the cycle count', async () => {
    const { flow, submits, appended, finish, flush } = createHarness([passMessage()]);
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(flow.isActive()).toBe(false);
    expect(appended.some((a) => a.content.includes('review passed'))).toBe(true);
    expect(submits).toHaveLength(2);
  });

  it('sends findings back for fixes on needs_changes, then reviews again', async () => {
    const messages = [needsChangesMessage(FINDINGS_XML)];
    const { flow, submits, runtime, finish, flush } = createHarness(messages);
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits[1]?.options?.reviewRequest).toBeDefined();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits).toHaveLength(3);
    expect(submits[2]?.content).toContain('review-findings');
    expect(submits[2]?.content).toContain('Null deref');
    expect(submits[2]?.options?.reviewRequest).toBeUndefined();
    // Fix turn completes → another review fires.
    runtime.getMessages.mockResolvedValue([passMessage()]);
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits[3]?.options?.reviewRequest).toBeDefined();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(flow.isActive()).toBe(false);
    expect(submits).toHaveLength(4);
  });

  it('falls back to raw review text when the result does not parse', async () => {
    const { flow, submits, finish, flush } = createHarness([
      needsChangesMessage('plain findings text'),
    ]);
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits[2]?.content).toContain('plain findings text');
  });

  it('stops on a failed review outcome', async () => {
    const { flow, appended, finish, flush } = createHarness([
      { role: 'assistant', content: '', origin: { reviewOutcome: 'failed' } } as TuiMessage,
    ]);
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(flow.isActive()).toBe(false);
    expect(appended.some((a) => a.kind === 'warning' && a.content.includes('invalid'))).toBe(true);
  });

  it('stops when the review produced no structured outcome', async () => {
    const { flow, appended, finish, flush } = createHarness([
      { role: 'assistant', content: 'some reply' } as TuiMessage,
    ]);
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(flow.isActive()).toBe(false);
    expect(appended.some((a) => a.content.includes('without a structured result'))).toBe(true);
  });

  it('stops on session.error and session.abort', async () => {
    const { flow, finish, flush } = createHarness();
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    flow.handleSettledRuntimeEvent({
      type: 'session.error',
      sessionId: 'session-1',
      turnId: 'turn-x',
    } as TuiRuntimeEvent);
    expect(flow.isActive()).toBe(false);

    await flow.start('task');
    flow.handleSettledRuntimeEvent({
      type: 'session.abort',
      sessionId: 'session-1',
      turnId: 'turn-y',
    } as TuiRuntimeEvent);
    expect(flow.isActive()).toBe(false);
  });

  it('stops after reaching the iteration cap', async () => {
    const { flow, appended, finish, flush } = createHarness([
      needsChangesMessage('still broken'),
    ]);
    await flow.start('task');
    // Each review cycle takes two finishes: work→review-submit, review→advance.
    for (let i = 0; i < TUI_LOOP_MAX_ITERATIONS * 2 + 2; i += 1) {
      flow.handleSettledRuntimeEvent(finish());
      await flush();
    }
    expect(flow.isActive()).toBe(false);
    expect(
      appended.some((a) => a.content.includes(String(TUI_LOOP_MAX_ITERATIONS))),
    ).toBe(true);
  });

  it('ignores terminal events from other sessions', async () => {
    const { flow, submits, finish, flush } = createHarness();
    await flow.start('task');
    flow.handleSettledRuntimeEvent(finish('other-session'));
    await flush();
    expect(submits).toHaveLength(1);
    expect(flow.isActive()).toBe(true);
  });

  it('refuses to start while a turn is running or a loop is active', async () => {
    const { flow, submits, appended, setActiveTurn } = createHarness();
    setActiveTurn('turn-live');
    await flow.start('task');
    expect(submits).toHaveLength(0);
    expect(appended.at(-1)?.kind).toBe('warning');
    setActiveTurn(undefined);
    await flow.start('task');
    await flow.start('another');
    expect(submits).toHaveLength(1);
    expect(appended.at(-1)?.kind).toBe('warning');
  });

  it('stop() clears the loop so later finishes are ignored', async () => {
    const { flow, submits, finish, flush } = createHarness();
    await flow.start('task');
    flow.stop();
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(submits).toHaveLength(1);
  });

  it('stops the loop if the next submission fails', async () => {
    const { flow, appended, finish, flush } = createHarness();
    const controller = (flow as unknown as { options: { controller: { submit: unknown } } });
    await flow.start('task');
    // Force the next submit to reject.
    const submitMock = controller.options.controller.submit as ReturnType<typeof vi.fn>;
    submitMock.mockRejectedValueOnce(new Error('turn rejected'));
    flow.handleSettledRuntimeEvent(finish());
    await flush();
    expect(flow.isActive()).toBe(false);
    expect(appended.some((a) => a.content.includes('turn rejected'))).toBe(true);
  });
});
