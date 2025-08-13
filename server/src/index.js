import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const OUTPUT_ROOT = path.join(__dirname, '..', 'outputs');

for (const dir of [UPLOAD_ROOT, OUTPUT_ROOT]) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const jobId = req.headers['x-job-id'];
		const target = path.join(UPLOAD_ROOT, String(jobId || 'default'));
		fs.mkdirSync(target, { recursive: true });
		cb(null, target);
	},
	filename: (req, file, cb) => {
		cb(null, file.originalname);
	}
});

const upload = multer({ storage });

// Gestión de streams SSE por jobId en memoria (para demo / dev). En producción
// usar un almacén compartido si se tienen múltiples instancias (e.g., Redis pub/sub).
const progressStreams = new Map(); // jobId -> Set<res>

function addSSEStream(jobId, res) {
	if (!progressStreams.has(jobId)) progressStreams.set(jobId, new Set());
	progressStreams.get(jobId).add(res);
}

function removeSSEStream(jobId, res) {
	const set = progressStreams.get(jobId);
	if (set) {
		set.delete(res);
		if (set.size === 0) progressStreams.delete(jobId);
	}
}

function publishProgress(jobId, payload) {
	const set = progressStreams.get(jobId);
	if (!set) return;
	for (const res of set) {
		res.write(`event: progress\n`);
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	}
}

function endProgress(jobId) {
	const set = progressStreams.get(jobId);
	if (!set) return;
	for (const res of set) {
		res.write('event: end\n');
		res.write('data: {}\n\n');
		res.end();
	}
	progressStreams.delete(jobId);
}

function buildJobDirs(jobId) {
	const uploadDir = path.join(UPLOAD_ROOT, jobId);
	const outputDir = path.join(OUTPUT_ROOT, jobId);
	fs.mkdirSync(uploadDir, { recursive: true });
	fs.mkdirSync(outputDir, { recursive: true });
	return { uploadDir, outputDir };
}

async function run(cmd) {
	// Ejecuta comandos con buffer amplio para CLIs verbosas
	return execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
}

// Convierte un CSV (ruta) a XLSX (ruta) usando xlsx
function convertCsvToXlsx(csvPath, xlsxPath) {
	const csvContent = fs.readFileSync(csvPath, 'utf8');
	const wb = XLSX.read(csvContent, { type: 'string' });
	// Si el CSV genera más de una hoja, tomamos la primera
	const firstSheetName = wb.SheetNames[0];
	const newWb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(newWb, wb.Sheets[firstSheetName], 'Datos');
	XLSX.writeFile(newWb, xlsxPath);
}

// Health
app.get('/health', (req, res) => {
	res.json({ ok: true });
});

// SSE de progreso por jobId
app.get('/progress/:jobId', (req, res) => {
	const { jobId } = req.params;
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();
	addSSEStream(jobId, res);
	res.write(`event: progress\n`);
	res.write(`data: ${JSON.stringify({ percent: 0, status: 'Conectado' })}\n\n`);
	const keepAlive = setInterval(() => {
		try {
			res.write(`event: ping\n`);
			res.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
		} catch (_) {
			// Ignorar
		}
	}, 25000);
	res.on('close', () => {
		clearInterval(keepAlive);
		removeSSEStream(jobId, res);
	});
});

// Subida genérica (útil si se quiere subir en pasos separados)
app.post('/upload', upload.array('files'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || 'default');
	const files = (req.files || []).map(f => ({ path: f.path, originalname: f.originalname }));
	publishProgress(jobId, { percent: 10, status: 'Archivos subidos' });
	res.json({ jobId, files });
});

// Unir PDFs con pdftk
app.post('/merge-pdf', upload.array('files'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || uuidv4());
	const { outputName = 'merged.pdf' } = req.body || {};
	const { outputDir } = buildJobDirs(jobId);
	try {
		const inputFiles = (req.files || [])
			.filter(f => f.originalname.toLowerCase().endsWith('.pdf'))
			.map(f => f.path);
		if (inputFiles.length < 2) {
			return res.status(400).json({ error: 'Se requieren al menos dos PDFs.' });
		}
		publishProgress(jobId, { percent: 15, status: 'Preparando unión de PDFs' });
		const outputFile = path.join(outputDir, outputName);
		const cmd = `pdftk ${inputFiles.map(f => `'${f}'`).join(' ')} cat output '${outputFile}'`;
		await run(cmd);
		publishProgress(jobId, { percent: 95, status: 'Guardando archivo resultante' });
		publishProgress(jobId, { percent: 100, status: 'Completado', url: `/download/${jobId}/${path.basename(outputFile)}` });
		endProgress(jobId);
		return res.json({ jobId, url: `/download/${jobId}/${path.basename(outputFile)}` });
	} catch (err) {
		publishProgress(jobId, { percent: 100, status: 'Error', error: String(err) });
		endProgress(jobId);
		return res.status(500).json({ error: String(err) });
	}
});

