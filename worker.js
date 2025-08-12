// Web Worker para procesamiento de PDFs en background
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');

// Configurar PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Configuración progresiva de límites
const LIMITS = {
    // Límites de archivo individual
    FILE_SIZE_MB: {
        SMALL: 50,      // Archivos pequeños
        MEDIUM: 100,    // Archivos medianos  
        LARGE: 200,     // Archivos grandes
        MAX: 300        // Límite absoluto
    },
    
    // Límites de páginas por archivo
    PAGES_PER_FILE: {
        SMALL: 100,     // Procesamiento normal
        MEDIUM: 300,    // Procesamiento agresivo
        LARGE: 500,     // Procesamiento extremo
        MAX: 1000       // Límite absoluto
    },
    
    // Límites totales del merge
    TOTAL_PAGES: {
        NORMAL: 200,    // Estrategia normal
        AGGRESSIVE: 500, // Estrategia agresiva
        EXTREME: 1000,  // Estrategia extrema
        MAX: 1500       // Límite absoluto
    },
    
    // Límites de memoria estimada
    MEMORY_ESTIMATE_MB: {
        SAFE: 100,      // Seguro
        WARNING: 200,   // Advertencia
        DANGER: 400,    // Peligroso
        MAX: 500        // Límite absoluto
    }
};

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
            case 'DIAGNOSE_FILES':
                await diagnoseFiles(data);
                break;
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'ERROR',
            error: getDetailedErrorMessage(error),
            diagnostic: analyzeDiagnosticInfo(error)
        });
    }
};

// Función para analizar información diagnóstica del error
function analyzeDiagnosticInfo(error) {
    const errorStr = error.toString();
    const diagnostic = {
        category: 'unknown',
        severity: 'medium',
        recommendation: 'Intenta con archivos más pequeños',
        technicalDetails: errorStr
    };
    
    if (errorStr.includes('páginas. Máximo permitido')) {
        diagnostic.category = 'page_limit';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Divide el archivo en partes más pequeñas (máximo 500 páginas por archivo)';
    } else if (errorStr.includes('demasiado grande') && errorStr.includes('MB')) {
        diagnostic.category = 'file_size';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Reduce el tamaño del archivo (máximo 200MB por archivo)';
    } else if (errorStr.includes('Total de páginas') && errorStr.includes('excede')) {
        diagnostic.category = 'total_pages';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Reduce el número total de páginas a procesar (máximo 1000 páginas en total)';
    } else if (errorStr.includes('out of memory') || errorStr.includes('Maximum call stack')) {
        diagnostic.category = 'memory';
        diagnostic.severity = 'critical';
        diagnostic.recommendation = 'Cierra otras pestañas del navegador y intenta con archivos más pequeños';
    } else if (errorStr.includes('Expected instance of')) {
        diagnostic.category = 'corruption';
        diagnostic.severity = 'medium';
        diagnostic.recommendation = 'El archivo está severamente corrupto. Intenta repararlo con otra herramienta primero';
    }
    
    return diagnostic;
}

// Función para obtener mensajes de error detallados
function getDetailedErrorMessage(error) {
    const errorStr = error.toString();
    
    if (errorStr.includes('páginas. Máximo permitido')) {
        const match = errorStr.match(/tiene (\d+) páginas.*Máximo permitido: (\d+)/);
        if (match) {
            return `❌ LÍMITE DE PÁGINAS EXCEDIDO: El archivo tiene ${match[1]} páginas, pero el máximo permitido es ${match[2]} páginas por archivo.`;
        }
    }
    
    if (errorStr.includes('demasiado grande') && errorStr.includes('MB')) {
        const match = errorStr.match(/(\d+\.?\d*)MB.*Máximo: (\d+)MB/);
        if (match) {
            return `❌ ARCHIVO MUY GRANDE: El archivo pesa ${match[1]}MB, pero el máximo permitido es ${match[2]}MB.`;
        }
    }
    
    if (errorStr.includes('Total de páginas') && errorStr.includes('excede')) {
        const match = errorStr.match(/Total de páginas \((\d+)\).*límite máximo \((\d+)\)/);
        if (match) {
            return `❌ DEMASIADAS PÁGINAS EN TOTAL: Intentas procesar ${match[1]} páginas, pero el máximo total permitido es ${match[2]} páginas.`;
        }
    }
    
    if (errorStr.includes('out of memory')) {
        return `❌ SIN MEMORIA: Tu navegador se quedó sin memoria. Cierra otras pestañas e intenta con archivos más pequeños.`;
    }
    
    if (errorStr.includes('Expected instance of')) {
        return `❌ ARCHIVO SEVERAMENTE CORRUPTO: El archivo está tan dañado que no se puede procesar. Intenta repararlo primero.`;
    }
    
    if (errorStr.includes('encrypted')) {
        return `🔒 ARCHIVO ENCRIPTADO: El archivo está protegido con contraseña y no se pudo desbloquear automáticamente.`;
    }
    
    return `❌ ERROR DESCONOCIDO: ${error.message || error}`;
}

