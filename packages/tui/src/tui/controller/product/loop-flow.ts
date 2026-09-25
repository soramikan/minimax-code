import type { TuiMessage, TuiRuntimeEvent } from '../../../runtime/port.js';
import type { TuiChatController } from '../chat-controller.js';
import type { TuiSubmitOptions } from '../chat-controller-types.js';
import {
  parseTuiReviewResult,
  renderReviewResultText,
  reviewOutcomeFromOrigin,
} from '../../../review/result.js';

/** Same transport text the `/review` command submits; the reviewRequest flag routes it into Review preparation. */
const LOOP_REVIEW_PROMPT = 'Please review my uncommitted changes.';
/** Review cycles the loop allows before giving up, counting the first review as iteration 1. */
export const TUI_LOOP_MAX_ITERATIONS = 10;

export type TuiLoopPhase = 'work' | 'review';

interface TuiLoopState {
  sessionId?: string;
  iteration: number;
  phase: TuiLoopPhase;
  /** Id of the review-result message already consumed; older outcomes must not retrigger fixes. */
  lastReviewMessageId?: string;
}

export interface TuiLoopFlowOptions {
  readonly controller: Pick<TuiChatController, 'submit' | 'snapshot'>;
  readonly runtime: {
    getMessages(sessionId: string, limit?: number): Promise<TuiMessage[]>;
  };
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly onChanged: () => void;
}

/**
 * Drives `/loop <task>`: work → review → fix cycles on the current Session until
 * the built-in review passes or the iteration budget is exhausted. Submissions
 * are fire-and-forget — `controller.submit` only resolves when the Turn ends, so
 * awaiting it inside the settled-event path would stall later Runtime events.
 */
export class TuiLoopFlow {
  private state?: TuiLoopState;

  constructor(private readonly options: TuiLoopFlowOptions) {}

  isActive(): boolean {
    return this.state !== undefined;
  }

  statusText(): string {
    if (!this.state) {
      return 'No active loop. Usage: /loop <task> to start one; /loop stop cancels it.';
    }
    return `Loop active — ${this.state.phase === 'review' ? 'reviewing' : 'working'}, iteration ${String(this.state.iteration)} of ${String(TUI_LOOP_MAX_ITERATIONS)}.`;
  }

  async start(task: string): Promise<void> {
    if (this.state) {
      this.options.append(
        'A loop is already running on this Session. Use /loop stop to cancel it first.',
        'warning',
      );
      return;
    }
    const snapshot = this.options.controller.snapshot();
    if (snapshot.activeTurnId || snapshot.status === 'running' || snapshot.status === 'starting') {
      this.options.append(
        'A turn is already running. Wait for it to finish before starting /loop.',
        'warning',
      );
      return;
    }
    this.state = { sessionId: snapshot.session?.sessionId, iteration: 0, phase: 'work' };
    this.options.append(
      `Loop started — the task runs, then /review repeats until it passes (max ${String(TUI_LOOP_MAX_ITERATIONS)} cycles).`,
    );
    this.submitLoopTurn(task, {
      onSessionResolved: (sessionId) => {
        if (this.state) this.state.sessionId = sessionId;
      },
    });
  }

  stop(reason: 'manual' | 'silent' = 'manual'): void {
    if (!this.state) {
      if (reason === 'manual') this.options.append('No active loop to stop.', 'warning');
      return;
    }
    this.state = undefined;
    if (reason === 'manual') this.options.append('Loop stopped.');
    this.options.onChanged();
  }

