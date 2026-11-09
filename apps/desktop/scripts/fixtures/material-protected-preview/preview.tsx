import { useState } from 'react';
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { mountPage, forbid } from '../../ui-page/harness';
import { MaterialPreviewDialog } from '../../../src/renderer/features/materials/MaterialPreviewDialog';
import { createMaterialReferenceService } from '../../../src/renderer/features/materials/materialReferenceService';
import { Button } from '../../../src/renderer/components/ui/button';
// Real pdf.js parser/rasterizer, in-process worker transport for the strict fixture CSP.
(globalThis as unknown as {pdfjsWorker:unknown}).pdfjsWorker=pdfWorker;
const url='xdt-file://material/'+'a'.repeat(64);
const scope={projectId:'p',workItemId:'task',bindingRevision:1};
function pdfBytes(){
 const patterns:Record<string,string[]>={
 P:['11110','10001','10001','11110','10000','10000','10000'],
 D:['11110','10001','10001','10001','10001','10001','11110'],
 F:['11111','10000','10000','11110','10000','10000','10000'],
 T:['11111','00100','00100','00100','00100','00100','00100'],
 E:['11111','10000','10000','11110','10000','10000','11111'],
 S:['01111','10000','10000','01110','00001','00001','11110'],
 space:[],
 };
 const glyphs=Object.entries(patterns);
 const streams=glyphs.map(([,rows])=> '600 0 0 0 600 800 d1\n'+rows.flatMap((row,y)=>[...row].flatMap((c,x)=>c==='1'?[`${x*100} ${(6-y)*100} 100 100 re f`]:[])).join('\n'));
 const text='BT /F1 32 Tf 40 320 Td (PDF TEST) Tj ET';
 const objects=[
 '<< /Type /Catalog /Pages 2 0 R >>',
 '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 800] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << '+glyphs.map(([name],i)=>`/${name} ${i+6} 0 R`).join(' ')+' >> /Encoding << /Type /Encoding /Differences [32 /space 68 /D /E /F 80 /P 83 /S /T] >> /FirstChar 32 /LastChar 84 /Widths ['+Array(53).fill('600').join(' ')+'] /Resources << >> >>',
 `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
 ...streams.map(glyph=>`<< /Length ${glyph.length} >>\nstream\n${glyph}\nendstream`),
 ];
 let out='%PDF-1.7\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(out.length);out+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=out.length;out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))out+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 out+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return new TextEncoder().encode(out);
}
function Page(){
 const [target,setTarget]=useState<null|{referenceId:string;materialId:string;version:number;name:string}>(null);
 const [service]=useState(()=>createMaterialReferenceService(scope));
 return <><Button onClick={async()=>{await service.list();setTarget({referenceId:'r',materialId:'m',version:1,name:'protected-document.pdf'});}}>Open protected PDF</Button>
 <MaterialPreviewDialog target={target} scope={scope} service={service} onClose={()=>setTarget(null)} onInvalidate={()=>setTarget(null)} onOpenInApp={()=>{throw Error('Raw viewer fallback')}}/></>;
}
mountPage({host:()=>({localDb:{materialContexts:{},materials:{
 list:async()=>({referenceContract:1,scope,materials:[]}),
 preview:async()=>({referenceContract:1,materialId:'m',version:1,name:'protected-document.pdf',kind:'unsupported',mime:'application/pdf',size:pdfBytes().length,url}),
 readPreviewBytes:async(input:{url:string})=>{if(input.url!==url)throw Error('Unknown grant');return {bytes:pdfBytes(),mime:'application/pdf'};},
}},readFileBytes:forbid('readFileBytes')}),render:()=> <Page/>});
