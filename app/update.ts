// When the app looks for a newer version of itself. It downloads quietly and only surfaces once there is something
// to press, so nothing here interrupts; the restart stays the owner's. No UI, no I/O of its own: nsh/updater is passed in.

export type FoundUpdate = { version: string; url: string; canInstall: boolean };

export type UpdaterApi = {
  check: () => Promise<FoundUpdate | null>;
  download: () => Promise<void>;
  install: () => Promise<void>;
};

export type UpdateState =
  | { kind: "none" }
  /** Downloaded and verified: a restart applies it. */
  | { kind: "ready"; version: string }
  /** The app cannot replace itself (Android, a system package): the owner gets it from the link. */
  | { kind: "link"; version: string; url: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; message: string };

export const CHECK_EVERY_MS = 60 * 60 * 1000;

export function createUpdates(api: UpdaterApi, onChange: (state: UpdateState) => void) {
  let state: UpdateState = { kind: "none" };
  let busy = false;
  const set = (next: UpdateState) => {
    state = next;
    onChange(next);
  };

  /** A failed check or download stays silent and the next tick tries again: a blip is not worth a banner. */
  async function check() {
    // A newer release can wait for this one's restart, and checking again would drop the download it holds.
    if (busy || state.kind === "ready" || state.kind === "installing" || state.kind === "failed") return;
    busy = true;
    try {
      const found = await api.check();
      if (!found) { if (state.kind !== "none") set({ kind: "none" }); return; }
      if (!found.canInstall) return set({ kind: "link", version: found.version, url: found.url });
      await api.download();
      set({ kind: "ready", version: found.version });
    } catch (e) {
      console.warn("update check failed:", String(e));
    } finally {
      busy = false;
    }
  }

  /** Exits this run when it works; a failure leaves the app as it was, and the same download can be tried again. */
  async function install() {
    if (state.kind !== "ready" && state.kind !== "failed") return;
    const { version } = state;
    set({ kind: "installing", version });
    try {
      await api.install();
    } catch (e) {
      set({ kind: "failed", version, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { check, install };
}
