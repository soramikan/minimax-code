import { describe, expect, it } from 'vitest';

import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';
import type { GlobalEventInput } from '@mavis/shared/global-events';

import { createSessionTurnLifecycleEvents } from './turn-lifecycle-event-observer.js';

const CONTEXT = { sessionId: 'sess_1', turnId: 'turn_1', turnSequence: 1 };

function harness() {
  const published: GlobalEventInput[] = [];
  const observer = createSessionTurnLifecycleEvents(
    {
      get: async () =>
        ({
          agentName: 'agent',
          memoryPolicy: { writeEnabled: false },
        }) as never,
    },
    (event) => published.push(event),
    undefined,
  );
  return { observer, published };
}

function failedEvent(error: { code: number; message: string }): RuntimeEvent {
  return {
    type: RuntimeEventType.SESSION_STATUS,
    payload: {
      status: RuntimeEventStatus.FAILED,
      error,
    },
  } as RuntimeEvent;
}

const STRUCTURED_BYOK =
  'BYOK upstream error: {"errorCode":50113,"message":"BYOK provider custom_provider:openai-codex upstream error: WebSocket closed 1012","errorSource":"byok_upstream","errorDetail":"WebSocket closed 1012","errorProviderId":"custom_provider:openai-codex"}';

describe('SessionTurnLifecycleEventObserver', () => {
  it('attributes structured BYOK upstream failures to the provider', async () => {
    const { observer, published } = harness();
    await observer.observeRuntimeEvent?.({
      context: CONTEXT,
      event: failedEvent({ code: 50113, message: STRUCTURED_BYOK }),
    });
    const error = published.find((event) => event.type === 'session.error');
    expect(error?.payload).toMatchObject({
      status: 'error',
      error: 'BYOK provider custom_provider:openai-codex upstream error: WebSocket closed 1012',
      errorCode: 50113,
      errorSource: 'byok_upstream',
      errorDetail: 'WebSocket closed 1012',
      errorProviderId: 'custom_provider:openai-codex',
    });
  });

  it('attributes legacy BYOK messages without a structured payload', async () => {
    const { observer, published } = harness();
    await observer.observeRuntimeEvent?.({
      context: CONTEXT,
      event: failedEvent({
        code: 50113,
        message: 'BYOK provider custom_provider:openai-codex upstream error: terminated',
      }),
    });
    const error = published.find((event) => event.type === 'session.error');
    expect(error?.payload).toMatchObject({
      errorSource: 'byok_upstream',
      errorDetail: 'terminated',
      errorProviderId: 'custom_provider:openai-codex',
    });
  });

  it('keeps agent-runtime attribution and details for non-BYOK failures', async () => {
    const { observer, published } = harness();
    await observer.observeRuntimeEvent?.({
      context: CONTEXT,
      event: {
        type: RuntimeEventType.SESSION_STATUS,
        payload: {
          status: RuntimeEventStatus.FAILED,
          error: { code: 500, message: 'internal failure', details: 'stack hint' },
        },
      } as RuntimeEvent,
    });
    const error = published.find((event) => event.type === 'session.error');
    expect(error?.payload).toMatchObject({
      error: 'internal failure',
      errorCode: 500,
      errorSource: 'agent-runtime',
      errorDetail: 'stack hint',
    });
    expect(error?.payload).not.toHaveProperty('errorProviderId');
  });
});
