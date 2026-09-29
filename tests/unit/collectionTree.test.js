'use strict';

const { findTreeProblem, descendantsOf, ancestryOf, MAX_COLLECTION_DEPTH } = require('../../src/modules/catalog/collectionTree');

const tree = (pairs) => new Map(Object.entries(pairs));

describe('collection tree rules', () => {
  it('accepts a flat list and a tree three levels deep', () => {
    expect(findTreeProblem(tree({ a: null, b: null }))).toBeNull();
    expect(findTreeProblem(tree({ a: null, b: 'a', c: 'b' }))).toBeNull();
    expect(MAX_COLLECTION_DEPTH).toBe(3);
  });

  it('refuses a fourth level', () => {
    expect(findTreeProblem(tree({ a: null, b: 'a', c: 'b', d: 'c' }))).toEqual({ code: 'COLLECTION_TOO_DEEP', id: 'd' });
  });

  it('refuses a collection inside itself, directly or through its children', () => {
    expect(findTreeProblem(tree({ a: 'a' }))).toEqual({ code: 'COLLECTION_CYCLE', id: 'a' });
    expect(findTreeProblem(tree({ a: 'c', b: 'a', c: 'b' }))).toMatchObject({ code: 'COLLECTION_CYCLE' });
  });

  it('lists descendants and the breadcrumb chain', () => {
    const t = tree({ a: null, b: 'a', c: 'b', d: 'a', e: null });
    expect(descendantsOf(t, 'a').sort()).toEqual(['b', 'c', 'd']);
    expect(descendantsOf(t, 'e')).toEqual([]);
    expect(ancestryOf(t, 'c')).toEqual(['a', 'b', 'c']);
    expect(ancestryOf(t, 'a')).toEqual(['a']);
  });

  it('never loops on a broken tree', () => {
    const t = tree({ a: 'b', b: 'a' });
    expect(ancestryOf(t, 'a')).toEqual(['b', 'a']);
    expect(descendantsOf(t, 'a')).toEqual(['b']);
  });
});
