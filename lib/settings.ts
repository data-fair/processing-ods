import type { AccountRef, DFTopic, DFLicense } from './types.ts'
import crypto from 'crypto'

export const activateMetadataFields = async (axios: any, accountRef: AccountRef, fieldsToActivate: string[]): Promise<void> => {
  if (fieldsToActivate.length === 0) return

  const settingsUrl = `api/v1/settings/${accountRef.type}/${accountRef.id}`
  const res = await axios.get(settingsUrl)
  const settings = res.data || {}

  const metadataFields = settings.metadataFields || {}
  for (const field of fieldsToActivate) {
    metadataFields[field] = { ...metadataFields[field], active: true }
  }

  await axios.patch(settingsUrl, { metadataFields })
}

export const syncTopics = async (axios: any, accountRef: AccountRef, odsThemes: string[]): Promise<Map<string, DFTopic>> => {
  const settingsUrl = `api/v1/settings/${accountRef.type}/${accountRef.id}`
  const res = await axios.get(settingsUrl)
  const settings = res.data || {}
  const existingTopics: DFTopic[] = settings.topics || []

  const topicsMap = new Map<string, DFTopic>()
  for (const topic of existingTopics) {
    topicsMap.set(topic.title.toLowerCase(), topic)
  }

  const newTopics: DFTopic[] = []
  for (const theme of odsThemes) {
    const key = theme.toLowerCase()
    if (!topicsMap.has(key)) {
      const topic: DFTopic = {
        id: crypto.randomUUID(),
        title: theme,
      }
      topicsMap.set(key, topic)
      newTopics.push(topic)
    }
  }

  if (newTopics.length > 0) {
    await axios.patch(settingsUrl, { topics: [...existingTopics, ...newTopics] })
  }

  return topicsMap
}

export const syncLicenses = async (axios: any, accountRef: AccountRef, odsLicenses: DFLicense[]): Promise<void> => {
  const settingsUrl = `api/v1/settings/${accountRef.type}/${accountRef.id}`
  const res = await axios.get(settingsUrl)
  const settings = res.data || {}
  const existingLicenses: DFLicense[] = settings.licenses || []

  const hrefSet = new Set(existingLicenses.map(l => l.href))
  const titleSet = new Set(existingLicenses.map(l => l.title.toLowerCase()))

  const newLicenses: DFLicense[] = []
  for (const license of odsLicenses) {
    if (!hrefSet.has(license.href) && !titleSet.has(license.title.toLowerCase())) {
      newLicenses.push(license)
      hrefSet.add(license.href)
      titleSet.add(license.title.toLowerCase())
    }
  }

  if (newLicenses.length > 0) {
    await axios.patch(settingsUrl, { licenses: [...existingLicenses, ...newLicenses] })
  }
}
