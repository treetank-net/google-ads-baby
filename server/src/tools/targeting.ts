import type { AdsConfig } from '../config.js';
import { executeGaql } from '../client.js';
import { formatError } from '../errors.js';

export interface ResolvedCriterion {
  id: string;
  label: string;
}

export interface TargetingResolution {
  error?: string;
  locations: ResolvedCriterion[];
  languages: ResolvedCriterion[];
}

export interface LanguageConstant {
  id: string;
  code: string;
  name: string;
  targetable: boolean;
}

const languagesByKey = new Map<string, LanguageConstant>();
const locationsByKey = new Map<string, ResolvedCriterion>();

let languagesLoaded = false;

export function resetTargetingCache(): void {
  languagesByKey.clear();
  locationsByKey.clear();
  languagesLoaded = false;
}

export function isNumericCriterionId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function languageKey(value: string): string {
  return value.trim().toLowerCase();
}

function locationKey(value: string): string {
  return value.trim().toUpperCase();
}

export function languageLabel(entry: LanguageConstant): string {
  return entry.code ? `${entry.name} (${entry.code})` : entry.name || entry.id;
}

export function indexLanguageRows(rows: any[]): Map<string, LanguageConstant> {
  const index = new Map<string, LanguageConstant>();
  for (const row of rows) {
    const constant = row?.language_constant;
    if (!constant?.id) continue;
    const entry: LanguageConstant = {
      id: String(constant.id),
      code: String(constant.code ?? ''),
      name: String(constant.name ?? ''),
      targetable: constant.targetable === true,
    };
    index.set(entry.id, entry);
    if (entry.code) index.set(languageKey(entry.code), entry);
  }
  return index;
}

export function indexLocationRows(rows: any[]): Map<string, ResolvedCriterion> {
  const index = new Map<string, ResolvedCriterion>();
  for (const row of rows) {
    const constant = row?.geo_target_constant;
    if (!constant?.id) continue;
    const id = String(constant.id);
    const code = String(constant.country_code ?? '');
    const targetType = String(constant.target_type ?? '');
    const isCountry = targetType.toLowerCase() === 'country';
    const suffix = isCountry ? code : [code, targetType].filter(Boolean).join(', ');
    const entry: ResolvedCriterion = {
      id,
      label: suffix ? `${constant.name ?? id} (${suffix})` : String(constant.name ?? id),
    };
    index.set(id, entry);
    if (isCountry && code) index.set(locationKey(code), entry);
  }
  return index;
}

export function matchLanguages(
  index: Map<string, LanguageConstant>,
  inputs: string[],
): { error?: string; resolved: ResolvedCriterion[] } {
  const resolved: ResolvedCriterion[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const entry = index.get(languageKey(input));
    if (!entry) {
      return {
        error:
          `Language "${input}" was not found. Pass an ISO language code such as "pl", "de" or "en", ` +
          'or a numeric language constant ID.',
        resolved: [],
      };
    }
    if (!entry.targetable) {
      return {
        error: `Language ${languageLabel(entry)} is not targetable in Google Ads, so the campaign would be rejected.`,
        resolved: [],
      };
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push({ id: entry.id, label: languageLabel(entry) });
  }
  return { resolved };
}

export function matchLocations(
  index: Map<string, ResolvedCriterion>,
  inputs: string[],
): { error?: string; resolved: ResolvedCriterion[] } {
  const resolved: ResolvedCriterion[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const trimmed = input.trim();
    const entry = index.get(isNumericCriterionId(trimmed) ? trimmed : locationKey(trimmed));
    if (!entry) {
      return {
        error:
          `Location "${input}" was not found. Pass an ISO country code such as "PL", "CZ" or "DE", ` +
          'or a numeric geo target constant ID for a region or city.',
        resolved: [],
      };
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push(entry);
  }
  return { resolved };
}

export function buildLanguageQuery(): string {
  return 'SELECT language_constant.id, language_constant.code, language_constant.name, language_constant.targetable FROM language_constant';
}

const GEO_SELECT =
  'SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code, ' +
  'geo_target_constant.target_type FROM geo_target_constant WHERE ';

export function buildCountryQuery(countryCodes: string[]): string {
  const list = countryCodes.map((code) => `'${locationKey(code).replace(/'/g, '')}'`).join(', ');
  return `${GEO_SELECT}geo_target_constant.country_code IN (${list}) AND geo_target_constant.target_type = 'Country'`;
}

export function buildGeoIdQuery(criterionIds: string[]): string {
  const list = criterionIds.map((id) => `'geoTargetConstants/${id.replace(/'/g, '')}'`).join(', ');
  return `${GEO_SELECT}geo_target_constant.resource_name IN (${list})`;
}

async function loadLanguages(cfg: AdsConfig, customerId: string): Promise<void> {
  if (languagesLoaded) return;
  const rows = (await executeGaql(cfg, customerId, buildLanguageQuery())) as any[];
  for (const [key, entry] of indexLanguageRows(rows)) languagesByKey.set(key, entry);
  languagesLoaded = true;
}

async function loadLocations(cfg: AdsConfig, customerId: string, inputs: string[]): Promise<void> {
  const pending = inputs.filter((input) => {
    const trimmed = input.trim();
    return !locationsByKey.has(isNumericCriterionId(trimmed) ? trimmed : locationKey(trimmed));
  });
  if (!pending.length) return;
  const codes = pending.filter((input) => !isNumericCriterionId(input));
  const ids = pending.filter((input) => isNumericCriterionId(input)).map((input) => input.trim());
  const queries: string[] = [];
  if (codes.length) queries.push(buildCountryQuery(codes));
  if (ids.length) queries.push(buildGeoIdQuery(ids));
  for (const query of queries) {
    const rows = (await executeGaql(cfg, customerId, query)) as any[];
    for (const [key, entry] of indexLocationRows(rows)) locationsByKey.set(key, entry);
  }
}

export async function resolveTargeting(
  cfg: AdsConfig,
  customerId: string,
  locations: string[],
  languages: string[],
): Promise<TargetingResolution> {
  const requestedLocations = locations ?? [];
  const requestedLanguages = languages ?? [];
  try {
    let resolvedLocations: ResolvedCriterion[] = [];
    if (requestedLocations.length) {
      await loadLocations(cfg, customerId, requestedLocations);
      const matched = matchLocations(locationsByKey, requestedLocations);
      if (matched.error) return { error: matched.error, locations: [], languages: [] };
      resolvedLocations = matched.resolved;
    }
    let resolvedLanguages: ResolvedCriterion[] = [];
    if (requestedLanguages.length) {
      await loadLanguages(cfg, customerId);
      const matched = matchLanguages(languagesByKey, requestedLanguages);
      if (matched.error) return { error: matched.error, locations: [], languages: [] };
      resolvedLanguages = matched.resolved;
    }
    return { locations: resolvedLocations, languages: resolvedLanguages };
  } catch (error) {
    return {
      error: `Could not verify targeting against Google Ads. ${formatError(error)}`,
      locations: [],
      languages: [],
    };
  }
}
