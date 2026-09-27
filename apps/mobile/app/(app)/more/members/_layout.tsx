import { Stack } from 'expo-router';

/**
 * Members stack (SAD §5.3: "Five tabs, each owning an independent stack").
 *
 * Members hang off the More tab rather than taking a tab of their own, and that is a product
 * decision with a technical consequence: the directory is *configuration* — it is who the
 * society is made of, read occasionally and edited rarely, unlike expenses or payments which
 * are daily work. The same judgement put buildings and flats under More.
 *
 * The `more` tab screen sets `headerShown: false`, so this stack owns the header and pushed
 * screens get a back button and their own title.
 */
export default function MembersLayout() {
  return <Stack screenOptions={{ headerShown: true, headerBackTitle: 'More' }} />;
}
