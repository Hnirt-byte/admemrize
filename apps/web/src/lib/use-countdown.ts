import { useEffect, useRef, useState } from "react";
import { serverNow } from "./api";

export interface Countdown {
  /** Millisecondes restantes, jamais négatives. */
  remainingMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** L'échéance est passée (selon l'horloge du serveur, corrigée). */
  due: boolean;
}

function split(remainingMs: number): Countdown {
  const total = Math.max(0, remainingMs);
  const seconds = Math.floor(total / 1000);
  return {
    remainingMs: total,
    days: Math.floor(seconds / 86_400),
    hours: Math.floor((seconds % 86_400) / 3_600),
    minutes: Math.floor((seconds % 3_600) / 60),
    seconds: seconds % 60,
    due: total <= 0,
  };
}

/**
 * Compte à rebours jusqu'à une date ISO, calé sur l'heure du serveur quand
 * elle est connue (voir `serverNow`).
 *
 * Il ne décide de rien : atteindre zéro ne révèle aucune photo, cela ne fait
 * qu'appeler `onDue` pour aller *demander* au serveur où il en est. Le statut
 * de l'événement est la seule autorité (addendum, section 10, point 11 : un
 * événement peut être REVEALED avec un `revealAt` encore dans le futur).
 */
export function useCountdown(targetIso: string, onDue?: () => void): Countdown {
  const target = Date.parse(targetIso);
  const [countdown, setCountdown] = useState(() =>
    split(target - serverNow().getTime())
  );

  const onDueRef = useRef(onDue);
  onDueRef.current = onDue;
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;

    const tick = () => {
      const next = split(target - serverNow().getTime());
      setCountdown(next);

      if (next.due && !firedRef.current) {
        firedRef.current = true;
        onDueRef.current?.();
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  return countdown;
}
