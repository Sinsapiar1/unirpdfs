// Web Worker para procesamiento de PDFs en background
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');

// Configurar PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Configuración para documentos masivos
const MASSIVE_DOCUMENT_THRESHOLD = 500; // páginas
const EXTREME_DOCUMENT_THRESHOLD = 1000; // páginas
const MAX_PAGES_PER_DOCUMENT = 2000; // límite absoluto
const MAX_TOTAL_PAGES = 3000; // límite total del merge

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
        return 'Documento demasiado grande. Aplicando optimizaciones extremas...';
    } else if (errorStr.includes('network') || errorStr.includes('fetch')) {
        return 'Error de conexión. Verifica tu conexión a internet.';
    } else if (errorStr.includes('Expected instance of')) {
        return 'PDF severamente corrupto. Usando método de recuperación alternativo...';
    } else if (errorStr.includes('too many pages')) {
        return 'Documento excede límites de procesamiento. Considera dividir el archivo.';
    } else {
        return `Error de procesamiento: ${error.message || error}`;
    }
}

// Función para determinar estrategia de procesamiento
function determineProcessingStrategy(totalPages) {
    if (totalPages > MAX_TOTAL_PAGES) {
        return {
            strategy: 'reject',
            message: `Demasiadas páginas (${totalPages}). Máximo permitido: ${MAX_TOTAL_PAGES}`
        };
    } else if (totalPages > EXTREME_DOCUMENT_THRESHOLD) {
        return {
            strategy: 'extreme',
            chunkSize: 1,
            imageScale: 1.0,
            maxConcurrent: 1,
            pauseTime: 100
        };
    } else if (totalPages > MASSIVE_DOCUMENT_THRESHOLD) {
        return {
            strategy: 'aggressive',
            chunkSize: 2,
            imageScale: 1.2,
            maxConcurrent: 2,
            pauseTime: 50
        };
    } else {
        return {
            strategy: 'normal',
            chunkSize: 5,
            imageScale: 2.0,
            maxConcurrent: 3,
            pauseTime: 10
        };
    }
}

// Función para intentar cargar PDFs con diferentes opciones
async function loadPDFWithOptions(fileBuffer, fileName = '') {
    // Verificar tamaño del archivo
    const fileSizeMB = fileBuffer.byteLength / (1024 * 1024);
    if (fileSizeMB > 300) { // 300MB límite por archivo
        throw new Error(`Archivo ${fileName} demasiado grande (${fileSizeMB.toFixed(1)}MB). Máximo: 300MB`);
    }
    
    // Lista de opciones para intentar en orden
    const loadAttempts = [
        // Intento 1: Carga normal
        {},
        // Intento 2: Ignorar encriptación
        { ignoreEncryption: true },
        // Intento 3: Modo rápido + ignorar encriptación
        { ignoreEncryption: true, updateXRefTable: false, parseSpeed: 2 }
    ];
    
    let lastError = null;
    
    // Intentar con pdf-lib primero (más rápido para documentos válidos)
    for (let i = 0; i < loadAttempts.length; i++) {
        try {
            const loadOptions = loadAttempts[i];
            const pdf = await PDFLib.PDFDocument.load(fileBuffer, loadOptions);
            
            const pageCount = pdf.getPageCount();
            if (pageCount > MAX_PAGES_PER_DOCUMENT) {
                throw new Error(`Documento ${fileName} tiene ${pageCount} páginas. Máximo permitido: ${MAX_PAGES_PER_DOCUMENT}`);
            }
            
            const encrypted = loadOptions.ignoreEncryption === true;
            const recovered = i > 0;
            
            return { 
                pdf, 
                encrypted, 
                corrupted: recovered,
                attemptUsed: i + 1,
                method: 'pdf-lib',
                pageCount
            };
            
        } catch (error) {
            lastError = error;
            console.warn(`PDF-lib intento ${i + 1} fallido para ${fileName}:`, error.message);
            
            // Si es error de límite de páginas, no continuar
            if (error.message.includes('páginas. Máximo permitido')) {
                throw error;
            }
        }
    }
    
    // Si pdf-lib falló, intentar con PDF.js (solo para archivos no demasiado grandes)
    if (fileSizeMB < 100) { // Solo usar PDF.js para archivos < 100MB
        console.log(`PDF-lib falló para ${fileName}, intentando con PDF.js...`);
        try {
            const pdfDoc = await pdfjsLib.getDocument({ 
                data: fileBuffer,
                stopAtErrors: false,
                maxImageSize: 512 * 512, // Reducir límite de imagen
                disableFontFace: true,
                verbosity: 0,
                useSystemFonts: false
            }).promise;
            
            if (pdfDoc.numPages > MAX_PAGES_PER_DOCUMENT) {
                throw new Error(`Documento ${fileName} tiene ${pdfDoc.numPages} páginas. Máximo permitido: ${MAX_PAGES_PER_DOCUMENT}`);
            }
            
            return {
                pdf: pdfDoc,
                encrypted: false,
                corrupted: true,
                attemptUsed: 4,
                method: 'pdf.js',
                pageCount: pdfDoc.numPages
            };
            
        } catch (pdfjsError) {
            console.error(`PDF.js también falló para ${fileName}:`, pdfjsError);
            if (pdfjsError.message.includes('páginas. Máximo permitido')) {
                throw pdfjsError;
            }
        }
    }
    
    throw new Error(`PDF ${fileName} no se puede procesar con ningún método disponible.`);
}

