import { it, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as odsPlugin from '../index.ts'
import catalogDatasets from './fixtures/catalog-datasets.json' with { type: 'json' }
import facetsTheme from './fixtures/facets-theme.json' with { type: 'json' }
import facetsLicense from './fixtures/facets-license.json' with { type: 'json' }

const testConfig = {
  dataFairUrl: 'http://localhost:1',
  dataFairAPIKey: 'test-key',
  adminMode: false,
  account: { type: 'organization', id: 'test-org', name: 'Test org' }
}

let server: http.Server
let portalUrl = 'http://127.0.0.1:1'

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', portalUrl)
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/explore/v2.1/catalog/datasets') return send(200, catalogDatasets)
    if (url.pathname === '/api/explore/v2.1/shared/datasets') return send(404, { message: 'shared source is not available for domain mock-portal.test' })
    if (url.pathname === '/api/explore/v2.1/catalog/facets') {
      const facet = url.searchParams.get('facet')
      if (facet === 'theme') return send(200, facetsTheme)
      if (facet === 'license') return send(200, facetsLicense)
      return send(200, { facets: [{ facets: [] }] })
    }
    return send(404, { message: 'not found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  portalUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('ODS analyse (mocked portal)', () => {
  it('runs the full analysis offline and pre-fills the mappings', async () => {
    const context = testUtils.context({
      processingConfig: {
        url: portalUrl,
        mode: 'analyse',
        includeFederated: true,
      },
    }, testConfig)

    await odsPlugin.run(context)

    assert.equal(context.processingConfig.mode, 'import')
    assert.equal(context.processingConfig.haveList, true)
    assert.deepEqual(context.processingConfig.themes, [
      { value: 'Consommation', dataFairThemes: [] },
      { value: 'Finances', dataFairThemes: [] }
    ])
    assert.deepEqual(context.processingConfig.licenses, [{ value: 'Licence Ouverte' }])
    assert.equal(context.processingConfig.makePublic, false)
  })
})
