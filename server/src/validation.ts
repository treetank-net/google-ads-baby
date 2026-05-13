export function normalizeCustomerId(customerId: string): string {
  return customerId.trim().replace(/-/g, '');
}

export function requireCustomerId(customerId: string): string | null {
  const normalized = normalizeCustomerId(customerId);
  if (!normalized) return 'Missing customer_id. Call list_accounts and use the client account ID, not the MCC.';
  if (!/^\d+$/.test(normalized)) return `Invalid customer_id "${customerId}". Use digits only or hyphenated format.`;
  return null;
}

export function normalizeResourceId(id: string): string {
  return id.trim().replace(/-/g, '');
}
