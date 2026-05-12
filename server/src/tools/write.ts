import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdsConfig, mutateCampaignStatus, mutateCampaignBudget } from '../client.js';
import { createToken, consumeToken, listPending } from '../confirm.js';

const MAX_BUDGET_MICROS = 500_000_000; // 500 PLN safety cap

export function registerWriteTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'prepare_campaign_status',
    'Prepare a campaign status change (enable/pause). Returns a preview and confirmation token. The user MUST confirm before the change is applied.',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      campaign_id: z.string().describe('Campaign ID'),
      campaign_name: z.string().describe('Campaign name (for preview)'),
      new_status: z.enum(['ENABLED', 'PAUSED']).describe('Target status'),
    },
    async ({ customer_id, campaign_id, campaign_name, new_status }) => {
      const action = new_status === 'ENABLED' ? 'Włączenie' : 'Wstrzymanie';
      const preview = `${action} kampanii "${campaign_name}" (ID: ${campaign_id}) na koncie ${customer_id}`;
      const mutation = createToken('campaign_status', { customer_id, campaign_id, new_status }, preview);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            expiresInSeconds: 60,
            instruction: 'Pokaż użytkownikowi preview i poczekaj na jego odpowiedź. Dopiero potem wywołaj confirm_mutation z tokenem.',
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
    },
    async ({ customer_id, budget_id, campaign_name, current_budget_pln, new_budget_pln }) => {
      const newMicros = Math.round(new_budget_pln * 1_000_000);
      if (newMicros > MAX_BUDGET_MICROS) {
        return {
          content: [{
            type: 'text',
            text: `Error: Budżet ${new_budget_pln} PLN przekracza limit bezpieczeństwa (${MAX_BUDGET_MICROS / 1_000_000} PLN/dzień). Zmień limit w konfiguracji serwera jeśli to celowe.`,
          }],
        };
      }
      const preview = `Zmiana budżetu kampanii "${campaign_name}": ${current_budget_pln} → ${new_budget_pln} PLN/dzień (konto ${customer_id})`;
      const mutation = createToken('budget_change', { customer_id, budget_id, amount_micros: newMicros }, preview);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            preview,
            token: mutation.token,
            expiresInSeconds: 60,
            instruction: 'Pokaż użytkownikowi preview i poczekaj na jego odpowiedź. Dopiero potem wywołaj confirm_mutation z tokenem.',
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
