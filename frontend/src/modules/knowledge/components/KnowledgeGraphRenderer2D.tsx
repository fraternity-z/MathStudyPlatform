import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Graph } from '@antv/g6';
import {
  createGraphInstance,
  graphFitView,
  graphZoomIn,
  graphZoomOut,
  updateGraphData,
} from '@/libs/graph';
import type { GraphRendererHandle, GraphRendererProps } from './graphRendererTypes';

const KnowledgeGraphRenderer2D = forwardRef<GraphRendererHandle, GraphRendererProps>(({
  nodes,
  edges,
  selectedNodeId,
  highlightedNodeIds,
  reducedMotion,
  onNodeClick,
  onNodeHover,
  onRendererError,
}, ref) => {
  const nodesById = useMemo(() => {
    const index = new Map<string, GraphRendererProps['nodes'][number]>();
    for (const node of nodes) {
      if (!index.has(node.id)) index.set(node.id, node);
    }
    return index;
  }, [nodes]);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const nodesRef = useRef(nodes);
  const nodesByIdRef = useRef(nodesById);
  const onNodeClickRef = useRef(onNodeClick);
  const onNodeHoverRef = useRef(onNodeHover);
  const onRendererErrorRef = useRef(onRendererError);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    nodesRef.current = nodes;
    nodesByIdRef.current = nodesById;
    onNodeClickRef.current = onNodeClick;
    onNodeHoverRef.current = onNodeHover;
    onRendererErrorRef.current = onRendererError;
  }, [nodes, nodesById, onNodeClick, onNodeHover, onRendererError]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => graphZoomIn(graphRef.current),
    zoomOut: () => graphZoomOut(graphRef.current),
    fitView: () => graphFitView(graphRef.current),
  }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    const initTimer = window.setTimeout(() => {
      if (!mounted || graphRef.current) return;
      try {
        const graph = createGraphInstance({
          container,
          width: Math.max(container.clientWidth, 1),
          height: Math.max(container.clientHeight, 1),
          nodes: nodesRef.current,
          edges,
          padding: [52, 52, 52, 52],
          nodeSize: 42,
          fontSize: 12,
          labelOffsetY: 9,
          lineWidth: 1.4,
          arrowSize: 7,
          nodesep: 70,
          ranksep: 92,
          onNodeClick: (nodeId) => {
            const node = nodesByIdRef.current.get(nodeId);
            if (node) onNodeClickRef.current?.(node);
          },
          onNodeHover: (nodeId) => {
            const node = nodeId
              ? nodesByIdRef.current.get(nodeId) ?? null
              : null;
            onNodeHoverRef.current?.(node);
          },
        });
        graphRef.current = graph;
        graph.render()
          .then(() => {
            if (mounted) setIsReady(true);
          })
          .catch((error: unknown) => {
            if (mounted) onRendererErrorRef.current?.(toError(error));
          });
      } catch (error) {
        if (mounted) onRendererErrorRef.current?.(toError(error));
      }
    }, 0);

    const resizeObserver = new ResizeObserver(() => {
      if (!graphRef.current) return;
      graphRef.current.setSize(
        Math.max(container.clientWidth, 1),
        Math.max(container.clientHeight, 1),
      );
    });
    resizeObserver.observe(container);

    return () => {
      mounted = false;
      window.clearTimeout(initTimer);
      resizeObserver.disconnect();
      graphRef.current?.destroy();
      graphRef.current = null;
    };
    // The graph instance owns its initial edge listeners; data updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !isReady) return;
    try {
      updateGraphData(graph, nodes, edges);
    } catch (error) {
      onRendererErrorRef.current?.(toError(error));
    }
  }, [nodes, edges, isReady]);

  const applyStates = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || !isReady) return;
    const hasHighlight = highlightedNodeIds.size > 0;
    const states: Record<string, string[]> = {};
    for (const node of nodes) {
      if (node.id === selectedNodeId) {
        states[node.id] = ['selected'];
      } else if (highlightedNodeIds.has(node.id)) {
        states[node.id] = ['active'];
      } else {
        states[node.id] = hasHighlight ? ['inactive'] : [];
      }
    }
    void graph.setElementState(states, false).catch((error: unknown) => {
      onRendererErrorRef.current?.(toError(error));
    });
    if (selectedNodeId) {
      void graph.focusElement(selectedNodeId, { duration: reducedMotion ? 0 : 280 });
    }
  }, [highlightedNodeIds, isReady, nodes, reducedMotion, selectedNodeId]);

  useEffect(() => {
    applyStates();
  }, [applyStates]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-[#111315]"
      data-graph-renderer="2d"
      aria-hidden="true"
    />
  );
});

KnowledgeGraphRenderer2D.displayName = 'KnowledgeGraphRenderer2D';

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('2D 图谱渲染失败');
}

export default KnowledgeGraphRenderer2D;
