export function normalizeCustomerId(customerId: string): string {
  return customerId.trim().replace(/-/g, '');
}

export function requireCustomerId(customerId: string): string | null {
  const normalized = normalizeCustomerId(customerId);
  if (!normalized) return 'Brak customer_id. Wywołaj list_accounts i użyj ID konta klienta, nie MCC.';
  if (!/^\d+$/.test(normalized)) return `Nieprawidłowy customer_id "${customerId}". Użyj samych cyfr albo formatu z myślnikami.`;
  return null;
}

export function normalizeResourceId(id: string): string {
  return id.trim().replace(/-/g, '');
}
