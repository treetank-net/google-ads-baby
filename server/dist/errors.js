export function formatError(err) {
    if (err instanceof Error) {
        const msg = err.message || String(err);
        const details = err.errors;
        if (Array.isArray(details)) {
            return `Error: ${msg}\n${details.map((d) => `  - ${d.message || JSON.stringify(d)}`).join('\n')}`;
        }
        return `Error: ${msg}`;
    }
    return `Error: ${JSON.stringify(err)}`;
}
//# sourceMappingURL=errors.js.map