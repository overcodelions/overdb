// "Send to overcli" — see src/shared/overcliHandoff.ts.
//
// With overcli installed (its inbox exists) the button sends; without it,
// the same spot links to overcli.app — see OvercliButton.
// The first send from a database asks which repo uses it and remembers the
// answer on the env set (or the lone connection), so every later send from
// any of its envs lands in the same place without asking.

import { create } from 'zustand';

import {
  linkedRepos,
  repoLinkOwner,
  type HandoffDraft,
} from '@shared/overcliHandoff';
import { useStore } from './store';

/// The site to send someone who does not have overcli yet.
export const OVERCLI_SITE = 'https://overcli.app';

/// Whether overcli can take a handoff. `null` until the first answer, so a
/// button never flashes the install link at someone who has it.
///
/// One answer shared by every button — a slow-query list is many rows — and
/// re-asked whenever the window comes back into focus: that is when overcli
/// is most likely to have just been installed.
const useStatus = create<{ available: boolean | null }>(() => ({ available: null }));

let watching = false;
function watchStatus(): void {
  if (watching) return;
  watching = true;
  const check = () =>
    void window.overdb
      .invoke('overcli:status')
      .then((s) => useStatus.setState({ available: s.available }))
      .catch(() => {});
  check();
  window.addEventListener('focus', check);
}

export function useOvercliAvailable(): boolean | null {
  watchStatus();
  return useStatus((s) => s.available);
}

export async function sendToOvercli(
  connectionId: string,
  draft: Omit<HandoffDraft, 'repoHints'>,
): Promise<boolean> {
  const st = useStore.getState();
  const owner = repoLinkOwner(connectionId, st.connections, st.envSets);
  if (!owner) return false;
  let repos = linkedRepos(owner, st.connections, st.envSets);
  if (repos.length === 0) {
    const picked = await window.overdb.invoke('overcli:pickRepo', { name: owner.name });
    if (!picked) return false;
    repos = [picked];
    await st.linkRepos(owner, repos);
    st.toast(`Linked ${owner.name} to ${picked.split('/').pop() ?? picked}.`);
  }
  const res = await window.overdb.invoke('overcli:send', { ...draft, repoHints: repos });
  if (!res.ok) {
    st.toast(res.error, 'error');
    return false;
  }
  st.toast('Sent to overcli. It’s waiting in overcli’s tray.');
  return true;
}
