import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDescriptor, resolveSlugs, getMetadata, odsGet, withRetry429, stageLabelFor, createOdsAxios, attachmentFileName, syncAttachments } from '../lib/utils.ts'
import type { OdsDataset } from '../lib/types.ts'

describe('normalizeDescriptor', () => {
  it('treats a /catalog dataset (no source_* metas) as a non-federated, clean id', () => {
    const raw = { dataset_id: 'budget-2024', metas: { default: {} } } as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'budget-2024')
    assert.equal(d.cleanId, 'budget-2024')
    assert.equal(d.isFederated, false)
  })

  it('treats a /shared own dataset (source_domain === parent_domain) as non-federated with clean source_dataset id', () => {
    const raw = {
      dataset_id: 'budget-2024@datacorsica',
      metas: { default: { source_domain: 'datacorsica', parent_domain: 'datacorsica', source_dataset: 'budget-2024' } }
    } as unknown as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'budget-2024@datacorsica')
    assert.equal(d.cleanId, 'budget-2024')
    assert.equal(d.isFederated, false)
  })

  it('detects a federated dataset (source_domain !== parent_domain) and exposes its source info', () => {
    const raw = {
      dataset_id: 'sanctuaire-pelagos@oddc-datacorsica',
      metas: {
        default: {
          source_domain: 'oddc-datacorsica',
          parent_domain: 'datacorsica',
          source_dataset: 'sanctuaire-pelagos',
          source_domain_address: 'oddc-datacorsica.opendatasoft.com'
        }
      }
    } as unknown as OdsDataset
    const d = normalizeDescriptor(raw)
    assert.equal(d.fullId, 'sanctuaire-pelagos@oddc-datacorsica')
    assert.equal(d.cleanId, 'sanctuaire-pelagos')
    assert.equal(d.isFederated, true)
    assert.equal(d.sourceDomain, 'oddc-datacorsica')
    assert.equal(d.sourceDomainAddress, 'oddc-datacorsica.opendatasoft.com')
    assert.equal(d.sourceDataset, 'sanctuaire-pelagos')
  })
})

describe('resolveSlugs', () => {
  const local = (id: string) => normalizeDescriptor({ dataset_id: id, metas: { default: {} } } as OdsDataset)
  const federated = (cleanId: string, domain: string) => normalizeDescriptor({
    dataset_id: `${cleanId}@${domain}`,
    metas: { default: { source_domain: domain, parent_domain: 'datacorsica', source_dataset: cleanId, source_domain_address: `${domain}.opendatasoft.com` } }
  } as unknown as OdsDataset)

  it('keeps clean slugs when there is no collision', () => {
    const slugs = resolveSlugs([local('a'), federated('b', 'oddc-datacorsica')])
    assert.equal(slugs.get('a'), 'a')
    assert.equal(slugs.get('b@oddc-datacorsica'), 'b')
  })

  it('keeps the local slug clean and suffixes the federated one on a local/federated collision', () => {
    const slugs = resolveSlugs([local('budget'), federated('budget', 'oddc-datacorsica')])
    assert.equal(slugs.get('budget'), 'budget')
    assert.equal(slugs.get('budget@oddc-datacorsica'), 'budget-oddc-datacorsica')
  })

  it('suffixes both federated datasets on a federated/federated collision', () => {
    const slugs = resolveSlugs([federated('parc', 'oddc-datacorsica'), federated('parc', 'autre-domaine')])
    assert.equal(slugs.get('parc@oddc-datacorsica'), 'parc-oddc-datacorsica')
    assert.equal(slugs.get('parc@autre-domaine'), 'parc-autre-domaine')
  })
})

describe('getMetadata', () => {
  it('sets origin to the source portal dataset page for a federated dataset', () => {
    const raw = {
      dataset_id: 'sanctuaire-pelagos@oddc-datacorsica',
      metas: {
        default: {
          title: 'Sanctuaire PELAGOS',
          references: 'https://georchestra.example/should-be-ignored',
          source_domain: 'oddc-datacorsica',
          parent_domain: 'datacorsica',
          source_dataset: 'sanctuaire-pelagos',
          source_domain_address: 'oddc-datacorsica.opendatasoft.com'
        }
      }
    } as unknown as OdsDataset
    const descriptor = normalizeDescriptor(raw)
    const meta = getMetadata(descriptor, 'sanctuaire-pelagos', 'https://www.data.corsica')
    assert.equal(meta.slug, 'sanctuaire-pelagos')
    assert.equal(meta.origin, 'https://oddc-datacorsica.opendatasoft.com/explore/dataset/sanctuaire-pelagos/')
  })

  it('keeps the references-based origin for a local dataset and uses the resolved slug', () => {
    const raw = {
      dataset_id: 'budget-2024',
      metas: { default: { title: 'Budget', references: 'https://example.org/source' } }
    } as unknown as OdsDataset
    const descriptor = normalizeDescriptor(raw)
    const meta = getMetadata(descriptor, 'budget-2024', 'https://www.data.corsica')
    assert.equal(meta.slug, 'budget-2024')
    assert.equal(meta.origin, 'https://example.org/source')
  })
})

