/**
 * urls.js — the address bar as a grammar.
 *
 * Two things here are not cosmetic and are what these tests exist for.
 *
 * The API BASE is derived from the current path, never hardcoded to "/api/".
 * The client fetches relative to the page, so at /trip/1234 a relative fetch
 * resolves to /trip/api/route/4.json and 404s; and the e2e fixture server
 * serves the entire client under a scenario prefix, so an absolute /api/ would
 * break every existing browser test in this repo.
 *
 * The QUERY FORM stays first-class. The board must open from a file:// URL,
 * where paths mean nothing and the History API is unavailable, and the ?state=
 * harness is the only way to look at an interaction state. Every link that
 * worked before this file existed still works.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'

const client = loadClient(['urls.js'])
const t = gateClient(client, 'urls', it)

describe('the api base a page hangs its fetches off', () => {
  t('is the root when the board is served at the root', (urls) => {
    expect(urls.baseFor('/')).toBe('/')
    expect(urls.baseFor('/index.html')).toBe('/')
  })

  t('strips an app path rather than treating it as a directory', (urls) => {
    /* The bug this prevents: a relative fetch from /trip/1234 asks for
       /trip/api/route/4.json, which does not exist. */
    expect(urls.baseFor('/trip/1234')).toBe('/')
    expect(urls.baseFor('/route/4/eb')).toBe('/')
    expect(urls.baseFor('/buses')).toBe('/')
    expect(urls.baseFor('/saved')).toBe('/')
  })

  t('keeps a serving directory, which is how the e2e server works', (urls) => {
    /* tests/e2e/server.mjs serves the client under a scenario prefix. An
       absolute "/api/" base would break every browser test in this repo. */
    expect(urls.baseFor('/fresh/index.html')).toBe('/fresh/')
    expect(urls.baseFor('/fresh/')).toBe('/fresh/')
    expect(urls.baseFor('/fresh/trip/7/2641')).toBe('/fresh/')
    expect(urls.baseFor('/fresh/route/4/eb')).toBe('/fresh/')
  })
})

describe('what a url asks for', () => {
  const parse = (u, p = '') => u.parse(p, '')

  t('reads the board with a route and a direction', (urls) => {
    expect(parse(urls, '/route/4/eb')).toMatchObject({
      view: 'board', route_id: '4', direction: 'eb', bus_id: null,
    })
  })

  t('reads a route with no direction', (urls) => {
    expect(parse(urls, '/route/4')).toMatchObject({
      view: 'board', route_id: '4', direction: null,
    })
  })

  t('accepts every direction token the grammar names', (urls) => {
    for (const token of ['eb', 'wb', 'nb', 'sb', 'both', '0', '1']) {
      expect(parse(urls, `/route/7/${token}`).direction, token).toBe(token)
    }
  })

  t('ignores a direction token it does not recognise', (urls) => {
    /* Better a board on the saved direction than a board on nothing. */
    expect(parse(urls, '/route/4/sideways').direction).toBeNull()
    expect(parse(urls, '/route/4/sideways').route_id).toBe('4')
  })

  t('is case-insensitive about direction, since people type EB', (urls) => {
    expect(parse(urls, '/route/4/EB').direction).toBe('eb')
  })

  t('reads the two view-only paths', (urls) => {
    expect(parse(urls, '/buses').view).toBe('all')
    expect(parse(urls, '/saved').view).toBe('saved')
  })

  t('carries nothing but the tab name on /saved', (urls) => {
    /* Saved trips live in localStorage. A watch in a URL would publish
       somebody's routine to whoever they sent the link to. */
    const got = parse(urls, '/saved')
    expect(got.route_id).toBeNull()
    expect(got.bus_id).toBeNull()
    expect(got.direction).toBeNull()
  })

  t('reads a bare bus id and leaves the route for the caller', (urls) => {
    expect(parse(urls, '/trip/1234')).toMatchObject({
      view: 'trip', bus_id: '1234', route_id: null,
    })
  })

  t('reads a bus id qualified by its route', (urls) => {
    expect(parse(urls, '/trip/7/1234')).toMatchObject({
      view: 'trip', route_id: '7', bus_id: '1234',
    })
  })

  t('reads the trip view with no bus at all', (urls) => {
    expect(parse(urls, '/trip')).toMatchObject({ view: 'trip', bus_id: null })
  })

  t('says nothing about the view at the root', (urls) => {
    expect(parse(urls, '/')).toMatchObject({ view: null, route_id: null })
    expect(parse(urls, '/index.html').view).toBeNull()
  })

  t('reads an app path served from a subdirectory', (urls) => {
    expect(parse(urls, '/fresh/trip/7/2641')).toMatchObject({
      base: '/fresh/', view: 'trip', route_id: '7', bus_id: '2641',
    })
  })
})

