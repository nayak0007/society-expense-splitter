import { Link, Stack } from 'expo-router';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';

/**
 * Shared template for placeholder screens (navigation-only phase). A title,
 * an optional description, and navigation links rendered as MD3 tonal
 * buttons. Real screens replace these file-by-file in later phases.
 */
export interface PlaceholderScreenProps {
  /** Title in the header and body. */
  readonly title: string;
  /** Optional one-line description under the title. */
  readonly description?: string;
  /** (label, href) pairs rendered as tonal buttons. */
  readonly links?: ReadonlyArray<readonly [string, string]>;
}

export function PlaceholderScreen({ title, description, links = [] }: PlaceholderScreenProps) {
  return (
    <View className="flex-1 gap-6 bg-surface p-lg">
      <Stack.Screen options={{ headerShown: true, headerTitle: title }} />
      <View className="gap-2">
        <View className="h-2 w-12 rounded-full bg-primary" />
        <Text variant="headlineSmall">{title}</Text>
        {description !== undefined ? (
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {description}
          </Text>
        ) : null}
        <Text variant="bodySmall" color="outline">
          Placeholder — navigation only, no features yet.
        </Text>
        {links.length > 0 ? (
          <View className="mt-4 gap-3">
            {links.map(([label, href]) => (
              <Link key={href} href={href} asChild>
                <Button variant="tonal">{label}</Button>
              </Link>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}
