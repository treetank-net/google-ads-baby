import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import {
  createAdGroup,
  createResponsiveSearchAd,
  createSearchCampaign,
  mutateCampaignBudget,
  mutateCampaignStatus,
} from '../client.js';
import { createToken, consumeToken, getTokenTtlSeconds, listPending } from '../confirm.js';
import { normalizeCustomerId, normalizeResourceId, requireCustomerId } from '../validation.js';

const MAX_BUDGET_MICROS = 500_000_000; // 500 PLN safety cap
const MAX_CPC_MICROS = 50_000_000; // 50 PLN safety cap
const safeWordSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,39}$/, 'safe_word must be one short ASCII word, 3-40 chars, no spaces');

function validationResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

function validateCustomer(customerId: string) {
  const error = requireCustomerId(customerId);
  return error ? validationResult(error) : null;
}

function normalizeSafeWord(safeWord: string): string {
  return safeWord.trim();
}

export function registerWriteTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'prepare_campaign_status',
    'Prepare a campaign status change (enable/pause). Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaign_id: z.string().describe('Campaign ID'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      new_status: z.enum(['ENABLED', 'PAUSED']).describe('Target status'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, campaign_name, new_status, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const action = new_status === 'ENABLED' ? 'Włączenie' : 'Wstrzymanie';
      const preview = `${action} kampanii "${campaign_name}" (ID: ${normalizedCampaignId}) na koncie ${normalizedCustomerId}`;
      const mutation = createToken('campaign_status', { customer_id: normalizedCustomerId, campaign_id: normalizedCampaignId, new_status }, preview, normalizeSafeWord(safe_word));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            safeWord: mutation.safeWord,
            expiresInSeconds: getTokenTtlSeconds(),
            instruction: `Pokaż użytkownikowi preview i poproś, żeby w odpowiedzi użył słowa "${mutation.safeWord}". Dopiero po takiej odpowiedzi wywołaj confirm_mutation z tokenem.`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'prepare_budget_change',
    'Prepare a campaign budget change. Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      budget_id: z.string().describe('Campaign budget resource ID'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      current_budget_pln: z.number().describe('Current daily budget in PLN'),
      new_budget_pln: z.number().describe('New daily budget in PLN'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, budget_id, campaign_name, current_budget_pln, new_budget_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const newMicros = Math.round(new_budget_pln * 1_000_000);
      if (newMicros > MAX_BUDGET_MICROS) {
        return {
          content: [{
            type: 'text',
            text: `Error: Budżet ${new_budget_pln} PLN przekracza limit bezpieczeństwa (${MAX_BUDGET_MICROS / 1_000_000} PLN/dzień).`,
          }],
        };
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedBudgetId = normalizeResourceId(budget_id);
      const preview = `Zmiana budżetu kampanii "${campaign_name}": ${current_budget_pln} -> ${new_budget_pln} PLN/dzień (konto ${normalizedCustomerId})`;
      const mutation = createToken('budget_change', { customer_id: normalizedCustomerId, budget_id: normalizedBudgetId, amount_micros: newMicros }, preview, normalizeSafeWord(safe_word));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            safeWord: mutation.safeWord,
            expiresInSeconds: getTokenTtlSeconds(),
            instruction: `Pokaż użytkownikowi preview i poproś, żeby w odpowiedzi użył słowa "${mutation.safeWord}". Dopiero po takiej odpowiedzi wywołaj confirm_mutation z tokenem.`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'prepare_search_campaign',
    'Prepare creation of a paused Search campaign with a daily budget. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_name: z.string().min(1).describe('New campaign name'),
      daily_budget_pln: z.number().positive().describe('Daily budget in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_name, daily_budget_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const budgetMicros = Math.round(daily_budget_pln * 1_000_000);
      if (budgetMicros > MAX_BUDGET_MICROS) {
        return validationResult(`Budżet ${daily_budget_pln} PLN przekracza limit bezpieczeństwa (${MAX_BUDGET_MICROS / 1_000_000} PLN/dzień).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const preview = `Utworzenie wstrzymanej kampanii Search "${campaign_name}" z budżetem ${daily_budget_pln} PLN/dzień na koncie ${normalizedCustomerId}`;
      const mutation = createToken('search_campaign_create', {
        customer_id: normalizedCustomerId,
        campaign_name,
        daily_budget_micros: budgetMicros,
      }, preview, normalizeSafeWord(safe_word));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            safeWord: mutation.safeWord,
            expiresInSeconds: getTokenTtlSeconds(),
            instruction: `Pokaż użytkownikowi preview i poproś, żeby w odpowiedzi użył słowa "${mutation.safeWord}". Dopiero po takiej odpowiedzi wywołaj confirm_mutation z tokenem.`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'prepare_ad_group',
    'Prepare creation of a paused Search ad group under an existing campaign. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      campaign_id: z.string().describe('Existing campaign ID'),
      ad_group_name: z.string().min(1).describe('New ad group name'),
      cpc_bid_pln: z.number().positive().describe('Max CPC bid in PLN; capped by server safety limit'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, campaign_id, ad_group_name, cpc_bid_pln, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const cpcMicros = Math.round(cpc_bid_pln * 1_000_000);
      if (cpcMicros > MAX_CPC_MICROS) {
        return validationResult(`Stawka CPC ${cpc_bid_pln} PLN przekracza limit bezpieczeństwa (${MAX_CPC_MICROS / 1_000_000} PLN).`);
      }
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedCampaignId = normalizeResourceId(campaign_id);
      const preview = `Utworzenie wstrzymanej grupy reklam "${ad_group_name}" w kampanii ${normalizedCampaignId}, max CPC ${cpc_bid_pln} PLN, konto ${normalizedCustomerId}`;
      const mutation = createToken('ad_group_create', {
        customer_id: normalizedCustomerId,
        campaign_id: normalizedCampaignId,
        ad_group_name,
        cpc_bid_micros: cpcMicros,
      }, preview, normalizeSafeWord(safe_word));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            safeWord: mutation.safeWord,
            expiresInSeconds: getTokenTtlSeconds(),
            instruction: `Pokaż użytkownikowi preview i poproś, żeby w odpowiedzi użył słowa "${mutation.safeWord}". Dopiero po takiej odpowiedzi wywołaj confirm_mutation z tokenem.`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'prepare_responsive_search_ad',
    'Prepare creation of a paused responsive search ad under an existing ad group. Returns a preview and confirmation token.',
    {
      customer_id: z.string().describe('Google Ads customer ID from list_accounts'),
      ad_group_id: z.string().describe('Existing ad group ID'),
      headlines: z.array(z.string().min(1)).min(3).max(15).describe('3-15 responsive search ad headlines'),
      descriptions: z.array(z.string().min(1)).min(2).max(4).describe('2-4 responsive search ad descriptions'),
      final_url: z.string().url().describe('Landing page URL'),
      safe_word: safeWordSchema.describe('LLM-invented random confirmation word, e.g. "cactus" or "orbit"; must be shown to the user'),
    },
    async ({ customer_id, ad_group_id, headlines, descriptions, final_url, safe_word }) => {
      const customerError = validateCustomer(customer_id);
      if (customerError) return customerError;
      const normalizedCustomerId = normalizeCustomerId(customer_id);
      const normalizedAdGroupId = normalizeResourceId(ad_group_id);
      const preview = [
        `Utworzenie wstrzymanej responsive search ad w grupie ${normalizedAdGroupId}, konto ${normalizedCustomerId}`,
        `Final URL: ${final_url}`,
        `Headlines: ${headlines.join(' | ')}`,
        `Descriptions: ${descriptions.join(' | ')}`,
      ].join('\n');
      const mutation = createToken('responsive_search_ad_create', {
        customer_id: normalizedCustomerId,
        ad_group_id: normalizedAdGroupId,
        headlines,
        descriptions,
        final_url,
      }, preview, normalizeSafeWord(safe_word));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            safeWord: mutation.safeWord,
            expiresInSeconds: getTokenTtlSeconds(),
            instruction: `Pokaż użytkownikowi preview i poproś, żeby w odpowiedzi użył słowa "${mutation.safeWord}". Dopiero po takiej odpowiedzi wywołaj confirm_mutation z tokenem.`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'confirm_mutation',
    'Execute a previously prepared mutation. Requires a valid, non-expired token from a prepare_* call. The user MUST have explicitly confirmed the action.',
    {
      token: z.string().describe('Confirmation token from prepare_* response'),
    },
    async ({ token }) => {
      const mutation = consumeToken(token);
      if (!mutation) {
        return {
          content: [{ type: 'text', text: 'Error: Token nieważny lub wygasł. Przygotuj operację ponownie za pomocą prepare_*.' }],
        };
      }

      try {
        const p = mutation.params as Record<string, any>;

        if (mutation.action === 'campaign_status') {
          await mutateCampaignStatus(cfg, p.customer_id, p.campaign_id, p.new_status);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — wykonano.` }] };
        }

        if (mutation.action === 'budget_change') {
          await mutateCampaignBudget(cfg, p.customer_id, p.budget_id, p.amount_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — wykonano.` }] };
        }

        if (mutation.action === 'search_campaign_create') {
          const result = await createSearchCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — wykonano.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'ad_group_create') {
          const result = await createAdGroup(cfg, p.customer_id, p.campaign_id, p.ad_group_name, p.cpc_bid_micros);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — wykonano.\n${JSON.stringify(result, null, 2)}` }] };
        }

        if (mutation.action === 'responsive_search_ad_create') {
          const result = await createResponsiveSearchAd(cfg, p.customer_id, p.ad_group_id, p.headlines, p.descriptions, p.final_url);
          return { content: [{ type: 'text', text: `OK: ${mutation.preview} — wykonano.\n${JSON.stringify(result, null, 2)}` }] };
        }

        return { content: [{ type: 'text', text: `Error: Nieznana akcja: ${mutation.action}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error: ${err.message || 'Nieznany błąd Google Ads API'}` }] };
      }
    },
  );

  server.tool(
    'list_pending_mutations',
    'List all pending (unconfirmed) mutations with their previews and tokens',
    {},
    async () => {
      const items = listPending();
      if (!items.length) {
        return { content: [{ type: 'text', text: 'Brak oczekujących operacji.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );
}
