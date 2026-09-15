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
npm run dev:worker   # boucle d'expiration (npm run sweep pour un passage unique)
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
- [x] **Phase 2** — backend : auth organisateur (Argon2id, JWT), CRUD événements, sessions invité
- [x] **Phase 3** — stockage objet Scaleway (abstraction S3, presigned URLs)
- [x] **Phase 4** — upload photo, validation, Sharp (thumbnail/preview)
- [x] **Phase 5** — révélation : gate serveur, `revealAt`, révélation anticipée
- [x] **Phase 6** — expiration : implémentation réelle du worker, suppression idempotente
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

## Phase 2 : auth organisateur + CRUD événements + sessions invité

Prompt à donner à Claude Code :

> Implémente la Phase 2 : auth organisateur (inscription email+password,
> connexion, refresh token — Argon2id pour le hash, JWT access+refresh) et
> endpoints CRUD `/api/v1/events` (create/list/get/update/delete), protégés
> par l'auth organisateur. Ajoute aussi la création de session invité :
> `POST /api/v1/events/:eventId/guest/join` reçoit un `nickname` et un
> `deviceId` généré côté client, crée une `GuestSession`, retourne un token
> de session invité — un format ou des claims JWT distincts de ceux de
> l'organisateur, qui ne doit **jamais** donner les mêmes droits. Appuie-toi
> sur `apps/api/src/db/schema.ts` déjà en place. Écris les tests de sécurité
> de la section 35 du master prompt : un token invité ne peut pas agir comme
> organisateur (créer/modifier un événement), un token invalide ou expiré
> est rejeté, un eventId inexistant retourne une erreur propre. Lance les
> tests avant de confirmer. Termine en me donnant les commandes curl exactes
> (inscription, connexion, création d'événement, jonction invité) avec de
> vraies valeurs d'exemple.

### Ce qui a été livré en Phase 2

| Route                                     | Auth                            | Rôle                                |
| ----------------------------------------- | ------------------------------- | ----------------------------------- |
| `POST /api/v1/auth/register`              | —                               | Inscription organisateur (Argon2id) |
| `POST /api/v1/auth/login`                 | —                               | Connexion, renvoie access + refresh |
| `POST /api/v1/auth/refresh`               | — (refresh token dans le corps) | Nouvelle paire de jetons            |
| `GET /api/v1/auth/me`                     | organisateur                    | Profil du compte connecté           |
| `POST /api/v1/events`                     | organisateur                    | Créer un événement                  |
| `GET /api/v1/events`                      | organisateur                    | Lister **ses** événements           |
| `GET /api/v1/events/:eventId`             | organisateur                    | Détail d'un de ses événements       |
| `PATCH /api/v1/events/:eventId`           | organisateur                    | Modifier                            |
| `DELETE /api/v1/events/:eventId`          | organisateur                    | Supprimer (cascade sessions/photos) |
| `POST /api/v1/events/:eventId/guest/join` | — (public)                      | Créer/retrouver une session invité  |
| `GET /api/v1/guest/me`                    | invité                          | Vérifier un jeton invité stocké     |

Trois familles de jetons, **trois secrets de signature distincts**
(`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_GUEST_SECRET`), trois
audiences JWT distinctes et un claim `tkn` explicite. Un jeton invité
présenté sur une route organisateur échoue dès la vérification de signature :
il n'existe aucun chemin de code où il produirait un contexte organisateur.

Deux points de configuration nouveaux : `JWT_GUEST_SECRET` doit être renseigné
dans `.env` (32 caractères minimum, différent des deux autres — l'API refuse de
démarrer sinon), et **les migrations sont désormais jouées automatiquement au
démarrage de l'API** (`apps/api/drizzle/`), donc plus besoin de `db:migrate`
manuel au déploiement.

### Comment tester la Phase 2 toi-même

```bash
# 0. Les tests automatisés (42 tests, dont ceux de sécurité de la section 35).
#    Aucun Docker requis : ils tournent sur un Postgres WebAssembly embarqué.
npm test
```

Puis, API lancée en local (`docker compose up -d postgres` puis `npm run dev:api`) :

1. **Inscription** — renvoie 201 + une session complète :

   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"kevin@admemrize.cloud","password":"SouvenirScelle!2026"}'
   ```

2. **Connexion** — note l'`accessToken` renvoyé dans `tokens` :

   ```bash
   curl -X POST http://localhost:3000/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"kevin@admemrize.cloud","password":"SouvenirScelle!2026"}'
   ```

3. **Création d'événement** (remplace `TON_ACCESS_TOKEN`) — note l'`id` :

   ```bash
   curl -X POST http://localhost:3000/api/v1/events \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer TON_ACCESS_TOKEN" \
     -d '{"name":"Mariage de Camille et Sofiane","type":"MARIAGE","eventDate":"2026-12-20T18:00:00Z","revealAt":"2026-12-20T23:00:00Z","retentionHours":72}'
   ```

4. **Jonction invité** (remplace `EVENT_ID`) — aucun token requis :

   ```bash
   curl -X POST http://localhost:3000/api/v1/events/EVENT_ID/guest/join \
     -H "Content-Type: application/json" \
     -d '{"nickname":"Tante Jacqueline","deviceId":"device-web-8f2c1a7d9e4b"}'
   ```

5. **Sécurité — le jeton invité ne doit PAS créer d'événement** (doit renvoyer
   401 `INVALID_TOKEN`) :

   ```bash
   curl -i -X POST http://localhost:3000/api/v1/events \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer TON_GUEST_TOKEN" \
     -d '{"name":"Événement pirate","type":"FETE","eventDate":"2026-12-20T18:00:00Z","revealAt":"2026-12-20T23:00:00Z","retentionHours":24}'
   ```

6. **Erreur propre sur un événement inexistant** (doit renvoyer 404
   `EVENT_NOT_FOUND`, pas une 500) :
   ```bash
   curl -i http://localhost:3000/api/v1/events/00000000-0000-4000-8000-000000000000 \
     -H "Authorization: Bearer TON_ACCESS_TOKEN"
   ```

Phase 2 validée quand les 6 points passent, en local **et** après déploiement
sur le VPS (mêmes commandes contre `https://admemrize.cloud`).

