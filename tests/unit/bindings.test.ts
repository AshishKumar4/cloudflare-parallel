import { describe, expect, test } from 'bun:test';
import { pickBindings } from '../../src/api/bindings';

describe('pickBindings', () => {
  test('narrows env to named keys', () => {
    const env = { AI: 'ai-stub', KV: 'kv-stub', SECRET: 'shh', R2: 'r2-stub' };
    const picked = pickBindings(env, ['AI', 'KV']);
    expect(picked).toEqual({ AI: 'ai-stub', KV: 'kv-stub' });
    expect('SECRET' in picked).toBe(false);
    expect('R2' in picked).toBe(false);
  });

  test('drops keys that are absent', () => {
    const env = { AI: 'ai' };
    const picked = pickBindings(env as { AI: string; MISSING?: string }, ['AI', 'MISSING']);
    expect(picked).toEqual({ AI: 'ai' });
    expect('MISSING' in picked).toBe(false);
  });

  test('handles empty / non-object env', () => {
    expect(pickBindings({} as Record<string, unknown>, ['x' as never])).toEqual({});
    expect(pickBindings(null as unknown as Record<string, unknown>, ['x' as never])).toEqual({});
    expect(pickBindings(undefined as unknown as Record<string, unknown>, ['x' as never])).toEqual(
      {},
    );
  });

  test('preserves type-level Pick', () => {
    interface Env {
      AI: { run: () => unknown };
      KV: { get: () => unknown };
      SECRET: string;
    }
    const env: Env = {
      AI: { run: () => null },
      KV: { get: () => null },
      SECRET: 'shh',
    };
    const picked: Pick<Env, 'AI' | 'KV'> = pickBindings(env, ['AI', 'KV']);
    expect(typeof picked.AI.run).toBe('function');
    expect(typeof picked.KV.get).toBe('function');
    // SECRET intentionally not in scope; type-level test.
  });
});
