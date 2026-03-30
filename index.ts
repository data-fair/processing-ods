import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig, DFLicense } from './lib/types.ts'
import { fetchOdsDatasets, getMetadata, downloadCSV } from './lib/utils.ts'
import { activateMetadataFields, syncTopics, syncLicenses } from './lib/settings.ts'
import { createReadStream } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig, axios, log } = context
  const { url: portalUrl } = processingConfig

  // 1. Account reference
  const accountRef = processingConfig.account

  // 2. Fetch all ODS datasets (paginated)
  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  // 3. Sync settings
  await log.step('Synchronisation des settings Data-Fair')

  // 3a. Detect which metadata fields are actually used and activate them
  const usedFields = new Set<string>()
  for (const ds of odsDatasets) {
    if (ds.metas?.default?.keyword?.length) usedFields.add('keywords')
    if (ds.metas?.default?.modified || ds.metas?.default?.metadata_processed) usedFields.add('modified')
    const dcat = ds.metas?.dcat
    if (dcat) {
      if (dcat.spatial) usedFields.add('spatial')
      if (dcat.temporal) usedFields.add('temporal')
      if (dcat.accrualperiodicity) usedFields.add('frequency')
      if (dcat.creator) usedFields.add('creator')
    }
  }
  await activateMetadataFields(axios, accountRef, [...usedFields])
  if (usedFields.size > 0) await log.info(`Champs de métadonnées activés : ${[...usedFields].join(', ')}`)

  // 3b. Collect unique themes and sync topics
  const allThemes = new Set<string>()
  for (const ds of odsDatasets) {
    for (const theme of ds.metas?.default?.theme || []) {
      allThemes.add(theme)
    }
  }
  const topicsMap = await syncTopics(axios, accountRef, [...allThemes])
  await log.info(`${allThemes.size} thèmes synchronisés`)

  // 3c. Collect unique licenses and sync
  const licensesMap = new Map<string, DFLicense>()
  for (const ds of odsDatasets) {
    if (ds.metas?.default?.license && ds.metas?.default?.license_url) {
      const key = ds.metas.default.license_url
      if (!licensesMap.has(key)) {
        licensesMap.set(key, { title: ds.metas.default.license, href: ds.metas.default.license_url })
      }
    }
  }
  await syncLicenses(axios, accountRef, [...licensesMap.values()])
  await log.info(`${licensesMap.size} licences synchronisées`)

  // 4. Import datasets in parallel
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

        // Build metadata with topics
        const metadata = getMetadata(odsDataset, portalUrl, topicsMap)

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
