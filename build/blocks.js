/*
 * Stable entry point for block continuation grading (api-contract.md §4).
 *
 * `blockConfidence` is the rule as a pure function over one predecessor/successor pair;
 * `buildBlockChains` is what the build job runs over the whole feed.
 */

export { blockConfidence, buildBlockChains, continuationReasons } from './lib/blocks.mjs';
