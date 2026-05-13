export interface AdsConfig {
    clientId: string;
    clientSecret: string;
    developerToken: string;
    refreshToken: string;
    loginCustomerId: string;
    safetyLevel: 'strict' | 'standard' | 'off';
    mutationTokenTtlSeconds: string;
    confirmStateTtlSeconds: string;
}
interface SavedConfig {
    clientId?: string;
    clientSecret?: string;
    developerToken?: string;
    loginCustomerId?: string;
    refreshToken?: string;
    safetyLevel?: 'strict' | 'standard' | 'off';
    mutationTokenTtlSeconds?: string;
    confirmStateTtlSeconds?: string;
    savedAt?: string;
}
export declare function getConfigPath(): string;
export declare function loadSavedConfig(): Promise<SavedConfig>;
export declare function saveConfig(config: Partial<SavedConfig>): Promise<string>;
export declare function configFromEnv(): Promise<AdsConfig>;
export {};
