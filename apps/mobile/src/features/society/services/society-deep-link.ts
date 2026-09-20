import { parseJoinDeepLink } from '@ses/domain';
import { router } from 'expo-router';

import { useSocietyStore } from '@/stores/society.store';

/**
 * Society deep links (PRD §3.2: the join code is shared on WhatsApp and via
 * QR, so the link must open the app with the code prefilled).
 *
 * The nav-side effect lives here rather than in the domain: `parseJoinDeepLink`
 * is pure and testable, and this function is the composition layer that stashes
 * the code and routes to the join screen.
 */
export function handleSocietyDeepLink(url: string): boolean {
  const code = parseJoinDeepLink(url);
  if (code === null) return false;

  useSocietyStore.getState().setPendingJoinCode(code);

  try {
    router.push({ pathname: '/(setup)/society-join', params: { code } });
  } catch {
    // Cold start: the code is already in the store, so the join screen
    // prefills from it once the router is mounted. Nothing to do here.
  }
  return true;
}
