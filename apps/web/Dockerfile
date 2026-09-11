FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace=@admemrize/web

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile.internal /etc/caddy/Caddyfile
# Ce Caddy interne ne fait AUCUN TLS et n'est jamais publié sur l'hôte (voir docker-compose.yml) :
# il sert uniquement de serveur de fichiers statiques, joignable en HTTP simple
# depuis le Caddy partagé du VPS via le réseau "edge".
