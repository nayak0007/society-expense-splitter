import { Stack } from 'expo-router';

/**
 * More-tab stack (SAD §5.3: "Five tabs, each owning an independent stack").
 * The tab is the entry point (settings hub); society profile and edit push on
 * top of it, so the tab bar stays visible and "back" always returns to More.
 *
 * The Tabs screen for `more` sets `headerShown: false` — this stack owns the
 * header so pushed screens get a back button and their own title.
 */
export default function MoreLayout() {
  return <Stack screenOptions={{ headerShown: true, headerBackTitle: 'More' }} />;
}
