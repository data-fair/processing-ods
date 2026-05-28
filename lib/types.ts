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

// Processing config
export type ProcessingConfig = {
  url: string
  mode: 'analyse' | 'import'
  haveList?: boolean
  themes?: ThemeMapping[]
  licenses?: LicenseMapping[]
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

// Minimal Data-Fair Dataset type for upload result
export type Dataset = {
  id: string;
  title: string;
}