## Phase 3 : stockage objet Scaleway

**Prérequis manuel, avant de lancer Claude Code** (Claude Code ne peut pas
le faire à ta place) :

1. Crée un compte sur [console.scaleway.com](https://console.scaleway.com).
2. Crée un bucket Object Storage, région `fr-par`, nom `admemrize-events`,
   **visibilité privée** (jamais public).
3. Génère une clé API (Identity → API Keys) avec les droits sur ce bucket.
4. Renseigne `S3_ACCESS_KEY_ID` et `S3_SECRET_ACCESS_KEY` dans ton `.env`
   local ET sur le VPS.

Prompt à donner à Claude Code :

> Implémente la Phase 3 : abstraction de stockage S3-compatible dans
> `apps/api/src/storage/` (interface générique avec `getUploadUrl`,
> `getDownloadUrl`, `deleteObject` ; implémentation concrète pour Scaleway
> via `@aws-sdk/client-s3` et `@aws-sdk/s3-request-presigner`). Structure des
> clés : `events/{eventId}/originals/`, `events/{eventId}/thumbnails/`,
> `events/{eventId}/previews/`, `exports/` (section 12 du master prompt).
> Ajoute `POST /api/v1/uploads/authorize` : vérifie la session (organisateur
> ou invité), vérifie que l'event est `ACTIVE_LOCKED`, vérifie le quota (500
> photos/session, 10000/event, configurables), vérifie la taille annoncée
> (max 15 Mo), puis retourne une URL signée à durée courte pour l'upload
> direct vers Scaleway — le fichier ne doit jamais transiter par l'API.
> Écris des tests : quota dépassé refusé, event non `ACTIVE_LOCKED` refusé,
> taille trop grande refusée, session invalide refusée. Termine en me
> donnant la commande curl pour demander une URL d'upload, et la commande
> pour uploader un fichier de test directement vers l'URL signée obtenue.

### Comment tester la Phase 3 toi-même

1. Demande une URL d'upload avec la commande curl donnée par Claude Code
   (nécessite un token invité ou organisateur valide de la Phase 2).
2. Upload un fichier de test réel vers l'URL signée reçue (curl `-T` ou
   `--upload-file`, Claude Code doit te donner la syntaxe exacte).
3. Va dans la console Scaleway, bucket `admemrize-events` → vérifie que le
   fichier apparaît bien sous `events/{eventId}/originals/`.
4. **Sécurité** : essaie d'accéder à ce même fichier par une URL Scaleway
   directe, sans les paramètres de signature — doit être refusé (le bucket
   est privé, aucun accès public ne doit fonctionner).
5. Essaie de demander une URL d'upload pour un event qui n'est pas
   `ACTIVE_LOCKED` (ex: un event déjà révélé) — doit être refusé.

## Phase 4 : upload photo, validation, Sharp

Prompt à donner à Claude Code :

> Implémente la Phase 4 : `POST /api/v1/photos/confirm`, appelé après un
> upload réussi vers Scaleway (Phase 3). Cet endpoint doit : télécharger le
> fichier depuis le stockage pour le valider réellement en vérifiant les
> magic bytes (ne jamais faire confiance au Content-Type envoyé par le
> client — section 14 du master prompt), générer thumbnail et preview via
> Sharp, les remonter sur Scaleway, enregistrer les métadonnées en base
> (table `photos`, `status` passe de `PENDING` à `READY` ou `FAILED`).
> Formats acceptés : JPEG et WebP (pas besoin de HEIC, la capture PWA
> produit du JPEG — voir `architecture-v1-addendum.md`). Limite 15 Mo. Écris
> des tests : un fichier renommé en `.jpg` mais qui n'est pas un vrai JPEG
> est rejeté malgré un Content-Type falsifié, un fichier trop volumineux est
> rejeté, thumbnail et preview sont bien générés pour un JPEG valide.
> Termine en me donnant la commande curl complète (upload Phase 3 +
> confirmation Phase 4) et le chemin exact où je peux vérifier les fichiers
> générés dans mon bucket Scaleway.