// DOCX -> PDF con pandoc
app.post('/docx-to-pdf', upload.single('file'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || uuidv4());
	const { outputName = 'output.pdf' } = req.body || {};
	const { outputDir } = buildJobDirs(jobId);
	try {
		if (!req.file || !req.file.originalname.toLowerCase().endsWith('.docx')) {
			return res.status(400).json({ error: 'Sube un archivo .docx' });
		}
		publishProgress(jobId, { percent: 15, status: 'Convirtiendo DOCX a PDF' });
		const input = req.file.path;
		const outputFile = path.join(outputDir, outputName);
		const cmd = `pandoc '${input}' -o '${outputFile}'`;
		await run(cmd);
		publishProgress(jobId, { percent: 100, status: 'Completado', url: `/download/${jobId}/${path.basename(outputFile)}` });
		endProgress(jobId);
		return res.json({ jobId, url: `/download/${jobId}/${path.basename(outputFile)}` });
	} catch (err) {
		publishProgress(jobId, { percent: 100, status: 'Error', error: String(err) });
		endProgress(jobId);
		return res.status(500).json({ error: String(err) });
	}
});

// PDF -> DOCX con pandoc
app.post('/pdf-to-docx', upload.single('file'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || uuidv4());
	const { outputName = 'output.docx' } = req.body || {};
	const { outputDir } = buildJobDirs(jobId);
	try {
		if (!req.file || !req.file.originalname.toLowerCase().endsWith('.pdf')) {
			return res.status(400).json({ error: 'Sube un archivo .pdf' });
		}
		publishProgress(jobId, { percent: 15, status: 'Convirtiendo PDF a DOCX' });
		const input = req.file.path;
		const outputFile = path.join(outputDir, outputName);
		const cmd = `pandoc '${input}' -o '${outputFile}'`;
		await run(cmd);
		publishProgress(jobId, { percent: 100, status: 'Completado', url: `/download/${jobId}/${path.basename(outputFile)}` });
		endProgress(jobId);
		return res.json({ jobId, url: `/download/${jobId}/${path.basename(outputFile)}` });
	} catch (err) {
		publishProgress(jobId, { percent: 100, status: 'Error', error: String(err) });
		endProgress(jobId);
		return res.status(500).json({ error: String(err) });
	}
});

// PDF -> Excel (XLSX) con Tabula (CSV) + conversión a XLSX
app.post('/pdf-to-excel', upload.single('file'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || uuidv4());
	const { outputName = 'output.xlsx' } = req.body || {};
	const { outputDir } = buildJobDirs(jobId);
	try {
		if (!req.file || !req.file.originalname.toLowerCase().endsWith('.pdf')) {
			return res.status(400).json({ error: 'Sube un archivo .pdf' });
		}
		publishProgress(jobId, { percent: 15, status: 'Extrayendo tablas (Tabula)' });
		const input = req.file.path;
		const tmpCsv = path.join(outputDir, 'tabula.csv');
		const outputFile = path.join(outputDir, outputName);
		const cmd = `tabula -o '${tmpCsv}' -f CSV '${input}'`;
		await run(cmd);
		publishProgress(jobId, { percent: 70, status: 'Convirtiendo CSV a Excel' });
		convertCsvToXlsx(tmpCsv, outputFile);
		publishProgress(jobId, { percent: 100, status: 'Completado', url: `/download/${jobId}/${path.basename(outputFile)}` });
		endProgress(jobId);
		return res.json({ jobId, url: `/download/${jobId}/${path.basename(outputFile)}` });
	} catch (err) {
		publishProgress(jobId, { percent: 100, status: 'Error', error: String(err) });
		endProgress(jobId);
		return res.status(500).json({ error: String(err) });
	}
});

// JPG -> PNG con ImageMagick (intenta convert, y si no existe usa magick convert)
app.post('/jpg-to-png', upload.single('file'), async (req, res) => {
	const jobId = String(req.headers['x-job-id'] || uuidv4());
	const { outputName = 'output.png' } = req.body || {};
	const { outputDir } = buildJobDirs(jobId);
	try {
		if (!req.file || !/\.(jpg|jpeg)$/i.test(req.file.originalname)) {
			return res.status(400).json({ error: 'Sube un archivo .jpg o .jpeg' });
		}
		publishProgress(jobId, { percent: 15, status: 'Convirtiendo imagen' });
		const input = req.file.path;
		const outputFile = path.join(outputDir, outputName);
		const cmd = `(convert '${input}' '${outputFile}') || (magick convert '${input}' '${outputFile}')`;
		await run(cmd);
		publishProgress(jobId, { percent: 100, status: 'Completado', url: `/download/${jobId}/${path.basename(outputFile)}` });
		endProgress(jobId);
		return res.json({ jobId, url: `/download/${jobId}/${path.basename(outputFile)}` });
	} catch (err) {
		publishProgress(jobId, { percent: 100, status: 'Error', error: String(err) });
		endProgress(jobId);
		return res.status(500).json({ error: String(err) });
	}
});

// Descargas
app.use('/download', express.static(OUTPUT_ROOT, { fallthrough: false }));

// Servir frontend (build de Vite) si existe
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
	app.use(express.static(CLIENT_DIST));
	app.get('/', (req, res) => {
		res.sendFile(path.join(CLIENT_DIST, 'index.html'));
	});
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
	console.log(`Servidor escuchando en http://localhost:${PORT}`);
});