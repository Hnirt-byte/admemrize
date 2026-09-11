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
- [x] **Phase 2** — backend : auth organisateur (Argon2id, JWT), CRUD événements, sessions invité
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

| Route | Auth | Rôle |
|---|---|---|
| `POST /api/v1/auth/register` | — | Inscription organisateur (Argon2id) |
| `POST /api/v1/auth/login` | — | Connexion, renvoie access + refresh |
| `POST /api/v1/auth/refresh` | — (refresh token dans le corps) | Nouvelle paire de jetons |
| `GET /api/v1/auth/me` | organisateur | Profil du compte connecté |
| `POST /api/v1/events` | organisateur | Créer un événement |
| `GET /api/v1/events` | organisateur | Lister **ses** événements |
| `GET /api/v1/events/:eventId` | organisateur | Détail d'un de ses événements |
| `PATCH /api/v1/events/:eventId` | organisateur | Modifier |
| `DELETE /api/v1/events/:eventId` | organisateur | Supprimer (cascade sessions/photos) |
| `POST /api/v1/events/:eventId/guest/join` | — (public) | Créer/retrouver une session invité |
| `GET /api/v1/guest/me` | invité | Vérifier un jeton invité stocké |

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

## Phase 6 : expiration

Prompt à donner à Claude Code :

> Implémente la Phase 6 : le vrai contenu du worker
> (`apps/worker/src/index.ts`, actuellement un squelette). Il doit chercher
> les events avec `deleteAt <= now()` ET `status = REVEALED`, puis supprimer
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

## Phase 7 : PWA invité (capture, offline, upload)

Prompt à donner à Claude Code :

> Implémente la Phase 7 : le flux invité complet dans
> `apps/web/src/routes/guest/` (sections 7 à 9 du master prompt). Écran de
> bienvenue (déjà un placeholder) → saisie du prénom → demande de
> permission caméra → écran caméra avec capture (`getUserMedia` + rendu sur
> `<canvas>` + `canvas.toBlob('image/jpeg')` — jamais de fichier HEIC, voir
> `architecture-v1-addendum.md`) → après capture, animation courte "Souvenir
> scellé" SANS jamais afficher la photo → écran d'attente avec compteur de
> photos scellées et compte à rebours avant `revealAt`. Queue offline via
> `IndexedDB` (utilise `idb-keyval`) qui stocke les photos en attente
> d'upload (Phases 3-4), avec retry automatique à chaque retour au premier
> plan de la page — Safari ne supporte pas la Background Sync API, c'est une
> limite connue et acceptée (voir addendum). Ne supprime jamais la copie
> locale avant confirmation serveur. Termine en m'expliquant comment simuler
> une coupure réseau dans Chrome DevTools pour que je teste moi-même la
> reprise de la queue offline.

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
