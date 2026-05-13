export interface PendingMutation {
    token: string;
    action: string;
    params: Record<string, unknown>;
    preview: string;
    createdAt: number;
    safeWord: string;
}
export declare const DEFAULT_TOKEN_TTL_SECONDS: number;
export declare const DEFAULT_CONFIRM_STATE_TTL_SECONDS: number;
export declare function getTokenTtlSeconds(): number;
export declare function createToken(action: string, params: Record<string, unknown>, preview: string, safeWord: string): PendingMutation;
export declare function consumeToken(token: string): PendingMutation | null;
export declare function getPendingToken(token: string): PendingMutation | null;
export declare function consumeConfirmState(mutation: PendingMutation): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare function listPending(): PendingMutation[];
