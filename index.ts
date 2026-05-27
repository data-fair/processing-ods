import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './lib/types.ts'
import { fetchOdsDatasets, getMetadata, downloadCSV } from './lib/utils.ts'
import { createReadStream } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

const buildTopicsSnippet = (topicTitles: string[]): string => {
  const proposed = topicTitles.map(title => ({ title }))
  return `// Sur la page Data-Fair (n'importe laquelle, vous devez être connecté), ouvrez la console du navigateur (F12) et collez ce snippet :
(async () => {
  const session = await fetch('/simple-directory/api/auth/my-session', { credentials: 'include' }).then(r => r.json()).catch(() => null);
  const account = session && session.account;
  if (!account || !account.type || !account.id) {
    console.error("Aucun compte actif détecté. Connectez-vous sur Data-Fair puis réessayez.");
    return;
  }
  const accountId = account.department ? \`\${account.id}:\${account.department}\` : account.id;
  const baseUrl = \`/data-fair/api/v1/settings/\${account.type}/\${accountId}\`;
  const settings = await fetch(baseUrl, { credentials: 'include' }).then(r => r.json());
  const proposed = ${JSON.stringify(proposed, null, 2).replace(/\n/g, '\n  ')};
  const existing = new Set((settings.topics || []).map(t => t.title));
  const toAdd = proposed.filter(t => !existing.has(t.title));
  if (!toAdd.length) {
    console.log("Aucune nouvelle thématique à ajouter.");
    return;
  }
  const res = await fetch(baseUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ topics: [...(settings.topics || []), ...toAdd] })
  });
  if (!res.ok) {
    console.error('Erreur PATCH', res.status, await res.text());
    return;
  }
  console.log(\`\${toAdd.length} thématique(s) ajoutée(s) :\`, toAdd.map(t => t.title));
})();`
}

const buildLicensesSnippet = (licenses: { title: string, href: string }[]): string => {
  return `// Sur la page Data-Fair (n'importe laquelle, vous devez être connecté), ouvrez la console du navigateur (F12) et collez ce snippet :
(async () => {
  const session = await fetch('/simple-directory/api/auth/my-session', { credentials: 'include' }).then(r => r.json()).catch(() => null);
  const account = session && session.account;
  if (!account || !account.type || !account.id) {
    console.error("Aucun compte actif détecté. Connectez-vous sur Data-Fair puis réessayez.");
    return;
  }
  const accountId = account.department ? \`\${account.id}:\${account.department}\` : account.id;
  const baseUrl = \`/data-fair/api/v1/settings/\${account.type}/\${accountId}\`;
  const settings = await fetch(baseUrl, { credentials: 'include' }).then(r => r.json());
  const proposed = ${JSON.stringify(licenses, null, 2).replace(/\n/g, '\n  ')};
  const existing = new Set((settings.licenses || []).map(l => l.href));
  const toAdd = proposed.filter(l => !existing.has(l.href));
  if (!toAdd.length) {
    console.log("Aucune nouvelle licence à ajouter.");
    return;
  }
  const res = await fetch(baseUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ licenses: [...(settings.licenses || []), ...toAdd] })
  });
  if (!res.ok) {
    console.error('Erreur PATCH', res.status, await res.text());
    return;
  }
  console.log(\`\${toAdd.length} licence(s) ajoutée(s) :\`, toAdd.map(l => l.title));
})();`
}

const runAnalyse = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig, axios, log, patchConfig } = context
  const { url: portalUrl } = processingConfig

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
    await log.info('Commande à exécuter pour créer ces thématiques dans Data-Fair disponible en extra', buildTopicsSnippet(sorted.map(([t]) => t)))
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
    const licenseList = [...licenses.values()].map(({ title, href }) => ({ title, href }))
    await log.info('Commande à exécuter pour créer ces licences dans Data-Fair disponible en extra', buildLicensesSnippet(licenseList))
  }

  // Metadata report
  await log.step('Rapport des métadonnées')
  const metaStats = { spatial: 0, temporal: 0, frequency: 0, creator: 0, modified: 0, keywords: 0 }
  for (const ds of odsDatasets) {
    if (ds.metas?.default?.keyword?.length) metaStats.keywords++
    if (ds.metas?.default?.modified || ds.metas?.default?.metadata_processed) metaStats.modified++
    const dcat = ds.metas?.dcat
    if (dcat) {
      if (dcat.spatial) metaStats.spatial++
      if (dcat.temporal) metaStats.temporal++
      if (dcat.accrualperiodicity) metaStats.frequency++
      if (dcat.creator) metaStats.creator++
    }
  }
  await log.info(`  Couverture spatiale : ${metaStats.spatial} dataset(s)`)
  await log.info(`  Couverture temporelle : ${metaStats.temporal} dataset(s)`)
  await log.info(`  Fréquence de mise à jour : ${metaStats.frequency} dataset(s)`)
  await log.info(`  Personne ou organisme créateur : ${metaStats.creator} dataset(s)`)
  await log.info(`  Date de modification de la source : ${metaStats.modified} dataset(s)`)
  await log.info(`  Mots clés : ${metaStats.keywords} dataset(s)`)

  // Switch to import mode and unlock the "Importer" action.
  await log.step('Activation du mode import')
  await patchConfig({ mode: 'import', haveList: true } as any)
  await log.info('Basculé en mode "Importer les jeux de données". Configurez le mapping des thématiques dans l\'onglet correspondant.')
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