// Función para estimar uso de memoria
function estimateMemoryUsage(fileSize, pageCount, isImageConversion = false) {
    let memoryMB = 0;
    
    // Memoria base del archivo
    memoryMB += fileSize / (1024 * 1024);
    
    if (isImageConversion) {
        // Conversión a imágenes usa más memoria
        // Estimamos ~2MB por página en memoria durante conversión
        memoryMB += pageCount * 2;
    } else {
        // Procesamiento normal de PDF
        // Estimamos ~0.5MB por página
        memoryMB += pageCount * 0.5;
    }
    
    // Memoria del PDF final (estimado)
    memoryMB += (pageCount * 0.3);
    
    return Math.round(memoryMB);
}

// Función para diagnosticar archivos antes de procesarlos
async function diagnoseFiles({ files }) {
    const diagnostics = [];
    let totalPages = 0;
    let totalSizeMB = 0;
    let totalMemoryEstimate = 0;
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileSizeMB = file.byteLength / (1024 * 1024);
        totalSizeMB += fileSizeMB;
        
        const diagnosis = {
            fileIndex: i,
            fileName: `archivo_${i + 1}`,
            sizeMB: Math.round(fileSizeMB * 10) / 10,
            issues: [],
            warnings: [],
            canProcess: true,
            pageCount: 0,
            memoryEstimate: 0
        };
        
        // Verificar tamaño de archivo
        if (fileSizeMB > LIMITS.FILE_SIZE_MB.MAX) {
            diagnosis.issues.push(`Archivo demasiado grande: ${diagnosis.sizeMB}MB (máximo: ${LIMITS.FILE_SIZE_MB.MAX}MB)`);
            diagnosis.canProcess = false;
        } else if (fileSizeMB > LIMITS.FILE_SIZE_MB.LARGE) {
            diagnosis.warnings.push(`Archivo muy grande: ${diagnosis.sizeMB}MB. Procesamiento será lento.`);
        }
        
        // Intentar obtener información del PDF
        try {
            const result = await loadPDFWithOptions(file, diagnosis.fileName);
            diagnosis.pageCount = result.pageCount;
            diagnosis.method = result.method;
            diagnosis.encrypted = result.encrypted;
            diagnosis.corrupted = result.corrupted;
            
            totalPages += diagnosis.pageCount;
            
            // Verificar límites de páginas por archivo
            if (diagnosis.pageCount > LIMITS.PAGES_PER_FILE.MAX) {
                diagnosis.issues.push(`Demasiadas páginas: ${diagnosis.pageCount} (máximo: ${LIMITS.PAGES_PER_FILE.MAX} por archivo)`);
                diagnosis.canProcess = false;
            } else if (diagnosis.pageCount > LIMITS.PAGES_PER_FILE.LARGE) {
                diagnosis.warnings.push(`Muchas páginas: ${diagnosis.pageCount}. Procesamiento será muy lento.`);
            }
            
            // Estimar memoria
            const isImageConversion = result.method === 'pdf.js';
            diagnosis.memoryEstimate = estimateMemoryUsage(file.byteLength, diagnosis.pageCount, isImageConversion);
            totalMemoryEstimate += diagnosis.memoryEstimate;
            
            if (diagnosis.memoryEstimate > LIMITS.MEMORY_ESTIMATE_MB.DANGER) {
                diagnosis.warnings.push(`Alto uso de memoria estimado: ${diagnosis.memoryEstimate}MB`);
            }
            
        } catch (error) {
            diagnosis.issues.push(`No se puede procesar: ${error.message}`);
            diagnosis.canProcess = false;
        }
        
        diagnostics.push(diagnosis);
    }
    
    // Verificar límites totales
    const globalIssues = [];
    const globalWarnings = [];
    
    if (totalPages > LIMITS.TOTAL_PAGES.MAX) {
        globalIssues.push(`Demasiadas páginas en total: ${totalPages} (máximo: ${LIMITS.TOTAL_PAGES.MAX})`);
    } else if (totalPages > LIMITS.TOTAL_PAGES.EXTREME) {
        globalWarnings.push(`Muchas páginas en total: ${totalPages}. Usar estrategia extrema.`);
    }
    
    if (totalMemoryEstimate > LIMITS.MEMORY_ESTIMATE_MB.MAX) {
        globalIssues.push(`Uso de memoria estimado demasiado alto: ${totalMemoryEstimate}MB (máximo seguro: ${LIMITS.MEMORY_ESTIMATE_MB.MAX}MB)`);
    } else if (totalMemoryEstimate > LIMITS.MEMORY_ESTIMATE_MB.DANGER) {
        globalWarnings.push(`Uso de memoria alto: ${totalMemoryEstimate}MB. Cierra otras pestañas.`);
    }
    
    const canProcessAll = diagnostics.every(d => d.canProcess) && globalIssues.length === 0;
    
    self.postMessage({
        type: 'DIAGNOSTIC_COMPLETE',
        data: {
            files: diagnostics,
            totals: {
                files: files.length,
                pages: totalPages,
                sizeMB: Math.round(totalSizeMB * 10) / 10,
                memoryEstimateMB: totalMemoryEstimate
            },
            globalIssues,
            globalWarnings,
            canProcess: canProcessAll,
            recommendedStrategy: determineProcessingStrategy(totalPages).strategy
        }
    });
}

