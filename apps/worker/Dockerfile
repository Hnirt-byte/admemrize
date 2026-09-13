FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
# Depuis la Phase 6, le worker importe le service d'expiration de l'API
# (@admemrize/api/services/expiration) plutôt que de redéclarer un accès aux
# tables : son package doit donc être présent et compilé ici aussi.
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm install
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN npm run build --workspace=@admemrize/shared
RUN npm run build --workspace=@admemrize/api
RUN npm run build --workspace=@admemrize/worker

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
CMD ["node", "apps/worker/dist/index.js"]
