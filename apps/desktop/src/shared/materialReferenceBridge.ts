import type {
  MaterialsListParams, MaterialsListResult, MaterialsAddParams, MaterialsAddResult,
  MaterialAddVersionParams, MaterialAddVersionResult, MaterialRemoveReferenceParams, MaterialRemoveReferenceResult,
  MaterialRetryReadParams, MaterialRetryReadResult, MaterialPreviewParams, MaterialPreview,
  MaterialContextCreateParams, MaterialContextCreateResult, MaterialContextListParams, MaterialContextsListResult,
  MaterialRecordSourceParams, MaterialRecordSourceResult,
} from './materials';

/** Public R1 bridge only: explicit scope/observed epoch or historical locator. No actor or private storage fields. */
export interface MaterialsReferenceApi {
  list(params: MaterialsListParams): Promise<MaterialsListResult>;
  add(params: MaterialsAddParams): Promise<MaterialsAddResult>;
  addVersion(params: MaterialAddVersionParams): Promise<MaterialAddVersionResult>;
  /** 源文件被改动时，把磁盘当前内容记成新版本；内容没变则 unchanged。 */
  recordSourceVersion(params: MaterialRecordSourceParams): Promise<MaterialRecordSourceResult>;
  removeReference(params: MaterialRemoveReferenceParams): Promise<MaterialRemoveReferenceResult>;
  retryRead(params: MaterialRetryReadParams): Promise<MaterialRetryReadResult>;
  preview(params: MaterialPreviewParams): Promise<MaterialPreview>;
}
export interface MaterialContextsReferenceApi {
  create(params: MaterialContextCreateParams): Promise<MaterialContextCreateResult>;
  list(params: MaterialContextListParams): Promise<MaterialContextsListResult>;
}
export interface MaterialReferenceBridge {
  materials: MaterialsReferenceApi;
  materialContexts: MaterialContextsReferenceApi;
}
