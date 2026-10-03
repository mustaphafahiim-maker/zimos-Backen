'use strict';

// The list sort whitelist and its keyset clauses, and when confirmed_at is
// stamped — pure functions only.

const {
  ORDER_SORT_KEYS,
  QUEUE_SORT_KEYS,
  orderSort,
  orderByClause,
  afterAnchorClause,
  anchorValue,
} = require('../../src/modules/orders/orderSort');
const { confirmedAtFor } = require('../../src/modules/orders/orderStateService');

describe('orderSort whitelist', () => {
  it('offers exactly the four sorts, and the queue its default on top', () => {
    expect(ORDER_SORT_KEYS).toEqual(['newest', 'oldest', 'total_desc', 'total_asc']);
    expect(QUEUE_SORT_KEYS).toEqual(['default', 'newest', 'oldest', 'total_desc', 'total_asc']);
  });

  it('never turns an unknown key into SQL: it falls back to newest', () => {
    for (const key of [undefined, '', 'o.id; DROP TABLE orders', 'constructor', '__proto__', 'total']) {
      const sort = orderSort(key);
      expect(sort.key).toBe('newest');
      expect(sort.column).toBe('o.created_at');
    }
  });

  it('keeps the newest-first list exactly as it was', () => {
    const sort = orderSort('newest');
    expect(orderByClause(sort, 'o.id')).toBe('o.created_at DESC, o.id DESC');
    expect(afterAnchorClause(sort, 'o.id', 'cursorValue', 'cursorId')).toBe(
      '(o.created_at, o.id) < ($cursorValue::timestamptz, $cursorId::uuid)'
    );
  });

  it('sorts both ways with a stable id tie-breaker in the same direction', () => {
    expect(orderByClause(orderSort('oldest'), 'o.id')).toBe('o.created_at ASC, o.id ASC');
    expect(orderByClause(orderSort('total_desc'), 't.id')).toBe('o.total_amount DESC, t.id DESC');
    expect(orderByClause(orderSort('total_asc'), 't.id')).toBe('o.total_amount ASC, t.id ASC');
  });

  it('pages forward in the sort direction', () => {
    expect(afterAnchorClause(orderSort('oldest'), 'o.id', 'v', 'i')).toBe('(o.created_at, o.id) > ($v::timestamptz, $i::uuid)');
    expect(afterAnchorClause(orderSort('total_desc'), 't.id', 'v', 'i')).toBe('(o.total_amount, t.id) < ($v::bigint, $i::uuid)');
    expect(afterAnchorClause(orderSort('total_asc'), 't.id', 'v', 'i')).toBe('(o.total_amount, t.id) > ($v::bigint, $i::uuid)');
  });

  it('reads the anchor value the sort pages on', () => {
    const order = { createdAt: new Date('2026-09-28T10:00:00.000Z'), totalAmount: '125050' };
    expect(anchorValue(orderSort('newest'), order)).toBe('2026-09-28T10:00:00.000Z');
    expect(anchorValue(orderSort('total_asc'), order)).toBe('125050');
  });
});

describe('confirmedAtFor', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const earlier = new Date('2026-09-28T09:00:00.000Z');

  it('stamps the move into confirmed', () => {
    expect(confirmedAtFor({ confirmationState: 'pending', confirmedAt: null }, 'confirmed', now)).toBe(now);
    expect(confirmedAtFor({ confirmationState: 'postponed', confirmedAt: null }, 'confirmed', now)).toBe(now);
  });

  it('keeps the first stamp while the order stays confirmed', () => {
    expect(confirmedAtFor({ confirmationState: 'confirmed', confirmedAt: earlier }, 'confirmed', now)).toBe(earlier);
  });

  it('clears it when the order leaves confirmed, and restamps a re-confirmation', () => {
    expect(confirmedAtFor({ confirmationState: 'confirmed', confirmedAt: earlier }, 'rejected', now)).toBeNull();
    expect(confirmedAtFor({ confirmationState: 'rejected', confirmedAt: null }, 'confirmed', now)).toBe(now);
  });

  it('is null for every other state', () => {
    for (const state of ['pending', 'rejected', 'unreachable', 'postponed']) {
      expect(confirmedAtFor({ confirmationState: 'pending', confirmedAt: null }, state, now)).toBeNull();
    }
  });
});
