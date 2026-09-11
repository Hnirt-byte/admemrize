import { randomBytes } from "node:crypto";
import { Algorithm, hash, parseOptions, verify } from "@node-rs/argon2";

/**
 * Paramètres Argon2id recommandés par l'OWASP Password Storage Cheat Sheet :
 * m = 19 MiB, t = 2, p = 1. Coût volontairement sensible (~50 ms sur un VPS
 * modeste) : c'est le budget de calcul qui protège les mots de passe en cas de
 * fuite de la table users.
 */
export const ARGON2ID_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID_OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  password: string
): Promise<boolean> {
  try {
    // Les paramètres (m, t, p) sont lus dans le hash lui-même : on ne les repasse
    // pas, sinon un ancien hash créé avec d'autres réglages ne serait plus vérifiable.
    return await verify(storedHash, password);
  } catch {
    // Hash corrompu ou format inconnu : échec de connexion, jamais une 500.
    return false;
  }
}

/**
 * Indique si un hash existant a été produit avec des paramètres plus faibles que
 * la politique courante. Permet de re-hacher silencieusement à la connexion
 * quand on durcit les paramètres, sans jamais demander à l'utilisateur de changer
 * son mot de passe.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const parsed = parseOptions(storedHash);
    return (
      parsed.algorithm !== ARGON2ID_OPTIONS.algorithm ||
      parsed.memoryCost < ARGON2ID_OPTIONS.memoryCost ||
      parsed.timeCost < ARGON2ID_OPTIONS.timeCost
    );
  } catch {
    return true;
  }
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * Hash "leurre" vérifié quand l'email de connexion n'existe pas. Sans lui, une
 * connexion sur un email inconnu répondrait beaucoup plus vite qu'une connexion
 * sur un email connu : un attaquant pourrait énumérer les comptes au chrono.
 */
export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHashPromise;
}
