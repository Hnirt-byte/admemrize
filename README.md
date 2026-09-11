# ADMEMRIZE

Squelette V1 — voir `architecture-v1-addendum.md` pour le détail des décisions,
et le master prompt original pour le cahier des charges produit complet.

## Démarrer en local

Prérequis : Node.js ≥ 20, Docker (pour Postgres uniquement en dev).

```bash
# 1. Copier les variables d'environnement
cp .env.example .env

# 2. Installer tout le monorepo (api, web, worker, shared)
npm install

# 3. Démarrer Postgres seul (Docker — docker-compose.override.yml expose le port en local)
docker compose up -d postgres

# 4. Générer et appliquer les migrations Drizzle (une fois le schéma stabilisé)
npm run db:generate
npm run db:migrate

# 5. Lancer chaque service dans un terminal séparé
npm run dev:api      # http://localhost:3000/api/v1/health
npm run dev:web      # http://localhost:5173
npm run dev:worker
```

## Structure

- `apps/api` — Fastify + Drizzle + Zod. Toute la logique serveur, source de vérité.
- `apps/web` — PWA Vite + React. Sert à la fois le flux invité (`/e/:eventSlug`)
  et le flux organisateur (`/app`).
- `apps/worker` — cron d'expiration (suppression définitive à `deleteAt`).
- `packages/shared` — schémas Zod partagés entre l'API et le web.

## Déploiement sur le VPS Hostinger (isolation stricte d'Hermes)

Hostinger Docker Manager fournit déjà un projet Traefik partagé (visible dans
ton hPanel à côté d'`hermes-agent-rrcn`) qui écoute seul sur les ports 80/443
et route vers les projets qui portent les bons labels Docker. Pas besoin d'un
deuxième reverse proxy, pas besoin de toucher à la config d'Hermes.

Isolation réseau côté ADMEMRIZE (voir `architecture-v1-addendum.md` section 6) :

- `internal` (`internal: true`) : Postgres seul, aucune route sortante.
- `traefik-proxy` (réseau externe, déjà créé par le template Traefik de
  Hostinger) : uniquement `admemrize-api` et `admemrize-web`. C'est le seul
  point de contact entre ADMEMRIZE et le reste du VPS.

Étapes de déploiement :

```bash
# 1. Sur le VPS, dans le dossier du projet ADMEMRIZE (ex: via Docker Manager > Compose > URL du repo)
cp .env.example .env
nano .env
# Renseigner : POSTGRES_PASSWORD, JWT_*, S3_*, et surtout ADMEMRIZE_DOMAIN
# (le sous-domaine réel, ex: admemrize.tondomaine.fr — pointe son DNS vers l'IP du VPS avant)

# 2. Avant de déployer, vérifie que "letsencrypt" est bien le nom du certresolver
#    configuré par TON instance Traefik (Hostinger peut varier) :
#    Terminal du projet "traefik" dans hPanel, puis :
docker inspect hermes-agent-rrcn --format '{{json .Config.Labels}}' | python3 -m json.tool
# Compare le nom du certresolver utilisé par Hermes à celui dans docker-compose.yml
# d'ADMEMRIZE ; corrige si différent.

# 3. Déployer (sans l'override de dev)
docker compose -f docker-compose.yml up -d --build
```

Traefik détecte automatiquement les nouveaux labels sans redémarrage. Source :
[documentation Hostinger — connecter plusieurs projets Docker Compose via Traefik](https://www.hostinger.com/support/connecting-multiple-docker-compose-projects-using-traefik-in-hostinger-docker-manager/).

## Roadmap (section 36 du master prompt, adaptée)

- [x] **Phase 1** — squelette du repo (ce commit)
- [ ] **Phase 2** — backend : auth organisateur (Argon2id, JWT), CRUD événements, sessions invité
- [ ] **Phase 3** — stockage objet Scaleway (abstraction S3, presigned URLs)
- [ ] **Phase 4** — upload photo, validation, Sharp (thumbnail/preview)
- [ ] **Phase 5** — révélation : gate serveur, `revealAt`, révélation anticipée
- [ ] **Phase 6** — expiration : implémentation réelle du worker, suppression idempotente
- [ ] **Phase 7** — PWA invité : capture caméra, queue offline, upload
- [ ] **Phase 8** — PWA organisateur : dashboard, QR, settings, déclenchement reveal
- [ ] **Phase 9** — galerie post-reveal : animation, onglets, téléchargement
- [ ] **Phase 10** — polish : manifest/icônes PWA, notifications, animations

## Comment continuer avec Claude Code

Ouvre ce dossier dans VS Code, lance le panneau Claude Code, et donne-lui
un objectif par phase (une seule à la fois, jamais plusieurs) — par exemple
pour la Phase 2 :

> Implémente la Phase 2 du README : auth organisateur (inscription, connexion,
> refresh token via JWT + Argon2id) et endpoints CRUD `/api/v1/events`, en
> t'appuyant sur le schéma `apps/api/src/db/schema.ts` déjà en place. Écris les
> tests de sécurité listés en section 35 du master prompt (un invité ne peut
> pas agir comme organisateur, token invalide refusé). Lance les tests avant
> de me confirmer que c'est fait.

Reviens ensuite dans cette conversation pour toute question d'architecture
ou si Claude Code te propose un changement structurant — ne le laisse pas
trancher seul une décision qui sort du périmètre de la phase en cours.
