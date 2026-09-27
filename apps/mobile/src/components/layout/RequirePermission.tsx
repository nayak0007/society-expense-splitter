import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * Route-level guard (SAD §5.5, layer 2): wraps a screen in a route file so
 * it cannot be bypassed by direct navigation or a deep link. Rendering the
 * fallback INSTEAD of the children (rather than redirecting) is the point —
 * the user sees why they cannot proceed.
 *
 * `authorized` is the caller's to compute, and it is meant to be a **capability** —
 * `canManageStructure`, `canManageSociety` — evaluated by `@ses/domain` from the
 * membership, which is the same matrix the API's `PermissionGuard` and the RLS
 * policies read. A role literal compared inline is a second copy of a rule that
 * must not have two. The society edit screen still does that; it is the call site
 * to bring in line.
 */
export interface RequirePermissionProps {
  /** e.g. 'expense.create', 'cycle.publish' — checked against the role matrix. */
  readonly action: string;
  readonly authorized: boolean;
  readonly children: ReactNode;
}

export function RequirePermission({ action, authorized, children }: RequirePermissionProps) {
  if (authorized) {
    return <>{children}</>;
  }
  return <PermissionDenied action={action} />;
}

/** The rendered denial state. */
export function PermissionDenied({ action }: { action?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-surface p-lg">
      <View className="h-14 w-14 items-center justify-center rounded-full bg-error-container">
        <Text variant="headlineSmall" color="onErrorContainer">
          !
        </Text>
      </View>
      <Text variant="titleMedium" align="center">
        Permission denied
      </Text>
      <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
        {action !== undefined
          ? `Your role does not allow "${action}" in this society.`
          : 'Your role does not allow this action in this society.'}
      </Text>
    </View>
  );
}
