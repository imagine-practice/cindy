/** Read-only declaration fixture extracted from frozen actual producer AST, not a reimplementation.
 * materialExecutionInput.ts D1B3B06A2704A583803C3EF5DD5D2D076A494385D040210246903C21DEC02F43
 * materialExecutionPdf.ts 826E24C3BA834037ADB26A7F6B9A57C327016FFD80FE49FCA472D38BFBA244D2
 * No producer runtime/PDF parser is installed or claimed tested by this fixture. */
import type { AgentInputSerializedFile } from '../../../../shared/agentInputQueue';
export interface MaterialPdfCoverage {
  kind: 'extractable-text-only';
  numPages: number;
  pagesInspected: number;
  textPages: number;
  clipped: boolean;
  completeText: boolean;
  /** Exact delivered extraction (including page labels), UTF-8 hash / JS character count. */
  textSha256: string;
  textChars: number;
  characterLimit: number;
  /** Empty/scan pages cannot be distinguished without inspection/OCR. */
  pagesWithoutTextOrNotInspected: number;
  visualCoverage: 'not-assessed';
}

export type MaterialPdfCode = 'PDF_SIZE_LIMIT' | 'PDF_TIMEOUT' | 'PDF_ENCRYPTED' | 'PDF_INVALID'
  | 'PDF_PROCESS_FAILED' | 'PDF_NO_TEXT' | 'SOURCE_MISSING' | 'SOURCE_CHANGED';

export type MaterialPreparationCode =
  | 'INVALID_PARAMS' | 'PRECONDITION_FAILED' | 'FORBIDDEN' | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_MISMATCH' | 'BINDING_CONFLICT' | 'CONTEXT_SCOPE_UNKNOWN'
  | 'PURPOSE_MISMATCH' | 'SNAPSHOT_CHANGED' | 'VERSION_NOT_FOUND' | 'VERSION_CHANGED'
  | 'VERSION_NOT_READABLE' | 'SOURCE_MISSING' | 'SOURCE_CHANGED' | 'UNSUPPORTED_CONTENT' | 'INTERNAL' | MaterialPdfCode;

interface Selection {
  referenceId: string;
  materialId: string;
  version: number;
  versionId: string;
  expectedSha256: string;
}

export type PreparedMaterialItem = Selection & (
  | { status: 'prepared' | 'partial'; verifiedSha256: string; content: { kind: 'text'; text: string } | { kind: 'attachment'; file: AgentInputSerializedFile }; pdf?: MaterialPdfCoverage }
  | { status: 'unsupported' | 'failed'; code: MaterialPreparationCode; pdf?: MaterialPdfCoverage }
);
