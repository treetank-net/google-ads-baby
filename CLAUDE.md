# google-ads-baby

Claude Code plugin: MCP server for Google Ads campaign management with two-phase mutation safety.

## Architecture

Plugin = MCP server (stdio) + Claude Code/Codex hooks (safety enforcement).

### MCP Server (`server/`)
- TypeScript source in `server/src/`, compiled with `tsc`, bundled with `esbuild` into single `server/bundle.cjs`
- `google-ads-api` v23 (community, gRPC), `@modelcontextprotocol/sdk` (stdio), `zod`
- All dependencies bundled — no `node_modules` needed at runtime, cold start ~0.8s
- Token store: in-memory, one-shot, 1h TTL

#### Source layout (`server/src/`)
```
index.ts                  — entrypoint: tworzy McpServer, rejestruje toole, startuje stdio
config.ts                 — AdsConfig, configFromEnv(), getConfigDir()
confirm.ts                — token store (in-memory Map), safe word / confirm state (pliki)
history.ts                — audit log JSONL (~/.google-ads-baby/mutation-history.jsonl)
errors.ts                 — formatError()
validation.ts             — normalizeCustomerId(), normalizeResourceId(), requireCustomerId()
constants.ts              — współdzielone stałe
client.ts                 — barrel re-export z client/

client/
  core.ts                 — getCustomer(), listAccounts(), getCampaigns(), executeGaql()
  campaigns.ts            — campaign CRUD, ad group create, targeting, bidding, demographics, conversion goals, shared sets, ad schedules
  ads.ts                  — responsive search/display ad, keywords, negative keywords, keyword/ad status changes
  assets.ts               — asset groups, extensions, sitelinks, callouts, image upload, linking
  index.ts                — barrel re-export

tools/
  auth.ts                 — OAuth flow (auth_google_ads, setup_google_auth)
  read.ts                 — orchestrator: registerReadTools()
  read-helpers.ts         — schemas, query builders, pure functions
  read-accounts.ts        — list_accounts, get_campaigns, execute_gaql, list_ads_entities, get_ad_blueprint
  read-history.ts         — get_mutation_history, get_mutation_stats
  write.ts                — orchestrator: registerWriteTools()
  write-schemas.ts        — Zod schemas, safety constants (budget caps, limits)
  write-helpers.ts        — validation, image inspection, preview formatting
  write-executor.ts       — executeMutation() dispatcher, formatMutationError()
  write-prepare-campaigns.ts — prepare_campaign_status, prepare_budget_change, prepare_search/display/pmax_campaign, prepare_demographic_bid_modifier, prepare_campaign_conversion_goals, prepare_campaign_shared_set, prepare_ad_schedule, etc.
  write-prepare-assets.ts — prepare_image_asset_*, prepare_sitelink/callout/call/snippet_assets, prepare_campaign/ad_group/asset_group_assets
  write-prepare-ads.ts    — prepare_responsive_search/display_ad, prepare_clone_entity, prepare_keywords, prepare_keyword_status, prepare_ad_status
  write-confirm.ts        — get_safety_setup, confirm_safe_word, confirm_mutation, confirm_all_mutations
```

#### Jak dodawać nowe rzeczy

**Nowy write tool (prepare_*):**
1. Schemat Zod → `write-schemas.ts`
2. Handler `server.tool('prepare_...')` → do odpowiedniego `write-prepare-*.ts` wg domeny:
   - kampanie/budżety/grupy reklam/targeting/bidding → `write-prepare-campaigns.ts`
   - assety/obrazki/rozszerzenia/linkowanie → `write-prepare-assets.ts`
   - reklamy/klonowanie/keywordy → `write-prepare-ads.ts`
3. Dispatch w `executeMutation()` → `write-executor.ts` (dodaj `if (mutation.action === '...')`)
4. Jeśli potrzeba nowej funkcji API → `client/` (campaigns.ts / ads.ts / assets.ts wg domeny), auto-eksportuje się przez barrel
5. Helpery (walidacja, formatowanie preview) → `write-helpers.ts`
6. **`npm run build`** po każdej zmianie w `src/` — bundle.cjs musi być aktualny