// Función para determinar estrategia de procesamiento
function determineProcessingStrategy(totalPages) {
    if (totalPages > LIMITS.TOTAL_PAGES.MAX) {
        return {
            strategy: 'reject',
            message: `Demasiadas páginas (${totalPages}). Máximo permitido: ${LIMITS.TOTAL_PAGES.MAX}`
        };
    } else if (totalPages > LIMITS.TOTAL_PAGES.EXTREME) {
        return {
            strategy: 'extreme',
            chunkSize: 1,
            imageScale: 0.8,
            maxConcurrent: 1,
            pauseTime: 200
        };
    } else if (totalPages > LIMITS.TOTAL_PAGES.AGGRESSIVE) {
        return {
            strategy: 'aggressive',
            chunkSize: 2,
            imageScale: 1.0,
            maxConcurrent: 2,
            pauseTime: 100
        };
    } else {
        return {
            strategy: 'normal',
            chunkSize: 5,
            imageScale: 1.5,
            maxConcurrent: 3,
            pauseTime: 50
        };
    }
}

// Función para intentar cargar PDFs con diferentes opciones
async function loadPDFWithOptions(fileBuffer, fileName = '') {
    // Verificar tamaño del archivo
    const fileSizeMB = fileBuffer.byteLength / (1024 * 1024);
    if (fileSizeMB > LIMITS.FILE_SIZE_MB.MAX) {
        throw new Error(`Archivo ${fileName} demasiado grande (${fileSizeMB.toFixed(1)}MB). Máximo: ${LIMITS.FILE_SIZE_MB.MAX}MB`);
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
            if (pageCount > LIMITS.PAGES_PER_FILE.MAX) {
                throw new Error(`Documento ${fileName} tiene ${pageCount} páginas. Máximo permitido: ${LIMITS.PAGES_PER_FILE.MAX}`);
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
    if (fileSizeMB < LIMITS.FILE_SIZE_MB.LARGE) { // Solo usar PDF.js para archivos < 200MB
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
            
            if (pdfDoc.numPages > LIMITS.PAGES_PER_FILE.MAX) {
                throw new Error(`Documento ${fileName} tiene ${pdfDoc.numPages} páginas. Máximo permitido: ${LIMITS.PAGES_PER_FILE.MAX}`);
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
        let viewport = page.getViewport({ scale });
        
        // Limitar tamaño máximo de canvas
        const maxDimension = 1500; // Reducido para mayor compatibilidad
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
            intent: 'print'
        }).promise;
        
        // Convertir a JPEG para menor tamaño
        const blob = await canvas.convertToBlob({ 
            type: 'image/jpeg', 
            quality: 0.7  // Reducida para documentos grandes
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
    // Primero hacer diagnóstico completo
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'diagnosing',
            current: 0,
            total: 1,
            message: 'Realizando diagnóstico completo de archivos...'
        });
    }
    
    await diagnoseFiles({ files });
    
    // Continuar con el procesamiento normal...
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
            if (totalPages > LIMITS.TOTAL_PAGES.MAX) {
                throw new Error(`too many pages: Total de páginas (${totalPages}) excede el límite máximo (${LIMITS.TOTAL_PAGES.MAX})`);
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
                            await new Promise(resolve => setTimeout(resolve, 300));
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