# google-ads-baby

Local MCP server and plugin for managing Google Ads accounts with two-phase safety confirmation.

It can list Google Ads accounts and campaigns, run read-only GAQL, prepare budget/status changes, and prepare creation of paused Search campaigns, ad groups, and responsive search ads.

## Safety model

All write operations use a two-step flow:

1. The LLM calls a `prepare_*` tool with a short random `safe_word`.
2. The server returns a preview, one-shot token, expiry, and the safe word.
3. The user must reply with the safe word.
4. Only then can the LLM call `confirm_mutation`.

Claude Code and Codex hooks enforce the user-message gate. The MCP server also keeps mutation tokens server-side, one-shot, and time-limited.

## Requirements

- Node.js 18+
- Google Ads API developer token
- Access to at least one Google Ads manager/client account
- Claude Code or Codex with plugin/MCP support

## Build

```bash
cd server
npm install
npm run build
```

## Install In Claude Code

This repository contains a Claude plugin manifest:

```text
.claude-plugin/plugin.json
```

Install/use the repository as a local Claude Code plugin, then reload plugins in Claude Code. The plugin registers:

- MCP server: `google-ads`
- safety hooks from `hooks/hooks.json`

After installing, ask Claude to run:

```text
setup_google_auth
```

## Install In Codex

This repository contains Codex plugin metadata:

```text
.codex-plugin/plugin.json
.mcp.json
hooks.json
.agents/plugins/marketplace.json
hooks/google-ads-baby-safety/hooks.json
```

The marketplace entry points to `./plugins/google-ads-baby`. That directory is a small Codex wrapper; it starts the MCP server through `npx` from this GitHub repository, so the installed plugin does not need to carry a local copy of `server/`.

Current Codex builds may not activate plugin-local hooks even when `hooks.json` exists. If Codex shows `No plugin hooks`, install the safety hooks separately:

```bash
npx codex-marketplace add treetank-net/google-ads-baby/hooks/google-ads-baby-safety --hook --global
```

Add this repository as a local Codex plugin/marketplace source, then enable `google-ads-baby`. The MCP server is configured in `.mcp.json` and runs through `npx` so a fresh install can build the server before starting.

## First Setup

Run the MCP tool:

```text
setup_google_auth
```

The tool opens a local browser flow:

1. Log in with Google.
2. Paste your Google Ads developer token.
3. Select the MCC/account from the list.
4. Choose the safety level.
5. Save.

Config is stored locally in:

```text
~/.google-ads-baby/config.json
```

or in the plugin data directory when the client provides one.

## Safety Levels

Safety can be configured during setup or via env vars.

- `standard`: safe word required, 1 hour token/state TTL
- `strict`: safe word required, 5 minute token/state TTL
- `off`: disables the client hook gate; server-side prepare token is still required

Optional env vars:

```text
GOOGLE_ADS_SAFETY_LEVEL
GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS
GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS
```

## Available Tools

Setup:

- `setup_google_auth`
- `get_safety_setup`

Read:

- `list_accounts`
- `get_campaigns`
- `execute_gaql`

Write preparation:

- `prepare_campaign_status`
- `prepare_campaign_removal`
- `prepare_budget_change`
- `prepare_image_asset_from_url`
- `prepare_search_campaign`
- `prepare_display_campaign`
- `prepare_ad_group`
- `prepare_display_ad_group`
- `prepare_responsive_search_ad`
- `prepare_responsive_display_ad`

Execution:

- `confirm_mutation`
- `list_pending_mutations`

## OAuth Credentials

The plugin includes OAuth app credentials for the local desktop setup flow. They are application credentials, not user credentials. User refresh tokens and Google Ads config are saved only locally.

You can override the bundled OAuth app with:

```text
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
```

## Development

```bash
cd server
npm run build
npm start
```

For MCP Inspector:

```bash
cd server
npx @modelcontextprotocol/inspector node dist/index.js
```

Use `setup_google_auth` inside the inspector after connecting.
