import { View } from 'react-native';

import { Button } from './Button';
import { Text } from './Text';

/**
 * Full-screen error state — MD3 error pattern with a retry action. Used when
 * a screen's query fails and there is no cached data to fall back on.
 * (Inline errors use EmptyState or TextInput.error instead.)
 */
export interface ErrorScreenProps {
  /** Human-readable summary. Defaults to a generic safe message. */
  readonly title?: string;
  /** Optional detail. Show only non-sensitive text — never raw error strings. */
  readonly description?: string;
  readonly retryLabel?: string;
  onRetry?: (() => void) | undefined;
}

export function ErrorScreen({
  title = 'Something went wrong',
  description,
  retryLabel = 'Try again',
  onRetry,
}: ErrorScreenProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-surface px-8">
      <View className="mb-2 h-14 w-14 items-center justify-center rounded-full bg-error-container">
        <Text variant="headlineSmall" color="onErrorContainer" align="center">
          !
        </Text>
      </View>
      <Text variant="titleMedium" color="onSurface" align="center">
        {title}
      </Text>
      {description !== undefined ? (
        <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
          {description}
        </Text>
      ) : null}
      {onRetry !== undefined ? (
        <View className="mt-3">
          <Button variant="tonal" onPress={onRetry}>
            {retryLabel}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
