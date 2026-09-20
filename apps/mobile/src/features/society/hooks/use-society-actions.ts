import { SocietyError } from '@ses/domain';
import type { Society, SocietyMembership } from '@ses/domain';
import type {
  CreateSocietyPayload,
  JoinSocietyPayload,
  UpdateSocietyPayload,
} from '@ses/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';

import {
  createSociety,
  deleteSociety,
  joinSociety,
  leaveSociety,
  regenerateJoinCode,
  updateSociety,
} from '../services/society.service';

import { societyKeys } from './society-keys';

/**
 * Society write hooks. Each mutation:
 *  - resolves the actor from the auth store (never from a screen argument,
 *    so scope cannot be spoofed by a caller);
 *  - invalidates the whole `society` key namespace on success, which
 *    re-syncs the memberships mirror in the store;
 *  - surfaces `SocietyError` unchanged, so screens render `error.message`.
 */

function useActorId(): string | null {
  return useAuthStore(selectAuthUser)?.id ?? null;
}

/** Resolved at call time — a hook must never throw during render. */
function requireActor(actorId: string | null): string {
  if (actorId === null) {
    throw new SocietyError('forbidden', 'Your session expired. Please sign in again.');
  }
  return actorId;
}

export function useCreateSociety() {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, CreateSocietyPayload>({
    mutationFn: (payload) => createSociety(requireActor(actorId), payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useUpdateSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, UpdateSocietyPayload>({
    mutationFn: (patch) => updateSociety(requireActor(actorId), societyId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useRegenerateJoinCode(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, void>({
    mutationFn: () => regenerateJoinCode(requireActor(actorId), societyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useDeleteSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void>({
    mutationFn: () => deleteSociety(requireActor(actorId), societyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useJoinSociety() {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<SocietyMembership, unknown, JoinSocietyPayload>({
    mutationFn: (payload) => joinSociety(requireActor(actorId), payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useLeaveSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void>({
    mutationFn: () => leaveSociety(requireActor(actorId), societyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}