// Función optimizada para convertir página de PDF.js a imagen
async function convertPdfjsPageToPdflib(pdfDoc, pageNum, targetPdf, scale = 1.0) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        
        // Limitar tamaño máximo de canvas
        const maxDimension = 2048;
        let finalScale = scale;
        if (viewport.width > maxDimension || viewport.height > maxDimension) {
            finalScale = Math.min(maxDimension / viewport.width, maxDimension / viewport.height);
            viewport = page.getViewport({ scale: finalScale });
        }
        
        // Crear canvas optimizado
        const canvas = new OffscreenCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d', { 
            alpha: false,
            desynchronized: true
        });
        
        // Renderizar página con optimizaciones
        await page.render({
            canvasContext: context,
            viewport: viewport,
            intent: 'print' // Mejor para documentos
        }).promise;
        
        // Convertir a JPEG para menor tamaño (mejor para documentos grandes)
        const blob = await canvas.convertToBlob({ 
            type: 'image/jpeg', 
            quality: 0.8 
        });
        const imageBytes = await blob.arrayBuffer();
        
        // Crear página en PDF-lib
        const image = await targetPdf.embedJpg(imageBytes);
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
    
    // Análisis previo para calcular páginas totales
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
            
            const result = await loadPDFWithOptions(files[i], `archivo_${i + 1}`);
            const { pdf, encrypted, corrupted, attemptUsed, method, pageCount } = result;
            
            totalPages += pageCount;
            
            // Verificar límite total antes de continuar
            if (totalPages > MAX_TOTAL_PAGES) {
                throw new Error(`too many pages: Total de páginas (${totalPages}) excede el límite máximo (${MAX_TOTAL_PAGES})`);
            }
            
            pdfDocs.push(pdf);
            fileAnalysis.push({ 
                encrypted, 
                corrupted, 
                pages: pageCount, 
                attemptUsed, 
                method 
            });
            
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
    
    // Determinar estrategia de procesamiento
    const strategy = determineProcessingStrategy(totalPages);
    if (strategy.strategy === 'reject') {
        throw new Error(strategy.message);
    }
    
    // Informar sobre archivos problemáticos y estrategia
    const encryptedCount = fileAnalysis.filter(f => f.encrypted).length;
    const corruptedCount = fileAnalysis.filter(f => f.corrupted).length;
    const imageConvertedCount = fileAnalysis.filter(f => f.method === 'pdf.js').length;
    
    if (progressCallback) {
        let warningMsg = `Procesando ${totalPages} páginas con estrategia ${strategy.strategy.toUpperCase()}. `;
        
        if (imageConvertedCount > 0) {
            warningMsg += `${imageConvertedCount} archivo(s) severamente corrupto(s) convertido(s) a imágenes. `;
        }
        if (encryptedCount > 0) {
            warningMsg += `${encryptedCount} archivo(s) encriptado(s) procesados. `;
        }
        if (corruptedCount > 0) {
            warningMsg += `${corruptedCount} archivo(s) reparados. `;
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
            message: `Iniciando procesamiento ${strategy.strategy} de ${totalPages} páginas...`
        });
    }
    
    // Procesamiento con estrategia adaptativa
    for (let i = 0; i < pdfDocs.length; i++) {
        const pdf = pdfDocs[i];
        const analysis = fileAnalysis[i];
        const isEncrypted = analysis.encrypted;
        const method = analysis.method;
        
        if (method === 'pdf.js') {
            // Procesar archivo PDF.js página por página con optimizaciones extremas
            const batchSize = strategy.strategy === 'extreme' ? 5 : 10;
            
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                try {
                    const success = await convertPdfjsPageToPdflib(
                        pdf, 
                        pageNum, 
                        mergedPdf, 
                        strategy.imageScale
                    );
                    if (success) {
                        processedPages++;
                    }
                    
                    if (progressCallback && pageNum % batchSize === 0) {
                        const percentage = Math.round((processedPages / totalPages) * 100);
                        self.postMessage({
                            type: 'PROGRESS',
                            stage: 'merging',
                            current: processedPages,
                            total: totalPages,
                            percentage,
                            message: `Convirtiendo imágenes (${strategy.strategy}): ${processedPages} de ${totalPages}`
                        });
                    }
                    
                    // Pausa adaptativa para gestión de memoria
                    if (pageNum % batchSize === 0) {
                        await new Promise(resolve => setTimeout(resolve, strategy.pauseTime));
                        
                        // Forzar garbage collection en documentos extremos
                        if (strategy.strategy === 'extreme' && pageNum % 50 === 0) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                        }
                    }
                    
                } catch (pageError) {
                    console.warn(`Error en página ${pageNum} del archivo ${i + 1}:`, pageError);
                }
            }
        } else {
            // Procesar archivo PDF-lib con chunks adaptativos
            const pageIndices = pdf.getPageIndices();
            
            for (let j = 0; j < pageIndices.length; j += strategy.chunkSize) {
                const chunk = pageIndices.slice(j, Math.min(j + strategy.chunkSize, pageIndices.length));
                
                try {
                    const copiedPages = await mergedPdf.copyPages(pdf, chunk);
                    copiedPages.forEach(page => mergedPdf.addPage(page));
                    processedPages += chunk.length;
                    
                    if (progressCallback) {
                        const percentage = Math.round((processedPages / totalPages) * 100);
                        self.postMessage({
                            type: 'PROGRESS',
                            stage: 'merging',
                            current: processedPages,
                            total: totalPages,
                            percentage,
                            message: `Procesando páginas (${strategy.strategy}): ${processedPages} de ${totalPages}${isEncrypted ? ' (encriptado)' : ''}`
                        });
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, strategy.pauseTime));
                    
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
        // Configuración de guardado optimizada para documentos grandes
        const saveOptions = {
            useObjectStreams: false,
            addDefaultPage: false,
            objectStreamsThreshold: 0
        };
        
        // Para documentos extremos, usar compresión adicional
        if (strategy.strategy === 'extreme') {
            saveOptions.compress = true;
        }
        
        const mergedPdfFile = await mergedPdf.save(saveOptions);
        
        self.postMessage({
            type: 'MERGE_COMPLETE',
            data: mergedPdfFile,
            stats: {
                totalFiles: files.length,
                totalPages: processedPages,
                encryptedFiles: encryptedCount,
                corruptedFiles: corruptedCount,
                imageConvertedFiles: imageConvertedCount,
                fileSize: mergedPdfFile.length,
                strategy: strategy.strategy
            }
        });
        
    } catch (saveError) {
        throw new Error(`Error al guardar el PDF final: ${saveError.message}`);
    }
}

// Función para analizar un PDF individual
async function analyzePDF({ fileBuffer, fileName }) {
    try {
        const result = await loadPDFWithOptions(fileBuffer, fileName);
        const { pdf, encrypted, corrupted, method, pageCount } = result;
        
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
        const { pdf, encrypted, method, pageCount } = result;
        
        let title;
        if (method === 'pdf.js') {
            title = 'Recuperado como imágenes';
        } else {
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