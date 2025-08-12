// Web Worker para procesamiento de PDFs en background
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');

// Configurar PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

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
    } else if (errorStr.includes('Expected instance of')) {
        return 'PDF severamente corrupto. Usando método de recuperación alternativo...';
    } else {
        return `Error de procesamiento: ${error.message || error}`;
    }
}

// Función para intentar cargar PDFs con diferentes opciones
async function loadPDFWithOptions(fileBuffer) {
    // Lista de opciones para intentar en orden
    const loadAttempts = [
        // Intento 1: Carga normal
        {},
        // Intento 2: Ignorar encriptación
        { ignoreEncryption: true },
        // Intento 3: Actualizar referencias cruzadas y ignorar encriptación
        { ignoreEncryption: true, updateXRefTable: true },
        // Intento 4: Modo de recuperación total
        { ignoreEncryption: true, updateXRefTable: true, parseSpeed: 1 }
    ];
    
    let lastError = null;
    
    for (let i = 0; i < loadAttempts.length; i++) {
        try {
            const loadOptions = loadAttempts[i];
            const pdf = await PDFLib.PDFDocument.load(fileBuffer, loadOptions);
            
            const encrypted = loadOptions.ignoreEncryption === true;
            const recovered = i > 1;
            
            return { 
                pdf, 
                encrypted, 
                corrupted: recovered,
                attemptUsed: i + 1,
                method: 'pdf-lib'
            };
            
        } catch (error) {
            lastError = error;
            console.warn(`PDF-lib intento ${i + 1} fallido:`, error.message);
        }
    }
    
    // Si pdf-lib falló completamente, intentar con PDF.js como fallback
    console.log('PDF-lib falló, intentando con PDF.js...');
    try {
        const pdfDoc = await pdfjsLib.getDocument({ 
            data: fileBuffer,
            stopAtErrors: false,
            maxImageSize: 1024 * 1024,
            disableFontFace: true,
            verbosity: 0
        }).promise;
        
        return {
            pdf: pdfDoc,
            encrypted: false,
            corrupted: true,
            attemptUsed: 5,
            method: 'pdf.js'
        };
        
    } catch (pdfjsError) {
        console.error('PDF.js también falló:', pdfjsError);
        throw new Error(`PDF severamente corrupto, no se puede procesar con ningún método.`);
    }
}

