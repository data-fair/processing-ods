import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { LicenseMapping, OdsDataset, OdsDescriptor, ThemeMapping } from './types.ts'
import type { ODSImportProcessingConfig as ProcessingConfig } from '#types/processingConfig/index.ts'
import { mapFrequency, parseTemporal, mapThemesToTopics, mapLicense, toDate } from './mappings.ts'

import path from 'path'
import fs from 'fs'

/**
 * GET an ODS resource, retrying on HTTP 429 (Too Many Requests): the ODS server rate-limits bursts,
 * so we pause and retry rather than failing the whole dataset. Only 429 is retried — other errors
 * (4xx/5xx, network) are rethrown immediately. Used for every ODS GET (listing, export, thumbnail,
 * similarity); Data-Fair calls are not wrapped.
 */
export const odsGet = async (
  axios: any,
  url: string,
  config?: any,
  opts: { log?: { warning: (msg: string) => any }, retries?: number, delayMs?: number } = {}
): Promise<any> => {
  const { log, retries = 3, delayMs = 10000 } = opts
  let attempt = 0
  while (true) {
    try {
      return await axios.get(url, config)
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      if (status !== 429 || attempt >= retries) throw err
      attempt++
      if (log) await log.warning(`429 reçu de l'API ODS — pause ${delayMs / 1000}s avant nouvelle tentative (${attempt}/${retries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

/**
 * Normalize an ODS dataset into a descriptor that abstracts over the /catalog and /shared shapes.
 * In the shared catalog every dataset_id is suffixed with `@source_domain` and the clean id lives in
 * `source_dataset`; a dataset is federated when its `source_domain` differs from `parent_domain`.
 */
export const normalizeDescriptor = (raw: OdsDataset): OdsDescriptor => {
  const def = raw.metas?.default
  const sourceDomain = def?.source_domain
  const parentDomain = def?.parent_domain
  const cleanId = def?.source_dataset || raw.dataset_id
  return {
    raw,
    fullId: raw.dataset_id,
    cleanId,
    isFederated: !!sourceDomain && !!parentDomain && sourceDomain !== parentDomain,
    sourceDomain,
    sourceDomainAddress: def?.source_domain_address,
    sourceDataset: def?.source_dataset,
  }
}

/**
 * Resolve the Data-Fair slug to push for each descriptor, keyed by `fullId`.
 *
 * Slugs default to the clean id. When the same clean id is carried by datasets of different origins
 * (local + federated, or two federated domains), keeping the clean slug for all would make them
 * collide into a single Data-Fair dataset. So on a collision the local dataset keeps the clean slug
 * and every federated dataset involved is namespaced with its source domain — mirroring how ODS
 * itself disambiguates with the `@domain` suffix.
 */
export const resolveSlugs = (descriptors: OdsDescriptor[]): Map<string, string> => {
  const byCleanId = new Map<string, OdsDescriptor[]>()
  for (const d of descriptors) {
    const list = byCleanId.get(d.cleanId) ?? []
    list.push(d)
    byCleanId.set(d.cleanId, list)
  }

  const slugs = new Map<string, string>()
  for (const [cleanId, group] of byCleanId) {
    // fullId is unique, so any group of more than one necessarily mixes origins → it's a collision.
    const collides = group.length > 1
    for (const d of group) {
      slugs.set(d.fullId, collides && d.isFederated ? `${cleanId}-${d.sourceDomain}` : cleanId)
    }
  }
  return slugs
}

export const fetchOdsDatasets = async (
  portalUrl: string,
  axios: any,
  includeFederated = false,
  log?: { warning: (msg: string) => any }
): Promise<OdsDataset[]> => {
  const datasets: OdsDataset[] = []
  const limit = 100
  let offset = 0
  // The shared catalog adds datasets federated from partner ODS portals; the plain catalog is the
  // domain's own datasets only. Some portals have no shared source, so the /shared endpoint 404s
  // ("shared source is not available for domain …"); in that case we fall back to the local catalog.
  let scope = includeFederated ? 'shared' : 'catalog'

  while (true) {
    const apiUrl = `${portalUrl}/api/explore/v2.1/${scope}/datasets?select=exclude(attachments),exclude(alternative_exports)&limit=${limit}&offset=${offset}`
    let res
    try {
      res = await odsGet(axios, apiUrl, undefined, { log })
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      if (scope === 'shared' && offset === 0 && status === 404) {
        // No shared source on this portal: warn and retry with the local catalog only.
        await log?.warning('Catalogue partagé indisponible sur ce portail : import des jeux de données fédérés ignoré, seul le catalogue local est utilisé.')
        scope = 'catalog'
        continue
      }
      throw err
    }
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
export type ExistingDataset = {
  id: string
  modified?: string
  owner?: { type?: string, id?: string, name?: string, department?: string }
  publicationSites?: string[]
}

export const fetchExistingDatasetsBySlug = async (axios: any): Promise<Map<string, ExistingDataset>> => {
  const bySlug = new Map<string, ExistingDataset>()
  const size = 1000
  let page = 1

  // owner + publicationSites are selected so the "publish" / "make public" actions can be applied
  // on the skip path (unchanged datasets) without an extra GET per dataset.
  while (true) {
    const res = await axios.get(`api/v1/datasets?size=${size}&page=${page}&select=id,slug,modified,owner,publicationSites`)
    const results = res.data?.results ?? []
    for (const ds of results) {
      if (ds.slug) bySlug.set(ds.slug, { id: ds.id, modified: ds.modified, owner: ds.owner, publicationSites: ds.publicationSites })
    }
    const count = res.data?.count ?? 0
    if (results.length < size || page * size >= count) break
    page++
  }

  return bySlug
}

type Owner = { type?: string, id?: string, name?: string, department?: string }

/**
 * Permissions equivalent to the Data-Fair UI "anyone can read" + "organization contributors can
 * update anything except breaking changes" (contribWriteNoBreaking), for a file dataset.
 * Mirrors ui-legacy/public/components/permissions.vue (setters `visibility` and `contribProfile`).
 */
export const buildPublicPermissions = (owner: Owner): any[] => {
  const publicRead = { operations: [], classes: ['list', 'read'] }
  if (owner.type !== 'organization' || !owner.id) {
    // user-owned (or unknown owner): only the public read entry is meaningful
    return [publicRead]
  }
  return [
    {
      type: 'organization',
      id: owner.id,
      department: owner.department || '-',
      name: owner.name,
      roles: ['contrib'],
      operations: ['writeData', 'cancelDraft', 'writeDescription', 'postMetadataAttachment', 'deleteMetadataAttachment'],
      classes: []
    },
    {
      type: 'organization',
      id: owner.id,
      name: owner.name,
      roles: ['contrib'],
      operations: [],
      classes: ['list', 'read', 'readAdvanced']
    },
    publicRead
  ]
}

// A permission entry we manage through the "make public" action: the public read entry, or any
// owner-organization entry. These are stripped before re-applying ours, so re-runs don't duplicate
// them while permissions set on other entities are preserved.
const isManagedPermission = (p: any, owner: Owner): boolean => {
  const isPublicRead = !p.type && (p.classes ?? []).includes('read')
  const isOwnerOrg = p.type === 'organization' && owner.type === 'organization' && p.id === owner.id
  return isPublicRead || isOwnerOrg
}

/**
 * Apply the one-shot "publish on a portal" and "make public" actions to a single dataset.
 * Errors are logged but never interrupt the import.
 */
export const applyExposure = async (
  axios: any,
  log: any,
  dataset: { id: string, owner?: Owner, publicationSites?: string[] },
  opts: { publicationSite?: string, makePublic?: boolean }
): Promise<void> => {
  const { id } = dataset

  // Publish on a portal — read-before-write merge: pushing publicationSites overwrites the whole
  // list, so we must keep the existing publications and only add the selected one.
  if (opts.publicationSite) {
    try {
      const current = Array.isArray(dataset.publicationSites) ? dataset.publicationSites : []
      if (!current.includes(opts.publicationSite)) {
        await axios.patch(`api/v1/datasets/${id}`, { publicationSites: [...current, opts.publicationSite] })
      }
    } catch (err: any) {
      const detail = err.response?.data
      await log.error(`Erreur lors de la publication sur le portail pour ${id}: ${err.message}`, typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '')
    }
  }

  // Make public — fetch current permissions, strip the ones we manage, re-apply ours, PUT.
  if (opts.makePublic) {
    try {
      const owner = dataset.owner ?? {}
      const current = (await axios.get(`api/v1/datasets/${id}/permissions`)).data ?? []
      const kept = (Array.isArray(current) ? current : []).filter((p: any) => !isManagedPermission(p, owner))
      await axios.put(`api/v1/datasets/${id}/permissions`, [...kept, ...buildPublicPermissions(owner)])
    } catch (err: any) {
      const detail = err.response?.data
      await log.error(`Erreur lors de la mise en public pour ${id}: ${err.message}`, typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '')
    }
  }
}

export const getMetadata = (
  descriptor: OdsDescriptor,
  slug: string,
  portalUrl: string,
  themesMapping?: ThemeMapping[],
  licensesMapping?: LicenseMapping[]
): Record<string, any> => {
  const odsDataset = descriptor.raw
  const dataset: Record<string, any> = {
    slug,
    title: odsDataset.metas?.default?.title ?? '',
    description: odsDataset.metas?.default?.description ?? '',
    keywords: odsDataset.metas?.default?.keyword ?? [],
    analysis: { escapeKeyAlgorithm: 'compat-ods' },
  }

  if (descriptor.isFederated && descriptor.sourceDomainAddress && descriptor.sourceDataset) {
    // Federated dataset: the provenance is the dataset's page on the portal it is federated from.
    dataset.origin = `https://${descriptor.sourceDomainAddress}/explore/dataset/${descriptor.sourceDataset}/`
  } else {
    // Origin is set only if ODS exposes an explicit source reference. The processing is meant
    // for migrations, so the ODS portal URL itself is not the provenance.
    const references = odsDataset.metas?.default?.references
    const referencesStr = Array.isArray(references) ? references.find(r => typeof r === 'string' && /^https?:\/\//.test(r)) : references
    if (typeof referencesStr === 'string' && /^https?:\/\//.test(referencesStr)) {
      dataset.origin = referencesStr
    }
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

export const downloadCSV = async (descriptor: OdsDescriptor, context: ProcessingContext<ProcessingConfig>): Promise<string> => {
  const { processingConfig: { url: portalUrl }, axios, log, tmpDir } = context

  // Federated datasets 404 on /catalog (the @domain-suffixed id only exists in the shared catalog),
  // so they must be exported through /shared. Local datasets keep the proven /catalog export.
  const url = descriptor.isFederated
    ? `${portalUrl}/api/explore/v2.1/shared/datasets/${descriptor.fullId}/exports/csv?compressed=true`
    : `${portalUrl}/api/explore/v2.1/catalog/datasets/${descriptor.cleanId}/exports/csv?compressed=true`
  const destFile = path.join(tmpDir, `${descriptor.cleanId}.csv.gz`)
  const writer = fs.createWriteStream(destFile)

  try {
    const response = await odsGet(axios, url, { responseType: 'stream' }, { log })

    let downloadedBytes = 0
    await log.task(`Téléchargement ${descriptor.cleanId}`)

    const logInterval = 500 // ms
    let lastLogged = Date.now()

    response.data.on('data', (chunk: any) => {
      downloadedBytes += chunk.length
      const now = Date.now()
      if (now - lastLogged > logInterval) {
        lastLogged = now
        log.progress(`Téléchargement ${descriptor.cleanId}`, downloadedBytes, NaN)
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
    await log.progress(`Téléchargement ${descriptor.cleanId}`, stats.size, stats.size)

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
