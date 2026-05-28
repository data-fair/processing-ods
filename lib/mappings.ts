import type { DFLicense, DFTopic, LicenseMapping, ThemeMapping } from './types.ts'

// Data-Fair accepts only this enum (see types/dataset/schema.js).
// Values from ODS portals are a mix of: ISO 8601 durations, Dublin Core URIs, the data-fair enum
// values themselves, and French free-text. Normalize on lowercase and lookup.
const DF_FREQUENCIES = new Set([
  'triennial', 'biennial', 'annual', 'semiannual', 'threeTimesAYear', 'quarterly', 'bimonthly',
  'monthly', 'semimonthly', 'biweekly', 'threeTimesAMonth', 'weekly', 'semiweekly', 'threeTimesAWeek',
  'daily', 'continuous', 'irregular'
])

const frequencyMap: Record<string, string> = {
  // ISO 8601 durations
  p1d: 'daily',
  p1w: 'weekly',
  'p0.5m': 'semimonthly',
  p2w: 'biweekly',
  p1m: 'monthly',
  p2m: 'bimonthly',
  p3m: 'quarterly',
  p6m: 'semiannual',
  p1y: 'annual',
  p2y: 'biennial',
  p3y: 'triennial',
  // Dublin Core URIs (already lowercased)
  'http://purl.org/cld/freq/daily': 'daily',
  'http://purl.org/cld/freq/weekly': 'weekly',
  'http://purl.org/cld/freq/semimonthly': 'semimonthly',
  'http://purl.org/cld/freq/monthly': 'monthly',
  'http://purl.org/cld/freq/bimonthly': 'bimonthly',
  'http://purl.org/cld/freq/quarterly': 'quarterly',
  'http://purl.org/cld/freq/semiannual': 'semiannual',
  'http://purl.org/cld/freq/annual': 'annual',
  'http://purl.org/cld/freq/biennial': 'biennial',
  'http://purl.org/cld/freq/triennial': 'triennial',
  'http://purl.org/cld/freq/continuous': 'continuous',
  'http://purl.org/cld/freq/irregular': 'irregular',
  // French free-text variants seen on ODS portals
  quotidienne: 'daily',
  quotidien: 'daily',
  journalière: 'daily',
  journaliere: 'daily',
  hebdomadaire: 'weekly',
  bimensuelle: 'semimonthly',
  mensuelle: 'monthly',
  mensuel: 'monthly',
  bimestriel: 'bimonthly',
  bimestrielle: 'bimonthly',
  trimestrielle: 'quarterly',
  trimestriel: 'quarterly',
  semestrielle: 'semiannual',
  semestriel: 'semiannual',
  annuelle: 'annual',
  annuel: 'annual',
  bisannuelle: 'biennial',
  biennale: 'biennial',
  triennale: 'triennial',
  'temps réel': 'continuous',
  'temps reel': 'continuous',
  "tous les quarts d'heure": 'continuous',
  ponctuelle: 'irregular',
  ponctuel: 'irregular',
  'production unique': 'irregular',
  irrégulière: 'irregular',
  irreguliere: 'irregular',
}

export const mapFrequency = (rawFrequency: string | undefined): string | undefined => {
  if (!rawFrequency) return undefined
  // Accept the data-fair enum value as-is.
  if (DF_FREQUENCIES.has(rawFrequency)) return rawFrequency
  return frequencyMap[rawFrequency.toLowerCase().trim()]
}

// Data-Fair expects format "date" (YYYY-MM-DD), but ODS often provides full ISO datetime.
export const toDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : undefined
}

export const parseTemporal = (temporal: string | undefined): { start: string, end: string } | undefined => {
  if (!temporal) return undefined
  const parts = temporal.split('/')
  if (parts.length !== 2) return undefined
  const start = toDate(parts[0])
  const end = toDate(parts[1])
  if (!start || !end) return undefined
  return { start, end }
}

export const mapThemesToTopics = (odsThemes: string[] | undefined, mappingTable: ThemeMapping[] | undefined): DFTopic[] | undefined => {
  if (!Array.isArray(odsThemes) || odsThemes.length === 0) return undefined
  if (!Array.isArray(mappingTable) || mappingTable.length === 0) return undefined

  const topics: DFTopic[] = []

  for (const odsTheme of odsThemes) {
    const mapping = mappingTable.find((m) => m.value === odsTheme)
    if (mapping) {
      for (const dfTheme of mapping.dataFairThemes) {
        if (!topics.some(t => JSON.stringify(t) === JSON.stringify(dfTheme))) {
          topics.push(dfTheme)
        }
      }
    }
  }

  return topics.length > 0 ? topics : undefined
}

export const mapLicense = (
  odsLicenseTitle: string | undefined,
  odsLicenseUrl: string | undefined,
  mappingTable: LicenseMapping[] | undefined
): DFLicense | undefined => {
  if (!odsLicenseTitle) return undefined
  const mapping = Array.isArray(mappingTable)
    ? mappingTable.find((m) => m.value === odsLicenseTitle)
    : undefined
  if (mapping?.dataFairLicense?.title && mapping.dataFairLicense?.href) {
    return { title: mapping.dataFairLicense.title, href: mapping.dataFairLicense.href }
  }
  if (odsLicenseUrl) return { title: odsLicenseTitle, href: odsLicenseUrl }
  return undefined
}