### Comment tester la Phase 4 toi-même

1. Prends une vraie photo JPEG sur ton téléphone/PC, fais le cycle complet
   upload (Phase 3) → confirm (Phase 4).
2. Vérifie dans Scaleway que thumbnail ET preview existent, en plus de
   l'original.
3. Vérifie en base (`psql` ou un client graphique) que `status = READY`.
4. **Test du piège** : renomme un fichier `.txt` en `photo.jpg`, tente
   l'upload + confirm — doit finir en `status = FAILED`, pas en `READY`.
   C'est la preuve que la vérification par magic bytes fonctionne, pas
   seulement l'extension du nom de fichier.

## Phase 5 : révélation

Prompt à donner à Claude Code :

> Implémente la Phase 5 : le gate de révélation côté serveur. Tout endpoint
> donnant accès aux photos doit vérifier `event.status` ET que `revealAt`
> est passé, en comparant à l'heure du **serveur** — jamais à une heure
> envoyée par le client (section 21 du master prompt). Endpoint
> `POST /api/v1/events/:eventId/reveal` (organisateur uniquement) déclenche
> la révélation anticipée : passe `status` de `ACTIVE_LOCKED` à `REVEALED`,
> irréversible, aucune transition inverse possible (section 6). Ajoute aussi
> un mécanisme qui passe automatiquement un event à `REVEALED` quand
> `revealAt` est atteint, sans action de l'organisateur (via le worker déjà
> scaffoldé, ou un check à la volée dans l'API — explique ton choix). Écris
> des tests : avant reveal, aucune photo accessible même pour
> l'organisateur ; après reveal, accessible ; appeler `/reveal` deux fois de
> suite ne casse rien (idempotent) ; impossible de repasser `REVEALED` à
> `ACTIVE_LOCKED`. Termine en me donnant les commandes curl pour créer un
> event avec `revealAt` dans le passé (vérifie que les photos sont
> accessibles) et un avec `revealAt` dans le futur (vérifie qu'elles ne le
> sont pas).

### Comment tester la Phase 5 toi-même

1. Crée un event avec `revealAt` dans le futur (dans 1h) — vérifie que
   l'accès aux photos est refusé, même avec le token organisateur.
2. Crée un deuxième event avec `revealAt` dans le passé — vérifie l'accès.
3. Déclenche `/reveal` sur le premier event (révélation anticipée) —
   vérifie que l'accès devient immédiatement possible.
4. Rappelle `/reveal` une seconde fois sur ce même event — ne doit pas
   produire d'erreur ni de changement d'état inattendu.

### Endpoints livrés en Phase 5

| Endpoint | Rôle | Gate |
|---|---|---|
| `POST /api/v1/events/:eventId/reveal` | organisateur | **nouveau** — révélation anticipée, idempotent, irréversible |
| `GET /api/v1/events/:eventId/photos` | organisateur ou invité | **nouveau** — refuse tant que l'événement n'est pas révélé |
| `GET /api/v1/photos/:photoId/download` | organisateur ou invité | **nouveau** — idem ; sert l'aperçu nettoyé, jamais l'original |

La bascule automatique à `revealAt` se fait **à la volée dans l'API**, pas dans
le worker : voir `apps/api/src/services/reveal.ts` et
`architecture-v1-addendum.md` section 10, point 10 (avec la conséquence à
respecter en Phase 6).

### Commandes curl de la Phase 5

```bash
API=http://localhost:3000/api/v1
JSON='Content-Type: application/json'
ID="JSON.parse(require('fs').readFileSync(0,'utf8')).id"

# 0. Jeton organisateur (ou POST /auth/login si le compte existe déjà)
TOKEN=$(curl -s -X POST $API/auth/register -H "$JSON" \
  -d '{"email":"orga@admemrize.test","password":"MotDePasseTresSolide!42"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).tokens.accessToken")

DANS_1H=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)

# 1. revealAt dans le futur → photos inaccessibles, y compris pour l'organisateur
FUTUR=$(curl -s -X POST $API/events -H "Authorization: Bearer $TOKEN" -H "$JSON" \
  -d "{\"name\":\"Capsule verrouillee\",\"type\":\"FETE\",\"eventDate\":\"$DANS_1H\",\"revealAt\":\"$DANS_1H\",\"retentionHours\":24}" \
  | node -pe "$ID")

curl -i $API/events/$FUTUR/photos -H "Authorization: Bearer $TOKEN"
# → 403 PHOTOS_NOT_REVEALED

# 2. revealAt dans le passé → bascule automatique, sans appeler /reveal.
#    L'API refuse volontairement un revealAt passé à la création (règle
#    produit) : on antidate la ligne en base pour ne pas attendre l'échéance.
PASSE=$(curl -s -X POST $API/events -H "Authorization: Bearer $TOKEN" -H "$JSON" \
  -d "{\"name\":\"Capsule echue\",\"type\":\"FETE\",\"eventDate\":\"$DANS_1H\",\"revealAt\":\"$DANS_1H\",\"retentionHours\":24}" \
  | node -pe "$ID")

docker compose exec -T postgres psql -U admemrize -d admemrize \
  -c "UPDATE events SET reveal_at = now() - interval '1 minute' WHERE id = '$PASSE';"

curl -i $API/events/$PASSE/photos -H "Authorization: Bearer $TOKEN"
# → 200, et status passé à REVEALED tout seul

# 3. Révélation anticipée sur l'événement encore verrouillé, puis rappel
curl -s -X POST $API/events/$FUTUR/reveal -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/events/$FUTUR/reveal -H "Authorization: Bearer $TOKEN"
# → deux fois 200 et status REVEALED (idempotent)

# 4. Tentative de reverrouillage
curl -i -X PATCH $API/events/$FUTUR -H "Authorization: Bearer $TOKEN" -H "$JSON" \
  -d '{"revealAt":"2030-01-01T00:00:00Z"}'
# → 409 EVENT_ALREADY_REVEALED
```

