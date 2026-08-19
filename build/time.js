/*
 * Stable entry point for service-day time resolution (api-contract.md §2).
 *
 * The implementation lives in build/lib/time.mjs; this is the path other lanes import.
 */

export {
	DEFAULT_TIME_ZONE,
	clockToSeconds,
	feedVersionToEpoch,
	secondsToClock,
	serviceClockToEpoch,
	serviceDayMidnight,
} from './lib/time.mjs';
