const dropArea = document.getElementById('drop-area');
const fileInput = document.getElementById('fileElem');
const previewContainer = document.getElementById('preview-container');
const mergeBtn = document.getElementById('mergeBtn');
const downloadLink = document.getElementById('downloadLink');
const statusText = document.getElementById('status');

// Nuevos elementos
const addFileBtn = document.getElementById('addFileBtn');
const addAnotherFileBtn = document.getElementById('addAnotherFileBtn');
const fileInput2 = document.getElementById('fileElem2');

let pdfFiles = [];
let worker = null;
let isProcessing = false;

// Inicializar Web Worker
function initWorker() {
    if (worker) {
        worker.terminate();
    }
    
    worker = new Worker('/workspace/worker.js');
    worker.onmessage = function(e) {
        const { type, data, error, stage, current, total, percentage, message } = e.data;
        
        switch(type) {
            case 'PROGRESS':
                updateProgress(stage, current, total, percentage, message);
                break;
            case 'MERGE_COMPLETE':
                handleMergeComplete(data);
                break;
            case 'PDF_INFO':
                handlePDFInfo(data);
                break;
            case 'ERROR':
                handleError(error);
                break;
        }
    };
    
    worker.onerror = function(error) {
        console.error('Worker error:', error);
        handleError('Error en el procesamiento: ' + error.message);
    };
}

// Función para mostrar progreso detallado
function updateProgress(stage, current, total, percentage, message) {
    let stageText = '';
    switch(stage) {
        case 'loading':
            stageText = '📂 Cargando archivos';
            break;
        case 'merging':
            stageText = '🔄 Uniendo páginas';
            break;
        case 'saving':
            stageText = '💾 Generando archivo';
            break;
    }
    
    const progressHTML = `
        <div class="progress-container">
            <div class="progress-stage">${stageText}</div>
            <div class="progress-message">${message}</div>
            ${percentage ? `
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${percentage}%"></div>
                </div>
                <div class="progress-percentage">${percentage}%</div>
            ` : ''}
        </div>
    `;
    
    statusText.innerHTML = progressHTML;
    statusText.classList.add('loading');
    statusText.setAttribute('aria-busy', 'true');
}

// Manejo de errores mejorado
function handleError(error) {
    console.error('Error:', error);
    statusText.innerHTML = `
        <div class="error-container">
            <div class="error-icon">⚠️</div>
            <div class="error-message">Error: ${error}</div>
            <div class="error-suggestion">Intenta con archivos más pequeños o reinicia la página</div>
        </div>
    `;
    statusText.classList.remove('loading');
    statusText.classList.add('error');
    statusText.removeAttribute('aria-busy');
    mergeBtn.disabled = false;
    isProcessing = false;
}

// Completar merge
function handleMergeComplete(mergedPdfFile) {
    const blob = new Blob([mergedPdfFile], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    downloadLink.href = url;
    downloadLink.download = 'pdf_unido.pdf';
    downloadLink.style.display = 'block';
    
    statusText.innerHTML = `
        <div class="success-container">
            <div class="success-icon">✅</div>
            <div class="success-message">¡PDF unido exitosamente!</div>
        </div>
    `;
    statusText.classList.remove('loading');
    statusText.classList.add('success');
    statusText.removeAttribute('aria-busy');
    mergeBtn.disabled = false;
    isProcessing = false;
}

// Eventos drag and drop
['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, e => {
        e.preventDefault();
        if (!isProcessing) {
            dropArea.classList.add('highlight');
        }
    });
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, e => {
        e.preventDefault();
        dropArea.classList.remove('highlight');
    });
});

dropArea.addEventListener('drop', e => {
    if (isProcessing) return;
    const files = [...e.dataTransfer.files];
    handleFiles(files);
});

fileInput.addEventListener('change', e => {
    if (isProcessing) return;
    const files = [...e.target.files];
    handleFiles(files);
});

if (fileInput2) {
    fileInput2.addEventListener('change', e => {
        if (isProcessing) return;
        const files = [...e.target.files];
        handleFiles(files);
    });
}

if (addFileBtn) {
    addFileBtn.addEventListener('click', () => {
        if (isProcessing) return;
        fileInput.value = '';
        fileInput.click();
    });
}

if (addAnotherFileBtn) {
    addAnotherFileBtn.addEventListener('click', () => {
        if (isProcessing) return;
        fileInput2.value = '';
        fileInput2.click();
    });
}

