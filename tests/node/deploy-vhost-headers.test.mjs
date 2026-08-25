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
 * proves the behaviour once, but it needs Docker, and this repo's suite deliberately
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

describe('the nginx vhost does not lose inherited headers', () => {
	const blocks = locationBlocks(nginx)

	it('finds the location blocks it means to check', () => {
		const names = blocks.map((b) => b.name)
		expect(names).toContain('= /index.html')
		expect(names).toContain('/api/')
		expect(names).toContain('/')
		/* If this ever drops, the loop below is asserting over nothing. */
		expect(blocks.length).toBeGreaterThanOrEqual(6)
	})

	it('declares every security header at server level', () => {
		const serverLevel = nginx.slice(0, nginx.indexOf('location /api/'))
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
    /* A bare <script> with no attributes is an inline one; every other script
       tag in this document carries a src. */
    expect(html.match(/<script>/g) ?? []).toHaveLength(1)
    expect(inline, 'no inline <script> found in client/index.html').not.toBeNull()
  })

  it('is admitted by its own hash in both vhosts', () => {
    const hash = 'sha256-' + createHash('sha256').update(inline[1], 'utf8').digest('base64')
    for (const [name, conf] of [['nginx', nginx], ['apache', apache]]) {
      expect(conf, `${name} does not carry the current bootstrap hash`).toContain(hash)
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
