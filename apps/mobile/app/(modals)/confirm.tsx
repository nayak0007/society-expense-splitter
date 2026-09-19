import { Stack } from 'expo-router';
import { Text, View } from 'react-native';

/** Modal placeholder — confirm dialog pattern lands with real flows. */
export default function ConfirmModal() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Stack.Screen options={{ presentation: 'modal', title: 'Confirm' }} />
      <Text>(modals)/confirm — placeholder.</Text>
    </View>
  );
}
