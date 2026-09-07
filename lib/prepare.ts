import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ODSImportProcessingConfig as ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * When the configuration is saved, move the ODS API key (used to import private datasets) out of
 * the config into the secrets store and write '********' back, so the key is never readable in the
 * stored config. An emptied field deletes the stored secret.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const apiKey = processingConfig.apiKey
  if (apiKey && apiKey !== '********') {
    secrets.apiKey = apiKey
    processingConfig.apiKey = '********'
  } else if (secrets.apiKey && apiKey === '') {
    delete secrets.apiKey
  }
  return { processingConfig, secrets }
}

export default prepare
