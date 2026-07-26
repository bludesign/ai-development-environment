export type BasicLayoutDirection = "HORIZONTAL" | "VERTICAL";

export type BasicLayoutItem = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
};

export type BasicLayoutEdge = { source: string; target: string };

export type BasicLayoutResult = {
  positions: Map<string, { x: number; y: number }>;
  bounds: { width: number; height: number };
};

const DEFAULT_WIDTH = 208;
const DEFAULT_HEIGHT = 88;
const LAYER_GAP = 64;
const SIBLING_GAP = 24;

/**
 * Projects a workflow DAG into simple topological layers. Authored positions
 * only break ties between peers in one layer; they never determine execution
 * order and are never mutated by this projection.
 */
export function basicWorkflowLayout(
  items: readonly BasicLayoutItem[],
  edges: readonly BasicLayoutEdge[],
  direction: BasicLayoutDirection,
): BasicLayoutResult {
  if (!items.length)
    return { positions: new Map(), bounds: { width: 0, height: 0 } };

  const byId = new Map(items.map((item) => [item.id, item]));
  const definitionIndex = new Map(items.map((item, index) => [item.id, index]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(items.map(({ id }) => [id, 0]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const compareAuthoredOrder = (leftId: string, rightId: string) => {
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    return (
      left.position.y - right.position.y ||
      left.position.x - right.position.x ||
      (definitionIndex.get(leftId) ?? 0) - (definitionIndex.get(rightId) ?? 0)
    );
  };

  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort(compareAuthoredOrder);
  const rank = new Map(queue.map((id) => [id, 0]));
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      rank.set(
        target,
        Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1),
      );
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        queue.push(target);
        queue.sort(compareAuthoredOrder);
      }
    }
  }

  // Invalid drafts should still be previewable. Keep cycle members visible in
  // one deterministic trailing layer while validation reports the real error.
  const unresolved = items
    .map(({ id }) => id)
    .filter((id) => !visited.has(id))
    .sort(compareAuthoredOrder);
  const trailingRank = Math.max(-1, ...rank.values()) + 1;
  for (const id of unresolved) rank.set(id, trailingRank);

  const layers = new Map<number, string[]>();
  for (const item of items) {
    const itemRank = rank.get(item.id) ?? 0;
    layers.set(itemRank, [...(layers.get(itemRank) ?? []), item.id]);
  }
  const orderedLayers = [...layers]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids.sort(compareAuthoredOrder));
  const dimensions = (id: string) => {
    const item = byId.get(id)!;
    return {
      width: item.width && item.width > 0 ? item.width : DEFAULT_WIDTH,
      height: item.height && item.height > 0 ? item.height : DEFAULT_HEIGHT,
    };
  };

  const positions = new Map<string, { x: number; y: number }>();
  if (direction === "HORIZONTAL") {
    const layerWidths = orderedLayers.map((ids) =>
      Math.max(...ids.map((id) => dimensions(id).width)),
    );
    const layerHeights = orderedLayers.map(
      (ids) =>
        ids.reduce((total, id) => total + dimensions(id).height, 0) +
        SIBLING_GAP * Math.max(0, ids.length - 1),
    );
    const height = Math.max(...layerHeights);
    let x = 0;
    orderedLayers.forEach((ids, layerIndex) => {
      let y = (height - layerHeights[layerIndex]!) / 2;
      for (const id of ids) {
        const size = dimensions(id);
        positions.set(id, {
          x: x + (layerWidths[layerIndex]! - size.width) / 2,
          y,
        });
        y += size.height + SIBLING_GAP;
      }
      x += layerWidths[layerIndex]! + LAYER_GAP;
    });
    return {
      positions,
      bounds: { width: x - LAYER_GAP, height },
    };
  }

  // A narrow viewport gets a single readable column. Branch peers stay in
  // deterministic authored order, but stack instead of forcing horizontal
  // overflow that would hide part of the flow on a phone.
  const width = Math.max(
    ...orderedLayers.flatMap((ids) => ids.map((id) => dimensions(id).width)),
  );
  let y = 0;
  orderedLayers.forEach((ids, layerIndex) => {
    ids.forEach((id, siblingIndex) => {
      const size = dimensions(id);
      positions.set(id, {
        x: (width - size.width) / 2,
        y,
      });
      y += size.height;
      if (siblingIndex < ids.length - 1) y += SIBLING_GAP;
    });
    if (layerIndex < orderedLayers.length - 1) y += LAYER_GAP;
  });
  return {
    positions,
    bounds: { width, height: y },
  };
}
