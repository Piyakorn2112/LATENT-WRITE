import { useSyncExternalStore } from "react";

type Listener = () => void;

let active = false;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function setRendererActive(value: boolean) {
  if (active === value) return;
  active = value;
  notify();
}

export function getRendererActive(): boolean {
  return active;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRendererActive(): boolean {
  return useSyncExternalStore(subscribe, getRendererActive, getRendererActive);
}
