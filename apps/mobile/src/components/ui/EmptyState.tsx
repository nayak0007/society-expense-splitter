import { View } from 'react-native';
import type { ReactNode } from 'react';

import { Button } from './Button';
import { Text } from './Text';

/**
 * Empty state — MD3 "no data" pattern: a calm icon, a short title, optional
 * description, optional action. Used by every list screen in the app.
 */
export interface EmptyStateProps {
  /** Glyph slot — pass an icon node sized ~48–56. */
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: string;
  /** Renders a filled Button below the description when provided. */
  readonly actionLabel?: string;
  onAction?: (() => void) | undefined;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-surface px-8">
      {icon !== undefined ? <View className="mb-2 opacity-60">{icon}</View> : null}
      <Text variant="titleMedium" color="onSurface" align="center">
        {title}
      </Text>
      {description !== undefined ? (
        <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
          {description}
        </Text>
      ) : null}
      {actionLabel !== undefined ? (
        <View className="mt-3">
          <Button variant="filled" onPress={onAction}>
            {actionLabel}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
