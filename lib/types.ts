// Data-Fair topic
export type DFTopic = {
  id?: string
  title: string
  color?: string
  icon?: object
}

// Data-Fair license
export type DFLicense = {
  title: string
  href: string
}

// Theme mapping entry (ODS theme → Data-Fair topics)
export type ThemeMapping = {
  value: string
  dataFairThemes: DFTopic[]
}

// License mapping entry (ODS license title → Data-Fair license)
export type LicenseMapping = {
  value: string
  dataFairLicense?: DFLicense
}

// Types for ODS Dataset (copied from catalog-ods)
export type OdsDataset = {
  dataset_id: string;
  dataset_uid?: string;
  attachments?: {
    mimetype?: string;
    url?: string;
    id?: string;
    title?: string;
    [k: string]: unknown;
  }[];
  has_records?: boolean;
  data_visible?: boolean;
  features?: string[];
  metas?: {
    default?: {
      title?: string;
      description?: string;
      keyword?: string[];
      license?: string;
      license_url?: string;
      theme?: string[];
      modified?: string;
      metadata_processed?: string;
      references?: string | string[];
      source_domain?: string;
      parent_domain?: string;
      source_dataset?: string;
      source_domain_address?: string;
      [k: string]: unknown;
    };
    dcat?: {
      spatial?: string;
      temporal?: string;
      accrualperiodicity?: string;
      creator?: string;
      [k: string]: unknown;
    };
    custom?: {
      [k: string]: unknown;
    };
    inspire?: {
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  fields?: {
    name?: string;
    label?: string;
    type?: string;
    annotations?: {
      [k: string]: unknown;
    };
    description?: string;
    [k: string]: unknown;
  }[];
  additionalProperties?: unknown;
}

// Normalized view of an ODS dataset, abstracting over the /catalog vs /shared shapes.
// `fullId` is the ODS dataset_id (suffixed with @domain in the shared catalog), used to address the
// dataset on its source endpoint. `cleanId` is the slug-friendly id (source_dataset when available).
export type OdsDescriptor = {
  raw: OdsDataset;
  fullId: string;
  cleanId: string;
  isFederated: boolean;
  sourceDomain?: string;
  sourceDomainAddress?: string;
  sourceDataset?: string;
}

// Minimal Data-Fair Dataset type for upload result
export type Dataset = {
  id: string;
  title: string;
}
