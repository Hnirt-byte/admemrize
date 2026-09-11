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

- `internal` (`internal: true`) : Postgres seul, aucune route sortante vers
  Internet. Hermes (autre projet Docker, réseau séparé) n'y a aucune route.
- `public` : réseau bridge Compose standard (pas externe, pas partagé
  explicitement) — `admemrize-api` et `admemrize-web` uniquement. Sur ce VPS,
  Traefik tourne en `network_mode: host` : il atteint ce réseau nativement,
  sans qu'on ait besoin de le créer ou de le partager au préalable, exactement
  comme il atteint déjà Hermes sur son propre réseau isolé.

Étapes de déploiement :

```bash
# 1. Sur le VPS, dans le dossier du projet ADMEMRIZE
cp .env.example .env
nano .env
# Renseigner : POSTGRES_PASSWORD, JWT_*, S3_*, et surtout ADMEMRIZE_DOMAIN
# (le sous-domaine réel, ex: admemrize.cloud — pointe son DNS vers l'IP du VPS avant)

# 2. Déployer (sans l'override de dev)
docker compose -f docker-compose.yml up -d --build
```

Traefik détecte automatiquement les nouveaux labels sans redémarrage — aucune
étape manuelle de réseau requise. Source : [documentation Hostinger — connecter
plusieurs projets Docker Compose via
Traefik](https://www.hostinger.com/support/connecting-multiple-docker-compose-projects-using-traefik-in-hostinger-docker-manager/)
(pattern générique ; le `network_mode: host` de cette instance simplifie encore
la mise en œuvre réelle — voir addendum section 6).

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

## Méthode à suivre pour chaque phase (pas seulement la Phase 2)

Ce déroulé se répète à l'identique pour les Phases 2 à 10 — seul le prompt
change. Garde cette checklist sous les yeux à chaque phase :

1. **Donne le prompt de la phase à Claude Code** (celui de la Phase 2 est
   rédigé ci-dessous ; pour les suivantes, reprends la description de la
   roadmap + la section correspondante du master prompt).
2. **Laisse Claude Code travailler seul** jusqu'à ce qu'il te dise "c'est
   fait" — il doit lancer ses propres tests avant de te le confirmer.
3. **Vérifie toi-même, ne te contente jamais de sa parole.** Section
   "Comment tester la Phase 2" ci-dessous pour cette phase précise. Si un
   test échoue, dis-le à Claude Code plutôt que de corriger à sa place.
4. **Si tout fonctionne** : commit + push depuis VS Code.
   ```bash
   git add -A
   git commit -m "Phase X : <résumé>"
   git push
   ```
5. **Déploie sur le VPS** (même geste qu'en Phase 1) :
   ```bash
   ssh sur le VPS, puis :
   cd /docker/admemrize && git pull
   docker compose -f docker-compose.yml up -d --build
   ```
6. **Reteste en production**, les mêmes vérifications qu'à l'étape 3 mais
   contre `https://admemrize.cloud` au lieu de `localhost`.
7. **Coche la case de la phase** dans la roadmap ci-dessus, reviens ici
   (cette conversation) si un point d'architecture s'est posé pendant le
   travail de Claude Code — sinon, prompt de la phase suivante.

Une règle à ajouter à **chaque** prompt donné à Claude Code, quelle que soit
la phase : demande-lui de terminer en te donnant les commandes exactes (curl
ou équivalent) pour tester ce qu'il vient de construire, avec de vraies
valeurs d'exemple — pas une description vague. C'est ce qui te permet de
vérifier par toi-même à l'étape 3, plutôt que de deviner la forme des
requêtes.

## Phase 2 : auth organisateur + CRUD événements

Prompt à donner à Claude Code :

> Implémente la Phase 2 du README : auth organisateur (inscription, connexion,
> refresh token via JWT + Argon2id) et endpoints CRUD `/api/v1/events`, en
> t'appuyant sur le schéma `apps/api/src/db/schema.ts` déjà en place. Écris les
> tests de sécurité listés en section 35 du master prompt (un invité ne peut
> pas agir comme organisateur, token invalide refusé). Lance les tests avant
> de me confirmer que c'est fait. Termine en me donnant les commandes curl
> exactes pour tester l'inscription, la connexion, et la création d'un
> événement, avec de vraies valeurs d'exemple.

### Comment tester la Phase 2 toi-même

Une fois Claude Code terminé, avant de commit/push, lance l'API en local
(`npm run dev:api`) et vérifie dans l'ordre :

1. **La base de données a bien les nouvelles tables** — si Claude Code a
   modifié `schema.ts`, il doit avoir généré et appliqué une migration :
   ```bash
   npm run db:generate
   npm run db:migrate
   ```
   Aucune erreur ne doit apparaître.

2. **Inscription** — utilise la commande curl exacte que Claude Code t'a
   donnée en fin de tâche (ou adapte celle-ci si les noms de champs
   diffèrent) :
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"UnMotDePasseSolide123!"}'
   ```
   Doit répondre avec un statut de succès (200/201), pas une erreur 500.

3. **Connexion** — récupère un token :
   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"UnMotDePasseSolide123!"}'
   ```
   Doit renvoyer un `accessToken` (et un `refreshToken`) dans la réponse.

4. **Création d'événement, avec le token** — remplace `TON_TOKEN` par la
   valeur reçue à l'étape 3 :
   ```bash
   curl -X POST http://localhost:3000/api/v1/events \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer TON_TOKEN" \
     -d '{"name":"Mariage Test","type":"MARIAGE","eventDate":"2026-12-20T18:00:00Z","revealAt":"2026-12-20T20:00:00Z","retentionHours":72}'
   ```
   Doit renvoyer l'événement créé.

5. **Sans token, ou avec un mauvais token** — doit être refusé :
   ```bash
   curl -X POST http://localhost:3000/api/v1/events \
     -H "Content-Type: application/json" \
     -d '{"name":"Ne devrait pas marcher"}'
   ```
   Doit renvoyer une erreur 401, pas créer d'événement. Si ça crée quand
   même l'événement, la Phase 2 n'est pas terminée — dis-le à Claude Code
   avant de continuer, c'est exactement le genre de faille que section 35
   du master prompt veut éviter.

Phase 2 validée seulement quand les 5 points passent, en local **et** après
déploiement sur le VPS.

## Comment continuer avec Claude Code

Reviens dans cette conversation pour toute question d'architecture, ou si
Claude Code te propose un changement structurant — ne le laisse pas trancher
seul une décision qui sort du périmètre de la phase en cours.
