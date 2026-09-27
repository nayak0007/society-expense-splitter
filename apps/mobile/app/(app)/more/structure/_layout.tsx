import { Stack } from 'expo-router';

/**
 * Structure stack (SAD §5.3: "Five tabs, each owning an independent stack").
 * Buildings hang off the More tab because a society's physical structure is
 * configuration, not daily work — it is set up once and revisited rarely, unlike
 * expenses or payments.
 *
 * The `more` tab screen sets `headerShown: false`, so this stack owns the header
 * and pushed screens get a back button and their own title.
 */
export default function StructureLayout() {
  return <Stack screenOptions={{ headerShown: true, headerBackTitle: 'More' }} />;
}
