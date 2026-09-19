import { ActivityIndicator, View } from 'react-native';

import { Text } from './Text';

/**
 * Loading indicator — MD3 linear/circular progress equivalent. Fills its
 * container by default so screens can render `<LoadingIndicator />` while
 * their first query loads.
 */
export interface LoadingIndicatorProps {
  /** Optional one-line explanation, e.g. "Loading society…". */
  readonly message?: string;
}

export function LoadingIndicator({ message }: LoadingIndicatorProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-surface">
      <ActivityIndicator size="large" />
      {message !== undefined ? (
        <Text variant="bodyMedium" color="onSurfaceVariant">
          {message}
        </Text>
      ) : null}
    </View>
  );
}
