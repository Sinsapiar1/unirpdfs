// Web Worker para procesamiento de PDFs en background
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');

// Configurar PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Configuración híbrida optimizada (inspirada en servidores)
const HYBRID_LIMITS = {
    // Límites más agresivos para compensar limitaciones del cliente
    FILE_SIZE_MB: {
        SMALL: 30,      // Archivos pequeños - procesamiento rápido
        MEDIUM: 60,     // Archivos medianos - procesamiento normal  
        LARGE: 100,     // Archivos grandes - procesamiento lento
        MAX: 150        // Límite absoluto más realista
    },
    
    // Límites de páginas más conservadores
    PAGES_PER_FILE: {
        SMALL: 50,      // Procesamiento normal
        MEDIUM: 150,    // Procesamiento agresivo
        LARGE: 300,     // Procesamiento extremo
        MAX: 500        // Límite absoluto realista
    },
    
    // Límites totales ajustados
    TOTAL_PAGES: {
        NORMAL: 100,    // Estrategia normal
        AGGRESSIVE: 250, // Estrategia agresiva
        EXTREME: 400,   // Estrategia extrema
        MAX: 600        // Límite absoluto
    },
    
    // Límites de memoria más realistas
    MEMORY_ESTIMATE_MB: {
        SAFE: 50,       // Seguro
        WARNING: 100,   // Advertencia
        DANGER: 200,    // Peligroso
        MAX: 300        // Límite absoluto
    },
    
    // Configuración de streaming
    STREAMING: {
        CHUNK_SIZE_PAGES: 5,        // Páginas por chunk
        MEMORY_CLEANUP_INTERVAL: 10, // Limpieza cada N páginas
        MAX_CONCURRENT_PAGES: 3,     // Páginas simultáneas en memoria
        COMPRESSION_QUALITY: 0.6     // Calidad de compresión agresiva
    }
};

