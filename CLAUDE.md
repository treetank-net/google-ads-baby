# google-ads-baby

Claude Code plugin: MCP server for Google Ads campaign management with two-phase mutation safety.

## Architecture

Plugin = MCP server (stdio) + Claude Code/Codex hooks (safety enforcement).

### MCP Server (`server/`)
- TypeScript, `@modelcontextprotocol/sdk` (stdio), `google-ads-api` v23 (community, gRPC)
- Build: `npm run build` (tsc), runtime: `node dist/index.js`
- Read tools: `list_accounts`, `get_campaigns`, `execute_gaql`
- Write tools: `prepare_campaign_status`, `prepare_budget_change` → `confirm_mutation`
- Token store: in-memory, one-shot, 1h TTL

### Safety Hooks (`hooks/` + `scripts/`)
- `PreToolUse` on `prepare_*` → sets state to "pending"
- `UserPromptSubmit` → if pending and user message contains the LLM-selected safe word, sets state to "user-confirmed"
- `PreToolUse` on `confirm_mutation` → blocks unless "user-confirmed"
- Effect: LLM cannot call prepare + confirm in sequence without user message between them

### Plugin Manifests
- Claude Code: `.claude-plugin/plugin.json`
- Codex: `.codex-plugin/plugin.json` + `.mcp.json` + root `hooks.json`
- Codex marketplace: `.agents/plugins/marketplace.json` points to repo root (`"./"`) so installed MCP has access to `server/` and `scripts/`
- Codex hook runtime currently may not activate plugin-local hooks; standalone hook package lives at `hooks/google-ads-baby-safety/hooks.json`

### Two-Phase Mutation Flow
1. LLM invents a short random ASCII safe word and calls `prepare_*` with `safe_word`
2. LLM shows preview + safe word to user, asks for confirmation using that word
3. User types response containing the safe word → hook marks as confirmed
4. LLM calls `confirm_mutation(token)` → hook allows → server executes

## Repo & CI
- GitLab: `treetank/google-ads-baby` (origin, primary)
- GitHub: `treetank-net/google-ads-baby` (mirror, remote `gh`)
- `.gitlab-ci.yml`: mirror job pushuje `master` + tagi do GitHuba przy każdym pushu (runner tag: `vps`, wymaga `GITHUB_TREETANK_TOKEN` w CI/CD variables)

## Commands
- `cd server && npm install && npm run build` — zainstaluj zależności i zbuduj
- `cd server && npm run dev` — watch mode (rebuild przy zmianach)
- `cd server && npm start` — uruchom MCP server (wymaga wcześniejszego buildu)
- `npx codex-marketplace add treetank-net/google-ads-baby/hooks/google-ads-baby-safety --hook --global` — zainstaluj hooki bezpieczeństwa dla Codexa

