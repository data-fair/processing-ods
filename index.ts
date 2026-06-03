import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ODSImportProcessingConfig as ProcessingConfig } from '#types/processingConfig/index.ts'
import { fetchOdsDatasets, fetchExistingDatasetsBySlug, applyExposure, getMetadata, downloadCSV } from './lib/utils.ts'
import { formatBytes } from '@data-fair/lib-utils/format/bytes.js'
import { createReadStream, statSync } from 'fs'
import { promisify } from 'util'
import FormData from 'form-data'

const MAX_PARALLEL = 5

type ImportResult = {
  datasetId: string
  title: string
  link: string
  success: boolean
  /** Data-Fair-generated id of the dataset (used to reference it, e.g. for related datasets). */
  dfId?: string
  /** True when the source was unchanged: metadata refreshed but the data download was skipped. */
  skipped?: boolean
  sizeBytes?: number
  error?: string
  code?: string | number
}

/** Rapport final affiché dans les logs à la fin d'un import. */
const logImportReport = async (
  log: ProcessingContext<ProcessingConfig>['log'],
  results: ImportResult[],
  totalDatasets: number
) => {
  const succeeded = results.filter(r => r.success)
  const skipped = succeeded.filter(r => r.skipped)
  const failed = results.filter(r => !r.success)
  const totalBytes = succeeded.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)

  await log.step('Rapport final')
  await log.info(`Jeux de données importés : ${succeeded.length}/${totalDatasets}`)
  if (skipped.length > 0) {
    await log.info(`dont ${skipped.length} inchangé(s) (téléchargement ignoré, métadonnées mises à jour)`)
  }
  await log.info(`Taille totale importée (compressée) : ${formatBytes(totalBytes)}`)

  if (failed.length === 0) {
    await log.info('Aucun jeu de données en erreur')
    return
  }

  await log.warning(`${failed.length} jeu(x) de données en erreur (trié par code d'erreur) :`)
  const sorted = [...failed].sort((a, b) =>
    String(a.code).localeCompare(String(b.code), undefined, { numeric: true })
  )
  for (const r of sorted) {
    await log.error(`  [${r.code}] ${r.title} — ${r.link} : ${r.error}`)
  }
}

// True when an interruption is requested for this processing.
// Set by the exported `stop` function, checked in long-running loops to exit gracefully.
let shouldBeStopped = false

