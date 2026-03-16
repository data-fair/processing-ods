import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { OdsDataset } from './types.ts'

import path from 'path'
import fs from 'fs'

export const fetchOdsDatasets = async (portalUrl: string, axios: any): Promise<OdsDataset[]> => {
  const apiUrl = portalUrl + '/api/explore/v2.1/catalog/datasets?select=exclude(attachments),exclude(alternative_exports),exclude(fields)'
  const res = await axios.get(apiUrl)
  if (!res.data || !Array.isArray(res.data.results)) throw new Error('Réponse inattendue de l\'API ODS')
  return res.data.results
}

// Génère le body FormData pour Data-Fair à partir d'un dataset ODS (métadonnées uniquement, pas de fichier)
export const getMetadata = (odsDataset: any, portalUrl: string): Record<string, any> => {
  const dataset: Record<string, any> = {
    slug: odsDataset.dataset_id,
    title: odsDataset.metas?.default?.title ?? '',
    description: odsDataset.metas?.default?.description ?? '',
    keywords: odsDataset.metas?.default?.keyword ?? [],
    origin: portalUrl + '/explore/dataset/' + odsDataset.dataset_id,
    analysis: { escapeKeyAlgorithm: 'compat-ods' },
  }
  if (odsDataset.metas?.default?.license && odsDataset.metas?.default?.license_url) {
    dataset.license = {
      title: odsDataset.metas.default.license,
      href: odsDataset.metas.default.license_url
    }
  }
  // Génération du schéma comme dans download.ts
  const fields = odsDataset.fields || []
  const containsGeoShape = fields.some((field: any) => field.type === 'geo_shape')
  dataset.schema = fields.map((OdsField: any) => {
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
      ...geoFormat
    }
  })
  return dataset
}

export const downloadCSV = async (odsDataset: OdsDataset, context: ProcessingContext<{ url: string }>): Promise<string> => {
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
  } catch (error) {
    console.error('Erreur lors de la récupération du dataset ODS (stream)', error)
    await log.error('Erreur lors de la récupération du dataset ODS (stream)', error instanceof Error ? error.message : String(error))
    throw new Error('Erreur pendant le téléchargement du dataset ODS en streaming')
  }
}
