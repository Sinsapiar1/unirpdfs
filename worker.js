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
            case 'ANALYZE_PDF':
                await analyzePDF(data);
                break;
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'ERROR',
            error: getErrorMessage(error)
        });
    }
};

// Función para obtener mensajes de error más informativos
function getErrorMessage(error) {
    const errorStr = error.toString();
    
    if (errorStr.includes('encrypted')) {
        return 'PDF protegido con contraseña detectado. Intentando cargar sin encriptación...';
    } else if (errorStr.includes('Invalid PDF')) {
        return 'Archivo PDF corrupto o inválido detectado.';
    } else if (errorStr.includes('out of memory') || errorStr.includes('Maximum call stack')) {
        return 'Archivo demasiado grande para procesar. Intenta con archivos más pequeños.';
    } else if (errorStr.includes('network') || errorStr.includes('fetch')) {
        return 'Error de conexión. Verifica tu conexión a internet.';
    } else {
        return `Error de procesamiento: ${error.message || error}`;
    }
}

// Función para intentar cargar PDFs con diferentes opciones
async function loadPDFWithOptions(fileBuffer) {
    let pdf = null;
    let loadOptions = {};
    
    try {
        // Intento 1: Carga normal
        pdf = await PDFLib.PDFDocument.load(fileBuffer);
        return { pdf, encrypted: false, corrupted: false };
    } catch (error) {
        if (error.toString().includes('encrypted')) {
            try {
                // Intento 2: Ignorar encriptación
                loadOptions = { ignoreEncryption: true };
                pdf = await PDFLib.PDFDocument.load(fileBuffer, loadOptions);
                return { pdf, encrypted: true, corrupted: false };
            } catch (encryptedError) {
                throw new Error(`PDF encriptado no se puede procesar: ${encryptedError.message}`);
            }
        } else if (error.toString().includes('Invalid PDF')) {
            throw new Error('El archivo no es un PDF válido o está corrupto');
        } else {
            throw error;
        }
    }
}

async function mergePDFs({ files, progressCallback = true }) {
    const mergedPdf = await PDFLib.PDFDocument.create();
    let totalPages = 0;
    let processedPages = 0;
    const pdfDocs = [];
    const fileAnalysis = [];
    
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'analyzing',
            current: 0,
            total: files.length,
            message: 'Analizando archivos PDF...'
        });
    }
    
    // Primero analizamos y cargamos todos los PDFs
    for (let i = 0; i < files.length; i++) {
        try {
            const result = await loadPDFWithOptions(files[i]);
            const { pdf, encrypted, corrupted } = result;
            
            pdfDocs.push(pdf);
            fileAnalysis.push({ encrypted, corrupted, pages: pdf.getPageCount() });
            totalPages += pdf.getPageCount();
            
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'analyzing',
                    current: i + 1,
                    total: files.length,
                    message: `Analizando archivo ${i + 1} de ${files.length}${encrypted ? ' (encriptado)' : ''}...`
                });
            }
            
        } catch (error) {
            throw new Error(`Error en archivo ${i + 1}: ${error.message}`);
        }
    }
    
    // Informar sobre archivos encriptados encontrados
    const encryptedCount = fileAnalysis.filter(f => f.encrypted).length;
    if (encryptedCount > 0 && progressCallback) {
        self.postMessage({
            type: 'WARNING',
            message: `Se encontraron ${encryptedCount} archivo(s) encriptado(s). Se procesarán sin protección.`
        });
    }
    
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'loading',
            current: files.length,
            total: files.length,
            message: `Todos los archivos analizados. Total: ${totalPages} páginas`
        });
    }
    
    // Ahora procesamos página por página con chunks adaptativos
    const adaptiveChunkSize = totalPages > 1000 ? 5 : totalPages > 500 ? 10 : 20;
    
    for (let i = 0; i < pdfDocs.length; i++) {
        const pdf = pdfDocs[i];
        const pageIndices = pdf.getPageIndices();
        const isEncrypted = fileAnalysis[i].encrypted;
        
        // Procesamos en chunks adaptativos
        for (let j = 0; j < pageIndices.length; j += adaptiveChunkSize) {
            const chunk = pageIndices.slice(j, Math.min(j + adaptiveChunkSize, pageIndices.length));
            
            try {
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
                        message: `Procesando páginas: ${processedPages} de ${totalPages}${isEncrypted ? ' (archivo encriptado)' : ''}`
                    });
                }
                
                // Pausa adaptativa basada en el tamaño del documento
                const pauseTime = totalPages > 1000 ? 10 : totalPages > 500 ? 7 : 5;
                await new Promise(resolve => setTimeout(resolve, pauseTime));
                
            } catch (chunkError) {
                console.warn(`Error procesando chunk en archivo ${i + 1}:`, chunkError);
                // Intentar procesar página por página en caso de error
                for (const pageIndex of chunk) {
                    try {
                        const copiedPages = await mergedPdf.copyPages(pdf, [pageIndex]);
                        copiedPages.forEach(page => mergedPdf.addPage(page));
                        processedPages++;
                    } catch (pageError) {
                        console.warn(`Página ${pageIndex + 1} omitida por error:`, pageError);
                        // Continuar con la siguiente página
                    }
                }
            }
        }
    }
    
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'saving',
            current: 100,
            total: 100,
            message: `Generando archivo final con ${processedPages} páginas...`
        });
    }
    
    try {
        const mergedPdfFile = await mergedPdf.save({
            useObjectStreams: false, // Mejor compatibilidad
            addDefaultPage: false,
            objectStreamsThreshold: 0
        });
        
        self.postMessage({
            type: 'MERGE_COMPLETE',
            data: mergedPdfFile,
            stats: {
                totalFiles: files.length,
                totalPages: processedPages,
                encryptedFiles: encryptedCount,
                fileSize: mergedPdfFile.length
            }
        });
        
    } catch (saveError) {
        throw new Error(`Error al guardar el PDF final: ${saveError.message}`);
    }
}

// Función para analizar un PDF individual
async function analyzePDF({ fileBuffer, fileName }) {
    try {
        const result = await loadPDFWithOptions(fileBuffer);
        const { pdf, encrypted, corrupted } = result;
        
        self.postMessage({
            type: 'PDF_ANALYSIS',
            data: {
                fileName,
                pageCount: pdf.getPageCount(),
                encrypted,
                corrupted,
                title: pdf.getTitle() || 'Sin título',
                fileSize: fileBuffer.length,
                canProcess: true
            }
        });
        
    } catch (error) {
        self.postMessage({
            type: 'PDF_ANALYSIS',
            data: {
                fileName,
                error: error.message,
                canProcess: false
            }
        });
    }
}

async function getPDFInfo({ fileBuffer }) {
    try {
        const result = await loadPDFWithOptions(fileBuffer);
        const { pdf, encrypted } = result;
        
        self.postMessage({
            type: 'PDF_INFO',
            data: {
                pageCount: pdf.getPageCount(),
                title: pdf.getTitle() || 'Sin título',
                encrypted
            }
        });
    } catch (error) {
        self.postMessage({
            type: 'PDF_INFO_ERROR',
            error: error.message
        });
    }
}