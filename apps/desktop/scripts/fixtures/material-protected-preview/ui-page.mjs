export default {
 name:'material-protected-preview',entry:'./preview.tsx',viewport:{width:390,height:820},
 real:'MaterialPreviewDialog, strict reference service, dedicated renderer byte loader, PdfPreview, actual pdf.js parser/TextLayer/canvas',
 notCovered:'Controlled byte bridge; in-process pdf.js worker transport; not real main IPC/SQLite. Fixture CSP is stricter than production. Main grant validation tested separately.',
 stubs:{'src/renderer/contexts/AuthContext': 'export function useOptionalDataOwnerGeneration(){return 0;}'},
 cases:{default:{about:'Protected PDF at 320px with strict CSP; Esc restores focus',viewport:{width:320,height:820}},wide:{about:'Protected PDF at 390px',viewport:{width:390,height:820}}},
 async check(page,ui){
   const trigger=page.getByRole('button',{name:'Open protected PDF'});await trigger.focus();await page.keyboard.press('Enter');
   await page.getByRole('button',{name:await ui.t('ccAgent.materials.previewOpenInApp')}).click();
   await page.locator('.textLayer').getByText('PDF TEST').waitFor();
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('canvas')).some(c=>c.width>0&&c.height>0));
   await ui.capture('pdf-body');
   await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
   await page.waitForFunction(el=>el===document.activeElement,await trigger.elementHandle());
 },
};
