import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Person, PersonStatus, Stage } from '../../shared/types.js';
import { River } from './River.js';

function person(id: number, stage: Stage, over: Partial<Person> = {}, status: PersonStatus = 'active'): Person {
  return {
    id, projectId: 1, name: `Person ${id}`, firstName: `P${id}`, company: 'Oko Pay', role: 'Founder', email: `p${id}@okopay.com`, linkedinUrl: null, xHandle: null,
    timezone: null, channel: 'email', stage, status, touches: 0, lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'paste', note: null,
    createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z',
    ...over,
  };
}

const NOW = new Date('2026-11-02T10:00:00Z');

describe('River', () => {
  it('draws every face as a button named with the person and where they are', async () => {
    const onFace = vi.fn();
    const people = [person(1, 'stranger'), person(2, 'hello'), person(3, 'following'), person(4, 'talking')];
    render(<River people={people} running still={[]} onFace={onFace} now={() => NOW} />);
    expect(screen.getByRole('button', { name: 'Person 1, Strangers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Person 2, Said hello' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Person 3, Following up' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Person 4, Talking' }));
    expect(onFace).toHaveBeenCalledWith(people[3]);
  });

  it('counts each lane underneath', () => {
    const people = [person(1, 'stranger'), person(2, 'stranger'), person(3, 'talking')];
    render(<River people={people} running still={[]} onFace={() => {}} now={() => NOW} />);
    const zone = (label: string) => screen.getByText(label).closest('.river-zone') as HTMLElement;
    expect(within(zone('Strangers')).getByText('2')).toBeInTheDocument();
    expect(within(zone('Said hello')).getByText('0')).toBeInTheDocument();
    expect(within(zone('Talking')).getByText('1')).toBeInTheDocument();
  });

  it('flows while running and stands still when not', () => {
    const { rerender } = render(<River people={[]} running still={[]} onFace={() => {}} now={() => NOW} />);
    expect(screen.getByRole('group', { name: 'Your river' })).toHaveClass('is-running');
    rerender(<River people={[]} running={false} still={[]} onFace={() => {}} now={() => NOW} />);
    expect(screen.getByRole('group', { name: 'Your river' })).toHaveClass('is-still');
  });

  it('turns faces on a paused channel grey with a pause badge, and leaves the others alone', () => {
    const people = [person(1, 'hello', { channel: 'linkedin' }), person(2, 'hello', { channel: 'email' }), person(3, 'talking', { channel: 'linkedin' })];
    render(<River people={people} running still={['linkedin']} onFace={() => {}} now={() => NOW} />);
    const li = screen.getByRole('button', { name: 'Person 1, Said hello' });
    expect(li).toHaveClass('going-still');
    expect(li).toHaveAttribute('aria-description', 'LinkedIn is paused');
    expect(li.querySelector('.river-badge-pause')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Person 2, Said hello' })).not.toHaveClass('going-still');
    expect(screen.getByRole('button', { name: 'Person 3, Talking' })).not.toHaveClass('going-still');
  });

  it('keeps people who wait on you out of the water', () => {
    const people = [person(1, 'talking', {}, 'waiting'), person(2, 'hello')];
    render(<River people={people} running still={[]} onFace={() => {}} now={() => NOW} />);
    expect(screen.queryByRole('button', { name: /Person 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Person 2/ })).toBeInTheDocument();
  });

  it('collapses a crowded river into one bubble per lane with the exact count', async () => {
    const onGroup = vi.fn();
    const people = Array.from({ length: 70 }, (_, i) => person(i + 1, i < 40 ? 'stranger' : 'hello'));
    render(<River people={people} running still={[]} onFace={() => {}} onGroup={onGroup} now={() => NOW} />);
    await userEvent.click(screen.getByRole('button', { name: '40 people, Strangers' }));
    expect(onGroup).toHaveBeenCalledWith('stranger');
    expect(screen.getByRole('button', { name: '30 people, Said hello' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Person 1,/ })).not.toBeInTheDocument();
  });

  it('shows the popover of the selected face and shows a sending badge', () => {
    const people = [person(1, 'talking'), person(2, 'talking', { badge: 'booked' })];
    render(<River people={people} running still={[]} onFace={() => {}} selectedId={1} popover={<p>Open card</p>} sendingIds={[1]} now={() => NOW} />);
    expect(screen.getByText('Open card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Person 1, Talking' }).querySelector('.river-badge-sending')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Person 2, Talking' }).querySelector('.river-badge-booked')).not.toBeNull();
  });

  it('draws plain pictures when faces cannot be opened', () => {
    render(<River people={[person(1, 'hello')]} running still={[]} now={() => NOW} />);
    expect(screen.getByRole('img', { name: 'Person 1, Said hello' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