## Phase 6 : expiration

Prompt à donner à Claude Code :

> Implémente la Phase 6 : le vrai contenu du worker
> (`apps/worker/src/index.ts`, actuellement un squelette). Il doit chercher
> les events avec `deleteAt <= now()` ET `status <> EXPIRED` (**corrigé
> depuis la Phase 5** : la révélation est paresseuse, un événement que
> personne n'a consulté après son `revealAt` est encore `ACTIVE_LOCKED` en
> base — filtrer sur `status = REVEALED` le rendrait immortel, voir
> `architecture-v1-addendum.md` section 10 point 10), puis supprimer
> dans l'ordre : objets S3 (originaux, previews, thumbnails), exports/ZIP
> temporaires, métadonnées photo en base, sessions invité, et enfin passer
> l'event à `EXPIRED` (section 22 du master prompt). La suppression doit
> être idempotente — si le worker s'interrompt à mi-chemin, la prochaine
> exécution doit pouvoir reprendre sans erreur ni doublon. Écris un test qui
> simule un event expiré, lance le sweep, vérifie que tout a disparu (S3 +
> DB), et qu'un deuxième passage sur le même event déjà `EXPIRED` ne plante
> pas. Termine en me donnant une commande (script ou requête SQL) pour créer
> manuellement un event déjà expiré en base à des fins de test, et comment
> déclencher le worker manuellement pour observer la suppression.

### Comment tester la Phase 6 toi-même

1. Utilise la commande donnée par Claude Code pour créer un event déjà
   expiré (avec au moins une photo dedans, issue des Phases 3-4).
2. Déclenche le worker manuellement.
3. Vérifie dans Scaleway que les fichiers de cet event ont disparu.
4. Vérifie en base que les lignes `photos` et `guest_sessions` de cet event
   ont disparu, et que `status = EXPIRED`.
5. Relance le worker une deuxième fois sur le même event déjà expiré — ne
   doit produire aucune erreur.

### Ce que fait le worker (Phase 6)

Pilotage dans [`apps/worker/src/index.ts`](apps/worker/src/index.ts), suppression
dans [`apps/api/src/services/expiration.ts`](apps/api/src/services/expiration.ts)
— le worker importe le service de l'API (`@admemrize/api/services/expiration`)
au lieu de redéclarer un accès aux tables, pour qu'il n'existe qu'une seule
définition de "ce que contient un événement".

Critère de recherche : `deleteAt <= now()` **ET** `status <> 'EXPIRED'`. Ordre de
suppression : objets Scaleway (originaux, aperçus, vignettes, exports ZIP) →
favoris → photos → sessions invité → `status = EXPIRED`. La ligne `events`
survit, vidée : c'est elle qui permet de répondre 410 à un vieux lien invité.

Les fichiers partent avant la base, jamais l'inverse : une interruption entre les
deux laisse l'événement non-EXPIRED, donc repris au passage suivant. Chaque
événement est traité isolément — un bucket qui refuse une suppression ne retient
pas les autres.

### Créer un événement déjà expiré, à la main

L'API refuse un `deleteAt` passé (il se déduit de `revealAt`, qui doit être dans
le futur). On antidate donc la ligne après coup. Crée d'abord un événement
normalement, avec au moins une photo dedans (Phases 3-4), puis :

```bash
# Antidate le dernier événement créé, en le laissant ACTIVE_LOCKED : c'est le
# cas que la révélation paresseuse de la Phase 5 rend possible (personne ne l'a
# consulté après son revealAt), et il doit quand même être supprimé.
docker compose exec -T postgres psql -U admemrize -d admemrize -c \
  "UPDATE events SET delete_at = now() - interval '1 hour'
   WHERE id = (SELECT id FROM events ORDER BY created_at DESC LIMIT 1)
   RETURNING id, name, status, delete_at;"
```

### Déclencher le worker à la main

```bash
# En dev local (un seul passage, puis sortie ; code 1 si un événement a échoué)
npm run sweep

# En prod, dans le conteneur worker
docker compose exec worker node apps/worker/dist/sweep-once.js

# Ou simplement observer la boucle, qui tourne toutes les 5 minutes
docker compose logs -f worker
```

