import { buildJoinShareMessage } from '@ses/domain';
import { Share, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

/**
 * Join code card (PRD §3.2: "Join code… Regenerable by Admin", shared over
 * WhatsApp, or written on the notice board).
 *
 * Sharing uses the platform share sheet (`Share.share`) rather than a
 * WhatsApp-specific SDK: the message carries both the code and the deep link,
 * so any channel works — and no extra dependency is required.
 */
export interface JoinCodeCardProps {
  readonly societyName: string;
  readonly joinCode: string;
  /** Only an Admin may regenerate the code. */
  readonly canManage: boolean;
  readonly isRegenerating: boolean;
  onRegenerate?: (() => void) | undefined;
}

export function JoinCodeCard({
  societyName,
  joinCode,
  canManage,
  isRegenerating,
  onRegenerate,
}: JoinCodeCardProps) {
  const share = async () => {
    await Share.share({ message: buildJoinShareMessage(societyName, joinCode) });
  };

  return (
    <Card variant="filled">
      <View className="gap-2">
        <Text variant="titleSmall">Join code</Text>
        <Text variant="displaySmall" color="primary">
          {joinCode}
        </Text>
        <Text variant="bodySmall" color="onSurfaceVariant">
          Share it with residents — they enter it under "Join society". Anyone with the code can
          request access.
        </Text>
        <View className="mt-1 flex-row gap-2">
          <Button variant="tonal" size="sm" onPress={() => void share()}>
            Share code
          </Button>
          {canManage ? (
            <Button variant="text" size="sm" loading={isRegenerating} onPress={onRegenerate}>
              Regenerate
            </Button>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
