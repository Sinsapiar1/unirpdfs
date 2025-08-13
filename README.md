# Unificador de PDFs - Versión Potenciada (Servidor)

Aplicación web moderna que procesa archivos en el servidor usando herramientas de línea de comandos:

- pdftk (unión de PDFs)
- pandoc (DOCX ⇄ PDF)
- ImageMagick (JPG → PNG)
- tabula (extracción de tablas PDF → CSV)

## Estructura

- `server/`: backend Express que recibe archivos, ejecuta comandos y sirve descargas
- `client/`: frontend Vite con UI moderna y responsiva

## Requisitos del sistema

Instala dependencias nativas en Linux (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y pdftk pandoc imagemagick default-jre
# Tabula CLI (si no está en repos):
wget -O tabula.zip https://github.com/tabulapdf/tabula/releases/download/v1.2.1/tabula-1.2.1-jar.zip
unzip tabula.zip -d tabula && sudo mv tabula/tabula-1.2.1.jar /usr/local/bin/tabula.jar
sudo bash -lc 'echo -e "#!/usr/bin/env bash\nexec java -jar /usr/local/bin/tabula.jar \"$@\"" > /usr/local/bin/tabula && chmod +x /usr/local/bin/tabula'
```

Nota: En algunos sistemas ImageMagick usa `magick convert` en lugar de `convert`. Ajusta el comando en `server/src/index.js` si es tu caso.

## Desarrollo

1) Backend

```bash
cd server
npm i
npm run dev
```

El servidor escucha en `http://localhost:4000`.

2) Frontend

```bash
cd client
npm i
npm run dev
```

El frontend escucha en `http://localhost:5173` y llama a `http://localhost:4000`.

Puedes configurar `VITE_SERVER_URL` si el backend corre en otra URL.

## Endpoints

- `POST /merge-pdf` (multipart) `files[]` → JSON `{ url }`
- `POST /docx-to-pdf` (multipart) `file` → JSON `{ url }`
- `POST /pdf-to-docx` (multipart) `file` → JSON `{ url }`
- `POST /pdf-to-excel` (multipart) `file` → JSON `{ url }`
- `POST /jpg-to-png` (multipart) `file` → JSON `{ url }`
- `GET /download/:jobId/:file` descarga archivo procesado

## Notas de seguridad y producción

- Valida extensiones y tipos MIME antes de procesar
- Limita tamaño de archivos con Multer y servidor
- Limpia directorios `uploads/` y `outputs/` con un job programado
- Corre los binarios en sandbox (contenedor) si es posible
- Detrás de un proxy inverso configura timeouts adecuados

## Licencia

MIT

## Despliegue con Docker

Construir y ejecutar localmente:

```bash
# Construir imagen
docker build -t pdf-power-tools:latest .
# Ejecutar
docker run --rm -p 4000:4000 pdf-power-tools:latest
# Abrir: http://localhost:4000
```

## Despliegue desde GitHub

- Al hacer push a `main`/`master`, el workflow `build-and-publish` construye el cliente, empaqueta todo en Docker y publica la imagen en GHCR: `ghcr.io/<owner>/<repo>:latest`.
- Para desplegar en tu infraestructura (VPS/Kubernetes/Render/Fly.io), extrae esa imagen y ejecútala exponiendo el puerto 4000.

```bash
docker pull ghcr.io/<owner>/<repo>:latest
docker run --rm -p 4000:4000 ghcr.io/<owner>/<repo>:latest
```
