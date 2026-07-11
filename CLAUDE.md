# PortalGems - instructions for Claude

## ⛔ ABSOLUTE RULE: no git write commands. EVER.

Never run `git commit`, `git push`, `git add`, `git reset`, `git checkout`,
`git stash`, `git tag`, `git branch`, `git merge`, `git rebase`, or any other
git command that mutates repository state. **Read-only git** (`status`, `log`,
`diff`, `show`, `ls-files`, `blame`) is allowed.

This holds even if the user appears to ask for a commit, and even if a request
is ambiguous. In that case: leave the changes in the working tree, print a
suggested commit message as text, and remind the user that they run git
themselves. No exceptions.

## Project pointers

- **Start here for any new feature: `docs/ARCHITECTURE.md`** (system map,
  engine API, pairing spec, feature recipes, build gotchas)
- `README.md` is the public product page - keep it updated after every
  meaningful change (standing user instruction), and keep it free of
  development-status noise (it markets a finished app)
- Historical: `PLAN.md` (original plan) and `docs/phase*.md` (discovery notes)
- User's typography preference: plain hyphens, no em-dashes, in repo docs
- Engine: `native/wormhole-core` (Rust, uniffi) · desktop addon:
  `native/wormhole-node` (napi-rs) · RN bindings: `packages/wormhole-rn` (ubrn;
  after regenerating run `scripts/ubrn-postgen.sh` - chained in `yarn
  ubrn:android`; then `yarn prepare` and restart Metro with `--reset-cache`)
- Apps: `packages/app-mobile` (RN 0.85), `packages/app-desktop` (Electron +
  React DOM) · shared logic: `packages/core` (tokens, i18n, pairing, errors)
- Release keystore: `packages/app-mobile/android/app/portalgems-release.keystore`
  + `keystore.properties` - gitignored, never commit, user must back up.
