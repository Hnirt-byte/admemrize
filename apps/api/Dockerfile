FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm install
COPY packages/shared packages/shared
COPY apps/api apps/api
# Le package partagé est compilé en JS avant l'API : celle-ci l'importe au
# runtime (packages/shared/dist), Node ne sait pas lire du TypeScript.
RUN npm run build --workspace=@admemrize/shared
RUN npm run build --workspace=@admemrize/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
# Migrations SQL : jouées au démarrage par apps/api/src/db/migrate.ts.
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
CMD ["node", "apps/api/dist/index.js"]
