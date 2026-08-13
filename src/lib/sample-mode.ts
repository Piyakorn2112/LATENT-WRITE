/**
 * The sample-mode persistence latch.
 *
 * While the sample story is open, the app's state is a sandbox: the novel in
 * memory is the shipped sample (possibly edited), and NOTHING may be written
 * to any real store — not the localStorage draft, not a project folder, not
 * the derived stores (story graph, annotations, adaptive, knowledge, review).
 * The App-level effects check this flag before saving, and the storage layer
 * checks it AGAIN at the write functions themselves, so a missed call site
 * degrades to a no-op instead of sample prose landing in a real book.
 *
 * A module-level flag rather than React state, deliberately: the guard must
 * be readable synchronously from plain library code (storage.ts) without
 * threading props, and it must be impossible for a stale closure to see the
 * old value. App remains the only writer, via enter/exit.
 */

let active = false;

export function isSampleModeActive(): boolean {
  return active;
}

export function setSampleModeActive(next: boolean): void {
  active = next;
}
