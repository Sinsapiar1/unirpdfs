// Web Worker para procesamiento de PDFs en background
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');

self.onmessage = async function(e) {
    const { type, data } = e.data;
    
    try {
        switch(type) {
            case 'MERGE_PDFS':
                await mergePDFs(data);
                break;
            case 'GET_PDF_INFO':
                await getPDFInfo(data);
                break;
        }
    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            error: error.message
        });
    }
};

async function mergePDFs({ files, progressCallback = true }) {
    const mergedPdf = await PDFLib.PDFDocument.create();
    let totalPages = 0;
    let processedPages = 0;
    
    // Primero calculamos el total de páginas
    const pdfDocs = [];
    for (let i = 0; i < files.length; i++) {
        const pdf = await PDFLib.PDFDocument.load(files[i]);
        pdfDocs.push(pdf);
        totalPages += pdf.getPageCount();
        
        if (progressCallback) {
            self.postMessage({
                type: 'PROGRESS',
                stage: 'loading',
                current: i + 1,
                total: files.length,
                message: `Cargando PDF ${i + 1} de ${files.length}...`
            });
        }
    }
    
    // Ahora procesamos página por página
    for (let i = 0; i < pdfDocs.length; i++) {
        const pdf = pdfDocs[i];
        const pageIndices = pdf.getPageIndices();
        
        // Procesamos en chunks para evitar bloqueos
        const chunkSize = 10; // Procesar 10 páginas a la vez
        for (let j = 0; j < pageIndices.length; j += chunkSize) {
            const chunk = pageIndices.slice(j, Math.min(j + chunkSize, pageIndices.length));
            const copiedPages = await mergedPdf.copyPages(pdf, chunk);
            
            copiedPages.forEach(page => mergedPdf.addPage(page));
            processedPages += chunk.length;
            
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'merging',
                    current: processedPages,
                    total: totalPages,
                    percentage: Math.round((processedPages / totalPages) * 100),
                    message: `Procesando páginas: ${processedPages} de ${totalPages}`
                });
            }
            
            // Pequeña pausa para permitir que otros procesos se ejecuten
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }
    
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'saving',
            current: 100,
            total: 100,
            message: 'Generando archivo final...'
        });
    }
    
    const mergedPdfFile = await mergedPdf.save();
    
    self.postMessage({
        type: 'MERGE_COMPLETE',
        data: mergedPdfFile
    });
}

async function getPDFInfo({ fileBuffer }) {
    const pdf = await PDFLib.PDFDocument.load(fileBuffer);
    
    self.postMessage({
        type: 'PDF_INFO',
        data: {
            pageCount: pdf.getPageCount(),
            title: pdf.getTitle() || 'Sin título'
        }
    });
}