const dropArea = document.getElementById('drop-area');
const fileInput = document.getElementById('fileElem');
const previewContainer = document.getElementById('preview-container');
const mergeBtn = document.getElementById('mergeBtn');
const downloadLink = document.getElementById('downloadLink');
const statusText = document.getElementById('status');

let pdfFiles = [];

// Eventos drag and drop
['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, e => {
        e.preventDefault();
        dropArea.classList.add('highlight');
    });
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, e => {
        e.preventDefault();
        dropArea.classList.remove('highlight');
    });
});

dropArea.addEventListener('drop', e => {
    const files = [...e.dataTransfer.files];
    handleFiles(files);
});

fileInput.addEventListener('change', e => {
    const files = [...e.target.files];
    handleFiles(files);
});

function handleFiles(files) {
    files = files.filter(file => file.type === 'application/pdf');
    pdfFiles.push(...files);
    renderPreviews();
    mergeBtn.disabled = pdfFiles.length < 2;
}

async function renderPreviews() {
    previewContainer.innerHTML = '';
    for (let file of pdfFiles) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: context, viewport }).promise;

        const div = document.createElement('div');
        div.classList.add('preview-item');
        const img = document.createElement('img');
        img.src = canvas.toDataURL();
        div.appendChild(img);
        previewContainer.appendChild(div);
    }
}

mergeBtn.addEventListener('click', async () => {
    if (pdfFiles.length < 2) return;
    statusText.textContent = 'Uniendo PDFs...';
    mergeBtn.disabled = true;

    const mergedPdf = await PDFLib.PDFDocument.create();

    for (let file of pdfFiles) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await PDFLib.PDFDocument.load(arrayBuffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach(page => mergedPdf.addPage(page));
    }

    const mergedPdfFile = await mergedPdf.save();
    const blob = new Blob([mergedPdfFile], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    downloadLink.href = url;
    downloadLink.download = 'pdf_unido.pdf';
    downloadLink.style.display = 'block';
    statusText.textContent = '¡Listo! Descarga tu PDF unido.';
});
