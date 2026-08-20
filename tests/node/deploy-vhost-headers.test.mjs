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