// Validación de archivos mejorada
function validateFiles(files) {
    const validFiles = [];
    const errors = [];
    
    for (const file of files) {
        if (file.type !== 'application/pdf') {
            errors.push(`${file.name}: No es un archivo PDF válido`);
            continue;
        }
        
        // Límite de tamaño por archivo (100MB)
        if (file.size > 100 * 1024 * 1024) {
            errors.push(`${file.name}: Archivo demasiado grande (máximo 100MB)`);
            continue;
        }
        
        validFiles.push(file);
    }
    
    if (errors.length > 0) {
        statusText.innerHTML = `
            <div class="warning-container">
                <div class="warning-icon">⚠️</div>
                <div class="warning-title">Algunos archivos no se pudieron procesar:</div>
                <ul class="warning-list">
                    ${errors.map(error => `<li>${error}</li>`).join('')}
                </ul>
            </div>
        `;
        statusText.classList.add('warning');
    }
    
    return validFiles;
}

function handleFiles(files) {
    if (isProcessing) return;
    
    const validFiles = validateFiles(files);
    if (!validFiles.length) return;
    
    pdfFiles.push(...validFiles);
    renderPreviews();
    mergeBtn.disabled = pdfFiles.length < 2;
    
    // Limpiar mensajes de estado anteriores
    if (statusText.classList.contains('warning')) {
        setTimeout(() => {
            statusText.innerHTML = '';
            statusText.classList.remove('warning');
        }, 5000);
    }
}

// Renderizado optimizado de previews
async function renderPreviews() {
    previewContainer.innerHTML = '';
    
    // Renderizar previews de forma lazy para mejor rendimiento
    for (let index = 0; index < pdfFiles.length; index++) {
        const file = pdfFiles[index];
        
        const div = document.createElement('div');
        div.classList.add('preview-item');
        
        // Botón para eliminar este archivo
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.type = 'button';
        removeBtn.title = 'Eliminar este PDF';
        removeBtn.innerHTML = '✕';
        removeBtn.addEventListener('click', () => {
            if (isProcessing) return;
            pdfFiles.splice(index, 1);
            renderPreviews();
            mergeBtn.disabled = pdfFiles.length < 2;
            if (pdfFiles.length === 0) {
                downloadLink.style.display = 'none';
                statusText.textContent = '';
            }
        });
        div.appendChild(removeBtn);

        // Placeholder mientras se carga la preview
        const placeholder = document.createElement('div');
        placeholder.className = 'preview-placeholder';
        placeholder.innerHTML = '📄';
        div.appendChild(placeholder);

        // Metadatos básicos
        const meta = document.createElement('div');
        meta.classList.add('preview-meta');
        const nameEl = document.createElement('div');
        nameEl.classList.add('file-name');
        nameEl.textContent = file.name;
        const sizeEl = document.createElement('div');
        sizeEl.classList.add('file-size');
        sizeEl.textContent = formatFileSize(file.size);
        meta.appendChild(nameEl);
        meta.appendChild(sizeEl);
        div.appendChild(meta);

        previewContainer.appendChild(div);
        
        // Cargar preview de forma asíncrona
        loadPreviewAsync(file, div, placeholder);
    }
}

// Carga asíncrona de previews para evitar bloqueos
async function loadPreviewAsync(file, container, placeholder) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport }).promise;

        const img = document.createElement('img');
        img.src = canvas.toDataURL();
        img.style.opacity = '0';
        img.onload = () => {
            img.style.transition = 'opacity 0.3s ease';
            img.style.opacity = '1';
        };
        
        // Reemplazar placeholder con la imagen
        container.replaceChild(img, placeholder);
        
        // Actualizar metadatos con el número de páginas
        const pagesEl = document.createElement('div');
        pagesEl.classList.add('file-pages');
        pagesEl.textContent = `${pdf.numPages} páginas`;
        container.querySelector('.preview-meta').appendChild(pagesEl);
        
    } catch (error) {
        console.error('Error loading preview:', error);
        placeholder.innerHTML = '❌';
        placeholder.title = 'Error al cargar preview';
    }
}

// Formatear tamaño de archivo
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Evento de merge con Web Worker
mergeBtn.addEventListener('click', async () => {
    if (pdfFiles.length < 2 || isProcessing) return;
    
    isProcessing = true;
    mergeBtn.disabled = true;
    downloadLink.style.display = 'none';
    
    // Limpiar clases de estado anteriores
    statusText.classList.remove('success', 'error', 'warning');
    
    try {
        // Inicializar worker si no existe
        if (!worker) {
            initWorker();
        }
        
        // Convertir archivos a ArrayBuffer para el worker
        const fileBuffers = [];
        for (const file of pdfFiles) {
            const buffer = await file.arrayBuffer();
            fileBuffers.push(buffer);
        }
        
        // Enviar al worker para procesamiento
        worker.postMessage({
            type: 'MERGE_PDFS',
            data: {
                files: fileBuffers,
                progressCallback: true
            }
        });
        
    } catch (error) {
        handleError(error.message);
    }
});

// Inicializar worker al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    initWorker();
});

// Limpiar worker al cerrar la página
window.addEventListener('beforeunload', () => {
    if (worker) {
        worker.terminate();
    }
});