self.onmessage = async function(e) {
    const { type, data } = e.data;
    
    try {
        switch(type) {
            case 'MERGE_PDFS':
                await mergePDFsHybrid(data);
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

// Función para análisis diagnóstico mejorado
function analyzeDiagnosticInfo(error) {
    const errorStr = error.toString();
    const diagnostic = {
        category: 'unknown',
        severity: 'medium',
        recommendation: 'Intenta con archivos más pequeños',
        technicalDetails: errorStr,
        hybridSolution: ''
    };
    
    if (errorStr.includes('páginas. Máximo permitido')) {
        diagnostic.category = 'page_limit';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Divide el archivo en partes más pequeñas (máximo 300 páginas por archivo)';
        diagnostic.hybridSolution = 'A diferencia de iLovePDF (que usa servidores), tu navegador tiene límites de memoria. Divide el PDF en partes de ~150 páginas.';
    } else if (errorStr.includes('demasiado grande') && errorStr.includes('MB')) {
        diagnostic.category = 'file_size';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Reduce el tamaño del archivo (máximo 100MB por archivo)';
        diagnostic.hybridSolution = 'iLovePDF procesa en servidores con RAM ilimitada. En tu navegador, usa archivos < 100MB para mejor rendimiento.';
    } else if (errorStr.includes('Total de páginas') && errorStr.includes('excede')) {
        diagnostic.category = 'total_pages';
        diagnostic.severity = 'high';
        diagnostic.recommendation = 'Reduce el número total de páginas a procesar (máximo 400 páginas en total)';
        diagnostic.hybridSolution = 'Los servidores de iLovePDF pueden procesar miles de páginas. En el navegador, limítate a ~400 páginas totales.';
    } else if (errorStr.includes('out of memory') || errorStr.includes('Maximum call stack')) {
        diagnostic.category = 'memory';
        diagnostic.severity = 'critical';
        diagnostic.recommendation = 'Cierra todas las demás pestañas y reinicia el navegador';
        diagnostic.hybridSolution = 'iLovePDF usa 32GB+ de RAM en servidores. Tu navegador tiene ~2GB de RAM disponible. Libera memoria cerrando pestañas.';
    }
    
    return diagnostic;
}

// Función de mensajes de error con comparación iLovePDF
function getDetailedErrorMessage(error) {
    const errorStr = error.toString();
    
    if (errorStr.includes('páginas. Máximo permitido')) {
        const match = errorStr.match(/tiene (\d+) páginas.*Máximo permitido: (\d+)/);
        if (match) {
            return `❌ LÍMITE DE PÁGINAS EXCEDIDO: Tu archivo tiene ${match[1]} páginas.
            
🏢 iLovePDF: Procesa en servidores con recursos ilimitados
🌐 Tu app: Limitada por la memoria del navegador (máximo ${match[2]} páginas)

💡 Solución: Divide tu PDF en partes de ~150 páginas cada una.`;
        }
    }
    
    if (errorStr.includes('demasiado grande') && errorStr.includes('MB')) {
        const match = errorStr.match(/(\d+\.?\d*)MB.*Máximo: (\d+)MB/);
        if (match) {
            return `❌ ARCHIVO MUY GRANDE: Tu archivo pesa ${match[1]}MB.
            
🏢 iLovePDF: Servidores con almacenamiento y RAM masivos
🌐 Tu app: Limitada por la memoria del navegador (máximo ${match[2]}MB)

💡 Solución: Comprime el PDF o divídelo en archivos más pequeños.`;
        }
    }
    
    if (errorStr.includes('out of memory')) {
        return `❌ SIN MEMORIA: Tu navegador se quedó sin memoria.
        
🏢 iLovePDF: Servidores con 32GB+ de RAM
🌐 Tu app: Tu navegador tiene ~2GB de RAM disponible

💡 Solución: Cierra todas las demás pestañas, reinicia el navegador, usa archivos más pequeños.`;
    }
    
    return `❌ ERROR: ${error.message || error}`;
}

// Streaming PDF processing (inspirado en arquitecturas de servidor)
class StreamingPDFProcessor {
    constructor() {
        this.memoryPool = new Map(); // Pool de memoria reutilizable
        this.processedPages = 0;
        this.totalPages = 0;
    }
    
    // Limpieza agresiva de memoria (simula garbage collection de servidor)
    async forceMemoryCleanup() {
        // Limpiar pool de memoria
        this.memoryPool.clear();
        
        // Forzar garbage collection si está disponible
        if (typeof gc !== 'undefined') {
            gc();
        }
        
        // Pausa para permitir limpieza
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Procesamiento por streaming (inspirado en servidores)
    async processPageStream(pdfDoc, pageNum, targetPdf, scale = 0.8) {
        try {
            // Verificar memoria antes de procesar
            if (this.processedPages % HYBRID_LIMITS.STREAMING.MEMORY_CLEANUP_INTERVAL === 0) {
                await this.forceMemoryCleanup();
            }
            
            const page = await pdfDoc.getPage(pageNum);
            let viewport = page.getViewport({ scale });
            
            // Límites más agresivos de canvas (inspirado en optimizaciones de servidor)
            const maxDimension = 1200; // Más pequeño para mejor rendimiento
            if (viewport.width > maxDimension || viewport.height > maxDimension) {
                const finalScale = Math.min(maxDimension / viewport.width, maxDimension / viewport.height);
                viewport = page.getViewport({ scale: finalScale });
            }
            
            // Canvas optimizado con configuración de servidor
            const canvas = new OffscreenCanvas(viewport.width, viewport.height);
            const context = canvas.getContext('2d', { 
                alpha: false,
                desynchronized: true,
                willReadFrequently: false // Optimización importante
            });
            
            // Renderizado optimizado
            await page.render({
                canvasContext: context,
                viewport: viewport,
                intent: 'print',
                renderInteractiveForms: false, // Desactivar formularios
                enableWebGL: false // Más estable
            }).promise;
            
            // Compresión agresiva (inspirada en optimizaciones de servidor)
            const blob = await canvas.convertToBlob({ 
                type: 'image/jpeg', 
                quality: HYBRID_LIMITS.STREAMING.COMPRESSION_QUALITY
            });
            const imageBytes = await blob.arrayBuffer();
            
            // Incrustar en PDF con optimizaciones
            const image = await targetPdf.embedJpg(imageBytes);
            const newPage = targetPdf.addPage([viewport.width, viewport.height]);
            newPage.drawImage(image, {
                x: 0,
                y: 0,
                width: viewport.width,
                height: viewport.height,
            });
            
            this.processedPages++;
            return true;
            
        } catch (error) {
            console.warn(`Error en streaming de página ${pageNum}:`, error);
            return false;
        }
    }
}

// Función principal de merge híbrido
async function mergePDFsHybrid({ files, progressCallback = true }) {
    // Diagnóstico previo con límites híbridos
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'diagnosing',
            current: 0,
            total: 1,
            message: '🩺 Diagnóstico híbrido: Analizando capacidades vs iLovePDF...'
        });
    }
    
    await diagnoseFiles({ files });
    
    // Inicializar procesador streaming
    const processor = new StreamingPDFProcessor();
    const mergedPdf = await PDFLib.PDFDocument.create();
    let totalPages = 0;
    let processedPages = 0;
    const pdfDocs = [];
    const fileAnalysis = [];
    
    // Análisis con límites híbridos
    for (let i = 0; i < files.length; i++) {
        try {
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'analyzing',
                    current: i,
                    total: files.length,
                    message: `Analizando archivo ${i + 1}/${files.length} (modo híbrido)...`
                });
            }
            
            const result = await loadPDFWithHybridLimits(files[i], `archivo_${i + 1}`);
            const { pdf, encrypted, corrupted, attemptUsed, method, pageCount } = result;
            
            totalPages += pageCount;
            
            // Verificar límites híbridos
            if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.MAX) {
                throw new Error(`too many pages: Total de páginas (${totalPages}) excede el límite híbrido (${HYBRID_LIMITS.TOTAL_PAGES.MAX})`);
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
                statusMsg = ' (conversión streaming)';
            } else if (encrypted) {
                statusMsg = ' (desencriptado)';
            } else if (corrupted) {
                statusMsg = ' (reparado)';
            }
            
            if (progressCallback) {
                self.postMessage({
                    type: 'PROGRESS',
                    stage: 'analyzing',
                    current: i + 1,
                    total: files.length,
                    message: `Archivo ${i + 1} listo${statusMsg} - ${pageCount} páginas`
                });
            }
            
        } catch (error) {
            throw new Error(`Error en archivo ${i + 1}: ${error.message}`);
        }
    }
    
    // Determinar estrategia híbrida
    const strategy = determineHybridStrategy(totalPages);
    if (strategy.strategy === 'reject') {
        throw new Error(strategy.message);
    }
    
    processor.totalPages = totalPages;
    
    // Información sobre el procesamiento híbrido
    if (progressCallback) {
        const encryptedCount = fileAnalysis.filter(f => f.encrypted).length;
        const corruptedCount = fileAnalysis.filter(f => f.corrupted).length;
        const imageConvertedCount = fileAnalysis.filter(f => f.method === 'pdf.js').length;
        
        let warningMsg = `🔄 MODO HÍBRIDO: Procesando ${totalPages} páginas con estrategia ${strategy.strategy.toUpperCase()}. `;
        
        if (imageConvertedCount > 0) {
            warningMsg += `${imageConvertedCount} archivo(s) convertidos con streaming. `;
        }
        
        warningMsg += `📊 Comparación: iLovePDF (servidor) vs Tu app (híbrida optimizada).`;
        
        self.postMessage({
            type: 'WARNING',
            message: warningMsg
        });
    }
    
    // Procesamiento híbrido con streaming
    for (let i = 0; i < pdfDocs.length; i++) {
        const pdf = pdfDocs[i];
        const analysis = fileAnalysis[i];
        const method = analysis.method;
        
        if (method === 'pdf.js') {
            // Streaming processing (inspirado en servidores)
            const batchSize = strategy.streaming.batchSize;
            
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const success = await processor.processPageStream(
                    pdf, 
                    pageNum, 
                    mergedPdf, 
                    strategy.streaming.scale
                );
                
                if (success) {
                    processedPages++;
                }
                
                // Progreso y limpieza de memoria
                if (progressCallback && pageNum % batchSize === 0) {
                    const percentage = Math.round((processedPages / totalPages) * 100);
                    self.postMessage({
                        type: 'PROGRESS',
                        stage: 'merging',
                        current: processedPages,
                        total: totalPages,
                        percentage,
                        message: `🚀 Streaming híbrido: ${processedPages}/${totalPages} páginas (${percentage}%)`
                    });
                }
                
                // Pausa adaptativa con limpieza de memoria
                if (pageNum % batchSize === 0) {
                    await new Promise(resolve => setTimeout(resolve, strategy.streaming.pauseTime));
                }
            }
        } else {
            // Procesamiento PDF-lib optimizado
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
                            message: `⚡ Procesamiento híbrido: ${processedPages}/${totalPages} páginas (${percentage}%)`
                        });
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, strategy.pauseTime));
                    
                } catch (chunkError) {
                    console.warn(`Error en chunk del archivo ${i + 1}:`, chunkError);
                    // Fallback página por página
                    for (const pageIndex of chunk) {
                        try {
                            const copiedPages = await mergedPdf.copyPages(pdf, [pageIndex]);
                            copiedPages.forEach(page => mergedPdf.addPage(page));
                            processedPages++;
                        } catch (pageError) {
                            console.warn(`Página ${pageIndex + 1} omitida:`, pageError);
                        }
                    }
                }
            }
        }
    }
    
    // Guardado final con limpieza
    if (progressCallback) {
        self.postMessage({
            type: 'PROGRESS',
            stage: 'saving',
            current: 100,
            total: 100,
            message: `💾 Generando PDF final híbrido (${processedPages} páginas)...`
        });
    }
    
    await processor.forceMemoryCleanup();
    
    try {
        const saveOptions = {
            useObjectStreams: false,
            addDefaultPage: false,
            objectStreamsThreshold: 0,
            compress: strategy.strategy === 'extreme'
        };
        
        const mergedPdfFile = await mergedPdf.save(saveOptions);
        
        self.postMessage({
            type: 'MERGE_COMPLETE',
            data: mergedPdfFile,
            stats: {
                totalFiles: files.length,
                totalPages: processedPages,
                encryptedFiles: fileAnalysis.filter(f => f.encrypted).length,
                corruptedFiles: fileAnalysis.filter(f => f.corrupted).length,
                imageConvertedFiles: fileAnalysis.filter(f => f.method === 'pdf.js').length,
                fileSize: mergedPdfFile.length,
                strategy: strategy.strategy,
                processingMode: 'hybrid'
            }
        });
        
    } catch (saveError) {
        throw new Error(`Error al guardar PDF híbrido: ${saveError.message}`);
    }
}

