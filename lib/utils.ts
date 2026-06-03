import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { LicenseMapping, OdsDataset, ThemeMapping } from './types.ts'
import type { ODSImportProcessingConfig as ProcessingConfig } from '#types/processingConfig/index.ts'
import { mapFrequency, parseTemporal, mapThemesToTopics, mapLicense, toDate } from './mappings.ts'

import path from 'path'
import fs from 'fs'

export const fetchOdsDatasets = async (portalUrl: string, axios: any): Promise<OdsDataset[]> => {
  const datasets: OdsDataset[] = []
  const limit = 100
  let offset = 0

  while (true) {
    const apiUrl = `${portalUrl}/api/explore/v2.1/catalog/datasets?select=exclude(attachments),exclude(alternative_exports)&limit=${limit}&offset=${offset}`
    const res = await axios.get(apiUrl)
    if (!res.data || !Array.isArray(res.data.results)) throw new Error('Réponse inattendue de l\'API ODS')
    datasets.push(...res.data.results)
    if (datasets.length >= res.data.total_count || res.data.results.length < limit) break
    offset += limit
  }

  return datasets
}

/**
 * Index the datasets already present in Data-Fair, keyed by slug.
 *
 * Data-Fair only resolves a slug in the `/datasets/{id}` URL when called from a portal, which is
 * not our case here, and the list endpoint has no slug filter. So to find a previously imported
 * dataset (and reuse its Data-Fair-generated id) without ever pushing an id ourselves, we list the
 * account's datasets once and build a slug -> { id, modified } map.
 */
export const fetchExistingDatasetsBySlug = async (axios: any): Promise<Map<string, { id: string, modified?: string }>> => {
  const bySlug = new Map<string, { id: string, modified?: string }>()
  const size = 1000
  let page = 1

  while (true) {
    const res = await axios.get(`api/v1/datasets?size=${size}&page=${page}&select=id,slug,modified`)
    const results = res.data?.results ?? []
    for (const ds of results) {
      if (ds.slug) bySlug.set(ds.slug, { id: ds.id, modified: ds.modified })
    }
    const count = res.data?.count ?? 0
    if (results.length < size || page * size >= count) break
    page++
  }

  return bySlug
}

export const getMetadata = (
  odsDataset: OdsDataset,
  portalUrl: string,
  themesMapping?: ThemeMapping[],
  licensesMapping?: LicenseMapping[]
): Record<string, any> => {
  const dataset: Record<string, any> = {
    slug: odsDataset.dataset_id,
    title: odsDataset.metas?.default?.title ?? '',
    description: odsDataset.metas?.default?.description ?? '',
    keywords: odsDataset.metas?.default?.keyword ?? [],
    analysis: { escapeKeyAlgorithm: 'compat-ods' },
  }

  // Origin is set only if ODS exposes an explicit source reference. The processing is meant
  // for migrations, so the ODS portal URL itself is not the provenance.
  const references = odsDataset.metas?.default?.references
  const referencesStr = Array.isArray(references) ? references.find(r => typeof r === 'string' && /^https?:\/\//.test(r)) : references
  if (typeof referencesStr === 'string' && /^https?:\/\//.test(referencesStr)) {
    dataset.origin = referencesStr
  }

  const license = mapLicense(
    odsDataset.metas?.default?.license,
    odsDataset.metas?.default?.license_url,
    licensesMapping
  )
  if (license) dataset.license = license

  // Topics
  const topics = mapThemesToTopics(odsDataset.metas?.default?.theme, themesMapping)
  if (topics) dataset.topics = topics

  // Modified date — Data-Fair expects format "date" (YYYY-MM-DD), ODS provides ISO datetime
  const modified = toDate(odsDataset.metas?.default?.modified || odsDataset.metas?.default?.metadata_processed)
  if (modified) dataset.modified = modified

  // DCAT metadata
  const dcat = odsDataset.metas?.dcat
  if (dcat) {
    if (dcat.spatial) dataset.spatial = dcat.spatial
    const temporal = parseTemporal(dcat.temporal)
    if (temporal) dataset.temporal = temporal
    const frequency = mapFrequency(dcat.accrualperiodicity)
    if (frequency) dataset.frequency = frequency
    if (dcat.creator) dataset.creator = dcat.creator
  }

  // Image is handled after dataset creation (try ODS thumbnail, attach to Data-Fair if hosted on ODS)

  // Schema
  const fields = odsDataset.fields || []
  const containsGeoShape = fields.some((field) => field.type === 'geo_shape')
  dataset.schema = fields.map((OdsField) => {
    const geoFormat: { [key: string]: any } = {}
    if (OdsField.type === 'geo_point_2d' && !containsGeoShape) {
      geoFormat['x-refersTo'] = 'http://www.w3.org/2003/01/geo/wgs84_pos#lat_long'
    } else if (OdsField.type === 'geo_shape') {
      geoFormat['x-refersTo'] = 'https://purl.org/geojson/vocab#geometry'
    }
    return {
      key: OdsField.name,
      description: OdsField.description ?? '',
      title: OdsField.label,
      ...geoFormat,
    }
  })

  return dataset
}

export const downloadCSV = async (odsDataset: OdsDataset, context: ProcessingContext<ProcessingConfig>): Promise<string> => {
  const { processingConfig: { url: portalUrl }, axios, log, tmpDir } = context

  const url = `${portalUrl}/api/explore/v2.1/catalog/datasets/${odsDataset.dataset_id}/exports/csv?compressed=true`
  const destFile = path.join(tmpDir, `${odsDataset.dataset_id}.csv.gz`)
  const writer = fs.createWriteStream(destFile)

  try {
    const response = await axios.get(url, { responseType: 'stream' })

    let downloadedBytes = 0
    await log.task(`Téléchargement ${odsDataset.dataset_id}`)

    const logInterval = 500 // ms
    let lastLogged = Date.now()

    response.data.on('data', (chunk: any) => {
      downloadedBytes += chunk.length
      const now = Date.now()
      if (now - lastLogged > logInterval) {
        lastLogged = now
        log.progress(`Téléchargement ${odsDataset.dataset_id}`, downloadedBytes, NaN)
      }
    })

    response.data.pipe(writer)

    const filePath = await new Promise<string>((resolve, reject) => {
      writer.on('finish', () => resolve(destFile))
      writer.on('error', (err: any) => {
        fs.unlink(destFile, () => { })
        reject(err)
      })

      response.data.on('error', (err: any) => {
        fs.unlink(destFile, () => { })
        reject(err)
      })
    })

    const stats = fs.statSync(destFile)
    await log.progress(`Téléchargement ${odsDataset.dataset_id}`, stats.size, stats.size)

    return filePath
  } catch (error: any) {
    console.error('Erreur lors de la récupération du dataset ODS (stream)', error)
    await log.error('Erreur lors de la récupération du dataset ODS (stream)', error instanceof Error ? error.message : String(error))
    const wrapped: any = new Error('Erreur pendant le téléchargement du dataset ODS en streaming')
    // Preserve the original HTTP status / network code so the final report can sort by it.
    wrapped.code = error?.response?.status ?? error?.code
    throw wrapped
  }
}