Sortie attendue sur un événement contenant une photo :

```
[worker] 2026-01-01T12:00:00.000Z 1 événement(s) échu(s) à supprimer
[worker] 2026-01-01T12:00:00.412Z Événement <uuid> expiré : 3 objet(s), 1 photo(s), 1 session(s)
[worker] 2026-01-01T12:00:00.415Z Passage terminé : 1/1 événement(s) expiré(s), 3 objet(s) et 1 photo(s) supprimé(s), 0 en échec
```

Vérifier ensuite, sans faire confiance au journal :

```bash
docker compose exec -T postgres psql -U admemrize -d admemrize -c \
  "SELECT status FROM events WHERE id = '<uuid>';
   SELECT count(*) AS photos FROM photos WHERE event_id = '<uuid>';
   SELECT count(*) AS sessions FROM guest_sessions WHERE event_id = '<uuid>';"
```

Puis dans la console Scaleway, que `events/<uuid>/` et `exports/<uuid>/` ont
disparu. Relance `npm run sweep` une seconde fois : l'événement est désormais
EXPIRED, il ne fait plus partie des candidats, et le passage ne fait rien.

## Phase 7 : PWA invité (capture, offline, upload)

Prompt à donner à Claude Code :

Implémente la Phase 7 : le flux invité complet dans apps/web/src/routes/guest/ (sections 7 à 9 du master prompt). Écran de bienvenue (déjà un placeholder) → saisie du prénom → demande de permission caméra → écran caméra avec capture (getUserMedia, caméra arrière par défaut via facingMode: 'environment', + rendu sur <canvas> + canvas.toBlob('image/jpeg') — jamais de fichier HEIC, voir architecture-v1-addendum.md) → après capture, animation courte "Souvenir scellé" SANS jamais afficher la photo → écran d'attente avec compteur de photos scellées et compte à rebours avant revealAt. Le paramètre de route s'appelle eventSlug dans le squelette actuel mais correspond en réalité à l'id (UUID) de l'événement — pas de champ slug dans le schéma ; renomme le paramètre en eventId pour éviter toute confusion. Persiste le deviceId du navigateur (localStorage) : au retour sur la page pour un événement déjà rejoint, retrouve la session existante via /guest/join (idempotent par deviceId, Phase 2) et saute directement à l'écran caméra, sans redemander le prénom. Si la permission caméra est refusée, affiche un état minimal et clair plutôt qu'un écran vide (la gestion complète des erreurs viendra en Phase 10, mais ce cas précis ne doit jamais laisser l'invité bloqué sans explication). Queue offline via IndexedDB (utilise idb-keyval) qui stocke les photos en attente d'upload (Phases 3-4), avec retry automatique à chaque retour au premier plan de la page — Safari ne supporte pas la Background Sync API, c'est une limite connue et acceptée (voir addendum). Ne supprime jamais la copie locale avant confirmation serveur. Termine en m'expliquant comment simuler une coupure réseau dans Chrome DevTools pour que je teste moi-même la reprise de la queue offline.
**Prérequis manuel, avant de tester** (comme pour la Phase 3, Claude Code ne
peut pas le faire à ta place) : autoriser le navigateur à envoyer un fichier
directement vers le bucket. Jusqu'ici les envois venaient de `curl`, qui se
moque du CORS ; à partir de la Phase 7 c'est la PWA qui fait le `PUT`, et
Scaleway le refuse tant que le bucket n'a pas de règle CORS. Dans la console
Scaleway (bucket `admemrize-events` → onglet Paramètres → CORS), ou en ligne de
commande :

```bash
cat > /tmp/cors.json <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:5173", "https://admemrize.ton-domaine.fr"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3000
    }
  ]
}
JSON

aws s3api put-bucket-cors \
  --endpoint-url https://s3.fr-par.scw.cloud \
  --bucket admemrize-events \
  --cors-configuration file:///tmp/cors.json
```

Sans cette règle, la capture fonctionne (la photo est bien scellée en local)
mais rien ne part : la file reste bloquée sur « en attente », et la console du
navigateur affiche une erreur CORS sur `s3.fr-par.scw.cloud`.

### Ce qui a été livré en Phase 7

Tout vit dans `apps/web/src/` :

| Fichier | Rôle |
|---|---|
| `routes/guest/GuestFlow.tsx` | Orchestrateur des 5 écrans, monté sur `/e/:eventId` |
| `routes/guest/GuestWelcome.tsx` | Écran de bienvenue (le placeholder de la Phase 1 est remplacé) |
| `routes/guest/NicknameForm.tsx` | Saisie du prénom, seule donnée personnelle demandée |
| `routes/guest/CameraPermission.tsx` | Demande d'accès caméra **et** état affiché en cas de refus |
| `routes/guest/CameraScreen.tsx` | Cadrage, déclencheur, bascule avant/arrière, compteurs |
| `routes/guest/SealedFlash.tsx` | Animation « Souvenir scellé » — ne montre jamais la photo |
| `routes/guest/WaitingScreen.tsx` | Compteur de souvenirs scellés + compte à rebours |
| `lib/api.ts` | Client des endpoints des Phases 2 à 4, enveloppe d'erreur partagée |
| `lib/camera.ts` | `getUserMedia`, capture `<canvas>` → `toBlob("image/jpeg")` |
| `lib/offline-queue.ts` | Queue IndexedDB (`idb-keyval`) des photos en attente |
| `lib/upload-sync.ts` | Moteur d'envoi : autorisation → PUT Scaleway → confirmation |
| `lib/guest-session.ts` | Session invité persistée, `deviceId`, renouvellement du jeton |

Points à connaître :

- **La route s'appelle désormais `/e/:eventId`** (elle s'appelait `:eventSlug`
  dans le squelette de la Phase 1) : le paramètre est bien l'`id` UUID de
  l'événement, il n'y a pas de champ `slug` dans le schéma. C'est cette forme
  d'URL que devra encoder le QR code de la Phase 8.
