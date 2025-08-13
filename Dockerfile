# Etapa 1: build del frontend
FROM node:22-alpine AS client-build
WORKDIR /app
COPY client/package*.json client/vite.config.js client/index.html client/main.js ./client/
RUN cd client && npm ci && npm run build

# Etapa 2: runtime
FROM debian:stable-slim
ENV NODE_ENV=production
# Dependencias del sistema
RUN apt-get update && apt-get install -y \
    curl ca-certificates \
    pdftk pandoc imagemagick default-jre \
  && rm -rf /var/lib/apt/lists/*

# Instalar Tabula (tabula-java) sin unzip
RUN set -eux; \
  curl -fL -o /usr/local/bin/tabula.jar https://github.com/tabulapdf/tabula-java/releases/download/v1.0.5/tabula-1.0.5.jar; \
  printf '#!/usr/bin/env bash\nexec java -jar /usr/local/bin/tabula.jar "$@"' > /usr/local/bin/tabula; \
  chmod +x /usr/local/bin/tabula

# Node
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get update && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --only=production
COPY server/src ./server/src
# Copiar build del cliente
COPY --from=client-build /app/client/dist ./client/dist

EXPOSE 4000
CMD ["node", "server/src/index.js"]