import type { AdsConfig } from './config.js';
export declare function startAuthFlow(cfg: AdsConfig): {
    url: string;
    port: number;
};
export declare function checkAuthStatus(): {
    done: boolean;
};
