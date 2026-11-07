// @vitest-environment jsdom
/** Regression: opaque PDF URL previously lost the action. Real Dialog -> typed service ->
 * PdfPreview -> dedicated loader. Controlled bridge/PDF engine for deterministic DOM timing;
 * native fixture separately parses/renders PDF. Unit tier, no native file reads. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({generation:0, read:vi.fn(), getDocument:vi.fn(), destroy:vi.fn()}));
vi.mock('@/contexts/AuthContext',()=>({useOptionalDataOwnerGeneration:()=>state.generation}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('pdfjs-dist',()=>({GlobalWorkerOptions:{},getDocument:state.getDocument,TextLayer:class{render(){return Promise.resolve()} cancel(){}}}));
vi.mock('@/components/chat/PreviewChrome',()=>({PreviewFooter:({children}:{children:React.ReactNode})=><div>{children}</div>,PreviewButton:({children,onClick,label}:{children:React.ReactNode;onClick:()=>void;label:string})=><button onClick={onClick} aria-label={label}>{children}</button>}));
import { MaterialPreviewDialog } from '../MaterialPreviewDialog';
import { createMaterialReferenceService } from '../materialReferenceService';
import { bridge, install, scope, deferred } from './referenceTestSupport';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PdfPreview } from '@/features/cc-agent/workdir-browse/PdfPreview';
const url=`xdt-file://material/${'a'.repeat(64)}`;
const payload={referenceContract:1,materialId:'m1',version:1,kind:'unsupported',name:'brief.pdf',mime:'application/pdf',size:100,url};
const target={referenceId:'ref-s1-7',materialId:'m1',version:1,name:'brief.pdf'};
// Initialize the real viewer once during collection, before measuring DOM behavior.
void PdfPreview;
let rawRead=vi.fn(), onClose=vi.fn();
beforeEach(()=>{
  install();state.generation=0;setDataOwnerGeneration('test',0);rawRead=vi.fn();onClose=vi.fn();
  Object.assign(bridge.materials,{readPreviewBytes:state.read});Object.assign(window.electronAPI,{readFileBytes:rawRead});
  bridge.materials.preview.mockResolvedValue(payload);
  state.read.mockReset().mockResolvedValue({bytes:new Uint8Array([37,80,68,70]),mime:'application/pdf'});
  state.getDocument.mockReset().mockImplementation(()=>({destroy:state.destroy,promise:Promise.resolve({numPages:1,destroy:state.destroy,getPage:async()=>({getViewport:()=>({width:600,height:800}),getTextContent:async()=>({items:[]})})})}));
});
afterEach(()=>{cleanup();vi.clearAllMocks()});
async function props(){const service=createMaterialReferenceService(scope());await service.list();return {service,scope:scope(),target,onClose,onInvalidate:vi.fn(),onOpenInApp:vi.fn()};}
async function open(){fireEvent.click(await screen.findByRole('button',{name:'ccAgent.materials.previewOpenInApp'}));}
it('opens the real viewer using protected bytes without a raw-path callback',async()=>{
  const p=await props();render(<MaterialPreviewDialog {...p}/>);await open();
  await waitFor(()=>expect(document.querySelector('[data-pdf-page]')).not.toBeNull());
  expect(state.read).toHaveBeenCalledWith({url});expect(state.getDocument.mock.calls[0][0].data).toEqual(new Uint8Array([37,80,68,70]));
  expect(rawRead).not.toHaveBeenCalled();expect(p.onOpenInApp).not.toHaveBeenCalled();
});
it.each(['revoked','changed','expired'])('shows a real failure for %s grants and never attempts path fallback',async reason=>{
  state.read.mockRejectedValue(Error(reason));render(<MaterialPreviewDialog {...await props()}/>);await open();
  expect(await screen.findByRole('alert')).toBeTruthy();expect(state.getDocument).not.toHaveBeenCalled();expect(rawRead).not.toHaveBeenCalled();
});
it('drops a pending byte reply on owner change before parsing',async()=>{
  const pending=deferred<{bytes:Uint8Array;mime:string}>();state.read.mockReturnValue(pending.promise);
  const p=await props();const view=render(<MaterialPreviewDialog {...p}/>);await open();
  await waitFor(()=>expect(state.read).toHaveBeenCalled());
  state.generation++;setDataOwnerGeneration('other',1);view.rerender(<MaterialPreviewDialog {...p}/>);
  await act(async()=>pending.resolve({bytes:new Uint8Array([37,80]),mime:'application/pdf'}));
  expect(state.getDocument).not.toHaveBeenCalled();expect(document.querySelector('[data-pdf-page]')).toBeNull();
});
it('clears parsed pages immediately on scope or target change and ignores late previews',async()=>{
  const p=await props(),view=render(<MaterialPreviewDialog {...p}/>);await open();
  await waitFor(()=>expect(document.querySelector('[data-pdf-page]')).not.toBeNull());
  const late=deferred<typeof payload>();bridge.materials.preview.mockReturnValue(late.promise);
  view.rerender(<MaterialPreviewDialog {...p} scope={scope('s2',8)}/>);
  expect(document.querySelector('[data-pdf-page]')).toBeNull();
  view.rerender(<MaterialPreviewDialog {...p} target={null}/>);
  await act(async()=>late.resolve(payload));expect(screen.queryByRole('dialog')).toBeNull();
});
it('shows image load errors and leaves Office unsupported',async()=>{
  bridge.materials.preview.mockResolvedValue({...payload,kind:'image',mime:'image/png'});
  const p=await props(),view=render(<MaterialPreviewDialog {...p}/>);
  fireEvent.error(await screen.findByRole('img'));expect(screen.getByText('ccAgent.materials.error.notReadable')).toBeTruthy();
  bridge.materials.preview.mockResolvedValue({...payload,mime:'application/zip'});
  view.rerender(<MaterialPreviewDialog {...p} target={{...target,name:'office.docx'}}/>);
  expect(await screen.findByText('ccAgent.materials.previewUnsupportedTitle')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'ccAgent.materials.previewOpenInApp'})).toBeNull();
});
it('rejects raw path URLs for PDFs',async()=>{
 bridge.materials.preview.mockResolvedValue({...payload,url:'xdt-file://local/?path=C:/secret.pdf'});
 render(<MaterialPreviewDialog {...await props()}/>);
 await screen.findByText('ccAgent.materials.previewUnsupportedTitle');
 expect(screen.queryByRole('button',{name:'ccAgent.materials.previewOpenInApp'})).toBeNull();expect(rawRead).not.toHaveBeenCalled();
});
