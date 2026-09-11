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
`docker-compose.yml` isolé et fournit un projet Traefik partagé (déjà présent
sur ce VPS, visible en tant que projet `traefik` dans hPanel à côté
d'`hermes-agent-rrcn`) comme unique point d'entrée HTTPS. Source : [doc
officielle Hostinger — connecter plusieurs projets Docker Compose via
Traefik](https://www.hostinger.com/support/connecting-multiple-docker-compose-projects-using-traefik-in-hostinger-docker-manager/)
(mise à jour fin août 2026).

Mécanique retenue :

- **Réseau `internal`** (`internal: true`) : Postgres seul. Aucune route
  sortante, même pas vers Internet. Techniquement injoignable depuis Hermes,
  pas seulement par convention.
- **Réseau `traefik-proxy`** : réseau externe déjà créé par le template
  Traefik de Hostinger. Seuls `admemrize-api` et `admemrize-web` le
  rejoignent, avec des labels Docker (`traefik.enable`, `traefik.http.routers.*`)
  qui indiquent à Traefik quel domaine router vers quel port — sans éditer
  aucune config partagée ni toucher à Hermes.
- **Aucun reverse proxy dans le compose d'ADMEMRIZE** : Traefik est déjà
  déployé par Hostinger, pas besoin d'en ajouter un deuxième qui entrerait en
  conflit sur les ports 80/443.
- **La PWA reste un conteneur à part** (`admemrize-web`, Caddy interne sans
  TLS, jamais publié sur l'hôte) qui sert les fichiers statiques ; Traefik
  fait uniquement le routage HTTPS vers lui.
- **Point à vérifier avant déploiement** : le nom du certresolver
  (`letsencrypt` dans le pattern documenté par Hostinger) doit correspondre à
  celui réellement configuré sur cette instance — se confirme en inspectant
  les labels du conteneur `hermes-agent-rrcn`, qui fonctionne déjà (commande
  dans le README).
- **Dev vs prod** : `docker-compose.override.yml` (jamais déployé sur le VPS)
  expose Postgres/API sur `127.0.0.1` et neutralise le caractère externe du
  réseau `traefik-proxy` pour le confort du développement local.

Cette segmentation ne coûte rien à la portabilité future (section "critère
de réussite commercial" du master prompt) : le repo ADMEMRIZE ne référence
Hermes nulle part, seulement un réseau Docker nommé `traefik-proxy` — sur un
futur VPS dédié, il suffit d'y déployer n'importe quel Traefik (via le même
template Hostinger ou manuellement) pour reproduire exactement ce montage.

## 7. Prochaine étape

Phase 1 : scaffolding du repo ci-dessus (monorepo, configs de base, docker-compose, schéma Drizzle initial). Prêt à démarrer sur confirmation.
