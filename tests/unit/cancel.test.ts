import { describe, expect, it } from 'bun:test';
import { CancelToken } from '../../src/api/cancel';
import { CancelledError } from '../../src/errors/index';

describe('CancelToken', () => {
  it('starts not cancelled', () => {
    const t = new CancelToken();
    expect(t.isCancelled).toBe(false);
    expect(t.poll().cancelled).toBe(false);
  });

  it('signals once on cancel', () => {
    const t = new CancelToken();
    let count = 0;
    t.onCancel(() => count++);
    t.cancel('reason');
    t.cancel('reason'); // idempotent
    expect(count).toBe(1);
    expect(t.isCancelled).toBe(true);
    expect(t.poll().reason).toBe('reason');
  });

  it('cancelled promise rejects with CancelledError', async () => {
    const t = new CancelToken();
    setTimeout(() => t.cancel('test'), 5);
    let caught: unknown;
    try {
      await t.cancelled;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CancelledError);
    expect((caught as CancelledError).reason).toBe('test');
  });

  it('child token is cancelled when parent is', () => {
    const parent = new CancelToken();
    const child = parent.child();
    parent.cancel('parent-reason');
    expect(child.isCancelled).toBe(true);
    expect(child.poll().reason).toBe('parent-reason');
  });

  it('child created after parent cancel is already cancelled', () => {
    const parent = new CancelToken();
    parent.cancel('x');
    const child = parent.child();
    expect(child.isCancelled).toBe(true);
  });

  it('fromAbortSignal adapts an AbortSignal', () => {
    const ac = new AbortController();
    const t = CancelToken.fromAbortSignal(ac.signal);
    expect(t.isCancelled).toBe(false);
    ac.abort('aborted');
    // Listener fires synchronously.
    expect(t.isCancelled).toBe(true);
  });

  it('withTimeout cancels after the delay', async () => {
    const t = CancelToken.withTimeout(10);
    await new Promise((r) => setTimeout(r, 25));
    expect(t.isCancelled).toBe(true);
  });

  it('signal is a real Web AbortSignal', () => {
    const t = new CancelToken();
    expect(t.signal).toBeInstanceOf(AbortSignal);
    t.cancel('go');
    expect(t.signal.aborted).toBe(true);
  });

  it('signal.throwIfAborted() throws a CancelledError', () => {
    const t = new CancelToken();
    t.cancel('boom');
    expect(() => t.signal.throwIfAborted()).toThrow();
  });
});
