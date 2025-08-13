const SERVER_URL = (import.meta.env.VITE_SERVER_URL || window.location.origin);

const OPERATIONS = [
	{ id: 'merge-pdf', label: 'Unir PDFs', multiple: true, field: 'files', accept: '.pdf' },
	{ id: 'docx-to-pdf', label: 'DOCX → PDF', multiple: false, field: 'file', accept: '.docx' },
	{ id: 'pdf-to-docx', label: 'PDF → DOCX', multiple: false, field: 'file', accept: '.pdf' },
	{ id: 'pdf-to-excel', label: 'PDF → Excel (XLSX)', multiple: false, field: 'file', accept: '.pdf' },
	{ id: 'jpg-to-png', label: 'JPG → PNG', multiple: false, field: 'file', accept: '.jpg,.jpeg' }
];

const tabsEl = document.getElementById('tabs');
const panelEl = document.getElementById('panel');
const barEl = document.getElementById('bar');
const statusEl = document.getElementById('status');
const taskEl = document.getElementById('task');
const resultEl = document.getElementById('result');

let currentOp = OPERATIONS[0].id;
let selectedFiles = [];
let jobId = crypto.randomUUID();
let es;

function connectSSE() {
	if (es) es.close();
	es = new EventSource(`${SERVER_URL}/progress/${jobId}`);
	es.addEventListener('progress', (e) => {
		try {
			const data = JSON.parse(e.data || '{}');
			if (typeof data.percent === 'number') barEl.style.width = `${Math.max(0, Math.min(100, data.percent))}%`;
			if (data.status) statusEl.textContent = data.status;
			if (data.url) setResult(`${SERVER_URL}${data.url}`);
		} catch (_) {}
	});
	es.addEventListener('end', () => {
		// Mantener la conexión para futuras tareas con el mismo jobId
	});
	es.onerror = () => {
		// Ignorar errores transitorios de red
	};
}

function setProgress(percent, text) {
	barEl.style.width = `${percent}%`;
	if (text) statusEl.textContent = text;
}

function setTask(text) { taskEl.textContent = text || '—'; }

function setResult(link) {
	if (!link) { resultEl.innerHTML = '<span style="color:#9aa6c7">—</span>'; return; }
	resultEl.innerHTML = `<a href="${link}" target="_blank">Descargar resultado</a>`;
}

function renderTabs() {
	tabsEl.innerHTML = '';
	OPERATIONS.forEach(op => {
		const b = document.createElement('button');
		b.className = 'tab' + (op.id === currentOp ? ' active' : '');
		b.textContent = op.label;
		b.onclick = () => { currentOp = op.id; renderTabs(); renderPanel(); };
		tabsEl.appendChild(b);
	});
}

function renderPanel() {
	const op = OPERATIONS.find(o => o.id === currentOp);
	panelEl.innerHTML = '';

	const drop = document.createElement('div');
	drop.className = 'drop';
	drop.innerHTML = `<div style="font-weight:700;margin-bottom:8px">${op.label}</div>
		<div>Arrastra tus archivos aquí o <span style=\"color:#b6f3fc;font-weight:700\">haz clic para seleccionar</span></div>`;

	const input = document.createElement('input');
	input.type = 'file';
	input.accept = op.accept;
	input.multiple = !!op.multiple;
	input.style.display = 'none';
	input.onchange = (e) => {
		selectedFiles = [...e.target.files];
		drop.querySelector('div').textContent = `${selectedFiles.length} archivo(s) seleccionado(s)`;
	};

	drop.onclick = () => input.click();
	drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('dragover'); };
	drop.ondragleave = () => drop.classList.remove('dragover');
	drop.ondrop = (e) => {
		e.preventDefault();
		drop.classList.remove('dragover');
		const files = [...e.dataTransfer.files];
		selectedFiles = op.multiple ? files.filter(f => f.name.toLowerCase().endsWith(op.accept.replace('.', ''))) : [files[0]];
		drop.querySelector('div').textContent = `${selectedFiles.length} archivo(s) seleccionado(s)`;
	};

	const nameWrap = document.createElement('div');
	nameWrap.style.marginTop = '12px';
	nameWrap.innerHTML = `<div style=\"font-weight:600;margin-bottom:6px\">Nombre de salida</div>`;
	const nameInput = document.createElement('input');
	nameInput.type = 'text';
	nameInput.placeholder = inferDefaultName(op.id);
	nameInput.value = '';
	nameWrap.appendChild(nameInput);

	const actions = document.createElement('div');
	actions.className = 'actions';
	const runBtn = document.createElement('button');
	runBtn.textContent = 'Procesar';
	runBtn.onclick = () => runOperation(op, nameInput.value.trim());
	const clearBtn = document.createElement('button');
	clearBtn.className = 'secondary';
	clearBtn.textContent = 'Limpiar';
	clearBtn.onclick = () => { selectedFiles = []; input.value = ''; setResult(null); setProgress(0, 'Esperando archivos…'); drop.querySelector('div').textContent = op.label; };
	actions.appendChild(runBtn);
	actions.appendChild(clearBtn);

	panelEl.appendChild(drop);
	panelEl.appendChild(input);
	panelEl.appendChild(nameWrap);
	panelEl.appendChild(actions);

	setTask(op.label);
}

function inferDefaultName(opId) {
	switch (opId) {
		case 'merge-pdf': return 'merged.pdf';
		case 'docx-to-pdf': return 'output.pdf';
		case 'pdf-to-docx': return 'output.docx';
		case 'pdf-to-excel': return 'output.xlsx';
		case 'jpg-to-png': return 'output.png';
		default: return 'output.bin';
	}
}

async function runOperation(op, outputName) {
	if (!selectedFiles.length) { alert('Selecciona archivo(s)'); return; }
	setProgress(5, 'Subiendo archivos…');
	setResult(null);

	const form = new FormData();
	const field = op.field;
	selectedFiles.forEach(f => form.append(field, f));
	if (outputName) form.append('outputName', outputName);

	try {
		const resp = await fetch(`${SERVER_URL}/${op.id}`, {
			method: 'POST',
			headers: { 'x-job-id': jobId },
			body: form
		});
		if (!resp.ok) {
			const err = await resp.json().catch(() => ({}));
			throw new Error(err.error || 'Error en el servidor');
		}
		await resp.json();
		// El progreso final llegará por SSE
	} catch (e) {
		console.error(e);
		statusEl.textContent = `Error: ${e.message}`;
	}
}

function boot() {
	connectSSE();
	renderTabs();
	renderPanel();
}

boot();