// Función para determinar estrategia híbrida
function determineHybridStrategy(totalPages) {
    if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.MAX) {
        return {
            strategy: 'reject',
            message: `Demasiadas páginas (${totalPages}). Límite híbrido: ${HYBRID_LIMITS.TOTAL_PAGES.MAX}`
        };
    } else if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.EXTREME) {
        return {
            strategy: 'extreme',
            chunkSize: 1,
            pauseTime: 150,
            streaming: {
                scale: 0.6,
                batchSize: 3,
                pauseTime: 200
            }
        };
    } else if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.AGGRESSIVE) {
        return {
            strategy: 'aggressive',
            chunkSize: 2,
            pauseTime: 100,
            streaming: {
                scale: 0.7,
                batchSize: 5,
                pauseTime: 150
            }
        };
    } else {
        return {
            strategy: 'normal',
            chunkSize: 3,
            pauseTime: 50,
            streaming: {
                scale: 0.8,
                batchSize: 8,
                pauseTime: 100
            }
        };
    }
}

// Función de carga con límites híbridos
async function loadPDFWithHybridLimits(fileBuffer, fileName = '') {
    const fileSizeMB = fileBuffer.byteLength / (1024 * 1024);
    if (fileSizeMB > HYBRID_LIMITS.FILE_SIZE_MB.MAX) {
        throw new Error(`Archivo ${fileName} demasiado grande (${fileSizeMB.toFixed(1)}MB). Máximo híbrido: ${HYBRID_LIMITS.FILE_SIZE_MB.MAX}MB`);
    }
    
    // Intentos de carga optimizados
    const loadAttempts = [
        {},
        { ignoreEncryption: true },
        { ignoreEncryption: true, updateXRefTable: false, parseSpeed: 2 }
    ];
    
    let lastError = null;
    
    for (let i = 0; i < loadAttempts.length; i++) {
        try {
            const loadOptions = loadAttempts[i];
            const pdf = await PDFLib.PDFDocument.load(fileBuffer, loadOptions);
            
            const pageCount = pdf.getPageCount();
            if (pageCount > HYBRID_LIMITS.PAGES_PER_FILE.MAX) {
                throw new Error(`Documento ${fileName} tiene ${pageCount} páginas. Máximo híbrido: ${HYBRID_LIMITS.PAGES_PER_FILE.MAX}`);
            }
            
            return { 
                pdf, 
                encrypted: loadOptions.ignoreEncryption === true, 
                corrupted: i > 0,
                attemptUsed: i + 1,
                method: 'pdf-lib',
                pageCount
            };
            
        } catch (error) {
            lastError = error;
            if (error.message.includes('páginas. Máximo híbrido')) {
                throw error;
            }
        }
    }
    
    // Fallback a PDF.js con límites híbridos
    if (fileSizeMB < HYBRID_LIMITS.FILE_SIZE_MB.LARGE) {
        try {
            const pdfDoc = await pdfjsLib.getDocument({ 
                data: fileBuffer,
                stopAtErrors: false,
                maxImageSize: 256 * 256, // Más pequeño para híbrido
                disableFontFace: true,
                verbosity: 0,
                useSystemFonts: false
            }).promise;
            
            if (pdfDoc.numPages > HYBRID_LIMITS.PAGES_PER_FILE.MAX) {
                throw new Error(`Documento ${fileName} tiene ${pdfDoc.numPages} páginas. Máximo híbrido: ${HYBRID_LIMITS.PAGES_PER_FILE.MAX}`);
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
            if (pdfjsError.message.includes('páginas. Máximo híbrido')) {
                throw pdfjsError;
            }
        }
    }
    
    throw new Error(`PDF ${fileName} no se puede procesar con el método híbrido.`);
}

// Función de diagnóstico con límites híbridos
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
            memoryEstimate: 0,
            hybridOptimizations: []
        };
        
        // Verificar límites híbridos
        if (fileSizeMB > HYBRID_LIMITS.FILE_SIZE_MB.MAX) {
            diagnosis.issues.push(`Archivo demasiado grande: ${diagnosis.sizeMB}MB (máximo híbrido: ${HYBRID_LIMITS.FILE_SIZE_MB.MAX}MB)`);
            diagnosis.canProcess = false;
        } else if (fileSizeMB > HYBRID_LIMITS.FILE_SIZE_MB.LARGE) {
            diagnosis.warnings.push(`Archivo grande: ${diagnosis.sizeMB}MB. Se usará compresión agresiva.`);
            diagnosis.hybridOptimizations.push('Compresión JPEG 60%');
        }
        
        try {
            const result = await loadPDFWithHybridLimits(file, diagnosis.fileName);
            diagnosis.pageCount = result.pageCount;
            diagnosis.method = result.method;
            diagnosis.encrypted = result.encrypted;
            diagnosis.corrupted = result.corrupted;
            
            totalPages += diagnosis.pageCount;
            
            // Verificar límites de páginas híbridos
            if (diagnosis.pageCount > HYBRID_LIMITS.PAGES_PER_FILE.MAX) {
                diagnosis.issues.push(`Demasiadas páginas: ${diagnosis.pageCount} (máximo híbrido: ${HYBRID_LIMITS.PAGES_PER_FILE.MAX})`);
                diagnosis.canProcess = false;
            } else if (diagnosis.pageCount > HYBRID_LIMITS.PAGES_PER_FILE.LARGE) {
                diagnosis.warnings.push(`Muchas páginas: ${diagnosis.pageCount}. Se usará streaming optimizado.`);
                diagnosis.hybridOptimizations.push('Streaming por lotes de 3 páginas');
            }
            
            // Estimar memoria híbrida
            const isImageConversion = result.method === 'pdf.js';
            diagnosis.memoryEstimate = estimateHybridMemoryUsage(file.byteLength, diagnosis.pageCount, isImageConversion);
            totalMemoryEstimate += diagnosis.memoryEstimate;
            
            if (diagnosis.memoryEstimate > HYBRID_LIMITS.MEMORY_ESTIMATE_MB.DANGER) {
                diagnosis.warnings.push(`Uso de memoria estimado: ${diagnosis.memoryEstimate}MB`);
                diagnosis.hybridOptimizations.push('Limpieza de memoria cada 10 páginas');
            }
            
        } catch (error) {
            diagnosis.issues.push(`No se puede procesar: ${error.message}`);
            diagnosis.canProcess = false;
        }
        
        diagnostics.push(diagnosis);
    }
    
    // Verificar límites totales híbridos
    const globalIssues = [];
    const globalWarnings = [];
    
    if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.MAX) {
        globalIssues.push(`Demasiadas páginas totales: ${totalPages} (máximo híbrido: ${HYBRID_LIMITS.TOTAL_PAGES.MAX})`);
    } else if (totalPages > HYBRID_LIMITS.TOTAL_PAGES.EXTREME) {
        globalWarnings.push(`Muchas páginas totales: ${totalPages}. Se usará estrategia extrema híbrida.`);
    }
    
    if (totalMemoryEstimate > HYBRID_LIMITS.MEMORY_ESTIMATE_MB.MAX) {
        globalIssues.push(`Memoria estimada demasiado alta: ${totalMemoryEstimate}MB (máximo híbrido: ${HYBRID_LIMITS.MEMORY_ESTIMATE_MB.MAX}MB)`);
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
            recommendedStrategy: determineHybridStrategy(totalPages).strategy,
            hybridMode: true,
            comparisonWithILovePDF: {
                serverAdvantages: ['RAM ilimitada', 'Procesamiento paralelo', 'Bibliotecas nativas'],
                hybridSolutions: ['Streaming de memoria', 'Compresión agresiva', 'Limpieza automática']
            }
        }
    });
}