**Nowy read tool:**
1. Handler → `read-accounts.ts` (dane z Google Ads) lub `read-history.ts` (lokalne dane)
2. Query buildery / helpery → `read-helpers.ts`
3. Jeśli nowy typ encji w `list_ads_entities` → rozszerz `entitySchema` i `buildListQuery()` w `read-helpers.ts`

**Nowa funkcja client (Google Ads API):**
1. Dobierz plik wg domeny: `client/campaigns.ts`, `client/ads.ts`, `client/assets.ts`
2. Eksportuj funkcję — barrel `client/index.ts` + `client.ts` propaguje automatycznie
3. Sygnatura: `(cfg: AdsConfig, customerId: string, ...params) => Promise<unknown>`

**Konwencje:**
- Każdy prepare tool tworzy token przez `createToken()` i zwraca przez `prepareResponse()`
- Budget/CPC walidacja przez stałe z `write-schemas.ts` (MAX_BUDGET_MICROS, MAX_CPC_MICROS)
- Customer ID normalizacja: `normalizeCustomerId()` + `validateCustomer()` na początku każdego handlera
- Nie dodawaj komentarzy w kodzie — nazwy funkcji/zmiennych muszą być samodokumentujące

### Safety Hooks (`hooks/` + `scripts/`)
- `PreToolUse` on `prepare_*` → sets state to "pending"
- `UserPromptSubmit` → if pending and user message contains the LLM-selected safe word, sets state to "user-confirmed"
- `PreToolUse` on `confirm_mutation` → blocks unless "user-confirmed"
- Effect: LLM cannot call prepare + confirm in sequence without user message between them
- Hooks written in pure JS (`scripts/safety-hook.js`) — cross-platform (Windows/macOS/Linux)

### Plugin Manifests
- Claude Code: `.claude-plugin/plugin.json`
- Codex: `.codex-plugin/plugin.json` + `.mcp.json` + root `hooks.json`
- Codex marketplace: `.agents/plugins/marketplace.json` points to `./plugins/google-ads-baby`; the wrapper uses `npx @treetank/google-ads-baby` for MCP and hook commands
- Codex hook runtime currently may not activate plugin-local hooks; standalone hook package lives at `hooks/google-ads-baby-safety/hooks.json`

### Marketing-knowledge server (interim — `marketing-knowledge`)
A second MCP server wired next to `google-ads` in every MCP manifest (`.claude-plugin/plugin.json` + both `.mcp.json`). **Purpose:** a persistent marketing knowledge base that accumulates across sessions (Claude Desktop has no memory) — client profiles, a decision log, "what works" learnings, general vs per-client knowledge. Stored as **plain, human-editable markdown**.
- Backend: `@movibe/memory-bank-mcp` (Node/npx, MIT, **pinned `0.4.1`**) — an off-the-shelf server, deliberately adopted instead of writing our own.
- Sync **without OAuth**: `MARKETING_KNOWLEDGE_DIR` points at a folder inside Google Drive / OneDrive desktop sync; the sync client handles cloud + team sharing. The plugin only does local file I/O.
- **Status: interim.** Conscious trade-offs vs the rest of the family: (a) `npx` = npm cold-start (not bundled like the `google-ads` bundle.cjs), (b) memory-bank's taxonomy is software-dev shaped (`product-context`/`active-context`/`progress`/`decision-log`/`system-patterns`) — we repurpose it for marketing, (c) no full-text search.
- **Planned next step (not done yet):** domain wiring — a `confirm_mutation` hook that auto-appends confirmed mutations to a per-client decision log; possibly our own lightweight family-style server if the interim proves out.

### Two-Phase Mutation Flow
1. LLM invents a short random ASCII safe word and calls `prepare_*` with `safe_word`
2. LLM shows preview + safe word to user, asks for confirmation using that word
3. User types response containing the safe word → hook marks as confirmed
4. LLM calls `confirm_mutation(token)` → hook allows → server executes

#### Batch Mode
Multiple `prepare_*` calls can share the same `safe_word`. After one user confirmation:
- `confirm_all_mutations(tokens: [...])` executes all pending mutations sequentially
- Confirm state is consumed once for the entire batch
- Results are returned per-operation with success/failure status

