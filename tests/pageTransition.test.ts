import { describe, expect, test } from 'bun:test';
import type { Location } from 'react-router-dom';
import {
  replaceCurrentLayerLocation,
  type LayerStatus,
} from '@/components/common/PageTransitionLayer';

const at = (key: string, pathname: string, search = ''): Location => ({
  key,
  pathname,
  search,
  hash: '',
  state: null,
});

type Layer = { key: string; location: Location; status: LayerStatus };

describe('replaceCurrentLayerLocation', () => {
  test('a search-only navigation reaches the current page without remounting it', () => {
    const layers: Layer[] = [
      { key: 'a', location: at('a', '/auth-files'), status: 'stacked' },
      { key: 'b', location: at('b', '/usage'), status: 'current' },
    ];
    const next = at('c', '/usage', '?view=providers');

    const updated = replaceCurrentLayerLocation(layers, next);

    expect(updated[1]).toEqual({ key: 'b', location: next, status: 'current' });
    expect(updated[0]).toBe(layers[0]);
    expect(layers[1].location.search).toBe('');
  });
});
