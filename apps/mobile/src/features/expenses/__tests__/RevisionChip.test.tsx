import { render, screen, fireEvent } from '@testing-library/react-native';

import { RevisionChip } from '../components/RevisionChip';

describe('RevisionChip', () => {
  it('renders plain text, not a control, when there are no revisions', async () => {
    await render(<RevisionChip revisionCount={0} />);
    expect(screen.getByText('Not edited')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a pressable chip with the plural count', async () => {
    await render(<RevisionChip revisionCount={2} />);
    expect(screen.getByText('Edited · 2 revisions')).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('uses the singular for one revision', async () => {
    await render(<RevisionChip revisionCount={1} />);
    expect(screen.getByText('Edited · 1 revision')).toBeTruthy();
  });

  it('opens the history when pressed', async () => {
    const onPress = jest.fn();
    await render(<RevisionChip revisionCount={3} onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
