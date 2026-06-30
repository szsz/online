# GitHub App helper — `szsz-online-bot`

Mints installation access tokens for the `szsz-online-bot` GitHub App (App ID
`3597037`, installed on `szsz/online` + `szsz/libreoffice-core-wasm`). Used
for bot-style automation: comment on PRs, query CI runs, post check results,
create issues from failing test runs.

## Setup

The private key lives at `/home/localadmin/gitapp/szsz-online-bot.2026-05-04.private-key.pem`
(perms `0600`, dir perms `0700`). It MUST NOT be committed to any repo. The
helper hard-codes the path; override with `GH_APP_PRIVATE_KEY_PATH` env var.

## Usage

```bash
cd wasm/tools/gh-app

# Mint a 1-hour installation access token (auto-detects installation):
TOKEN=$(node token.js)

# Use it with the gh CLI:
GH_TOKEN="$TOKEN" gh pr list --repo szsz/online

# Or directly with curl:
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/installation/repositories

# Other modes:
node token.js --jwt                      # print the App-level JWT (10-min TTL)
node token.js --list-installations       # list installations (id, owner, ...)
node token.js --installation-id=129415089 # use a specific install
```

## Token lifetimes

- **JWT** (App-level): 10 minutes max. Used only to mint installation tokens.
- **Installation token**: ~1 hour. Re-mint freely; tokens are cheap.

The helper signs a fresh JWT and exchanges it on every call, so tokens are
single-use from the caller's perspective. For long-running scripts that need
to call many endpoints, mint once and reuse the token (`TOKEN=$(...)`).

## Permissions

The App has these repository permissions (set during App registration):

- Actions: read   — query workflow runs / artifacts
- Checks: write   — post check results
- Contents: read  — read source / branches / commits
- Issues: write   — create / comment
- Metadata: read  — required default
- Pull requests: write — create / comment / review

If we need more (e.g. push access, settings), update the App's permissions
in https://github.com/settings/apps/szsz-online-bot and accept the new
permission grant on each install.