### OAuth Flow & Custom App Credentials
1. LLM calls `auth_google_ads` → starts local HTTP server on port 9876
2. Browser opens `http://127.0.0.1:9876/open` → landing page with optional custom OAuth app fields
3. User can expand "I want to use my own OAuth app credentials" and enter Client ID/Secret, or use the built-in default
4. Custom credentials are saved to `config.json` and used for all subsequent OAuth flows
5. After clicking "Sign in with Google" → standard OAuth consent → callback → dev token + account selection page

## Repo & CI
- GitLab: `treetank/google-ads-baby` (origin, primary)
- GitHub: `treetank-net/google-ads-baby` (mirror, remote `gh`)
- `.gitlab-ci.yml`: mirror job pushuje `master` + tagi do GitHuba przy każdym pushu (runner tag: `vps`, wymaga `GITHUB_TREETANK_TOKEN` w CI/CD variables)

## Commands
- `cd server && npm install && npm run build` — zainstaluj zależności, skompiluj TS i zbuduj bundle
- `cd server && npm run dev` — watch mode (rebuild TS przy zmianach, bundle trzeba przebudować ręcznie)
- `cd server && npm start` — uruchom MCP server z bundle.cjs
- `cd server && npx esbuild dist/index.js --bundle --platform=node --target=node18 --format=cjs --minify --outfile=bundle.cjs` — przebuduj bundle ręcznie

## Build
1. `cd server && npm install` — zainstaluj zależności (tylko do developmentu)
2. `npx tsc` — kompilacja TS → `server/dist/` (intermediate, nie w git)
3. `npx esbuild dist/index.js --bundle --platform=node --target=node18 --format=cjs --minify --outfile=bundle.cjs` — bundle → `server/bundle.cjs` (w git, dystrybuowany)
4. Albo po prostu: `npm run build` — robi krok 2 i 3 razem

### Co jest w git, a co nie
- `server/src/` — źródła TypeScript ✓
- `server/bundle.cjs` — zbundlowany runtime (25MB, zawiera wszystkie deps) ✓
- `server/dist/` — intermediate output z tsc ✗ (w .gitignore)
- `server/node_modules/` — zależności dev ✗ (w .gitignore)

