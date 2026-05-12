export interface AdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  loginCustomerId: string;
}

export function configFromEnv(): AdsConfig {
  const required = (key: string) => {
    const val = process.env[key];
    if (!val) throw new Error(`Brak zmiennej środowiskowej: ${key}`);
    return val;
  };
  return {
    clientId: required('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: required('GOOGLE_ADS_CLIENT_SECRET'),
    developerToken: required('GOOGLE_ADS_DEVELOPER_TOKEN'),
    refreshToken: required('GOOGLE_ADS_REFRESH_TOKEN'),
    loginCustomerId: required('GOOGLE_ADS_MCC_ID'),
  };
}
