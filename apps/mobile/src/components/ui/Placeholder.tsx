import { Text, View } from 'react-native';

/**
 * Minimal shared UI placeholder. Real design-system components (Button, Card,
 * Sheet, Money, EmptyState…) land with the theme work — this only proves the
 * shared component folder is importable from features and routes.
 */
export function Placeholder({ message }: { message: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>{message}</Text>
    </View>
  );
}
