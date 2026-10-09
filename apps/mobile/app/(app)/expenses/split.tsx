import SplitConfiguratorScreen from '@/features/expenses/screens/SplitConfiguratorScreen';

/**
 * The split configurator route — PRD screen #29 (Roadmap T075).
 *
 * Reachable from both the create form (`/expenses/new`) and an unpublished edit
 * (`/expenses/[id]/edit`); the optional `expenseId` parameter is the scope key's third
 * segment, so a create session and an edit session never share a workspace. A route file
 * is deliberately this thin — the screen owns the editor, and the configuration travels
 * through the shared split workspace, never through this URL.
 */
export default function SplitRoute() {
  return <SplitConfiguratorScreen />;
}