- **La photo n'est jamais affichée.** Le `<canvas>` de capture n'est pas
  attaché au document, et rien dans l'interface ne rend le blob : ni vignette,
  ni aperçu flouté.
- **Aucune copie locale n'est supprimée avant que le serveur ait tranché.** Une
  photo quitte IndexedDB dans deux cas seulement : `/photos/confirm` a répondu
  `READY` (elle est scellée), ou il a répondu `FAILED` — le fichier a été
  examiné et rejeté, aucune reprise n'y changera rien et garder ces octets
  n'aiderait personne. Ce second cas est silencieux : l'invité n'a jamais vu
  cette photo et ne peut pas la refaire, lui signaler une perte qu'il ne peut
  ni constater ni réparer trahirait la promesse de la capsule (la trace reste
  dans la console du navigateur). En revanche, un refus qui ne met pas en cause
  le fichier — quota atteint, événement expiré — arrête les tentatives mais
  **conserve** le blob : la photo est bonne, la jeter serait perdre un souvenir
  valable.
- **La reprise est en deux temps.** Si l'envoi vers Scaleway a réussi mais que
  la confirmation a échoué, la reprise ne renvoie pas le fichier : elle rejoue
  seulement la confirmation, qui est idempotente (Phase 4).
- **Retour d'un invité déjà inscrit** : le `deviceId` en `localStorage` fait de
  `/guest/join` un simple rafraîchissement de jeton, et l'invité retombe
  directement sur l'écran caméra — sans repasser par le prénom, et sans
  attendre le réseau (la session connue est relue localement d'abord).
- **Pas de Background Sync** (Safari ne l'implémente pas, addendum section 2) :
  la reprise se déclenche au retour au premier plan, au retour du réseau, et
  par un filet de sécurité toutes les 60 secondes. Onglet fermé, rien ne part —
  limite connue et acceptée pour la V1.
- **Le compte à rebours n'autorise rien.** Il s'affiche à partir de `revealAt`
  corrigé de l'horloge du serveur, mais c'est le `status` renvoyé par l'API qui
  décide si la capsule est ouverte (addendum section 10, point 11).
- **Les quotas d'appels ne sont plus comptés par IP** sur les routes photo
  authentifiées, mais par session invité (ou par organisateur) : une salle
  entière derrière le même Wi-Fi ne se bloque plus elle-même. Détail et
  justification en point 15 de `architecture-v1-addendum.md`, tests dans
  `apps/api/test/rate-limit.test.ts`. Deux nouvelles variables d'environnement,
  `SESSION_RATE_LIMIT_MAX` et `GUEST_JOIN_RATE_LIMIT_MAX` (voir `.env.example`)
  — à reporter dans le `.env` du VPS au prochain déploiement, sans quoi les
  valeurs par défaut s'appliquent (300 et 600, qui conviennent).
- **Caméra en HTTPS uniquement.** Pour tester depuis un vrai téléphone sur le
  réseau local, `http://192.168.x.x:5173` ne donnera pas accès à la caméra :
  les navigateurs réservent `getUserMedia` aux contextes sécurisés. L'écran
  l'explique au lieu de rester noir, mais pour tester réellement il faut passer
  par le domaine HTTPS du VPS (ou un tunnel).

### Obtenir un lien invité pour tester (en attendant la Phase 8)

L'écran organisateur qui génère le QR code arrive en Phase 8 : d'ici là, on
crée l'événement en ligne de commande et on ouvre l'URL invité à la main.

```bash
API=http://localhost:3000/api/v1
JSON='Content-Type: application/json'
ID="JSON.parse(require('fs').readFileSync(0,'utf8')).id"

# 1. Compte organisateur (ou /auth/login si le compte existe déjà)
TOKEN=$(curl -s -X POST $API/auth/register -H "$JSON" \
  -d '{"email":"orga@admemrize.test","password":"MotDePasseTresSolide!42"}' \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).tokens.accessToken")

# 2. Un événement qui se révèle dans 2 heures — de quoi voir un vrai compte à rebours
DANS_2H=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
EVENT=$(curl -s -X POST $API/events -H "Authorization: Bearer $TOKEN" -H "$JSON" \
  -d "{\"name\":\"Mariage de test\",\"type\":\"MARIAGE\",\"eventDate\":\"$DANS_2H\",\"revealAt\":\"$DANS_2H\",\"retentionHours\":24}" \
  | node -pe "$ID")

# 3. Le lien à ouvrir dans le navigateur (celui que portera le QR code)
echo "http://localhost:5173/e/$EVENT"
```

Puis, après avoir pris des photos, vérifier ce qui est réellement arrivé côté
serveur — sans se fier au compteur affiché dans la PWA :

```bash
docker compose exec -T postgres psql -U admemrize -d admemrize -c \
  "SELECT p.status, p.captured_at, g.nickname
     FROM photos p JOIN guest_sessions g ON g.id = p.guest_session_id
    WHERE p.event_id = '<eventId>' ORDER BY p.captured_at;"
```

Trois lignes `READY` pour trois photos prises : le circuit complet (capture →
IndexedDB → URL signée → Scaleway → confirmation → Sharp) a fonctionné.

### Tests automatisés de la Phase 7

```bash
npm run test:web    # logique de la queue d'envoi (apps/web/test/)
npm test            # tout : API + web
```

`apps/web/test/upload-sync.test.ts` tourne sur un vrai IndexedDB
(`fake-indexeddb`) avec les appels réseau doublés : il fige le sort réservé à
chaque type d'échec — photo rejetée par le serveur supprimée sans réessai,
coupure réseau réessayée sans renvoyer le fichier déjà arrivé, refus de quota
qui arrête les tentatives mais garde la photo.

### Comment tester la Phase 7 toi-même

1. Ouvre la PWA dans le navigateur, va jusqu'à l'écran caméra, prends une
   photo — vérifie que l'animation "Souvenir scellé" s'affiche et que la
   photo n'apparaît **jamais** à l'écran.
2. Dans Chrome DevTools → onglet Network → passe en mode "Offline", prends
   2-3 photos supplémentaires — elles doivent rester visibles dans le
   compteur "photos scellées" sans erreur bloquante.
3. Repasse en ligne (désactive le mode Offline) — les photos en attente
   doivent se synchroniser automatiquement en revenant sur l'onglet.
4. Vérifie côté serveur (Phase 4) que ces photos sont bien arrivées.

### Simuler une coupure réseau dans Chrome DevTools

1. Ouvre la PWA, va jusqu'à l'écran caméra, prends une première photo en ligne
   pour vérifier que le circuit complet fonctionne (le compteur passe à 1 et
   l'écran « Révélation » n'affiche aucune photo en attente).
2. Ouvre DevTools (`F12` ou `Ctrl+Maj+I`), onglet **Network** (Réseau).
3. Dans la barre d'outils de cet onglet, ouvre la liste déroulante de
   throttling — elle affiche « No throttling » par défaut, à droite de la case
   « Disable cache » — et choisis **Offline**.
   Variante plus complète : onglet **Network conditions** (menu `⋮` → *More
   tools* → *Network conditions*), case **Offline**. Elle a l'avantage de
   rester active même si tu changes d'onglet DevTools.
4. Prends 2 ou 3 photos. Chacune doit déclencher l'animation « Souvenir
   scellé », et le bouton « Révélation » doit afficher « N en attente de
   réseau ». Aucun message d'erreur bloquant ne doit apparaître.
5. Vérifie que les photos sont bien stockées : onglet **Application** →
   *Storage* → **IndexedDB** → `admemrize` → `pending-photos`. Tu dois y voir
   une entrée par photo, avec son `blob` et son `stage` (`TO_UPLOAD`).
6. Repasse la liste déroulante sur **No throttling**. Deux choses peuvent
   relancer l'envoi : l'événement `online` du navigateur (immédiat), ou le
   retour au premier plan. Pour tester explicitement le second cas, bascule sur
   un autre onglet puis reviens : c'est exactement le scénario iOS, où il n'y a
   pas de Background Sync.
7. Le compteur « en attente » doit retomber à zéro, et les entrées disparaître
   d'IndexedDB — c'est la preuve que la suppression locale n'arrive qu'après la
   confirmation du serveur. Vérifie enfin dans Scaleway
   (`events/<eventId>/originals|thumbnails|previews/`) et en base
   (`SELECT status FROM photos WHERE event_id = '<uuid>'` → `READY`).

Deux pièges à connaître pour ce test :

- **Le mode Offline de DevTools ne s'applique qu'à l'onglet ouvert**, et il est
  désactivé si tu fermes DevTools. Pour couper vraiment le réseau (utile pour
  tester sur téléphone), utilise le mode avion de l'appareil.
- **Recharger la page en mode Offline** est un test encore plus intéressant :
  la PWA doit rouvrir sur l'écran caméra (session relue depuis `localStorage`),
  les photos en attente doivent toujours être là, et le compteur doit les
  compter. C'est le scénario du téléphone qui n'a plus de réseau de toute la
  soirée. Attention : celui-là ne marche **que sur un build de production**, le
  service worker n'étant pas actif sous `vite dev`. Pour le faire tourner en
  local contre l'API de dev :

  ```bash
  # Le build de prod suppose l'API sur le même domaine ; en local il faut le lui dire.
  VITE_API_BASE_URL=http://localhost:3000 npm run build --workspace=@admemrize/web
  npm run preview --workspace=@admemrize/web   # sert le build sur http://localhost:4173
  ```

  L'origine change (4173 au lieu de 5173) : remplace `APP_DOMAIN` par
  `http://localhost:4173` dans `.env` et redémarre l'API — elle n'autorise
  qu'une seule origine en CORS (`apps/api/src/app.ts`) — et ajoute cette même
  origine à la règle CORS du bucket Scaleway ci-dessus.

## Phase 8 : PWA organisateur (dashboard, QR, settings, reveal)

Prompt à donner à Claude Code :

> Implémente la Phase 8 : les écrans organisateur dans
> `apps/web/src/routes/organizer/` (section 25 du master prompt). Home
> (liste des events), Create Event (nom, type, date, heure de révélation,
> durée de conservation 24/48/72h/7j), Dashboard (statut, nombre de photos,
> participants, countdown, accès QR, partage, settings), écran QR (génère le
> QR avec la lib `qrcode`, affiche le lien, bouton partager via l'API Web
> Share, téléchargement du QR en haute résolution), Settings (modification
> avant reveal, bouton "Révéler maintenant" avec les 3 écrans d'avertissement
> successifs de la section 3 du master prompt — humoristique, plus
> humoristique, puis sérieux et irréversible — et bouton "Fermer
> l'événement"). Connecte tout aux endpoints des Phases 2 et 5. Termine en
> me donnant la liste des routes créées et un scénario clic par clic pour
> que je teste la création d'un événement de bout en bout dans le
> navigateur.

### Comment tester la Phase 8 toi-même

Suis le scénario clic par clic donné par Claude Code, en vérifiant
particulièrement :

1. Un événement créé apparaît bien dans le Dashboard avec le bon countdown.
2. Le QR généré, scanné avec ton téléphone, ouvre bien le lien invité
   (`/e/:eventSlug`) de la Phase 7.
3. Le bouton "Révéler maintenant" affiche bien les 3 écrans successifs, pas
   moins — et le dernier doit clairement dire que c'est irréversible.
4. Une fois révélé, le bouton ne doit plus permettre de reverrouiller.

## Phase 9 : galerie post-reveal

Prompt à donner à Claude Code :

> Implémente la Phase 9 : l'animation de révélation (section 4 du master
> prompt : écran verrouillé → icône cadenas → déverrouillage → compte à
> rebours 3-2-1 → "LA CAPSULE S'OUVRE" → transition vers la galerie →
> nombre de souvenirs révélés) et la galerie elle-même (section 10 : onglets
> Toutes / Mes photos / Favoris, plein écran, swipe, sélection multiple,
> téléchargement individuel et multiple). Ajoute
> `POST /api/v1/photos/:id/favorite` (invité uniquement, sur ses propres
> favoris). Connecte-toi aux endpoints de la Phase 5 pour la liste des
> photos. Termine en me donnant un moyen de déclencher l'animation de
> révélation manuellement dans mon environnement de dev, sans attendre le
> vrai `revealAt`.

### Comment tester la Phase 9 toi-même

1. Utilise le moyen donné par Claude Code pour déclencher la révélation en
   dev — regarde l'animation complète, vérifie qu'elle reste courte et
   fluide (section 4 : "la durée doit rester courte et satisfaisante").
2. Teste les 3 onglets de la galerie (Toutes / Mes photos / Favoris).
3. Ajoute et retire un favori, vérifie que ça persiste après rechargement.
4. Télécharge une photo individuelle, puis une sélection multiple.

## Phase 10 : polish (design, erreurs, notifications)

Prompt à donner à Claude Code :

> Implémente la Phase 10 : direction "Organic Premium" de la section 26 du
> master prompt (palette ivoire/crème/sable/sauge/terracotta, typographie
> serif pour les titres, sans-serif pour l'interface), icônes et manifest
> PWA réels (remplace les placeholders de `vite.config.ts`), gestion des
> erreurs et des états de chargement sur tous les écrans existants, bannière
> d'installation iOS ("Partager → Sur l'écran d'accueil", nécessaire pour
> les notifications — voir addendum), notifications Web Push (VAPID) pour
> les rappels de la section 29 (optionnelles, activables par
> l'organisateur). Termine en me donnant la liste des écrans qui n'ont
> toujours pas d'état de chargement ou d'erreur géré, s'il en reste.

### Comment tester la Phase 10 toi-même

Pas de commande précise ici — c'est la phase la plus visuelle, donc le test
est humain : parcours chaque écran, coupe le réseau à des moments
inattendus (vérifie qu'un message d'erreur clair s'affiche, jamais un écran
blanc ou figé), active les notifications et vérifie qu'elles arrivent bien
sur mobile.

## Comment continuer avec Claude Code

Reviens dans cette conversation pour toute question d'architecture, ou si
Claude Code te propose un changement structurant — ne le laisse pas trancher
seul une décision qui sort du périmètre de la phase en cours.
