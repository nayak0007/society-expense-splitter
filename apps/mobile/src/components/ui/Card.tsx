import { Pressable } from 'react-native';
import type { ReactNode } from 'react';

/**
 * MD3 Card (m3.material.io/components/cards) — elevated / filled / outlined.
 * Shape: 12dp radius (MD3 `md.corner`). Press feedback only when onPress is
 * provided (MD3 state layers are handled by Pressable's default ripple on
 * Android; a themed ripple color is applied via border/background classes).
 */

export type CardVariant = 'elevated' | 'filled' | 'outlined';

export interface CardProps {
  readonly children: ReactNode;
  readonly variant?: CardVariant;
  onPress?: (() => void) | undefined;
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  elevated: 'bg-surface-container-low shadow-sm rounded-card',
  filled: 'bg-surface-container-highest rounded-card',
  outlined: 'bg-surface border border-outline-variant rounded-card',
};

export function Card({ children, variant = 'filled', onPress }: CardProps) {
  const className = `p-4 ${VARIANT_CLASSES[variant]}`;

  if (onPress !== undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        className={`active:opacity-80 ${className}`}
      >
        {children}
      </Pressable>
    );
  }

  return <Pressable className={className}>{children}</Pressable>;
}
