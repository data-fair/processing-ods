import type { DFLicense, DFTopic, LicenseMapping, ThemeMapping } from './types.ts'

const frequencyMap: Record<string, string> = {
  // ISO 8601 durations
  P1D: 'daily',
  P1W: 'weekly',
  'P0.5M': 'semimonthly',
  P1M: 'monthly',
  P3M: 'quarterly',
  P6M: 'semiannual',
  P1Y: 'annual',
  // DCAT URIs
  'http://purl.org/cld/freq/daily': 'daily',
  'http://purl.org/cld/freq/weekly': 'weekly',
  'http://purl.org/cld/freq/semimonthly': 'semimonthly',
  'http://purl.org/cld/freq/monthly': 'monthly',
  'http://purl.org/cld/freq/quarterly': 'quarterly',
  'http://purl.org/cld/freq/semiannual': 'semiannual',
  'http://purl.org/cld/freq/annual': 'annual',
  'http://purl.org/cld/freq/biennial': 'biennial',
  'http://purl.org/cld/freq/triennial': 'triennial',
  'http://purl.org/cld/freq/continuous': 'continuous',
  'http://purl.org/cld/freq/irregular': 'irregular',
}

export const mapFrequency = (isoFrequency: string | undefined): string | undefined => {
  if (!isoFrequency) return undefined
  return frequencyMap[isoFrequency]
}

export const parseTemporal = (temporal: string | undefined): { start: string, end: string } | undefined => {
  if (!temporal) return undefined
  const parts = temporal.split('/')
  if (parts.length !== 2) return undefined
  return { start: parts[0], end: parts[1] }
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
