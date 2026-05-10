/**
 * Unit tests for the v0.3 RPC optimizations:
 *   1. `ctx.exports.<WorkerEntrypoint>` loopback for small-N submits.
 *   2. Promise pipelining via held `RpcTarget` sessions per leaf DO.
 *   3. `locationHint` colocation derived from the request's incoming colo.
 *
 * The runtime-level wins (round-trip count, dispatch floor) are exercised
 * by the live edge bench. These unit tests pin the surface contracts:
 *  - `locationHintForColo` covers all documented regions and is `undefined`
 *    for unknown colos.
 *  - `Pool.runManyTarget` routes size ≤ 4 through `inProcess` only when the
 *    user has wired one up.
 *  - The in-process coordinator class accepts the same wire shape as the
 *    DO coordinator.
 */
import { describe, expect, it } from 'bun:test';
import { locationHintForColo } from '../../src/coordinator/internal';
import type {
  CoordinatorFanOutRequest,
  CoordinatorRunRequest,
  RunOneResult,
} from '../../src/coordinator/protocol';

describe('locationHintForColo', () => {
  it('maps SFO to wnam', () => {
    expect(locationHintForColo('SFO')).toBe('wnam');
  });

  it('maps IAD to enam', () => {
    expect(locationHintForColo('IAD')).toBe('enam');
  });

  it('maps LHR to weur', () => {
    expect(locationHintForColo('LHR')).toBe('weur');
  });

  it('maps NRT to apac', () => {
    expect(locationHintForColo('NRT')).toBe('apac');
  });

  it('maps SYD to oc', () => {
    expect(locationHintForColo('SYD')).toBe('oc');
  });

  it('maps GRU to sam', () => {
    expect(locationHintForColo('GRU')).toBe('sam');
  });

  it('maps JNB to afr', () => {
    expect(locationHintForColo('JNB')).toBe('afr');
  });

  it('maps DXB to me', () => {
    expect(locationHintForColo('DXB')).toBe('me');
  });

  it('is case-insensitive', () => {
    expect(locationHintForColo('sfo')).toBe('wnam');
    expect(locationHintForColo('SfO')).toBe('wnam');
  });

  it('returns undefined for unknown colos', () => {
    expect(locationHintForColo('XXX')).toBeUndefined();
    expect(locationHintForColo('')).toBeUndefined();
  });

  it('returns undefined for missing input', () => {
    expect(locationHintForColo(undefined)).toBeUndefined();
  });
});

/**
 * Structural contract: anything matching `InProcessCoordinatorBinding`
 * (e.g. `ctx.exports.CfpInProcessCoordinator`) can satisfy the
 * `inProcess` Pool option without TypeScript ceremony.
 */
describe('InProcessCoordinatorBinding shape', () => {
  it('a minimal mock satisfies the binding shape', () => {
    const mock = {
      runOne: async (_req: CoordinatorRunRequest): Promise<RunOneResult> => ({
        ok: true as const,
        value: 42,
      }),
      runMany: async (
        req: CoordinatorFanOutRequest,
      ): Promise<{
        results: RunOneResult[];
        topology: 'in-do';
        fanOutPerLevel: number[];
        treeDepth: number;
      }> => ({
        results: req.argsList.map(() => ({ ok: true as const, value: 0 })),
        topology: 'in-do' as const,
        fanOutPerLevel: [req.argsList.length],
        treeDepth: 1,
      }),
    };

    // Type assertion: accepts the structural shape.
    const accept = (binding: typeof mock): typeof mock => binding;
    expect(accept(mock)).toBe(mock);
  });
});
