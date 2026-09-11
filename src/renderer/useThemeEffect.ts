import { useEffect, useState } from 'react';
import { useStore } from './store';

/// Whether the preference resolves to dark right now. 'system' is not a
/// third answer — it is dark or light too, decided by the OS.
function resolve(theme: 'dark' | 'light' | 'system'): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/// Toggles `html.dark` to match the user's theme preference. 'system'
/// follows `prefers-color-scheme` and listens for OS-level theme
/// changes so the app responds without a reload.
export function useThemeEffect(): void {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const root = document.documentElement;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => root.classList.toggle('dark', resolve(theme));

    apply();

    if (theme === 'system') {
      const handler = () => apply();
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
  }, [theme]);
}

/// The resolved theme, for the few places that cannot read a CSS variable —
/// CodeMirror decides its own built-in caret and selection colours from a
/// boolean, so it has to be told.
export function useIsDark(): boolean {
  const theme = useStore((s) => s.settings.theme);
  const [dark, setDark] = useState(() => resolve(theme));

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(resolve(theme));
    if (theme !== 'system') return;
    const handler = () => setDark(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  return dark;
}
