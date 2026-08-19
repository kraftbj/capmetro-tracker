/**
 * Silent failures 3 and 5, on the build side of the split.
 *
 * The build job and the runtime job resolve the same GTFS clock strings and
 * must agree exactly. A one-hour disagreement on a DST day puts a wrong number
 * on every row with nothing in any log.
 *
 * Expected epochs come from the fixtures, computed against the IANA database,
 * so the test and the implementation cannot agree on the same bug.
 */
import { describe, expect, it } from 'vitest'
import { gate, optionalModule } from './helpers/optional.mjs'
import { synthetic } from './helpers/fixtures.mjs'

const time = await optionalModule('build/lib/time.mjs')
const tClock = gate(time, ['secondsToClock'], it)
const tEpoch = gate(time, ['serviceClockToEpoch'], it)

const spring = synthetic('dst-spring-forward-20260308.json')
const fall = synthetic('dst-fall-back-20261101.json')
const afterMidnight = synthetic('after-midnight-tripupdate.json')

describe('a clock hour past 23 survives the round trip instead of wrapping at midnight', () => {
  tClock('renders 90600 seconds as 25:10:00 rather than 01:10:00', (_m, fn) => {
    expect(fn('secondsToClock')(25 * 3600 + 10 * 60)).toBe('25:10:00')
  })

  tClock('renders the exact midnight boundary as 24:00:00', (_m, fn) => {
    expect(fn('secondsToClock')(24 * 3600)).toBe('24:00:00')
  })

  tClock('keeps the ordinary times untouched', (_m, fn) => {
    expect(fn('secondsToClock')(9 * 3600 + 33 * 60)).toBe('09:33:00')
    expect(fn('secondsToClock')(0)).toBe('00:00:00')
  })

  tClock('round-trips every after-midnight time the schedule can contain', (_m, fn) => {
    for (const clock of ['24:00:00', '25:10:00', '27:59:59', '28:29:00']) {
      const [h, m, s] = clock.split(':').map(Number)
      expect(fn('secondsToClock')(h * 3600 + m * 60 + s)).toBe(clock)
    }
  })
})

describe('the shard build stamps the GTFS publication with a real instant', () => {
  const tFeed = gate(time, ['feedVersionToEpoch'], it)

  tFeed('reads 260818_1456 as 2026-08-18 14:56 in Austin, which is what schedule_age_days counts from', (_m, fn) => {
    const epoch = fn('feedVersionToEpoch')('260818_1456')
    expect(typeof epoch).toBe('number')
    const local = new Date(epoch * 1000).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    })
    expect(local).toContain('08/18/2026')
    expect(local).toContain('14:56')
  })

  tFeed('refuses a malformed feed version rather than stamping the epoch', (_m, fn) => {
    for (const bad of ['', 'latest', '260818']) {
      const out = fn('feedVersionToEpoch')(bad)
      expect(out === null || out === undefined || Number.isNaN(out), `"${bad}" produced ${out}`).toBe(true)
    }
  })
})

/*
 * The build job resolves clock strings to epochs through the shard emitter
 * rather than a named export, so these bind only once one exists. The same
 * arithmetic is covered end to end on the runtime side by
 * tests/php/ServiceClockTest.php, which runs today.
 */
describe('a service-day clock resolves to the same instant the runtime job computes', () => {
  tEpoch('resolves 25:10:00 on 2026-08-19 to 1:10am the next morning', (_m, fn) => {
    expect(fn('serviceClockToEpoch')('20260819', '25:10:00')).toBe(afterMidnight._expected.start_epoch)
  })

  for (const c of spring.cases) {
    tEpoch(`resolves ${c.clock} on the spring-forward date to ${c.expected_local_iso}`, (_m, fn) => {
      expect(fn('serviceClockToEpoch')('20260308', c.clock)).toBe(c.expected_epoch)
    })
  }

  for (const c of fall.cases) {
    tEpoch(`resolves ${c.clock} on the fall-back date to ${c.expected_local_iso}`, (_m, fn) => {
      expect(fn('serviceClockToEpoch')('20261101', c.clock)).toBe(c.expected_epoch)
    })
  }
})

describe('the two DST fixtures describe genuinely irregular days', () => {
  it('gives the spring-forward day a 23-hour anchor that is not local midnight', () => {
    expect(spring.service_day_midnight_epoch).not.toBe(spring.local_midnight_epoch)
    expect(spring.local_midnight_epoch - spring.service_day_midnight_epoch).toBe(3600)
  })

  it('gives the fall-back day a 25-hour anchor that is not local midnight', () => {
    expect(fall.service_day_midnight_epoch).not.toBe(fall.local_midnight_epoch)
    expect(fall.service_day_midnight_epoch - fall.local_midnight_epoch).toBe(3600)
  })

  it('puts two different clock strings on the same repeated wall-clock hour', () => {
    const at = (clock) => fall.cases.find((c) => c.clock === clock)
    expect(at('00:30:00').expected_local_iso).toContain('T01:30:00')
    expect(at('01:30:00').expected_local_iso).toContain('T01:30:00')
    expect(at('01:30:00').expected_epoch - at('00:30:00').expected_epoch).toBe(3600)
  })
})
