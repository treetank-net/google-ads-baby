# google-ads-baby

Claude Code plugin: MCP server for Google Ads campaign management with two-phase mutation safety.

## Architecture

Plugin = MCP server (stdio) + Claude Code hooks (safety enforcement).

### MCP Server (`server/`)
- `@modelcontextprotocol/sdk` stdio transport
- `google-ads-api` v23 (gRPC, GAQL)
- Read tools: `list_accounts`, `get_campaigns`, `execute_gaql`
- Write tools: `prepare_campaign_status`, `prepare_budget_change` → `confirm_mutation`
- Token store: in-memory, one-shot, 60s TTL

### Safety Hooks (`hooks/` + `scripts/`)
- `PreToolUse` on `prepare_*` → sets state to "pending"
- `UserPromptSubmit` → if pending, sets state to "user-confirmed"
- `PreToolUse` on `confirm_mutation` → blocks unless "user-confirmed"
- Effect: LLM cannot call prepare + confirm in sequence without user message between them

### Two-Phase Mutation Flow
1. LLM calls `prepare_*` → gets preview + token
2. LLM shows preview to user, asks for confirmation
3. User types response → hook marks as confirmed
4. LLM calls `confirm_mutation(token)` → hook allows → server executes

## Commands
- `cd server && npm install && npm run build` — build MCP server
- `cd server && npm run dev` — watch mode

## Config
All via env vars (set in plugin.json, sourced from user's environment):
- `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` — OAuth2 app
- `GOOGLE_ADS_REFRESH_TOKEN` — user's OAuth2 refresh token
- `GOOGLE_ADS_DEVELOPER_TOKEN` — Google Ads API developer token
- `GOOGLE_ADS_MCC_ID` — top-level MCC account ID

## Safety Guardrails
- Budget cap: 500 PLN/day max (configurable in `tools/write.ts`)
- GAQL mutations blocked in `execute_gaql` tool
- Token: one-shot, 60s expiry, server-side only
- Hook: requires real user message between prepare and confirm