// Función para convertir página de PDF.js a imagen y luego a PDF-lib
async function convertPdfjsPageToPdflib(pdfDoc, pageNum, targetPdf) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 }); // Escala más alta para mejor calidad
        
        // Crear canvas para renderizar
        const canvas = new OffscreenCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        
        // Renderizar página
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        // Convertir canvas a blob
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const imageBytes = await blob.arrayBuffer();
        
        // Crear página en PDF-lib con la imagen
        const image = await targetPdf.embedPng(imageBytes);
        const newPage = targetPdf.addPage([viewport.width, viewport.height]);
        newPage.drawImage(image, {
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
        });
        
        return true;
    } catch (error) {
        console.warn(`Error convirtiendo página ${pageNum}:`, error);
        return false;
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
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'analyzing',
                    current: i,
                    total: files.length,
                    message: `Analizando archivo ${i + 1} de ${files.length}...`
                });
            }
            
            const result = await loadPDFWithOptions(files[i]);
            const { pdf, encrypted, corrupted, attemptUsed, method } = result;
            
            pdfDocs.push(pdf);
            
            let pageCount;
            if (method === 'pdf.js') {
                pageCount = pdf.numPages;
            } else {
                pageCount = pdf.getPageCount();
            }
            
            fileAnalysis.push({ 
                encrypted, 
                corrupted, 
                pages: pageCount, 
                attemptUsed, 
                method 
            });
            totalPages += pageCount;
            
            let statusMsg = '';
            if (method === 'pdf.js') {
                statusMsg = ' (recuperado como imágenes)';
            } else if (encrypted && corrupted) {
                statusMsg = ' (encriptado y reparado)';
            } else if (encrypted) {
                statusMsg = ' (encriptado)';
            } else if (corrupted) {
                statusMsg = ' (reparado)';
            }
            
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'analyzing',
                    current: i + 1,
                    total: files.length,
                    message: `Archivo ${i + 1} procesado${statusMsg} - ${pageCount} páginas`
                });
            }
            
        } catch (error) {
            throw new Error(`Error en archivo ${i + 1}: ${error.message}`);
        }
    }
    
    // Informar sobre archivos problemáticos encontrados
    const encryptedCount = fileAnalysis.filter(f => f.encrypted).length;
    const corruptedCount = fileAnalysis.filter(f => f.corrupted).length;
    const imageConvertedCount = fileAnalysis.filter(f => f.method === 'pdf.js').length;
    
    if ((encryptedCount > 0 || corruptedCount > 0 || imageConvertedCount > 0) && progressCallback) {
        let warningMsg = '';
        if (imageConvertedCount > 0) {
            warningMsg = `${imageConvertedCount} archivo(s) severamente corrupto(s) convertido(s) a imágenes. `;
        }
        if (encryptedCount > 0 && corruptedCount > 0) {
            warningMsg += `${encryptedCount} archivo(s) encriptado(s) y ${corruptedCount} corrupto(s) procesados automáticamente.`;
        } else if (encryptedCount > 0) {
            warningMsg += `${encryptedCount} archivo(s) encriptado(s) procesados automáticamente.`;
        } else if (corruptedCount > 0) {
            warningMsg += `${corruptedCount} archivo(s) corrupto(s) reparados automáticamente.`;
        }
        
        self.postMessage({
            type: 'WARNING',
            message: warningMsg
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
    const adaptiveChunkSize = totalPages > 1000 ? 3 : totalPages > 500 ? 5 : 10;
    
    for (let i = 0; i < pdfDocs.length; i++) {
        const pdf = pdfDocs[i];
        const analysis = fileAnalysis[i];
        const isEncrypted = analysis.encrypted;
        const method = analysis.method;
        
        if (method === 'pdf.js') {
            // Procesar archivo PDF.js página por página
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                try {
                    const success = await convertPdfjsPageToPdflib(pdf, pageNum, mergedPdf);
                    if (success) {
                        processedPages++;
                    }
                    
                    if (progressCallback && pageNum % 5 === 0) {
                        self.postMessage({
                            type: 'PROGRESS',
                            stage: 'merging',
                            current: processedPages,
                            total: totalPages,
                            percentage: Math.round((processedPages / totalPages) * 100),
                            message: `Convirtiendo imágenes: ${processedPages} de ${totalPages}`
                        });
                    }
                    
                    // Pausa para no saturar la memoria
                    if (pageNum % 10 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    
                } catch (pageError) {
                    console.warn(`Error en página ${pageNum} del archivo ${i + 1}:`, pageError);
                }
            }
        } else {
            // Procesar archivo PDF-lib normalmente
            const pageIndices = pdf.getPageIndices();
            
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
                    
                    const pauseTime = totalPages > 1000 ? 15 : totalPages > 500 ? 10 : 5;
                    await new Promise(resolve => setTimeout(resolve, pauseTime));
                    
                } catch (chunkError) {
                    console.warn(`Error procesando chunk en archivo ${i + 1}:`, chunkError);
                    // Intentar procesar página por página
                    for (const pageIndex of chunk) {
                        try {
                            const copiedPages = await mergedPdf.copyPages(pdf, [pageIndex]);
                            copiedPages.forEach(page => mergedPdf.addPage(page));
                            processedPages++;
                        } catch (pageError) {
                            console.warn(`Página ${pageIndex + 1} omitida por error:`, pageError);
                        }
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
            useObjectStreams: false,
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
                corruptedFiles: corruptedCount,
                imageConvertedFiles: imageConvertedCount,
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
        const { pdf, encrypted, corrupted, method } = result;
        
        let pageCount;
        if (method === 'pdf.js') {
            pageCount = pdf.numPages;
        } else {
            pageCount = pdf.getPageCount();
        }
        
        self.postMessage({
            type: 'PDF_ANALYSIS',
            data: {
                fileName,
                pageCount,
                encrypted,
                corrupted,
                method,
                title: method === 'pdf.js' ? 'Recuperado como imágenes' : (pdf.getTitle() || 'Sin título'),
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
        const { pdf, encrypted, method } = result;
        
        let pageCount, title;
        if (method === 'pdf.js') {
            pageCount = pdf.numPages;
            title = 'Recuperado como imágenes';
        } else {
            pageCount = pdf.getPageCount();
            title = pdf.getTitle() || 'Sin título';
        }
        
        self.postMessage({
            type: 'PDF_INFO',
            data: {
                pageCount,
                title,
                encrypted,
                method
            }
        });
    } catch (error) {
        self.postMessage({
            type: 'PDF_INFO_ERROR',
            error: error.message
        });
    }
}