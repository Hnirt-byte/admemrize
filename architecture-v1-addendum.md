# ADMEMRIZE — Addendum d'architecture V1

Ce document complète le master prompt initial. Il ne le remplace pas : il documente les écarts décidés en revue technique, avec leur justification, pour que le master prompt reste la source du *concept produit* et ce fichier la source de la *réalité technique* au moment de coder.

---

## 1. Résumé des changements vs master prompt original

| Sujet | Master prompt original | Décision retenue | Raison |
|---|---|---|---|
| Stockage objet | MinIO (self-hosted) | S3-compatible managé EU (Scaleway Object Storage, région Paris) | MinIO Community Edition a cessé d'être maintenu (dépôt archivé, plus de binaires précompilés depuis 2025, projet officiellement arrêté en février 2026). Choix mort-né en V1. |
| Traitement HEIC | Sharp côté serveur | Capture caméra en JPEG côté client (canvas), pas d'upload de fichiers HEIC bruts | Les binaires précompilés de Sharp ne supportent pas le HEVC (brevet), nécessiterait un build libvips custom. Contournable puisqu'on capture en direct dans le navigateur, pas d'import depuis la pellicule en V1. |
| Photo uploadée après `revealAt` | Non spécifié | Acceptée et affichée immédiatement, tant que `status != EXPIRED` | Cohérent avec la promesse offline-first (section 9) : une photo ne doit jamais se perdre à cause du réseau, même si elle arrive après la révélation. |
| Téléchargements (ZIP, individuel) | Non précisé si original ou copie nettoyée | Toujours la copie EXIF-nettoyée (jamais l'original brut avec GPS) | Cohérence avec la section 15 (vie privée) : un original avec GPS ne doit jamais quitter le serveur. |
| App mobile organisateur + invité | React Native + Expo | **PWA (web app) pour les deux rôles** | Élimine la dépendance à l'App Store Apple (99 $/an, review, comptes développeur) et Google Play pour la V1. Aucune fonctionnalité du cahier des charges ne nécessite du natif. Une seule codebase, déploiement instantané, marche aussi sur desktop pour l'organisateur. |

---

## 2. Stack technique révisée

### Frontend (remplace section 24 du master prompt)

- **Vite + React + TypeScript** (pas Next.js — pas besoin de SSR/SEO, l'app est authentifiée/éphémère, un SPA classique est plus simple à raisonner pour un projet solo).
- **vite-plugin-pwa** (Workbox) pour le manifest, le service worker, le cache offline des assets statiques.
- **React Router** pour la navigation (invité `/e/:eventSlug`, organisateur `/app/...`).
- **Zustand** pour l'état, **TanStack Query** pour le data fetching — inchangé par rapport au master prompt.
- **Zod** pour la validation, partagé avec le backend via un package `packages/shared`.
- Build final = fichiers statiques servis directement par Caddy. Pas de serveur Node dédié au frontend.

### Capture photo & offline (remplace section 9 et l'étape 6 du flux invité)

- Capture via `getUserMedia()` (flux vidéo live) → rendu sur `<canvas>` → `canvas.toBlob('image/jpeg')`. Conséquence utile : on ne manipule jamais de fichier HEIC, le blob est JPEG par construction.
- Queue offline : **IndexedDB** (via `idb-keyval` ou `Dexie`) pour stocker les blobs en attente + tentative d'upload à chaque retour au premier plan de la page.
- Limite connue à documenter : Safari/WebKit ne supporte pas la Background Sync API standard — pas de resynchronisation silencieuse quand l'onglet est fermé. Le retry se fait à la réouverture. Acceptable pour l'usage réel (l'invité garde la page ouverte ou y revient pendant l'événement), mais à tester sur device réel en Phase 7.

### Notifications (remplace section 29)

- **Web Push (VAPID)** au lieu du service Expo Push.
- Sur iOS, ne fonctionne que si la PWA a été ajoutée à l'écran d'accueil (support depuis iOS 16.4) — Safari ne déclenche pas l'événement `beforeinstallprompt` natif comme Chrome/Android : prévoir une bannière d'instructions manuelle iOS ("Partager → Sur l'écran d'accueil") pour l'organisateur, qui est le rôle qui bénéficie le plus des rappels.
- Pour l'invité, pas d'enjeu critique à pousser l'installation — l'usage est court (durée de l'événement), un onglet suffit.

### Infrastructure (remplace section 32)

Services Docker Compose d'ADMEMRIZE : `postgres`, `admemrize-api`, `admemrize-web`, `worker` — voir section 6 pour la segmentation réseau détaillée (VPS partagé avec Hermes). Le service `mobile` disparaît complètement (plus de natif).

### Backend

Inchangé : Node.js + TypeScript + Fastify + Zod (`fastify-type-provider-zod`, activement maintenu pour Fastify 5 / Zod 4) + Drizzle + PostgreSQL + Sharp (binaires standards, pas de build custom) + Scaleway Object Storage via l'abstraction S3.

---

## 3. Arborescence du repo (Phase 1)

```
admemrize/
├── apps/
│   ├── api/                 # Fastify + Drizzle + Zod (service "admemrize-api")
│   │   ├── src/
│   │   │   ├── routes/      # /api/v1/auth, /events, /guest, /photos, /uploads (Phase 2+)
│   │   │   ├── db/          # schema Drizzle
│   │   │   ├── storage/     # abstraction S3 (adapter Scaleway, remplaçable) — Phase 3
│   │   │   ├── services/    # reveal gate, expiration worker logic — Phase 5
│   │   │   └── plugins/     # auth, rate limit, error handling — Phase 2
│   │   └── Dockerfile
│   ├── web/                 # Vite + React PWA, guest + organizer (service "admemrize-web")
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── guest/       # flux invité
│   │   │   │   └── organizer/   # dashboard organisateur
│   │   │   └── lib/             # offline-queue (IndexedDB) et camera (canvas) — Phase 7
│   │   ├── Dockerfile           # build + sert via Caddy interne (Caddyfile.internal)
│   │   └── vite.config.ts
│   └── worker/               # cron expiration (deleteAt <= now) — Phase 6
├── packages/
│   └── shared/                # schémas Zod partagés api <-> web
├── infra-vps-shared-edge/     # référence du Caddy partagé du VPS — hors repo en réalité
├── docker-compose.yml         # prod : postgres, admemrize-api, admemrize-web, worker
├── docker-compose.override.yml # dev local uniquement, jamais déployé
├── .env.example
└── config/
    └── app-config.ts          # appName, appTagline, appDomain, supportEmail
```

---

## 4. Coût estimé mis à jour

Suppression des postes App Store / Google Play / EAS Build en V1 (plus de natif) :

| Poste | Coût |
|---|---|
| VPS (déjà en place) | ~0€ marginal |
| Stockage objet Scaleway (Paris) | ~0 à 2€/mois en beta |
| Nom de domaine | ~10-15€/an |
| Reste (push, build, email) | 0€ (tiers gratuits largement suffisants au volume V1) |

**Total V1 réaliste : 10 à 15€ pour l'année.** Les frais Apple/Google ne redeviennent pertinents que si un jour tu enveloppes cette même PWA dans un wrapper natif (Capacitor) pour une présence store — décision reportable sans réécrire la logique métier.

---

## 5bis. Nom de l'application

`APP_NAME` est remplacé par **ADMEMRIZE** dans tout le repo (identifiants de
packages, config centralisée `config/app-config.ts`). L'indirection de la
section 27 du master prompt reste en place : un futur changement de nom reste
une modification à un seul endroit.

## 6. Isolation sur VPS partagé (Hermes / ADMEMRIZE)

ADMEMRIZE et Hermes tournent sur le même VPS Hostinger KVM2, sans serveur
dédié — via **Hostinger Docker Manager**, qui déploie chaque projet comme un
`docker-compose.yml` isolé, avec un projet Traefik partagé (déjà présent sur
ce VPS, visible en tant que projet `traefik` dans hPanel à côté
d'`hermes-agent-rrcn`) comme unique point d'entrée HTTPS.

**Mécanisme réel, vérifié en conditions réelles** (et différent de l'hypothèse
initiale tirée de la doc générique Hostinger — voir plus bas) : le conteneur
Traefik de ce VPS tourne en `network_mode: host` (confirmé via `docker
inspect traefik-traefik-1 --format '{{.HostConfig.NetworkMode}}'`). Il
partage donc directement la pile réseau de l'hôte, ce qui lui donne une route
locale vers **tous** les réseaux bridge Docker de la machine — pas besoin
qu'un réseau soit "externe" ou explicitement partagé. C'est déjà comme ça
qu'il atteint Hermes, qui vit sur son propre réseau isolé
`hermes-agent-rrcn_default` sans aucun réseau commun avec Traefik.

Conséquence pratique : `docker-compose.yml` d'ADMEMRIZE n'a pas besoin de
réseau `external: true` ni d'étape de création manuelle. Deux réseaux
Compose standards suffisent :

- **`internal`** (`internal: true`) : Postgres seul. Aucune route sortante
  vers Internet.
- **`public`** : `admemrize-api` et `admemrize-web`, avec les labels Docker
  (`traefik.enable`, `traefik.http.routers.*`) qui indiquent à Traefik quel
  domaine router vers quel port — sans éditer aucune config partagée ni
  toucher à Hermes.

**Correction honnête sur la portée réelle de l'isolation** (une première
version de ce document affirmait que Postgres serait injoignable "même pas
via l'hôte" — c'était trop fort, corrigé ici) : `internal: true` empêche
Postgres de sortir vers Internet et empêche d'autres conteneurs Docker
classiques (dont Hermes) de le joindre — cette garantie tient. Mais un
processus qui partage la pile réseau de l'hôte, comme ce Traefik
spécifiquement, a par construction une route locale vers ce réseau, `internal:
true` ou non — ce flag régit la sortie vers Internet, pas l'accès depuis
l'hôte lui-même. Risque résiduel assumé : si Traefik était compromis (déjà le
composant le plus exposé du VPS par construction), il aurait une route réseau
vers Postgres, mais pas son mot de passe, jamais présent dans sa config.
Aucune action corrective supplémentaire prise pour la V1 (pinner l'accès
Postgres à une IP de conteneur précise serait fragile, les IP internes
Docker n'étant pas garanties stables au redémarrage) — documenté ici pour que
la décision soit explicite, pas silencieuse.

- **Aucun reverse proxy dans le compose d'ADMEMRIZE** : Traefik est déjà
  déployé par Hostinger, pas besoin d'en ajouter un deuxième qui entrerait en
  conflit sur les ports 80/443.
- **La PWA reste un conteneur à part** (`admemrize-web`, Caddy interne sans
  TLS, jamais publié sur l'hôte) qui sert les fichiers statiques ; Traefik
  fait uniquement le routage HTTPS vers lui.
- **Certresolver confirmé** : `letsencrypt`, vérifié en inspectant les labels
  du conteneur `hermes-agent-rrcn-hermes-agent-1`, qui fonctionne déjà en
  production sur ce Traefik.
- **Dev vs prod** : `docker-compose.override.yml` (jamais déployé sur le VPS)
  expose Postgres/API sur `127.0.0.1` pour le confort du développement local.

Cette segmentation ne coûte rien à la portabilité future (section "critère
de réussite commercial" du master prompt) : le repo ADMEMRIZE ne référence
Hermes nulle part, et ne dépend même plus d'un réseau externe pré-existant —
sur un futur VPS, `docker compose up` recrée tout automatiquement, qu'un
Traefik en mode host y tourne déjà ou non (il suffira d'adapter le mécanisme
de découverte si le nouveau Traefik n'est pas en `network_mode: host`).

## 8. Leçons du déploiement V1 réel (VPS Hostinger)

Phase 1 validée en production le 11 septembre 2026 (`https://admemrize.cloud`).
Trois causes distinctes ont dû être diagnostiquées avant que ça tienne debout
— utile de les garder en mémoire pour les phases suivantes :

1. **`node:22-alpine` vs `node:22-slim`** : un `package-lock.json` généré sur
   une plateforme glibc, utilisé dans un build Docker Alpine (musl), fait
   échouer Rollup/Vite (`Cannot find module @rollup/rollup-linux-x64-musl`).
   Correctif : image `slim` (glibc) pour le stage de build qui utilise Vite.
2. **Réseau Traefik externe inexistant** : la doc générique Hostinger suppose
   un réseau `external: true` partagé. Sur ce VPS, Traefik tourne en
   `network_mode: host` (confirmé via `docker inspect ... NetworkMode`) — il
   atteint nativement tout réseau bridge du VPS, aucun réseau externe à créer.
   Un réseau `public` (bridge standard, non-external) suffit.
3. **Certresolver déclaré en double** : `admemrize-api` et `admemrize-web`
   déclaraient chacun `tls.certresolver=letsencrypt` pour le même domaine —
   deux demandes ACME concurrentes pour le même nom, source probable
   d'échecs répétés ("Cannot retrieve the ACME challenge"). Un seul routeur
   par domaine doit posséder le `certresolver` ; les autres utilisent
   `tls=true` seul, le certificat déjà obtenu s'applique automatiquement par
   nom de domaine (SNI), pas par routeur.
4. **La vraie dernière cause, la plus bête** : `.env` sur le VPS pas
   resynchronisé après une correction — `ADMEMRIZE_DOMAIN` gardait encore le
   placeholder `admemrize.ton-domaine.fr` alors que le code source était
   déjà correct. Symptôme trompeur : 404 Traefik + certificat auto-signé
   "TRAEFIK DEFAULT CERT", qui ressemble à un problème ACME alors que c'est
   un routeur qui ne matche simplement rien.

**Méthode qui a permis de trancher sans deviner à l'infini** : à chaque
hypothèse, vérifier ce que Traefik/Docker voit *réellement*
(`docker inspect ... --format '{{json .Config.Labels}}'`, `docker logs`,
`curl -v`) plutôt que supposer qu'un fichier édité a été pris en compte. Un
outil externe (`letsdebug.net`) a permis d'éliminer une fausse piste (IPv6)
avec une preuve plutôt qu'une intuition.

## 10. Dette technique connue (à reconsidérer plus tard, pas bloquant V1)

- **Refresh tokens sans table de révocation** (Phase 2) : la rotation émet un
  nouveau couple, mais l'ancien refresh token reste valide jusqu'à son
  expiration naturelle (30 j) — pas de déconnexion à distance immédiate en
  cas de vol. Acceptable au risque V1 (app de photos de mariage, pas de
  données bancaires), à revoir si le produit devient commercial : ajouter
  une table `refresh_tokens` avec statut révocable.
- **Pas d'index sur `events.owner_id` ni de contrainte unique sur
  `guest_sessions(event_id, device_id)`** (Phase 2, `schema.ts` volontairement
  non modifié) : sans conséquence au volume V1. La contrainte unique absente
  laisse une théorique race condition sur une jonction invité en double clic
  rapide/retry réseau — improbable, pas grave si ça arrive (une session en
  trop, pas une faille de sécurité), mais à corriger si ça devient gênant.

5. **`internal: true` bloque aussi la publication de port, pas seulement la
   sortie Internet** (découvert en dev local Windows) : ajouter `ports:`
   dans `docker-compose.override.yml` sur un service resté sur le réseau
   `internal` ne suffit pas — Docker ne peut pas câbler la redirection NAT
   hôte→conteneur sur un réseau volontairement privé de toute route externe.
   L'override doit aussi neutraliser le flag lui-même (`internal: false`)
   pour ce contexte de dev, la vraie isolation ne s'appliquant qu'en prod
   (sans cet override). Symptôme trompeur : `docker compose config` affiche
   la config fusionnée comme correcte, seul `docker port <conteneur>` (vide
   au lieu d'afficher le mapping) révèle l'écart entre l'intention déclarée
   et ce que Docker peut réellement faire.

6. **`POSTGRES_PASSWORD` ne s'applique qu'à la toute première initialisation
   du volume de données** : changer cette variable dans `.env` n'a aucun
   effet sur un Postgres déjà initialisé — il faut soit `ALTER USER` en SQL
   (si des données existent), soit supprimer le volume (`docker volume rm`,
   acceptable seulement sans données réelles à perdre). Symptôme observé :
   `password authentication failed` malgré des identifiants strictement
   identiques entre `POSTGRES_PASSWORD` et `DATABASE_URL`.

7. **`sizeBytes` non vérifié à l'upload réel** (Phase 3) : `/uploads/authorize`
   valide la taille *annoncée* par le client avant de délivrer l'URL signée,
   mais une URL PUT S3 signée standard n'impose pas elle-même que le fichier
   envoyé fasse cette taille — rien n'empêche d'annoncer une petite taille
   puis d'uploader un fichier bien plus gros directement vers Scaleway, hors
   du contrôle de l'API. La limite de 15 Mo (section 13 du master prompt)
   n'est donc pour l'instant qu'une déclaration sur l'honneur. **À corriger
   en Phase 4** : puisque cette phase télécharge déjà le fichier pour
   vérifier les magic bytes, elle doit aussi vérifier la taille réelle de
   l'objet à ce moment-là (HeadObject ou taille du buffer téléchargé) et
   rejeter/supprimer si elle dépasse la limite — ne pas se contenter de
   valider le format.
   **Corrigé en Phase 4** : `POST /api/v1/photos/confirm`
   (`routes/photos.ts`) appelle `storage.headObject()` avant tout
   téléchargement — un objet au-delà de `MAX_UPLOAD_SIZE_BYTES` est supprimé
   du bucket et la photo passe en `FAILED`, sans jamais télécharger son
   contenu ni générer de dérivé.

8. **`/uploads/authorize` exigeait `ACTIVE_LOCKED`, incohérent avec la ligne
   "Photo uploadée après `revealAt`" du tableau en section 1** (Phase 3,
   corrigé après coup) : la Phase 3 livrée bloquait toute nouvelle demande
   d'URL d'upload dès qu'un événement passait à `REVEALED`, alors que la
   promesse produit est qu'une photo capturée hors ligne avant la révélation
   ne doit jamais se perdre à cause du réseau — y compris quand le téléphone
   de l'invité ne se reconnecte qu'après coup. `routes/uploads.ts` et
   `routes/photos.ts` (Phase 4) utilisent désormais la même règle : refusé
   uniquement si `status === "EXPIRED"`, accepté pour `ACTIVE_LOCKED` et
   `REVEALED`. Le test qui vérifiait l'ancien comportement
   (`apps/api/test/uploads.test.ts`) a été ajusté pour couvrir `EXPIRED` au
   lieu de `REVEALED`, avec un test symétrique ajouté qui prouve que
   `REVEALED` est maintenant accepté.

9. **Organisateur traité comme un invité de son propre événement pour les
   photos, plutôt que `photos.guest_session_id` nullable** (Phase 4, décision
   revue après coup) : une première version rendait cette colonne nullable
   pour permettre à un organisateur de confirmer une photo sans session
   invité. Revenu en arrière — `guest_session_id` reste NOT NULL sans
   exception, aucune photo en base sans session. À la place,
   `lib/organizer-guest-session.ts` auto-provisionne silencieusement une
   `GuestSession` au premier appel d'un organisateur à `/uploads/authorize` ou
   `/photos/confirm` sur son propre événement (nickname dérivé de la partie
   locale de son email, `deviceId` synthétique déterministe
   `organizer:{userId}` qui sert aussi de clé de réutilisation, `tokenHash`
   aléatoire sans rapport avec un jeton réel — cette session n'est jamais
   joignable via `requireGuest`, l'organisateur continue de s'authentifier
   uniquement par son propre jeton). Conséquence assumée : les photos de
   l'organisateur comptent désormais aussi contre `SESSION_PHOTO_QUOTA`,
   comme celles de n'importe quel invité — cohérent avec l'objectif
   "traité comme un invité de son propre événement pour tout ce qui touche
   aux photos". Même risque de course que la dette technique déjà acceptée en
   section 10, point 2 (pas de contrainte unique sur
   `guest_sessions(event_id, device_id)`) : deux appels concurrents du même
   organisateur avant la première insertion pourraient créer deux sessions au
   lieu d'une réutilisée — pas grave si ça arrive, pas une faille de sécurité.

## 11. Prochaine étape

Phase 1 : scaffolding du repo ci-dessus (monorepo, configs de base, docker-compose, schéma Drizzle initial). Prêt à démarrer sur confirmation.
