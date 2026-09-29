'use strict';

/**
 * The collection tree's two rules, checked on the whole tree as it would look
 * after a change: no collection may be its own ancestor, and no chain may be
 * deeper than MAX_COLLECTION_DEPTH (a top-level collection is depth 1, its
 * child 2, a grandchild 3).
 *
 * Pure — a Map of id → parentId in, the first problem (or null) out — so the
 * service can run it inside its transaction against the rows it just locked,
 * and the rules can be tested on their own.
 */
const MAX_COLLECTION_DEPTH = 3;

/** @returns {{ code: 'COLLECTION_CYCLE' | 'COLLECTION_TOO_DEEP', id: string } | null} */
function findTreeProblem(parentOf, maxDepth = MAX_COLLECTION_DEPTH) {
  for (const id of parentOf.keys()) {
    const seen = new Set();
    let depth = 0;
    let current = id;
    while (current) {
      if (seen.has(current)) return { code: 'COLLECTION_CYCLE', id };
      seen.add(current);
      depth += 1;
      if (depth > maxDepth) return { code: 'COLLECTION_TOO_DEEP', id };
      current = parentOf.get(current) || null;
    }
  }
  return null;
}

/** Every collection under `rootId` (children, grandchildren…), not including it. */
function descendantsOf(parentOf, rootId) {
  const children = new Map();
  for (const [id, parentId] of parentOf) {
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(id);
  }
  const out = [];
  const stack = [...(children.get(rootId) || [])];
  const seen = new Set([rootId]);
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(children.get(id) || []));
  }
  return out;
}

/** The chain from the top level down to `id`, inclusive. Stops on a cycle rather than looping. */
function ancestryOf(parentOf, id) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current && !seen.has(current) && parentOf.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = parentOf.get(current) || null;
  }
  return chain;
}

module.exports = { MAX_COLLECTION_DEPTH, findTreeProblem, descendantsOf, ancestryOf };