// Single-quoted JS string literal, with proper escaping (used to avoid any
// double-quote in the snippet — when stored as JSON in the log "extra" field,
// double quotes get escaped to \" and break copy-paste into the browser console).
const sq = (s: string): string => {
  // eslint-disable-next-line no-control-regex -- intentionally matches control characters to escape them
  const unsafe = /[\x00-\x1F\x7F\u2028\u2029\\']/g
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
  const { processingConfig, axios, log, processingId, patchConfig } = context
  const { url: portalUrl, themes: themesMapping, licenses: licensesMapping, relatedDatasetsThreshold, publicationSite, makePublic } = processingConfig
  // One-shot exposure actions: applied to every dataset during this run, then reset at the end.
  const exposure = { publicationSite, makePublic }
  const exposureRequested = !!publicationSite || !!makePublic

  await log.step('Récupération de la liste des jeux de données ODS')
  const odsDatasets = await fetchOdsDatasets(portalUrl, axios)
  await log.info(`${odsDatasets.length} jeux de données trouvés sur le portail ODS`)

  // Index existing Data-Fair datasets by slug, so re-runs update them in place (by their
  // Data-Fair-generated id) instead of creating slug-suffixed duplicates.
  await log.step('Indexation des jeux de données déjà présents dans Data-Fair')
  const existingBySlug = await fetchExistingDatasetsBySlug(axios)
  await log.info(`${existingBySlug.size} jeux de données existants indexés (recherche par slug)`)

  await log.step('Téléchargement et upload des jeux de données')

  const activeDownloads = new Set()
  const results: ImportResult[] = []

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

    const title = odsDataset.metas?.default?.title ?? odsDataset.dataset_id
    const link = `${portalUrl}/explore/dataset/${odsDataset.dataset_id}/information/`

    const processDataset = async () => {
      // Tracks how far we got, so the error report can attribute the failure precisely.
      let stage: 'download' | 'upload' = 'download'
      try {
        const slug = odsDataset.dataset_id

        // Build metadata with theme/license mapping. getMetadata also resolves the ODS "modified"
        // date (YYYY-MM-DD) into metadata.modified, which we compare against Data-Fair below.
        const metadata = getMetadata(odsDataset, portalUrl, themesMapping, licensesMapping)

        // Existing dataset (matched by slug during the initial indexing). When present, `existing.id`
        // is the Data-Fair-generated id — we reuse it, we never push an id of our own.
        const existing = existingBySlug.get(slug)

        // Incremental import: when the dataset already exists and the ODS "modified" date is
        // unchanged, skip the (expensive) download and only refresh the metadata, so mapping
        // changes (topics, licenses…) still get applied. No ODS "modified" date → re-import.
        if (existing && metadata.modified && existing.modified === metadata.modified) {
          const metaOnly: Record<string, any> = { ...metadata }
          delete metaOnly.analysis
          delete metaOnly.schema
          delete metaOnly.slug
          await axios.patch(`api/v1/datasets/${existing.id}`, metaOnly)
          if (exposureRequested) await applyExposure(axios, log, { id: existing.id, owner: existing.owner, publicationSites: existing.publicationSites }, exposure)
          await log.info(`Inchangé (modified ${metadata.modified}) — métadonnées mises à jour, téléchargement ignoré: ${metadata.title || slug}`)
          results.push({ datasetId: slug, title, link, success: true, skipped: true, dfId: existing.id })
          return
        }

        // Download CSV
        const filePath = await downloadCSV(odsDataset, context)
        const sizeBytes = statSync(filePath).size
        stage = 'upload'

        // Tag the dataset so we can trace which processing created it.
        const body = { ...metadata, extras: { ...(metadata.extras ?? {}), processingId } }

        // Upload to Data-Fair: create with POST (Data-Fair generates the id, we only provide the
        // slug) or, when it already exists, update its data via POST on its generated id.
        const formData = new FormData()
        formData.append('file', createReadStream(filePath))
        formData.append('body', JSON.stringify(body))

        const getLength = promisify(formData.getLength.bind(formData))
        const contentLength = await getLength()

        const uploadResponse = await axios({
          method: 'post',
          url: existing ? `api/v1/datasets/${existing.id}` : 'api/v1/datasets',
          data: formData,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: {
            ...formData.getHeaders(),
            'content-length': contentLength.toString()
          }
        })

        const result = await uploadResponse.data
        await log.info(`${existing ? 'Mise à jour' : 'Création'} réussie: ${result.title} (ID: ${result.id})`)

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

        if (exposureRequested) await applyExposure(axios, log, { id: result.id, owner: result.owner, publicationSites: result.publicationSites }, exposure)

        results.push({ datasetId: odsDataset.dataset_id, title, link, success: true, sizeBytes, dfId: result.id })
      } catch (err: any) {
        const detail = err.response?.data
        const detailStr = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
        const stageLabel = stage === 'upload' ? "lors de l'upload vers Data-Fair" : 'lors du téléchargement depuis ODS'
        const code = err.response?.status ?? err.code ?? 'ERR'
        await log.error(`Erreur ${stageLabel} pour ${odsDataset.dataset_id}: ${err.message}`, detailStr)
        results.push({ datasetId: odsDataset.dataset_id, title, link, success: false, error: err.message, code })
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
    await logImportReport(log, results, totalDatasets)
    return
  }

  // Related datasets — uses ODS dataset_similarity scoring.
  if (relatedDatasetsThreshold && relatedDatasetsThreshold > 0) {
    await log.step('Construction des jeux de données liés')
    // Lookups for successfully imported datasets (reusing what we already have in memory).
    // relatedDatasets must reference datasets by their Data-Fair id, and the PATCH target is
    // addressed by its Data-Fair id too — never by the ODS slug.
    const importedTitles = new Map<string, string>()
    const slugToDfId = new Map<string, string>()
    for (const r of results) {
      if (r.success && r.dfId) slugToDfId.set(r.datasetId, r.dfId)
    }
    for (const ds of odsDatasets) {
      if (slugToDfId.has(ds.dataset_id)) {
        importedTitles.set(ds.dataset_id, ds.metas?.default?.title ?? ds.dataset_id)
      }
    }
    const targets = [...importedTitles.keys()]
    await log.info(`Recherche des jeux similaires (seuil ${relatedDatasetsThreshold}, limite 3) pour ${targets.length} jeux de données`)

    const activeRelated = new Set<string>()
    let relatedDone = 0
    let relatedWithLinks = 0
    for (const datasetId of targets) {
      if (shouldBeStopped) break
      while (activeRelated.size >= MAX_PARALLEL) {
        if (shouldBeStopped) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (shouldBeStopped) break
      activeRelated.add(datasetId)

      const processRelated = async () => {
        try {
          const params = new URLSearchParams({
            where: `not(datasetid = "${datasetId}")`,
            select: 'datasetid,score() as score',
            order_by: `dataset_similarity("${datasetId}")`,
            limit: '3'
          })
          const url = `${portalUrl}/api/explore/v2.1/catalog/datasets?${params.toString()}`
          const res = await axios.get(url)
          const matches = (res.data?.results || [])
            .filter((r: any) => typeof r.score === 'number' && r.score >= relatedDatasetsThreshold)
            .map((r: any) => r.datasetid)
            .filter((id: string) => slugToDfId.has(id))
          if (matches.length) {
            const relatedDatasets = matches.map((id: string) => ({ id: slugToDfId.get(id) as string, title: importedTitles.get(id) as string }))
            await axios.patch(`api/v1/datasets/${slugToDfId.get(datasetId)}`, { relatedDatasets })
            relatedWithLinks++
          }
        } catch (err: any) {
          const detail = err.response?.data
          const detailStr = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
          await log.error(`Erreur lors de la résolution des jeux liés pour ${datasetId}: ${err.message}`, detailStr)
        } finally {
          activeRelated.delete(datasetId)
          relatedDone++
          await log.progress('Jeux de données liés', relatedDone, targets.length)
        }
      }

      processRelated()
    }

    while (activeRelated.size > 0) await new Promise(resolve => setTimeout(resolve, 100))
    await log.info(`Jeux liés ajoutés sur ${relatedWithLinks}/${targets.length} jeux de données`)
  }

  // Reset the one-shot exposure actions so they don't replay on the next (sync) run. Only on a
  // completed run — if interrupted, we keep them so a re-run can finish (operations are idempotent).
  if (exposureRequested && !shouldBeStopped) {
    await patchConfig({ makePublic: false, publicationSite: null } as any)
    await log.info('Options de publication réinitialisées (publier sur un portail / rendre public).')
  }

  await logImportReport(log, results, totalDatasets)
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
