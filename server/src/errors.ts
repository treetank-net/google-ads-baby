export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || String(err);
    const details = (err as any).errors;
    if (Array.isArray(details)) {
      return `Error: ${msg}\n${details.map((d: any) => `  - ${d.message || JSON.stringify(d)}`).join('\n')}`;
    }
    return `Error: ${msg}`;
  }
  return `Error: ${JSON.stringify(err)}`;
}
