// IndexedDB n'existe pas dans Node : `fake-indexeddb/auto` installe une
// implémentation complète sur les globales, ce qui laisse `idb-keyval` — donc
// lib/offline-queue.ts — tourner exactement comme dans un navigateur, blobs
// compris.
import "fake-indexeddb/auto";

/**
 * `navigator.onLine` commande la reprise de la queue (upload-sync.ts). Node ne
 * l'expose pas, et les versions qui exposent un `navigator` n'y mettent pas
 * cette propriété : on le remplace en entier, en ligne par défaut. Un test qui
 * veut simuler une coupure réécrit `navigator.onLine`.
 */
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
  writable: true,
});
