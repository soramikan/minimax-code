import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { classifyLLMErrorToCode, LLM_ERROR_CODES } from '@mavis/shared/llm-error-classifier';

const BYOK_ERROR_PREFIX = 'BYOK upstream error';
const MAX_ERROR_MESSAGE_LENGTH = 1_200;

export function withByokErrorAttribution(input: {
  readonly streamFn?: StreamFn;
  readonly providerId: string;
}): StreamFn {
  const base = input.streamFn ?? streamSimple;
  return (async (model, context, options) => {
    try {
      const stream = await base(model, context, options);
      return wrapStream(stream, input.providerId, options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new Error(formatByokErrorMessage(error, input.providerId));
    }
  }) as StreamFn;
}

function formatByokErrorMessage(raw: unknown, providerId: string): string {
  const rawMessage = errorText(raw);
  if (rawMessage.startsWith(BYOK_ERROR_PREFIX)) return rawMessage;
  const classified = classifyLLMErrorToCode(raw);
  const detail = redactByokErrorMessage(
    (classified?.message ?? rawMessage) || 'LLM provider request failed',
  );
  return `${BYOK_ERROR_PREFIX}: ${JSON.stringify({
    errorCode: classified?.status_code ?? LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
    message: `BYOK provider ${providerId} upstream error: ${detail}`,
    errorSource: 'byok_upstream',
    errorDetail: detail,
    errorProviderId: providerId,
  })}`;
}

function redactByokErrorMessage(message: string): string {
  return message
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-***')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, '$1***')
    .replace(/((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s"',}]+/giu, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, '$1***');
}

function wrapStream(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const wrapped: AssistantMessageEventStream = Object.create(stream);
  Object.defineProperty(wrapped, Symbol.asyncIterator, {
    value: () => attributedEvents(stream, providerId, signal),
  });
  Object.defineProperty(wrapped, 'result', {
    value: () => attributedResult(stream, providerId, signal),
  });
  return wrapped;
}

async function* attributedEvents(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<AssistantMessageEvent> {
  try {
    for await (const event of stream) {
      yield attributeEvent(event, providerId);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(formatByokErrorMessage(error, providerId));
  }
}

async function attributedResult(
  stream: AssistantMessageEventStream,
  providerId: string,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  try {
    return attributeMessage(await stream.result(), providerId);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(formatByokErrorMessage(error, providerId));
  }
}

function attributeEvent(event: AssistantMessageEvent, providerId: string): AssistantMessageEvent {
  return event.type === 'error' && event.reason === 'error'
    ? { ...event, error: attributeMessage(event.error, providerId) }
    : event;
}

function attributeMessage(message: AssistantMessage, providerId: string): AssistantMessage {
  return message.stopReason === 'error' && message.errorMessage
    ? {
        ...message,
        errorMessage: formatByokErrorMessage(message.errorMessage, providerId),
      }
    : message;
}

function errorText(raw: unknown): string {
  if (raw instanceof Error) return raw.message;
  return typeof raw === 'string' ? raw : '';
}

export interface ByokErrorAttribution {
  /** Human-readable upstream detail message (`BYOK provider <id> upstream error: <detail>`). */
  readonly message: string;
  /** Classified code carried by the structured payload, when present. */
  readonly errorCode?: number;
  readonly errorSource: 'byok_upstream';
  /** Sanitized upstream detail (tokens/keys redacted at format time). */
  readonly errorDetail: string;
  readonly errorProviderId: string;
}

/**
 * Read back what {@link formatByokErrorMessage} embedded. Handles both the
 * structured `BYOK upstream error: {json}` form and the legacy
 * `BYOK provider <id> upstream error: <detail>` form so older persisted
 * errors still attribute correctly.
 */
export function parseByokErrorAttribution(
  rawMessage: string | undefined,
): ByokErrorAttribution | undefined {
  if (!rawMessage) return undefined;
  if (rawMessage.startsWith(BYOK_ERROR_PREFIX)) {
    const start = rawMessage.indexOf('{');
    if (start >= 0) {
      try {
        const attributed = normalizeStructuredPayload(
          JSON.parse(rawMessage.slice(start)) as Record<string, unknown>,
          rawMessage,
        );
        if (attributed) return attributed;
      } catch {
        // Fall through to the legacy shape below.
      }
    }
  }
  const legacy = parseLegacyMessage(rawMessage);
  return legacy
    ? {
        message: rawMessage,
        errorSource: 'byok_upstream',
        errorDetail: legacy.detail,
        errorProviderId: legacy.providerId,
      }
    : undefined;
}

function normalizeStructuredPayload(
  payload: Readonly<Record<string, unknown>>,
  rawMessage: string,
): ByokErrorAttribution | undefined {
  const message = readPayloadString(payload, 'message') ?? rawMessage;
  const legacy = parseLegacyMessage(message);
  const errorProviderId = readPayloadString(payload, 'errorProviderId') ?? legacy?.providerId;
  const errorDetail = readPayloadString(payload, 'errorDetail') ?? legacy?.detail;
  if (!errorProviderId || !errorDetail) return undefined;
  return {
    message,
    ...(typeof payload.errorCode === 'number' ? { errorCode: payload.errorCode } : {}),
    errorSource: 'byok_upstream',
    errorDetail,
    errorProviderId,
  };
}

function parseLegacyMessage(
  message: string,
): { readonly providerId: string; readonly detail: string } | undefined {
  const match = /^BYOK provider (?<providerId>.+?) upstream error: (?<detail>[\s\S]*)$/u.exec(
    message,
  );
  const providerId = match?.groups?.providerId?.trim();
  const detail = match?.groups?.detail?.trim();
  return providerId && detail ? { providerId, detail } : undefined;
}

function readPayloadString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
