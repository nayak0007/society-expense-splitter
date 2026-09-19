/**
 * Auth group — welcome, login, register, forgot-password. No guard here:
 * this group is the destination for unauthenticated users (SAD §5.1).
 */
import { Stack } from 'expo-router';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerBackTitle: 'Back' }} />;
}
