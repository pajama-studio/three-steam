# Security policy

## Supported versions

`three-steam` is currently a research preview and has no production-supported
release. Security fixes are applied to the latest `main` branch.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow in the Security tab of
this repository. Do not open a public issue containing exploit details, credentials,
private Steamworks material, or affected user data.

Include the affected commit, platform, reproduction steps, expected impact, and any
suggested mitigation. Maintainers will acknowledge a complete report as soon as
practical and coordinate disclosure after a fix is available.

## Security boundaries

The game page is untrusted content. It must not gain Node.js access, unrestricted
filesystem access, arbitrary native calls, DevTools in production, or navigation to
unapproved origins. See `AGENTS.md` and `docs/03-validation-gates.md` for required
bridge, origin, and rendering constraints.
