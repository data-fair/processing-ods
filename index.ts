import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './lib/types.ts'
import { fetchOdsDatasets, getMetadata, downloadCSV } from './lib/utils.ts'
import { createReadStream } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

// True when an interruption is requested for this processing.
// Set by the exported `stop` function, checked in long-running loops to exit gracefully.
let shouldBeStopped = false

// Single-quoted JS string literal, with proper escaping (used to avoid any
// double-quote in the snippet — when stored as JSON in the log "extra" field,
// double quotes get escaped to \" and break copy-paste into the browser console).
const sq = (s: string): string => {
  const unsafe = new RegExp("[\\x00-\\x1F\\x7F\\u2028\\u2029\\\\']", 'g')
  const escaped = s.replace(unsafe, c => {
    if (c === '\\') return '\\\\'
    if (c === "'") return "\\'"
    if (c === '\n') return '\\n'
    if (c === '\r') return '\\r'
    if (c === '\t') return '\\t'
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  })
  return "'" + escaped + "'"
}

const buildTopicsSnippet = (topicTitles: string[]): string => {
  const proposed = '[' + topicTitles.map(t => sq(t)).join(',') + '].map(title => ({ title }))'
  return `(async () => { const session = await fetch('/simple-directory/api/auth/my-session', { credentials: 'include' }).then(r => r.json()).catch(() => null); const account = session && session.account; if (!account || !account.type || !account.id) { console.error('Aucun compte actif détecté. Connectez-vous sur Data-Fair puis réessayez.'); return; } const accountId = account.department ? \`\${account.id}:\${account.department}\` : account.id; const baseUrl = \`/data-fair/api/v1/settings/\${account.type}/\${accountId}\`; const settings = await fetch(baseUrl, { credentials: 'include' }).then(r => r.json()); const proposed = ${proposed}; const existing = new Set((settings.topics || []).map(t => t.title)); const toAdd = proposed.filter(t => !existing.has(t.title)); if (!toAdd.length) { console.log('Aucune nouvelle thématique à ajouter.'); return; } const res = await fetch(baseUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ topics: [...(settings.topics || []), ...toAdd] }) }); if (!res.ok) { console.error('Erreur PATCH', res.status, await res.text()); return; } console.log(\`\${toAdd.length} thématique(s) ajoutée(s) :\`, toAdd.map(t => t.title)); })();`
}

const buildLicensesSnippet = (licenses: { title: string, href: string }[]): string => {
  const proposed = '[' + licenses.map(l => `[${sq(l.title)},${sq(l.href)}]`).join(',') + '].map(([title, href]) => ({ title, href }))'
  return `(async () => { const session = await fetch('/simple-directory/api/auth/my-session', { credentials: 'include' }).then(r => r.json()).catch(() => null); const account = session && session.account; if (!account || !account.type || !account.id) { console.error('Aucun compte actif détecté. Connectez-vous sur Data-Fair puis réessayez.'); return; } const accountId = account.department ? \`\${account.id}:\${account.department}\` : account.id; const baseUrl = \`/data-fair/api/v1/settings/\${account.type}/\${accountId}\`; const settings = await fetch(baseUrl, { credentials: 'include' }).then(r => r.json()); const proposed = ${proposed}; const existing = new Set((settings.licenses || []).map(l => l.href)); const toAdd = proposed.filter(l => !existing.has(l.href)); if (!toAdd.length) { console.log('Aucune nouvelle licence à ajouter.'); return; } const res = await fetch(baseUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ licenses: [...(settings.licenses || []), ...toAdd] }) }); if (!res.ok) { console.error('Erreur PATCH', res.status, await res.text()); return; } console.log(\`\${toAdd.length} licence(s) ajoutée(s) :\`, toAdd.map(l => l.title)); })();`
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
  const { url: portalUrl, themes: themesMapping, licenses: licensesMapping } = processingConfig

  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  await log.step('Téléchargement et upload des jeux de données')

  const activeDownloads = new Set()
  const results: { datasetId: string, success: boolean, error?: string }[] = []

  let completedCount = 0
  const totalDatasets = odsDatasets.length

  for (const odsDataset of odsDatasets) {
    if (shouldBeStopped) break
    while (activeDownloads.size >= MAX_PARALLEL) {
      if (shouldBeStopped) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (shouldBeStopped) break
    activeDownloads.add(odsDataset.dataset_id)

    const processDataset = async () => {
      try {
        // Download CSV
        const filePath = await downloadCSV(odsDataset, context)

        // Build metadata with theme mapping
        const metadata = getMetadata(odsDataset, portalUrl, themesMapping, licensesMapping)

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

        // Image: if ODS exposes a thumbnail for this dataset, fetch it and attach it to the
        // Data-Fair dataset (we don't keep an ODS-hosted URL, since the goal is a clean migration).
        const thumbUrl = `${portalUrl}/api/explore/v2.1/catalog/datasets/${odsDataset.dataset_id}/thumbnail`
        try {
          const thumbRes = await axios.get(thumbUrl, { responseType: 'arraybuffer', validateStatus: (s: number) => s < 500 })
          const ctRaw = thumbRes.headers?.['content-type']
          const ct = typeof ctRaw === 'string' ? ctRaw : ''
          if (thumbRes.status === 200 && ct.startsWith('image/')) {
            const ext = ct.split('/')[1].split(';')[0].split('+')[0] || 'png'
            const attachmentName = `thumbnail.${ext}`
            const attachForm = new FormData()
            attachForm.append('attachment', Buffer.from(thumbRes.data), { filename: attachmentName, contentType: ct })
            const attachLen = await promisify(attachForm.getLength.bind(attachForm))()
            await axios.post(`api/v1/datasets/${result.id}/metadata-attachments`, attachForm, {
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
              headers: { ...attachForm.getHeaders(), 'content-length': attachLen.toString() }
            })
            await axios.patch(`api/v1/datasets/${result.id}`, { image: `api/v1/datasets/${result.id}/metadata-attachments/${attachmentName}` })
          }
        } catch {
          // Thumbnail not available or upload failed, skip silently
        }

        results.push({ datasetId: odsDataset.dataset_id, success: true })
      } catch (err: any) {
        const detail = err.response?.data
        const detailStr = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
        const stage = err.response ? "lors de l'upload vers Data-Fair" : 'lors du téléchargement depuis ODS'
        await log.error(`Erreur ${stage} pour ${odsDataset.dataset_id}: ${err.message}`, detailStr)
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

  // Wait for in-flight downloads/uploads to finish (so we don't leave half-written state)
  while (activeDownloads.size > 0) await new Promise(resolve => setTimeout(resolve, 100))

  if (shouldBeStopped) {
    await log.warning(`Traitement interrompu — ${completedCount}/${totalDatasets} jeux de données traités`)
  }
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  shouldBeStopped = false
  if (context.processingConfig.mode === 'analyse') {
    await runAnalyse(context)
  } else {
    await runImport(context)
  }
}

// Sets `shouldBeStopped = true` so that `run` exits gracefully at the next checkpoint.
export const stop = async () => { shouldBeStopped = true }
