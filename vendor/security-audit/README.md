# Cloudflare's security-audit skill, vendored

From https://github.com/cloudflare/security-audit-skill, `skills/security-audit/` at
c1c8a8c1471069fb0e188eeaff69b8e8db6564a8 (2026-09-14), MIT (`LICENSE`, beside this file).
Unchanged, but for the two `*.test.cjs` files, left out: a session never runs them.

`/securityAudit` copies this folder into the chat's workspace and has the session follow
`SKILL.md` (api.md, *Outpost commands*). It is not installed as a skill: a skill's description
rides every request of every session (docs/architecture.md, a feature pays for its tokens).

To update: replace every file here with the upstream folder's, drop the tests again, and change
the commit above.
