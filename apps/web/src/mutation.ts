import {
  type DefaultError,
  type UseMutationOptions,
  type UseMutationResult,
  useMutation as useQueryMutation,
} from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';

/**
 * TanStack Query's `useMutation`, but `mutate()` always runs the latest rendered callbacks.
 *
 * TanStack hands each render's options to its mutation observer in a passive effect, and React
 * runs passive effects in a later task than the commit that put the new values on screen. A tap
 * in between ran the previous render's `mutationFn`: the scan page showed "Receive 12" after a
 * second case was scanned and sent quantity 1. Here the callbacks read a ref that a layout effect
 * updates during the commit itself, so they always match what the page shows. Use this one;
 * Biome refuses the direct import.
 */
export function useMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TOnMutateResult = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>,
): UseMutationResult<TData, TError, TVariables, TOnMutateResult> {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  return useQueryMutation<TData, TError, TVariables, TOnMutateResult>({
    ...options,
    ...(options.mutationFn ? { mutationFn: (...args) => latest.current.mutationFn!(...args) } : {}),
    ...(options.onMutate
      ? {
          onMutate: (...args) => latest.current.onMutate?.(...args) as TOnMutateResult,
        }
      : {}),
    onSuccess: (...args) => latest.current.onSuccess?.(...args),
    onError: (...args) => latest.current.onError?.(...args),
    onSettled: (...args) => latest.current.onSettled?.(...args),
  });
}
