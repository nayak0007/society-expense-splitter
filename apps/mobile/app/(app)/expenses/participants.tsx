import ParticipantSelectorScreen from '@/features/expenses/screens/ParticipantSelectorScreen';

/**
 * The participant selector route — PRD screen #30 (Roadmap T075).
 *
 * A sibling of `split` (the configurator) so the two screens are separate, deep-linkable
 * routes with the same scope parameter. The selector edits the stored eight-dimension
 * `participantSelector`; it is never a hand-picked flat list.
 */
export default function ParticipantsRoute() {
  return <ParticipantSelectorScreen />;
}
