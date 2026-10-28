import { createContext, useContext } from 'react';
import type { Location } from 'react-router-dom';

export type LayerStatus = 'current' | 'exiting' | 'stacked';

export type PageTransitionLayerContextValue = {
  status: LayerStatus;
  isCurrentLayer: boolean;
  isAnimating: boolean;
};

export const PageTransitionLayerContext = createContext<PageTransitionLayerContextValue | null>(
  null
);

export const PAGE_TRANSITION_LAYER_CONTEXT_VALUES: Record<
  LayerStatus,
  PageTransitionLayerContextValue
> = {
  current: { status: 'current', isCurrentLayer: true, isAnimating: false },
  stacked: { status: 'stacked', isCurrentLayer: false, isAnimating: false },
  exiting: { status: 'exiting', isCurrentLayer: false, isAnimating: false },
};

export function usePageTransitionLayer() {
  return useContext(PageTransitionLayerContext);
}

/**
 * A navigation that keeps the pathname (search, hash or state only) stays on the same page:
 * hand the current layer the new location in place, keeping its key so the page is not remounted.
 */
export const replaceCurrentLayerLocation = <T extends { location: Location; status: LayerStatus }>(
  layers: T[],
  location: Location
): T[] => layers.map((layer) => (layer.status === 'current' ? { ...layer, location } : layer));
