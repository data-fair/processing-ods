import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import { fetchOdsDatasets, getMetadata, downloadCSV } from './lib/utils.ts'
import { createReadStream } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

export const run = async (context: ProcessingContext<{ url: string }>) => {
  const { processingConfig: { url: portalUrl }, axios, log } = context

  // 1. Récupérer la liste des jeux de données ODS
  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets: any[] = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  // 2. Télécharger et uploader en parallèle
  await log.step('Téléchargement et upload des jeux de données')

  const activeDownloads = new Set()
  const results: { datasetId: string; success: boolean; error?: string }[] = []

  let completedCount = 0
  const totalDatasets = odsDatasets.length

  for (const odsDataset of odsDatasets) {
    // Attendre qu'une place se libère si on a atteint la limite
    while (activeDownloads.size >= MAX_PARALLEL) await new Promise(resolve => setTimeout(resolve, 100))
    activeDownloads.add(odsDataset.dataset_id)

    // Télécharger et uploader en série
    const processDataset = async () => {
      try {
        // 3.1 Télécharger le fichier en flux
        const filePath = await downloadCSV(odsDataset, context)

        // 3.2 Uploader sur Data-Fair
        const formData = new FormData()
        formData.append('file', createReadStream(filePath))
        formData.append('body', JSON.stringify(getMetadata(odsDataset, portalUrl)))

        const getLength = promisify(formData.getLength.bind(formData))
        const contentLength = await getLength()

        const uploadResponse = await axios({
          method: 'POST',
          url: 'api/v1/datasets',
          data: formData,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: {
            ...formData.getHeaders(),
            'content-length': contentLength.toString()
          }
        })

        const result = await uploadResponse.data
        await log.info(`Upload réussi: ${result.title} (ID: ${result.id})`)

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

  // Attendre que tous les téléchargements soient terminés
  while (activeDownloads.size > 0) await new Promise(resolve => setTimeout(resolve, 100))
}