## Config
Env vars (set in plugin.json, sourced from user's environment) OR saved in `config.json` via OAuth flow:
- `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` — OAuth2 app (optional — can be set via /open page, defaults to built-in app)
- `GOOGLE_ADS_REFRESH_TOKEN` — user's OAuth2 refresh token
- `GOOGLE_ADS_DEVELOPER_TOKEN` — Google Ads API developer token
- `GOOGLE_ADS_MCC_ID` — top-level MCC account ID
- `GOOGLE_ADS_SAFETY_LEVEL` — `standard` (default), `strict`, or `off`
- `GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS` — optional server-side mutation token TTL override
- `GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS` — optional Claude hook confirmation-state TTL override

## Safety Guardrails
- Budget cap: 500 PLN/day max (configurable in `tools/write-schemas.ts`)
- GAQL mutations blocked in `execute_gaql` tool
- Token: one-shot, 1h expiry by default, server-side only
- Safety level:
  - `standard`: requires the LLM-selected safe word in a real user message between `prepare_*` and `confirm_mutation`; 1h token/state TTL
  - `strict`: same flow, but 5 min token/state TTL
  - `off`: disables the Claude hook gate; server-side prepare token is still required
- Hook: requires real user message between prepare and confirm
- MCP tool `get_safety_setup` tells the LLM/user how to install Codex safety hooks when Codex shows `No plugin hooks`
- Mutation history: every executed mutation (success/failure) is logged to `~/.google-ads-baby/mutation-history.jsonl`
  - `get_mutation_history` — browse past operations, filter by customer/action/date, includes full params + asset IDs
  - `get_mutation_stats` — summary: counts, success rate, action breakdown, recently used asset IDs

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

### Bundling — dlaczego jeden plik CJS

Problem: `npm install` przy cold start trwał 30-60s (timeout w Claude Desktop).
`google-ads-api` ciągnie ~80MB zależności (protobuf, gRPC).

- **npx z github:** — timeout 30-60s na clone + install
- **npm install w start-mcp.js** — ~2.4s po cache, ale cold start dalej za długi
- **esbuild bundle** — jeden plik CJS, 25MB, cold start 0.8s, zero zależności runtime
- ESM bundle nie działał — `google-ads-node` używa dynamic `require()`, Node rzucał `ERR_AMBIGUOUS_MODULE_SYNTAX`
- CJS bundle wymaga braku top-level await — `index.ts` zawinięty w `async function main()`

## Kolejne kroki

### Natychmiastowe
- [x] Dodać `.gitignore`
- [x] GitLab CI mirror do GitHuba (`treetank-net/google-ads-baby`)
- [x] Poprawka mutacji — `customer.campaigns.update()` / `customer.campaignBudgets.update()`
- [x] TypeScript kompiluje się bez błędów (`npm run build`)
- [x] Hooki w czystym JS — cross-platform (Windows/macOS/Linux)
- [x] Bundle CJS — cold start 0.8s zamiast 30-60s
- [x] Custom OAuth app credentials w flow autoryzacji
- [ ] Testowanie end-to-end z prawdziwym kontem Google Ads (wymaga env vars)

### Krótkoterminowe
- [ ] Testowanie end-to-end z prawdziwym kontem Google Ads (dev token w trybie testowym)
- [x] Dodać `prepare_keyword_status` — zmiana statusu keywordów (ENABLED/PAUSED/REMOVED)
- [x] Dodać `prepare_ad_status` — zmiana statusu reklam (ENABLED/PAUSED)
- [x] Dodać `prepare_demographic_bid_modifier` — korekty stawek wiek/płeć
- [x] Dodać `prepare_campaign_conversion_goals` — ustawienie PRIMARY/SECONDARY konwersji per kampania
- [x] Dodać `prepare_campaign_shared_set` — linkowanie shared negative keyword lists
- [x] Dodać `prepare_ad_schedule` — harmonogram reklam z bid modifierami
- [x] Fix: sitelink `final_urls` przeniesione na poziom asset (query params w URLach działają poprawnie)
- [ ] Dodać `prepare_ad_group_status` — pauza/wznowienie ad groupów
- [ ] Lepsze error handling w MCP server (Google Ads API errors → czytelne komunikaty po polsku)

### Średnioterminowe
- [ ] OS dialog fallback (`zenity`/`osascript`) dla klientów bez hooków — konfigurowalny w env var
- [x] Audit log — `mutation-history.jsonl` + `get_mutation_history` / `get_mutation_stats` toole
- [ ] Rate limiting — max N mutacji na minutę (server-side)
- [ ] Konfigurowalny budget cap per-account (nie globalny 500 PLN)
- [ ] Toole do tworzenia kampanii (`prepare_campaign_create`) — najczęstszy use case to nowa kampania
      na wzór istniejącej. Cache na struktury kampanii (ad groupy, keywordy, ustawienia) jako template.

### Podjęte decyzje
- **Node.js + `google-ads-api`** — TypeScript + community `google-ads-api` v23 (gRPC).
  Powód: docelowy użytkownik (marketingowiec) ma Node.js, nie ma Pythona.
  Wersja Pythonowa zachowana w historii gita (commit ccfb764).
- **Marketplace** — standalone repo, ale instalacja przez marketplace (bez marketplace niewygodnie).
- **Scope: read + manage + create** — LLM tworzy kampanie (często na wzór istniejących),
  zarządza istniejącymi, odczytuje dane. Cache na template'y kampanii.
- **Bundle CJS, nie npm publish** — plugin dystrybuowany z GitHub marketplace, `bundle.cjs` w repo.
  npm package niepotrzebny (był opublikowany jako `@treetank/google-ads-baby`, unpublished).
- **Custom OAuth app** — user może podać własne Client ID/Secret w flow autoryzacji (/open page).
  Domyślna appka jest wbudowana (desktop type, publiczne credentials per Google docs).