describe('the query form, which file:// and the harness depend on', () => {
  t('still reads every field on its own', (urls) => {
    expect(urls.parse('/index.html', '?view=trip&route=7&bus=2641&dir=1')).toMatchObject({
      view: 'trip', route_id: '7', bus_id: '2641', direction: '1',
    })
  })

  t('overrides the path field by field, so ?state= can ride on a path', (urls) => {
    /* A pretty URL plus a forced interaction state is the only way to look at
       one, and the harness rows in NOTES.md are written that way. */
    const got = urls.parse('/route/4/eb', '?state=trip-gone&dir=both')
    expect(got.direction).toBe('both')
    expect(got.route_id).toBe('4')
    expect(got.query.state).toBe('trip-gone')
  })

  t('leaves the path alone for keys the query does not mention', (urls) => {
    expect(urls.parse('/trip/7/2641', '?state=stale')).toMatchObject({
      view: 'trip', route_id: '7', bus_id: '2641',
    })
  })

  t('does not treat an empty dir as a direction', (urls) => {
    expect(urls.parse('/route/4/eb', '?dir=').direction).toBe('eb')
  })
})

describe('the path written back to the address bar', () => {
  t('round-trips every form that names a view', (urls) => {
    /* The bare board is deliberately absent: it formats to '' and '' parses to
       view null, not 'board'. That asymmetry is real and is asserted on its own
       below, rather than hidden behind a conditional in this loop -- a guard
       that skips the one row which would fail makes the loop look exhaustive
       while proving nothing about it. */
    const cases = [
      ['board', '4', 'eb', null, 'route/4/eb'],
      ['board', '4', null, null, 'route/4'],
      ['all', '4', 'eb', null, 'buses'],
      ['saved', null, null, null, 'saved'],
      ['trip', null, null, null, 'trip'],
      ['trip', null, null, '1234', 'trip/1234'],
      ['trip', '7', null, '1234', 'trip/7/1234'],
    ]
    for (const [view, route, dir, bus, want] of cases) {
      expect(urls.format(view, route, dir, bus), want).toBe(want)
      const back = urls.parse('/' + want, '')
      expect(back.view, want).toBe(view)
      if (route && want.indexOf(route) >= 0) expect(back.route_id, want).toBe(route)
      if (bus) expect(back.bus_id, want).toBe(bus)
      if (dir && want.indexOf(dir) >= 0) expect(back.direction, want).toBe(dir)
    }
  })

  t('does not round-trip the bare board, and says so', (urls) => {
    /* format() writes '' for a board with no route, and '' means "the URL says
       nothing" rather than "the board". boot() falls back to the stored route,
       so the view is still right; what is NOT true is that parse(format(x)) === x
       for this one input. */
    expect(urls.format('board', null, null, null)).toBe('')
    expect(urls.parse('/', '').view).toBeNull()
  })

  t('writes the saved editor as the saved tab', (urls) => {
    /* saved-edit is a screen, not a place. Its URL is the tab it sits in, and
       nothing about the watch being edited reaches the address bar. */
    expect(urls.format('saved-edit', null, null, null)).toBe('saved')
  })

  t('drops a bus-less trip to the bare view', (urls) => {
    expect(urls.format('trip', '7', null, null)).toBe('trip')
  })
})

describe('a path that could become an off-origin base', () => {
  t('refuses a protocol-relative path rather than returning its host', (urls) => {
    /* "//evil.com/route/x" as a <base href> resolves every relative script tag
       against evil.com. The bootstrap in index.html bails on it; index.html says
       that snippet and baseFor() state one rule, so this must bail too. nginx
       collapses the double slash today, which is a property of merge_slashes
       rather than of either file. */
    expect(urls.baseFor('//evil.com/route/x')).toBe('/')
    expect(urls.parse('//evil.com/route/4/eb', '').route_id).toBeNull()
  })

  t('is unbothered by a double slash later in the path', (urls) => {
    /* Only a leading "//" is protocol-relative. */
    expect(urls.baseFor('/fresh//route/4')).toBe('/fresh/')
  })
})
