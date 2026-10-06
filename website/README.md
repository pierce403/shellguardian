# ShellGuardian website

Static product/download website. `dist/` is tracked source, not the desktop build.
Production is https://shellguardian.org, deployed as Cloudflare Workers Static
Assets in the user's existing account. The apex custom domain is managed by the
Worker's route; do not replace unrelated zone or mail records.

```bash
npm ci
npm run check
npm run deploy:check
npm run types
npm run deploy
```

Deploy only the committed/pushed source; verify public HTML and assets against
that commit and check `/install.sh` through its GitHub Release redirect. No runtime
secrets, storage, Worker application logic, or persistent deploy credentials are
added. Wrangler reuses the user's existing local OAuth authorization.

The earlier owner-private Sites preview retains its identity in
`.openai/hosting.json` and source checkout `/home/pierce/projects/shellguardian-website`.
It is not the production origin. Preserve its Git metadata if editing that preview.

The screenshot is the actual app's explicitly labeled sample environment, not
live agent telemetry. No analytics, remote fonts, accounts, or browser storage.
Installation links use the public GitHub Release, not authenticated Site assets.

Wrangler 4.147.0's development-only Miniflare graph originally pulled a vulnerable
Sharp/librsvg. The reviewed Sharp 0.35.5 override removes GHSA-wq5f-xc86-pv6w;
validate dry-run and audit before changing/removing it. It is not shipped to browsers.

Verify responsive/keyboard rendering, copy-command behavior, local asset paths,
and public release links when changing this site. Keep release/platform claims
aligned with actual signed assets and root `FEATURES.md` acceptance gates.