  /** Invoked for settled `session.finish`/`session.error`/`session.abort` events on the current Session. */
  handleSettledRuntimeEvent(event: TuiRuntimeEvent): void {
    const state = this.state;
    if (!state) return;
    const sessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    if (sessionId && event.sessionId && event.sessionId !== sessionId) return;
    if (
      sessionId &&
      this.options.controller.snapshot().session?.sessionId !== sessionId
    ) {
      this.state = undefined;
      return;
    }
    if (event.type === 'session.abort' || event.type === 'session.error') {
      this.state = undefined;
      this.options.append('Loop stopped: the turn did not complete.', 'warning');
      this.options.onChanged();
      return;
    }
    if (event.type !== 'session.finish') return;
    if (state.phase === 'review') {
      state.phase = 'work';
      void this.advanceAfterReview(sessionId ?? event.sessionId ?? '', event.turnId);
      return;
    }
    state.phase = 'review';
    this.submitLoopTurn(LOOP_REVIEW_PROMPT, {
      reviewRequest: { scope: 'local_changes' },
      displayContent: '/review',
      onSessionResolved: (resolved) => {
        if (this.state) this.state.sessionId = resolved;
      },
    });
  }

  private async advanceAfterReview(sessionId: string, turnId?: string): Promise<void> {
    if (!this.state || !sessionId) return;
    let review: { outcome: string; content: string; messageId?: string } | undefined;
    try {
      const messages = await this.options.runtime.getMessages(sessionId);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const outcome = reviewOutcomeFromOrigin(message?.origin);
        if (!outcome) continue;
        // Skip outcomes from older turns and ones already consumed; nothing past
        // a consumed message can belong to the turn that just finished.
        if (message?.id && message.id === this.state.lastReviewMessageId) break;
        if (turnId && message?.turnId && message.turnId !== turnId) continue;
        review = { outcome, content: message?.content ?? '', messageId: message?.id };
        break;
      }
    } catch {
      review = undefined;
    }
    if (!this.state) return;
    if (!review) {
      this.state = undefined;
      this.options.append(
        'Loop stopped: the review finished without a structured result.',
        'warning',
      );
      this.options.onChanged();
      return;
    }
    if (review.messageId) this.state.lastReviewMessageId = review.messageId;
    if (review.outcome === 'failed') {
      this.state = undefined;
      this.options.append('Loop stopped: the review result was rejected as invalid.', 'warning');
      this.options.onChanged();
      return;
    }
    if (review.outcome === 'pass') {
      const iterations = this.state.iteration + 1;
      this.state = undefined;
      this.options.append(
        `Loop finished — code review passed after ${String(iterations)} review cycle${iterations === 1 ? '' : 's'}.`,
      );
      this.options.onChanged();
      return;
    }
    // needs_changes
    this.state.iteration += 1;
    if (this.state.iteration >= TUI_LOOP_MAX_ITERATIONS) {
      this.state = undefined;
      this.options.append(
        `Loop stopped after ${String(TUI_LOOP_MAX_ITERATIONS)} review cycles without a pass.`,
        'warning',
      );
      this.options.onChanged();
      return;
    }
    const parsed = parseTuiReviewResult(review.content);
    const findings = parsed ? renderReviewResultText(parsed) : review.content;
    const prompt = [
      'The latest code review of the current changes reported findings. Resolve every finding below, then stop.',
      '',
      '<review-findings>',
      findings,
      '</review-findings>',
    ].join('\n');
    this.submitLoopTurn(prompt, {
      displayContent: `Fix review findings · loop iteration ${String(this.state.iteration)}`,
    });
  }

  private submitLoopTurn(content: string, options: TuiSubmitOptions): void {
    void this.scheduleSubmit(content, options);
  }

  private async scheduleSubmit(content: string, options: TuiSubmitOptions): Promise<void> {
    // session.finish reaches this flow before the finished turn's submit()
    // resolves, so the controller still reports the old turn as active. Wait
    // briefly for it to unwind instead of racing the cleanup.
    for (let waitedMs = 0; this.state && waitedMs < 5_000; waitedMs += 50) {
      const snapshot = this.options.controller.snapshot();
      if (
        !snapshot.activeTurnId &&
        snapshot.status !== 'running' &&
        snapshot.status !== 'starting'
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.state) return;
    try {
      await this.options.controller.submit(content, options);
    } catch (error: unknown) {
      if (!this.state) return;
      this.state = undefined;
      this.options.append(
        `Loop stopped: could not submit the next step (${
          error instanceof Error ? error.message : String(error)
        }).`,
        'warning',
      );
      this.options.onChanged();
    }
  }
}