describe('odsGet', () => {
  const silentLog = { warning: async () => {} }

  it('retries on 429 and returns the result once the server recovers', async () => {
    let attempts = 0
    const axios = {
      get: async () => {
        attempts++
        if (attempts < 3) { const e: any = new Error('rate limited'); e.response = { status: 429 }; throw e }
        return { data: 'ok' }
      }
    }
    const res = await odsGet(axios, 'http://ods/x', undefined, { log: silentLog, delayMs: 0 })
    assert.equal(res.data, 'ok')
    assert.equal(attempts, 3)
  })

  it('gives up after the configured number of retries and rethrows the last error', async () => {
    let attempts = 0
    const axios = { get: async () => { attempts++; const e: any = new Error('still 429'); e.status = 429; throw e } }
    await assert.rejects(
      odsGet(axios, 'http://ods/x', undefined, { log: silentLog, retries: 3, delayMs: 0 }),
      /still 429/
    )
    assert.equal(attempts, 4) // 1 initial + 3 retries
  })

  it('does not retry on a non-429 error', async () => {
    let attempts = 0
    const axios = { get: async () => { attempts++; const e: any = new Error('boom'); e.response = { status: 500 }; throw e } }
    await assert.rejects(odsGet(axios, 'http://ods/x', undefined, { log: silentLog, delayMs: 0 }), /boom/)
    assert.equal(attempts, 1)
  })
})

describe('withRetry429', () => {
  const silentLog = { warning: async () => {} }

  it('returns the result without retrying when the call succeeds', async () => {
    let attempts = 0
    const res = await withRetry429(async () => { attempts++; return 'ok' }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 1)
  })

  it('retries on 429 (err.response.status) then returns once it succeeds', async () => {
    let attempts = 0
    const res = await withRetry429(async () => {
      attempts++
      if (attempts < 3) { const e: any = new Error('rate limited'); e.response = { status: 429 }; throw e }
      return 'ok'
    }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 3)
  })

  it('detects 429 from err.status too', async () => {
    let attempts = 0
    const res = await withRetry429(async () => {
      attempts++
      if (attempts < 2) { const e: any = new Error('rate limited'); e.status = 429; throw e }
      return 'ok'
    }, { log: silentLog, delayMs: 0 })
    assert.equal(res, 'ok')
    assert.equal(attempts, 2)
  })

  it('gives up after the configured number of retries and rethrows the last error', async () => {
    let attempts = 0
    await assert.rejects(
      withRetry429(async () => { attempts++; const e: any = new Error('still 429'); e.status = 429; throw e }, { log: silentLog, retries: 3, delayMs: 0 }),
      /still 429/
    )
    assert.equal(attempts, 4) // 1 initial + 3 retries
  })

  it('does not retry a non-429 error', async () => {
    let attempts = 0
    await assert.rejects(
      withRetry429(async () => { attempts++; const e: any = new Error('boom'); e.response = { status: 500 }; throw e }, { log: silentLog, delayMs: 0 }),
      /boom/
    )
    assert.equal(attempts, 1)
  })
})

