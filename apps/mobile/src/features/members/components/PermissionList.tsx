import type { Action } from '@ses/domain';
import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * What a role may do, in the words a screen can show (T046).
 *
 * ## Why the list is not a curated set of sentences
 *
 * The action identifiers come from the server, and there are 32 of them across the matrix. A
 * hand-written label per action would be a **third** description of the matrix (after the
 * evaluator and the policies), and it would age in the direction that matters least: a permission
 * hidden behind a missing label is a permission a user cannot audit. `describeAction` renders the
 * identifier itself, with the punctuation tidied so it reads as a sentence fragment —
 * `member.role_change` → *Member · Role change* — which keeps the list truthful at the cost of
 * being terse.
 *
 * ## An empty list is a state, not a failure
 *
 * A pending or suspended membership holds no actions (the use case folds the status in), so the
 * empty case says which of the two it is: the role's *grant* is not what applies to a member who
 * cannot act, and a screen that rendered nothing would look broken.
 */
export function PermissionList({
  actions,
  emptyMessage,
}: {
  readonly actions: readonly Action[];
  readonly emptyMessage: string;
}) {
  if (actions.length === 0) {
    return (
      <Text variant="bodySmall" color="onSurfaceVariant">
        {emptyMessage}
      </Text>
    );
  }

  return (
    <View className="gap-1">
      {actions.map((action) => (
        <Text key={action} variant="bodySmall" color="onSurfaceVariant">
          {`•  ${describeAction(action)}`}
        </Text>
      ))}
    </View>
  );
}

/**
 * `member.role_change` → `Member · Role change`.
 *
 * Deliberately generic: it prettifies any identifier from the vocabulary rather than knowing the
 * vocabulary. A missing action is then impossible — there is nothing to keep in sync — and a
 * future module's actions render correctly before anyone writes a label for them.
 */
export function describeAction(action: string): string {
  const [group, ...rest] = action.split('.');
  const name = rest.length === 0 ? group : rest.join('.');

  return `${capitalise(group ?? '')} · ${capitalise(name ?? '')}`;
}

/** Underscores become spaces and the first letter is raised; nothing else is rewritten. */
function capitalise(value: string): string {
  const words = value.split('_').join(' ').trim();
  if (words.length === 0) return '';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
