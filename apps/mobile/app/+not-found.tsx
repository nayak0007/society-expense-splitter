import { Link, Stack } from 'expo-router';
import { Text, View } from 'react-native';

export default function NotFound() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Text>This screen does not exist.</Text>
      <Link href="/">Go home</Link>
    </View>
  );
}
