/** Set by `build.mjs --dev` for test installs; empty in normal builds. */
declare const __DEV_TOKEN__: string;

export interface Settings {
  bridgeUrl: string;
  token: string;
  /** Ask the user before tools with effect "irrev". */
  confirmIrreversible: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'ws://127.0.0.1:8765',
  token: __DEV_TOKEN__,
  confirmIrreversible: true,
};

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadSettings().then(cb);
  });
}