describe('createOdsAxios', () => {
  it('returns the original axios unchanged without an API key', () => {
    const axios = { get: async () => ({}) }
    assert.equal(createOdsAxios(axios), axios)
    assert.equal(createOdsAxios(axios, ''), axios)
  })

  it('injects the Apikey authorization header on ODS requests', async () => {
    let seenConfig: any = null
    const axios = { get: async (_url: string, config?: any) => { seenConfig = config; return { data: 'ok' } } }
    const odsAxios = createOdsAxios(axios, 'my-key')
    await odsAxios.get('https://ods.example.com/api/explore/v2.1/catalog/datasets')
    assert.equal(seenConfig.headers.Authorization, 'Apikey my-key')
  })

  it('preserves the rest of the request config (responseType, existing headers)', async () => {
    let seenConfig: any = null
    const axios = { get: async (_url: string, config?: any) => { seenConfig = config; return {} } }
    const odsAxios = createOdsAxios(axios, 'my-key')
    await odsAxios.get('https://ods.example.com/exports/csv', { responseType: 'stream', headers: { Accept: 'text/csv' } })
    assert.equal(seenConfig.responseType, 'stream')
    assert.equal(seenConfig.headers.Accept, 'text/csv')
    assert.equal(seenConfig.headers.Authorization, 'Apikey my-key')
  })

  it('does not mutate the wrapped axios config when no config is given', async () => {
    let seenConfig: any = null
    const axios = { get: async (_url: string, config?: any) => { seenConfig = config; return {} } }
    const odsAxios = createOdsAxios(axios, 'my-key')
    await odsAxios.get('https://ods.example.com/api/explore/v2.1/catalog/facets?facet=theme')
    assert.deepEqual(seenConfig, { headers: { Authorization: 'Apikey my-key' } })
  })
})

describe('stageLabelFor', () => {
  it('labels the download stage as an ODS download', () => {
    assert.equal(stageLabelFor('download'), 'lors du téléchargement depuis ODS')
  })

  it('labels the upload stage as a Data-Fair upload', () => {
    assert.equal(stageLabelFor('upload'), "lors de l'upload vers Data-Fair")
  })

  it('labels the metadata-refresh stage as a Data-Fair metadata update, not ODS', () => {
    assert.equal(stageLabelFor('meta'), 'lors de la mise à jour des métadonnées dans Data-Fair')
  })
})

describe('attachmentFileName', () => {
  it('keeps the ODS title when it is a file name', () => {
    assert.equal(attachmentFileName({ id: 'bp_2023_pdf', title: 'BP 2023.pdf', mimetype: 'application/pdf' }), 'BP 2023.pdf')
  })

  it('falls back to the id with an extension from the mime type', () => {
    assert.equal(attachmentFileName({ id: 'notice', title: 'Notice explicative', mimetype: 'application/pdf' }), 'notice.pdf')
  })

  it('never produces a path', () => {
    assert.equal(attachmentFileName({ id: 'x', title: 'a/b.csv' }), 'a-b.csv')
  })
})

describe('syncAttachments', () => {
  const silentLog = { warning: async () => {} }
  const odsAxios = { get: async (url: string) => ({ data: Buffer.from(url) }) }

  it('uploads only the missing files and keeps the entries not coming from ODS', async () => {
    const posted: string[] = []
    let patched: any
    const axios = {
      post: async (url: string) => { posted.push(url); return { data: { size: 3, mimetype: 'application/pdf' } } },
      patch: async (_url: string, body: any) => { patched = body; return { data: {} } }
    }
    const ods = [
      { id: 'a', title: 'A.pdf', url: 'http://ods/a', mimetype: 'application/pdf' },
      { id: 'b', title: 'B.pdf', url: 'http://ods/b', mimetype: 'application/pdf' }
    ]
    const existing = [{ type: 'file', name: 'A.pdf', title: 'A.pdf' }, { type: 'url', title: 'Site', url: 'http://site' }]
    const n = await syncAttachments(axios, odsAxios, 'ds1', ods, existing, silentLog)
    assert.equal(n, 1)
    assert.deepEqual(posted, ['api/v1/datasets/ds1/metadata-attachments'])
    assert.deepEqual(patched.attachments.map((a: any) => a.name ?? a.url), ['A.pdf', 'http://site', 'B.pdf'])
  })

  it('does nothing when every attachment is already there', async () => {
    const axios = { post: async () => { throw new Error('no upload expected') }, patch: async () => { throw new Error('no patch expected') } }
    const n = await syncAttachments(axios, odsAxios, 'ds1', [{ id: 'a', title: 'A.pdf', url: 'http://ods/a' }], [{ type: 'file', name: 'A.pdf', title: 'A.pdf' }], silentLog)
    assert.equal(n, 0)
  })

  it('warns instead of failing when a download fails', async () => {
    const warnings: string[] = []
    const failing = { get: async () => { const e: any = new Error('gone'); e.response = { status: 404 }; throw e } }
    const axios = { post: async () => ({ data: {} }), patch: async () => ({ data: {} }) }
    const n = await syncAttachments(axios, failing, 'ds1', [{ id: 'a', title: 'A.pdf', url: 'http://ods/a' }], [], { warning: async (m: string) => { warnings.push(m) } })
    assert.equal(n, 0)
    assert.equal(warnings.length, 1)
  })
})
