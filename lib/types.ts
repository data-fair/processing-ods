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