// Función para estimar memoria híbrida
function estimateHybridMemoryUsage(fileSize, pageCount, isImageConversion = false) {
    let memoryMB = fileSize / (1024 * 1024);
    
    if (isImageConversion) {
        // Streaming reduce significativamente el uso de memoria
        memoryMB += pageCount * 0.8; // Reducido de 2MB por página
    } else {
        memoryMB += pageCount * 0.3; // Reducido de 0.5MB por página
    }
    
    memoryMB += (pageCount * 0.2); // Reducido el overhead del PDF final
    
    return Math.round(memoryMB);
}

// Funciones auxiliares simplificadas
async function analyzePDF({ fileBuffer, fileName }) {
    try {
        const result = await loadPDFWithHybridLimits(fileBuffer, fileName);
        const { pdf, encrypted, corrupted, method, pageCount } = result;
        
        self.postMessage({
            type: 'PDF_ANALYSIS',
            data: {
                fileName,
                pageCount,
                encrypted,
                corrupted,
                method,
                title: method === 'pdf.js' ? 'Procesamiento híbrido' : (pdf.getTitle() || 'Sin título'),
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
        const result = await loadPDFWithHybridLimits(fileBuffer);
        const { pdf, encrypted, method, pageCount } = result;
        
        let title;
        if (method === 'pdf.js') {
            title = 'Procesamiento híbrido optimizado';
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