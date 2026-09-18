/**
 * Regression: the vhosts dropped every security header on the one HTML document.
 * Found during review of the three open client PRs on 2026-08-19.
 *
 * nginx inherits `add_header` from an enclosing level ONLY when the current level
 * declares none of its own. A single `add_header` inside a `location` silently
 * discards every header inherited from `server`. Each location in the vhost sets its
 * own Cache-Control, so the four security headers declared at server level reached
 * only `location /` -- which `location = /index.html` shadows. The board's HTML
 * document, and every script, stylesheet and API response, went out with no CSP, no
 * Referrer-Policy and no X-Frame-Options.
 *
 * Verified against nginx:alpine before the fix: zero of all three on /index.html,
 * /styles.css and /api/health.json. Verified after: all four present on all five paths.
 *
 * This is a text assertion rather than a live one on purpose. Running the real server
 * proves the behavior once, but it needs Docker, and this repo's suite deliberately
 * needs nothing but node, php and python. What the text can pin is the invariant that
 * actually broke: any location that sets a header must set all of them.
 *
 * Apache is checked too, but for the opposite reason -- mod_headers is additive across
 * scopes, so its server-level block genuinely does cover every location, and repeating
 * the headers per-location there would be noise. The two files are correct in different
 * ways and the test says which is which.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const SECURITY_HEADERS = [
	'X-Content-Type-Options',
	'X-Frame-Options',
	'Referrer-Policy',
	'Content-Security-Policy',
]

const nginx = readFileSync(new URL('../../deploy/nginx-capmetro.conf', import.meta.url), 'utf8')
const apache = readFileSync(new URL('../../deploy/apache-capmetro.conf', import.meta.url), 'utf8')

/* Split the server block into its top-level `location` blocks, brace-matched so a
   nested `types { }` does not end one early. */