## Config
All via env vars (set in plugin.json, sourced from user's environment):
- `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` — OAuth2 app
- `GOOGLE_ADS_REFRESH_TOKEN` — user's OAuth2 refresh token
- `GOOGLE_ADS_DEVELOPER_TOKEN` — Google Ads API developer token
- `GOOGLE_ADS_MCC_ID` — top-level MCC account ID
- `GOOGLE_ADS_SAFETY_LEVEL` — `standard` (default), `strict`, or `off`
- `GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS` — optional server-side mutation token TTL override
- `GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS` — optional Claude hook confirmation-state TTL override

## Safety Guardrails
- Budget cap: 500 PLN/day max (configurable in `tools/write.ts`)
- GAQL mutations blocked in `execute_gaql` tool
- Token: one-shot, 1h expiry by default, server-side only
- Safety level:
  - `standard`: requires the LLM-selected safe word in a real user message between `prepare_*` and `confirm_mutation`; 1h token/state TTL
  - `strict`: same flow, but 5 min token/state TTL
  - `off`: disables the Claude hook gate; server-side prepare token is still required
- Hook: requires real user message between prepare and confirm
- MCP tool `get_safety_setup` tells the LLM/user how to install Codex safety hooks when Codex shows `No plugin hooks`

## Background — dlaczego tak, a nie inaczej

Punkt wyjścia: integracja Google Ads w projekcie Marketing67 (ecomhub) — `google-ads-api` v23, GAQL,
OAuth2 + developer token, MCC → child accounts. Działa jako data source do dashboardów (read-only).

Cel: narzędzie do **automatyzacji kampanii** (nie tylko odczytu) przez Claude Code Desktop,
działające lokalnie na komputerze klienta.

### Rozważone opcje

1. **Oficjalny Google Ads MCP Server** ([googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp))
   — tylko 3 toole read-only (search, get_resource_metadata, list_accessible_customers). Zero mutacji.

2. **Community MCP** ([cohnen/mcp-google-ads](https://github.com/cohnen/mcp-google-ads))
   — 5 tooli, też read-only (list_accounts, execute_gaql_query, get_campaign_performance, get_ad_performance, run_gaql).

3. **Własny MCP server** ← wybraliśmy to, bo nikt nie oferuje write'ów.

### Bezpieczeństwo — ewolucja myślenia

Problem: mutacje na koncie reklamowym przez LLM = ryzyko (halucynacja → wydany budżet).

- **MCP tool annotations** (`destructiveHint: true`) — okazały się bezużyteczne. To tylko hinty,
  klient może je zignorować, nie wymuszają prompta nawet w Claude Code Desktop.

- **`permissions.ask`** w settings.json — wymusza prompt w Claude Code, ale user może zmienić config,
  a inny klient MCP w ogóle tego nie respektuje.

- **Two-phase token (server-side)** — `prepare_*` → token → `confirm_mutation`. Lepiej, ale jeśli LLM
  ma permission na oba toole, może je wywołać w sekwencji bez udziału usera.

- **PreToolUse hook** ← finalne rozwiązanie. Hook blokuje `confirm_mutation` jeśli nie było
  `UserPromptSubmit` (= prawdziwej wiadomości od usera) między `prepare_*` a `confirm_mutation`.
  LLM nie może sfałszować user message. W połączeniu z server-side tokenem daje dwie niezależne warstwy.

- **Dlaczego plugin, nie goły MCP server** — sam serwer MCP nie może zainstalować hooków.
  Plugin bundluje serwer + hooki w jednym pakiecie. User instaluje jedno, dostaje całość.

- **OS dialog (rozważony, odłożony)** — `zenity`/`osascript` popup jako fallback dla klientów MCP
  bez hooków (Cursor, inne). Bardziej uniwersalny, ale gorszy UX niż naturalny chat flow.
  Może jako opcja w przyszłości.

## Kolejne kroki

Natychmiastowe (kompilacja, poprawka mutacji), krótkoterminowe (nowe toole, testy e2e),
średnioterminowe (OS dialog fallback, audit log, rate limiting) i otwarte pytania
(gRPC vs REST, scope tooli, dystrybucja).

### Natychmiastowe
- [x] Dodać `.gitignore`
- [x] GitLab CI mirror do GitHuba (`treetank-net/google-ads-baby`)
- [x] Poprawka mutacji — `customer.campaigns.update()` / `customer.campaignBudgets.update()`
- [x] TypeScript kompiluje się bez błędów (`npm run build`)
- [ ] Testowanie end-to-end z prawdziwym kontem Google Ads (wymaga env vars)

### Krótkoterminowe
- [ ] Testowanie end-to-end z prawdziwym kontem Google Ads (dev token w trybie testowym)
- [ ] Dodać `prepare_keyword_add` / `prepare_keyword_remove` — zarządzanie keywordami
- [ ] Dodać `prepare_ad_group_status` — pauza/wznowienie ad groupów
- [ ] Walidacja w safety.sh — timeout na pending state (jeśli user nie odpowiedział w 5 min → kasuj pending)
- [ ] Lepsze error handling w MCP server (Google Ads API errors → czytelne komunikaty po polsku)

### Średnioterminowe
- [ ] OS dialog fallback (`zenity`/`osascript`) dla klientów bez hooków — konfigurowalny w env var
- [ ] Audit log — każda mutacja logowana do pliku z timestampem, tokenem, wynikiem
- [ ] Rate limiting — max N mutacji na minutę (server-side)
- [ ] Konfigurowalny budget cap per-account (nie globalny 500 PLN)
- [ ] Toole do tworzenia kampanii (`prepare_campaign_create`) — najczęstszy use case to nowa kampania
      na wzór istniejącej. Cache na struktury kampanii (ad groupy, keywordy, ustawienia) jako template.
- [ ] Dystrybucja przez marketplace (jak hooker)

### Podjęte decyzje
- **Node.js + `google-ads-api`** — TypeScript + community `google-ads-api` v23 (gRPC).
  Powód: docelowy użytkownik (marketingowiec) ma Node.js, nie ma Pythona.
  Wersja Pythonowa zachowana w historii gita (commit ccfb764).
- **Marketplace** — standalone repo, ale instalacja przez marketplace (bez marketplace niewygodnie).
- **Scope: read + manage + create** — LLM tworzy kampanie (często na wzór istniejących),
  zarządza istniejącymi, odczytuje dane. Cache na template'y kampanii.
