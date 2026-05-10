/**
 * Separate exports path for testing fakes. Production bundles do NOT import
 * this module; tree-shaking keeps fakes out of deployed Workers.
 *
 * Use:
 *   import { Parallel } from 'cloudflare-parallel/testing';
 *   const fake = Parallel.testing.poolFake({ bindings: { KV: kvStub } });
 */

export { Parallel } from './api/parallel.js';
export { poolFake, loaderOnlyFake, actorFake, schedulerFake, vmFake } from './api/testing.js';
