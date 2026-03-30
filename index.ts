import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './lib/types.ts'
import { fetchOdsDatasets, getMetadata, downloadCSV } from './lib/utils.ts'
import { createReadStream } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

const runAnalyse = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig: { url: portalUrl }, axios, log } = context

  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  // Themes report
  await log.step('Rapport des thématiques')
  const themeCounts = new Map<string, number>()
  for (const ds of odsDatasets) {
    for (const theme of ds.metas?.default?.theme || []) {
      themeCounts.set(theme, (themeCounts.get(theme) || 0) + 1)
    }
  }
  if (themeCounts.size === 0) {
    await log.info('Aucune thématique trouvée')
  } else {
    const sorted = [...themeCounts.entries()].sort((a, b) => b[1] - a[1])
    for (const [theme, count] of sorted) {
      await log.info(`  ${theme} : ${count} dataset(s)`)
    }
  }

  // Licenses report
  await log.step('Rapport des licences')
  const licenses = new Map<string, { title: string, href: string, count: number }>()
  for (const ds of odsDatasets) {
    if (ds.metas?.default?.license && ds.metas?.default?.license_url) {
      const key = ds.metas.default.license_url
      const existing = licenses.get(key)
      if (existing) {
        existing.count++
      } else {
        licenses.set(key, { title: ds.metas.default.license, href: ds.metas.default.license_url, count: 1 })
      }
    }
  }
  if (licenses.size === 0) {
    await log.info('Aucune licence trouvée')
  } else {
    for (const [, lic] of licenses) {
      await log.info(`  ${lic.title} (${lic.href}) : ${lic.count} dataset(s)`)
    }
  }

  // DCAT metadata report
  await log.step('Rapport des métadonnées DCAT')
  const dcatStats = { spatial: 0, temporal: 0, frequency: 0, creator: 0, modified: 0, keywords: 0 }
  for (const ds of odsDatasets) {
    if (ds.metas?.default?.keyword?.length) dcatStats.keywords++
    if (ds.metas?.default?.modified || ds.metas?.default?.metadata_processed) dcatStats.modified++
    const dcat = ds.metas?.dcat
    if (dcat) {
      if (dcat.spatial) dcatStats.spatial++
      if (dcat.temporal) dcatStats.temporal++
      if (dcat.accrualperiodicity) dcatStats.frequency++
      if (dcat.creator) dcatStats.creator++
    }
  }
  await log.info(`  keywords : ${dcatStats.keywords} dataset(s)`)
  await log.info(`  modified : ${dcatStats.modified} dataset(s)`)
  await log.info(`  spatial : ${dcatStats.spatial} dataset(s)`)
  await log.info(`  temporal : ${dcatStats.temporal} dataset(s)`)
  await log.info(`  frequency : ${dcatStats.frequency} dataset(s)`)
  await log.info(`  creator : ${dcatStats.creator} dataset(s)`)
}

const runImport = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig, axios, log } = context
  const { url: portalUrl, themes: themesMapping } = processingConfig

  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  await log.step('Téléchargement et upload des jeux de données')

  const activeDownloads = new Set()
  const results: { datasetId: string, success: boolean, error?: string }[] = []

  let completedCount = 0
  const totalDatasets = odsDatasets.length

  for (const odsDataset of odsDatasets) {
    while (activeDownloads.size >= MAX_PARALLEL) await new Promise(resolve => setTimeout(resolve, 100))
    activeDownloads.add(odsDataset.dataset_id)

    const processDataset = async () => {
      try {
        // Download CSV
        const filePath = await downloadCSV(odsDataset, context)

        // Build metadata with theme mapping
        const metadata = getMetadata(odsDataset, portalUrl, themesMapping)

        // Check if dataset already exists
        const slug = odsDataset.dataset_id
        const existingRes = await axios.get(`api/v1/datasets/${slug}`, { validateStatus: (s: number) => s === 200 || s === 404 })
        const datasetExists = existingRes.status === 200

        // Upload to Data-Fair
        const formData = new FormData()
        formData.append('file', createReadStream(filePath))
        formData.append('body', JSON.stringify(metadata))

        const getLength = promisify(formData.getLength.bind(formData))
        const contentLength = await getLength()

        const uploadResponse = await axios({
          method: datasetExists ? 'PUT' : 'POST',
          url: datasetExists ? `api/v1/datasets/${slug}` : 'api/v1/datasets',
          data: formData,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: {
            ...formData.getHeaders(),
            'content-length': contentLength.toString()
          }
        })

        const result = await uploadResponse.data
        await log.info(`${datasetExists ? 'Mise à jour' : 'Création'} réussie: ${result.title} (ID: ${result.id})`)

        // Try to set image from ODS thumbnail
        if (metadata.image) {
          try {
            const thumbRes = await axios.get(metadata.image, { responseType: 'arraybuffer', validateStatus: (s: number) => s < 400 })
            if (thumbRes.status === 200) {
              await axios.patch(`api/v1/datasets/${result.id}`, { image: metadata.image })
            }
          } catch {
            // Thumbnail not available, skip
          }
        }

        results.push({ datasetId: odsDataset.dataset_id, success: true })
      } catch (err: any) {
        await log.error(`Erreur pour ${odsDataset.dataset_id}: ${err.message}`)
        results.push({ datasetId: odsDataset.dataset_id, success: false, error: err.message })
      } finally {
        activeDownloads.delete(odsDataset.dataset_id)
        completedCount++
        await log.progress(
          'Progression globale',
          completedCount,
          totalDatasets
        )
      }
    }

    processDataset()
  }

  // Wait for all downloads to complete
  while (activeDownloads.size > 0) await new Promise(resolve => setTimeout(resolve, 100))
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  if (context.processingConfig.mode === 'analyse') {
    await runAnalyse(context)
  } else {
    await runImport(context)
  }
}
