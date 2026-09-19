import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';

/** Placeholder only — Create/Join choice screen lands in Phase 3. */
export default function SocietyChoice() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Stack.Screen options={{ title: 'Setup' }} />
      <Text>(setup)/society-choice — placeholder, no features yet.</Text>
      <Link href="/(app)/home">Go to (app) placeholder</Link>
    </View>
  );
}
