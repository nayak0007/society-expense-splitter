import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { selectPendingJoinCode, useSocietyStore } from '@/stores/society.store';

/**
 * Onboarding choice (PRD §3.1: "Zero memberships → Onboarding Choice screen
 * (Create Society / Join Society)").
 *
 * The resolver sends a signed-in user here when they belong to no society.
 * If a `societyexpense://join?code=…` link started the session, the code is
 * already in the store and is offered here rather than silently discarded.
 */
export default function SocietyChoice() {
  const router = useRouter();
  const pendingJoinCode = useSocietyStore(selectPendingJoinCode);

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Get started' }} />
      <ScrollView>
        <View className="gap-4 p-lg">
          <Text variant="headlineSmall">Set up your society</Text>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            A society holds your members, expenses and payments. Create one if you are setting
            things up, or join one with the code your committee shared.
          </Text>

          {pendingJoinCode !== null ? (
            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Invite code detected</Text>
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  We picked up code {pendingJoinCode} from your invite link.
                </Text>
                <View className="mt-1">
                  <Button
                    variant="tonal"
                    size="sm"
                    onPress={() =>
                      router.push({
                        pathname: '/(setup)/society-join',
                        params: { code: pendingJoinCode },
                      })
                    }
                  >
                    Join with this code
                  </Button>
                </View>
              </View>
            </Card>
          ) : null}

          <Button variant="filled" size="lg" onPress={() => router.push('/(setup)/society-create')}>
            Create a society
          </Button>
          <Button variant="outlined" size="lg" onPress={() => router.push('/(setup)/society-join')}>
            Join with an invite code
          </Button>

          <Text variant="bodySmall" color="onSurfaceVariant">
            You can belong to more than one society — an owner in one, an Admin or Treasurer in
            another — and switch between them at any time.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