function locationBlocks(conf) {
	const out = []
	const re = /^\s*location\s+([^{]+?)\s*\{/gm
	let m
	while ((m = re.exec(conf)) !== null) {
		let depth = 1
		let i = re.lastIndex
		for (; i < conf.length && depth > 0; i++) {
			if (conf[i] === '{') depth++
			else if (conf[i] === '}') depth--
		}
		out.push({ name: m[1].trim(), body: conf.slice(re.lastIndex, i - 1) })
	}
	return out
}

/*
 * Apache's equivalent of locationBlocks. Needed because asserting on the whole file lets a
 * directive in ANY block satisfy a check meant for one: both apache cache rules could be
 * flipped to `immutable, max-age=31536000` -- including the one that serves sw.js, the file
 * whose staleness the worker cannot fix for itself -- with the suite green, because the
 * test only asserted that the block existed.
 */
function apacheBlock(conf, open) {
	const i = conf.indexOf(open)
	if (i === -1) return null
	/* Closer derived from the tag name itself. Hardcoding the Files/FilesMatch pair meant
	   adding a <Location> block silently sliced to the wrong terminator. */
	const tag = open.match(/^<([A-Za-z]+)/)
	if (!tag) return null
	const j = conf.indexOf(`</${ tag[1] }>`, i)
	return j === -1 ? null : conf.slice(i, j)
}

describe('the nginx vhost does not lose inherited headers', () => {
	const blocks = locationBlocks(nginx)

	it('finds the location blocks it means to check', () => {
		const names = blocks.map((b) => b.name)
		expect(names).toContain('= /index.html')
		/* `^~` on purpose: a plain prefix loses to any regex location that also
		   matches, which would let the icon rule answer /api/*.png. Spelled out
		   here so dropping the modifier fails rather than quietly re-opening it. */
		expect(names).toContain('^~ /api/')
		expect(names).toContain('^~ /api/departures/')
		expect(names).toContain('/')
		/* If this ever drops, the loop below is asserting over nothing. */
		expect(blocks.length).toBeGreaterThanOrEqual(6)
	})

	it('declares every security header at server level', () => {
		/*
		 * Cut at the first location block, whatever it is called. Finding it by
		 * the literal string `location /api/` broke silently the day that block
		 * gained its `^~`: indexOf returned -1, slice(0, -1) handed back almost
		 * the whole file, and every assertion below passed against the location
		 * blocks' own repeated headers instead of the server-level ones.
		 */
		const firstLocation = nginx.search(/^\s*location\s/m)
		expect(firstLocation, 'no location block found in the nginx conf').toBeGreaterThan(0)
		const serverLevel = nginx.slice(0, firstLocation)
		for (const h of SECURITY_HEADERS) {
			expect(serverLevel).toMatch(new RegExp(`^\\s*add_header ${h}\\b`, 'm'))
		}
	})

	it.each(SECURITY_HEADERS)(
		'repeats %s in every location that sets a header of its own',
		(header) => {
			for (const block of blocks) {
				if (!/^\s*add_header\b/m.test(block.body)) continue
				expect(
					block.body,
					`location ${block.name} sets a header, so it discards all inherited ones ` +
						`and must repeat ${header} itself`
				).toMatch(new RegExp(`^\\s*add_header ${header}\\b`, 'm'))
			}
		}
	)

	it('leaves a location that sets nothing alone, so it can inherit', () => {
		const root = blocks.find((b) => b.name === '/')
		expect(root).toBeDefined()
		expect(root.body).not.toMatch(/^\s*add_header\b/m)
	})

	it('serves index.html with a CSP, which is the case that regressed', () => {
		const index = blocks.find((b) => b.name === '= /index.html')
		expect(index.body).toMatch(/add_header Content-Security-Policy/)
		expect(index.body).toMatch(/add_header Referrer-Policy no-referrer/)
	})
})

describe('the apache vhost is correct the other way', () => {
	it('sets every security header once, since mod_headers is additive across scopes', () => {
		for (const h of SECURITY_HEADERS) {
			expect(apache).toMatch(new RegExp(`^\\s*Header always set ${h}\\b`, 'm'))
		}
	})
})

/*
 * The inline <base> bootstrap, and the hash that lets it run.
 *
 * index.html carries exactly one inline script: the bootstrap that sets a
 * <base> so relative asset tags resolve when the board is served at a deep path
 * like /route/4/eb. Both vhosts admit it by sha256 hash rather than by adding
 * 'unsafe-inline', which would readmit every injected inline script on an origin
 * whose whole defence is that it has none.
 *
 * Hashing an inline script has exactly one hazard: edit the snippet, forget the
 * config, and the browser silently refuses to run it — the board then renders
 * nothing at every pretty URL while every other check stays green. This
 * recomputes the hash from index.html on each run, so that edit fails here
 * instead of on the box.
 */
describe('the inline bootstrap and its CSP hash', () => {
  const html = readFileSync(new URL('../../client/index.html', import.meta.url), 'utf8')
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)

  it('is the only inline script in the document', () => {
    /* The hash admits one snippet. A second would need its own, and would more
       likely be an accident than a decision. */
    /*
     * Counted as "script tags with no src", not "tags with no attributes". `/<script>/g`
     * matches only the attribute-less spelling, so a second inline script written as
     * <script type="module"> -- the realistic way one gets added -- was invisible here. It
     * would get no hash of its own and be silently refused by the CSP, which is precisely
     * the state this test exists to make impossible.
     */
    const stripped = html.replace(/<!--[\s\S]*?-->/g, '')
    const noSrc = [...stripped.matchAll(/<script\b([^>]*)>/gi)]
      .filter((m) => !/\bsrc\s*=/i.test(m[1]))
    expect(noSrc, 'index.html no longer has exactly one inline script').toHaveLength(1)
    expect(inline, 'no inline <script> found in client/index.html').not.toBeNull()
  })

  it('is admitted by its own hash in EVERY policy, not just somewhere in the file', () => {
    /*
     * Per policy, not per file. nginx repeats the whole policy string in eight
     * places -- server level plus seven location blocks -- against apache's
     * one, and `expect(conf).toContain(hash)` is satisfied by any single
     * occurrence. Editing the bootstrap and updating eight of those nine copies
     * left this green while one block served a stale hash, and if the missed
     * block were `location = /index.html` the browser would refuse the
     * bootstrap and the board would render nothing at every pretty URL -- which
     * is the exact hazard the comment in the vhost says this test removes.
     */
    const hash = 'sha256-' + createHash('sha256').update(inline[1], 'utf8').digest('base64')
    for (const [name, conf] of [['nginx', nginx], ['apache', apache]]) {
      const found = [...conf.matchAll(/Content-Security-Policy[" ]+([^"]+)"/g)].map((m) => m[1])
      expect(found.length, `${name} declares no CSP`).toBeGreaterThan(0)
      found.forEach((policy, i) => {
        expect(policy, `${name} policy ${i + 1} of ${found.length} carries a stale or missing bootstrap hash`)
          .toContain(hash)
      })
    }
  })

  it('can set a base at all, which base-uri none would forbid', () => {
    /* 'none' makes every <base> inert however it is inserted, including one
       built with createElement — so the hash alone would not be enough. */
    for (const [name, conf] of [['nginx', nginx], ['apache', apache]]) {
      expect(conf, `${name} still forbids <base>`).toContain("base-uri 'self'")
      expect(conf, `${name} still says base-uri none`).not.toContain("base-uri 'none'")
    }
  })

  it('never buys the bootstrap with unsafe-inline', () => {
    /* Checked against the header VALUES, not the file text: both vhosts discuss
       unsafe-inline in prose explaining why they do not use it. */
    for (const [name, conf] of [['nginx', nginx], ['apache', apache]]) {
      const policies = [...conf.matchAll(/Content-Security-Policy[" ]+([^"]+)"/g)].map((m) => m[1])
      expect(policies.length, `${name} declares no CSP`).toBeGreaterThan(0)
      for (const policy of policies) {
        expect(policy, `${name} opened script-src to all inline scripts`).not.toContain("'unsafe-inline'")
      }
    }
  })
})

/*
 * One rule, three files. The app-path list lives in the nginx vhost, the apache
 * vhost, the e2e fixture server and client/urls.js, and nothing derives one from
 * another. A verb added to the client without the servers renders a 404 for a
 * link the client believes in; added to the servers without the client, a blank
 * board. Neither shows up in any other test.
 */
describe('the app-path verbs agree everywhere they are written', () => {
  const VERBS = ['route', 'buses', 'trip', 'saved']
  const sources = {
    nginx,
    apache,
    'tests/e2e/server.mjs': readFileSync(new URL('../e2e/server.mjs', import.meta.url), 'utf8'),
    'client/urls.js': readFileSync(new URL('../../client/urls.js', import.meta.url), 'utf8'),
  }

  it('lists the same four in every file that names them', () => {
    for (const [name, src] of Object.entries(sources)) {
      const group = src.match(/\(\??:?(route\|buses\|trip\|saved)\)/)
        || src.match(/route: 1, buses: 1, trip: 1, saved: 1/)
      expect(group, `${name} does not spell the verb list in the expected shape`).not.toBeNull()
    }
    /* And the client's own table is exactly those four, no more. */
    const table = sources['client/urls.js'].match(/var VERBS = \{([^}]*)\}/)[1]
    expect(table.match(/(\w+):/g).map((s) => s.slice(0, -1)).sort()).toEqual([...VERBS].sort())
  })
})

/*
 * Being installable is a property of the HEADERS, not of the client.
 *
 * `default-src 'none'` is the whole point of this origin's policy, and both
 * manifest-src and worker-src fall back to it. With neither named, index.html
 * can link a perfect manifest and register a perfect worker and the browser
 * will refuse both: no install prompt, no offline board, one console line each,
 * and nothing wrong on screen to notice. Every other test in this repo would
 * stay green.
 *
 * The MIME type is the same shape of failure one layer down. Neither nginx nor
 * Apache ships a mapping for .webmanifest, so an unconfigured origin serves it
 * as application/octet-stream -- which Chrome parses anyway and Safari does not,
 * on an origin that sends X-Content-Type-Options: nosniff.
 */
describe('the vhosts let the board be installed', () => {
  const policies = (conf) =>
    [...conf.matchAll(/Content-Security-Policy[" ]+([^"]+)"/g)].map((m) => m[1])

  it.each(['manifest-src', 'worker-src'])(
    'names %s explicitly in every policy, rather than letting it fall back to none',
    (directive) => {
      for (const [name, conf] of [['nginx', nginx], ['apache', apache]]) {
        const found = policies(conf)
        expect(found.length, `${name} declares no CSP`).toBeGreaterThan(0)
        for (const policy of found) {
          expect(policy, `${name} would refuse the ${directive} fetch`).toContain(`${directive} 'self'`)
        }
      }
    },
  )

  it('still starts from default-src none, which is what makes the two necessary', () => {
    for (const conf of [nginx, apache]) {
      for (const policy of policies(conf)) expect(policy).toContain("default-src 'none'")
    }
  })

  it('serves the manifest as application/manifest+json in both', () => {
    /*
     * Scoped to the manifest's own location block. Two independent whole-file regexes are
     * the "any-one-of-N-copies suffices" shape this file's header calls out: moving
     * `default_type application/manifest+json;` into the unrelated /api/ block, leaving the
     * manifest block untyped, satisfied both patterns and left the suite green. The manifest
     * would then go out as octet-stream under nosniff, which Safari refuses -- the exact
     * failure this test exists to prevent.
     */
    const block = locationBlocks(nginx).find((b) => b.name === '= /manifest.webmanifest')
    expect(block, 'nginx has no manifest location block').toBeDefined()
    expect(block.body, 'the manifest block does not set its own type')
      .toMatch(/default_type application\/manifest\+json;/)
    expect(apache).toMatch(/^\s*AddType application\/manifest\+json \.webmanifest$/m)
  })

  it('lets the worker install from the http cache without risking a stale release', () => {
    /*
     * client/sw.js precaches the shell with the browser's own HTTP cache rather
     * than bypassing it, which is what stopped a first visit re-downloading
     * ~290 KB it had just fetched. That is only safe because of what is
     * asserted here: every entry the shell needs is served must-revalidate or
     * no-cache, so the browser has to check with the origin before reusing a
     * copy and the install cannot freeze the previous release as the offline
     * board.
     *
     * Give the scripts or the document a long max-age and this fails -- which
     * is the point. The failure would otherwise appear weeks later, on one
     * phone, as a board serving old code with no way to tell.
     *
     * Fonts are deliberately exempt: `immutable`, content-addressed by name,
     * and the one set worth taking from cache outright.
     */
    const revalidates = /Cache-Control "(no-cache|public, max-age=0, must-revalidate)"/
    for (const name of ['= /index.html', '~* \\.(js|css)$', '= /manifest.webmanifest']) {
      const block = locationBlocks(nginx).find((b) => b.name === name)
      expect(block, `nginx has no ${name} block`).toBeDefined()
      expect(block.body, `nginx serves ${name} in a way the worker install could freeze`)
        .toMatch(revalidates)
    }
    /* Apache says the same thing with FilesMatch rather than location. Sliced to the block,
       not scanned across the file: a lazy `[\s\S]*?` finds the first matching directive
       AFTER the opening tag, which can belong to a later block entirely. */
    /*
     * Apache, EVERY block the install's correctness rests on -- not just js/css. The first
     * version checked only the js|css FilesMatch, so pinning Apache's index.html for a year
     * was invisible: the board's one HTML document, frozen in every browser's cache, with
     * this test's own comment claiming it covered "the scripts or the document".
     *
     * It also carried a ternary whose condition was String.replace(...), which always
     * returns a non-empty string -- always truthy, so the alternative arm was dead code
     * wearing the shape of a choice.
     */
    const apacheRevalidate =
      /Header always set Cache-Control "(no-cache|public, max-age=0, must-revalidate)"/
    for (const [label, open] of [
      ['the document', '<Location "/index.html">'],
      ['js/css', '<FilesMatch "\\.(js|css)$">'],
      ['the manifest', '<Files "manifest.webmanifest">'],
    ]) {
      const body = apacheBlock(apache, open)
      expect(body, `apache has no ${ label } block (${ open })`).not.toBeNull()
      expect(body, `apache serves ${ label } in a way the worker install could freeze`)
        .toMatch(apacheRevalidate)
    }
  })

  it('does not let the manifest or the worker script cache past a deploy', () => {
    /*
     * The manifest names every icon and the start URL, and sw.js is the one file
     * whose staleness the worker cannot fix for itself -- it is what decides
     * what everything else does.
     *
     * Both halves assert the DIRECTIVE now. The apache half used to assert only that the
     * block existed, so `<Files "manifest.webmanifest">` and the `<FilesMatch "\.(js|css)$">`
     * that serves sw.js could both be flipped to `immutable, max-age=31536000` -- pinning
     * the worker on every device for a year -- with this test green. Found by mutation.
     */
    const revalidate = /Cache-Control "public, max-age=0, must-revalidate"/
    const manifestBlock = locationBlocks(nginx).find((b) => b.name === '= /manifest.webmanifest')
    expect(manifestBlock, 'nginx has no manifest location').toBeDefined()
    expect(manifestBlock.body).toMatch(revalidate)
    /* sw.js is served by the js|css rule, which already revalidates. */
    const jsBlock = locationBlocks(nginx).find((b) => b.name === '~* \\.(js|css)$')
    expect(jsBlock, 'nginx has no js|css location').toBeDefined()
    expect(jsBlock.body).toMatch(revalidate)

    for (const [label, open] of [
      ['manifest', '<Files "manifest.webmanifest">'],
      ['js/css (which serves sw.js)', '<FilesMatch "\\.(js|css)$">'],
    ]) {
      const body = apacheBlock(apache, open)
      expect(body, `apache has no ${label} block`).not.toBeNull()
      expect(body, `apache lets ${label} cache past a deploy`)
        .toMatch(/Header always set Cache-Control "public, max-age=0, must-revalidate"/)
    }
  })

  it('keeps the deny blocks above the icon location, like every other asset rule', () => {
    /*
     * The regression the deny blocks were moved for: nginx takes the FIRST
     * matching regex location, so an asset block declared above them is a hole
     * they never see. A new one added in the wrong place reopens it silently.
     */
    const deny = nginx.indexOf('location ~ /\\. { deny all; }')
    const icons = nginx.indexOf('location ~* \\.(png|svg|ico)$')
    expect(deny).toBeGreaterThan(0)
    expect(icons).toBeGreaterThan(deny)
  })
})
