/**
 * Re-export the library's Durable Object classes for users to register in
 * their Worker entrypoint:
 *
 *   import { CfpCoordinator, CfpWorkerDO, CfpSubCoord, CfpSchedulerDO }
 *     from 'cloudflare-parallel/durable-objects';
 *   export { CfpCoordinator, CfpWorkerDO, CfpSubCoord, CfpSchedulerDO };
 *
 * The matching `wrangler.toml` bindings live in MIGRATION.md (or use
 * `cloudflare-parallel doctor` to scaffold them).
 */

export { CfpCoordinator, CfpWorkerDO, CfpWorkerDOEntry, CfpSubCoord } from './coordinator/index.js';
export { CfpSchedulerDO } from './scheduler/index.js';
