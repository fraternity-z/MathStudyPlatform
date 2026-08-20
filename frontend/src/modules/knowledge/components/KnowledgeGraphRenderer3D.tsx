import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d';
import { forceRadial } from 'd3-force-3d';
import SpriteText from 'three-spritetext';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Points,
  PointsMaterial,
  SphereGeometry,
  TorusGeometry,
  type Object3D,
} from 'three';
import { getMasteryColor } from '@/libs/graph';
import type { KnowledgeEdge, KnowledgeNode } from '@/modules/knowledge/types/knowledge';
import {
  knowledgeEdgeKey,
  type GraphRendererHandle,
  type GraphRendererProps,
} from './graphRendererTypes';

type ForceNode = KnowledgeNode & {
  degree: number;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
};
type ForceLink = KnowledgeEdge & { key: string };
type RenderNode = NodeObject<ForceNode>;
type RenderLink = LinkObject<ForceNode, ForceLink>;

const relationLabels: Record<KnowledgeEdge['relation'], string> = {
  prerequisite: '先修关系',
  used_in: '应用关系',
  related: '相关关系',
};

const CANVAS_BACKGROUND = '#070b12';
const SELECTED_NODE_SCALE = 1.2;
const TARGET_NODE_SCALE = 1.1;
const STAR_COUNT = 320;
const FIT_CAMERA_SCALE = 0.8;
const FIT_PADDING = 44;
const FOCUS_CAMERA_DISTANCE = 320;

const KnowledgeGraphRenderer3D = forwardRef<GraphRendererHandle, GraphRendererProps>(({
  nodes,
  edges,
  selectedNodeId,
  targetNodeId,
  highlightedNodeIds,
  highlightedEdgeKeys,
  reducedMotion,
  onNodeClick,
  onNodeHover,
  onRendererError,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<ForceNode, ForceLink> | undefined>(undefined);
  const renderNodesByIdRef = useRef(new Map<string, RenderNode>());
  const initialFocusDoneRef = useRef(false);
  const fitTimerRef = useRef(0);
  const onRendererErrorRef = useRef(onRendererError);
  const [size, setSize] = useState({ width: 1, height: 1 });

  const graphData = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    return {
      nodes: nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 })),
      links: edges.map((edge) => ({ ...edge, key: knowledgeEdgeKey(edge) })),
    };
  }, [edges, nodes]);

  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes],
  );

  const prerequisiteDepths = useMemo(
    () => getPrerequisiteDepths(nodes, edges),
    [edges, nodes],
  );

  useEffect(() => {
    onRendererErrorRef.current = onRendererError;
  }, [onRendererError]);

  useEffect(() => {
    initialFocusDoneRef.current = false;
  }, [graphData.nodes]);

  useEffect(() => () => window.clearTimeout(fitTimerRef.current), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setSize({
        width: Math.max(container.clientWidth, 1),
        height: Math.max(container.clientHeight, 1),
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    let canvas: HTMLCanvasElement | null = null;
    let disposeSceneDecoration: (() => void) | undefined;
    const graph = graphRef.current;
    const renderNodesById = renderNodesByIdRef.current;
    graph?.resumeAnimation();
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onRendererErrorRef.current?.(new Error('WebGL context lost'));
    };
    const timer = window.setTimeout(() => {
      try {
        const currentGraph = graphRef.current;
        canvas = currentGraph?.renderer().domElement ?? null;
        if (!canvas) return;
        canvas.addEventListener('webglcontextlost', handleContextLost);
        if (currentGraph) disposeSceneDecoration = decorateScene(currentGraph);
      } catch (error) {
        onRendererErrorRef.current?.(toError(error));
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      canvas?.removeEventListener('webglcontextlost', handleContextLost);
      disposeSceneDecoration?.();
      graph?.pauseAnimation();
      renderNodesById.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try {
      const radialForce = prerequisiteDepths
        ? forceRadial<ForceNode>(
            (node) => 54 + (prerequisiteDepths.get(node.id) ?? 0) * 74,
            0,
            0,
            0,
          ).strength(0.46)
        : null;
      graph.d3Force('prerequisite-depth', radialForce);
      graph.d3Force('charge')
        ?.strength?.((node: ForceNode) => -120 - Math.min(node.degree, 8) * 12)
        ?.distanceMax?.(460);
      graph.d3Force('link')
        ?.distance?.((link: ForceLink) => link.relation === 'prerequisite' ? 92 : 124)
        ?.strength?.((link: ForceLink) => link.relation === 'prerequisite' ? 0.72 : 0.26);
    } catch (error) {
      onRendererErrorRef.current?.(toError(error));
    }
  }, [prerequisiteDepths]);

  useEffect(() => {
    if (selectedNodeId || graphData.nodes.length === 0) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const positionInitialCamera = () => {
      if (cancelled) return;
      const graph = graphRef.current;
      if (graph) {
        graph.cameraPosition(
          { x: 0, y: 0, z: getInitialCameraDistance(graphData.nodes.length) },
          { x: 0, y: 0, z: 0 },
          reducedMotion ? 0 : 280,
        );
        return;
      }
      attempts += 1;
      if (attempts < 20) timer = window.setTimeout(positionInitialCamera, 100);
    };
    timer = window.setTimeout(positionInitialCamera, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graphData.nodes, reducedMotion, selectedNodeId]);

  const focusNode = useCallback((node: RenderNode) => {
    const graph = graphRef.current;
    if (!graph || !isFinitePosition(node)) return;
    window.clearTimeout(fitTimerRef.current);
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const z = node.z ?? 0;
    const magnitude = Math.hypot(x, y, z);
    const distance = FOCUS_CAMERA_DISTANCE;
    const position = magnitude > 0.001
      ? {
          x: x * (1 + distance / magnitude),
          y: y * (1 + distance / magnitude),
          z: z * (1 + distance / magnitude),
        }
      : { x: 0, y: 0, z: distance };
    graph.cameraPosition(position, { x, y, z }, reducedMotion ? 0 : 280);
  }, [reducedMotion]);

  const fitGraph = useCallback((duration: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    window.clearTimeout(fitTimerRef.current);
    graph.zoomToFit(duration, FIT_PADDING);
    fitTimerRef.current = window.setTimeout(() => {
      const currentGraph = graphRef.current;
      if (!currentGraph) return;
      const camera = currentGraph.camera();
      currentGraph.cameraPosition({
        x: camera.position.x * FIT_CAMERA_SCALE,
        y: camera.position.y * FIT_CAMERA_SCALE,
        z: camera.position.z * FIT_CAMERA_SCALE,
      }, { x: 0, y: 0, z: 0 }, reducedMotion ? 0 : 160);
    }, duration + 24);
  }, [reducedMotion]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const selected = renderNodesByIdRef.current.get(selectedNodeId);
    if (selected) focusNode(selected);
  }, [focusNode, graphData.nodes, selectedNodeId]);

  const handleEngineTick = useCallback(() => {
    if (selectedNodeId || initialFocusDoneRef.current) return;
    const graph = graphRef.current;
    if (!graph || renderNodesByIdRef.current.size === 0) return;
    initialFocusDoneRef.current = true;
    fitGraph(reducedMotion ? 0 : 240);
  }, [fitGraph, reducedMotion, selectedNodeId]);

  const handleEngineStop = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (!selectedNodeId) {
      fitGraph(reducedMotion ? 0 : 280);
      return;
    }
    const selected = renderNodesByIdRef.current.get(selectedNodeId);
    if (selected) focusNode(selected);
  }, [fitGraph, focusNode, reducedMotion, selectedNodeId]);

  const scaleCamera = useCallback((factor: number) => {
    const graph = graphRef.current;
    if (!graph) return;
    const camera = graph.camera();
    graph.cameraPosition({
      x: camera.position.x * factor,
      y: camera.position.y * factor,
      z: camera.position.z * factor,
    }, undefined, reducedMotion ? 0 : 180);
  }, [reducedMotion]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => scaleCamera(0.82),
    zoomOut: () => scaleCamera(1.22),
    fitView: () => fitGraph(reducedMotion ? 0 : 280),
  }), [fitGraph, reducedMotion, scaleCamera]);

  const handleNodePositionUpdate = useCallback((
    _object: unknown,
    coords: { x: number; y: number; z: number },
    node: NodeObject,
  ) => {
    const renderNode = node as RenderNode;
    Object.assign(renderNode, coords);
    renderNodesByIdRef.current.set(String(renderNode.id), renderNode);
    return false;
  }, []);

  const createNodeVisual = useCallback((node: RenderNode): Object3D => {
    renderNodesByIdRef.current.set(String(node.id), node);
    return buildNodeVisual({
      node,
      isSelected: node.id === selectedNodeId,
      isTarget: node.id === targetNodeId,
      isHighlighted: highlightedNodeIds.has(String(node.id)),
      isDimmed: highlightedNodeIds.size > 0 && !highlightedNodeIds.has(String(node.id)),
    });
  }, [highlightedNodeIds, selectedNodeId, targetNodeId]);

  const linkColor = useCallback((link: RenderLink) => {
    const linkKey = String(link.key ?? '');
    if (highlightedEdgeKeys.has(linkKey)) return '#fbbf24';
    if (highlightedEdgeKeys.size > 0) return '#334155';
    if (link.relation === 'used_in') return '#22d3ee';
    if (link.relation === 'related') return '#a78bfa';
    return '#94a3b8';
  }, [highlightedEdgeKeys]);

  const linkWidth = useCallback((link: RenderLink) => {
    if (highlightedEdgeKeys.has(String(link.key ?? ''))) return 2.8;
    if (link.relation === 'prerequisite') return 1.45;
    if (link.relation === 'used_in') return 1.65;
    return 1;
  }, [highlightedEdgeKeys]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-[#070b12]"
      data-graph-renderer="3d"
      aria-hidden="true"
    >
      <ForceGraph3D<ForceNode, ForceLink>
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData}
        backgroundColor={CANVAS_BACKGROUND}
        showNavInfo={false}
        nodeId="id"
        nodeLabel={(node) => `${node.label} · 掌握度 ${Math.round(node.mastery * 100)}%`}
        nodeThreeObject={createNodeVisual}
        nodePositionUpdate={handleNodePositionUpdate}
        linkLabel={(link) => relationLabels[link.relation]}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkOpacity={0.82}
        linkResolution={10}
        linkCurvature={(link) => link.relation === 'related' ? 0.2 : link.relation === 'used_in' ? 0.08 : 0}
        linkCurveRotation={(link) => edgeCurveRotation(String(link.key ?? ''))}
        linkDirectionalArrowLength={(link) => link.relation === 'prerequisite' ? 5.5 : 3.5}
        linkDirectionalArrowRelPos={0.94}
        linkDirectionalArrowResolution={10}
        linkDirectionalArrowColor={linkColor}
        warmupTicks={80}
        cooldownTicks={reducedMotion ? 0 : 140}
        cooldownTime={reducedMotion ? 0 : 2100}
        d3VelocityDecay={0.4}
        enableNodeDrag={!reducedMotion}
        onEngineTick={handleEngineTick}
        onEngineStop={handleEngineStop}
        onNodeClick={(node) => {
          focusNode(node);
          const original = nodesById.get(String(node.id));
          if (original) onNodeClick?.(original);
        }}
        onNodeHover={(node) => {
          const original = node ? nodesById.get(String(node.id)) ?? null : null;
          onNodeHover?.(original);
        }}
      />
    </div>
  );
});

KnowledgeGraphRenderer3D.displayName = 'KnowledgeGraphRenderer3D';

interface NodeVisualOptions {
  node: RenderNode;
  isSelected: boolean;
  isTarget: boolean;
  isHighlighted: boolean;
  isDimmed: boolean;
}

function buildNodeVisual({
  node,
  isSelected,
  isTarget,
  isHighlighted,
  isDimmed,
}: NodeVisualOptions): Object3D {
  const group = new Group();
  const scale = isSelected ? SELECTED_NODE_SCALE : isTarget ? TARGET_NODE_SCALE : 1;
  const radius = getNodeRadius(node) * scale;
  const color = new Color(isTarget ? '#f59e0b' : getMasteryColor(node.mastery));
  const glowColor = color.clone().lerp(new Color('#ffffff'), isSelected ? 0.5 : 0.18);

  const core = new Mesh(
    createNodeGeometry(node.type, radius),
    new MeshStandardMaterial({
      color,
      emissive: color.clone(),
      emissiveIntensity: isDimmed ? 0.04 : isSelected ? 0.58 : isTarget ? 0.48 : 0.26,
      metalness: node.type === 'theorem' ? 0.18 : 0.08,
      roughness: node.type === 'method' ? 0.32 : 0.24,
      transparent: isDimmed,
      opacity: isDimmed ? 0.3 : 0.98,
      depthWrite: !isDimmed,
      flatShading: node.type !== 'concept',
    }),
  );
  group.add(core);

  const rim = new Mesh(
    createNodeGeometry(node.type, radius * 1.065),
    new MeshBasicMaterial({
      color: isSelected ? '#f8fafc' : glowColor,
      wireframe: true,
      transparent: true,
      opacity: isDimmed ? 0.04 : isSelected ? 0.7 : isTarget ? 0.5 : 0.2,
      depthWrite: false,
    }),
  );
  group.add(rim);

  const halo = new Mesh(
    createNodeGeometry(node.type, radius * 1.45),
    new MeshBasicMaterial({
      color: glowColor,
      side: BackSide,
      transparent: true,
      opacity: isDimmed ? 0.012 : isSelected ? 0.2 : isTarget ? 0.17 : isHighlighted ? 0.11 : 0.055,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(halo);

  if (isSelected || isTarget) {
    const orbit = new Mesh(
      new TorusGeometry(radius * 1.55, Math.max(0.1, radius * 0.035), 8, 48),
      new MeshBasicMaterial({
        color: isTarget ? '#fbbf24' : '#f8fafc',
        transparent: true,
        opacity: isSelected ? 0.86 : 0.68,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    orbit.rotation.set(Math.PI * 0.62, Math.PI * 0.16, Math.PI * 0.08);
    group.add(orbit);
  }

  if (shouldShowNodeLabel(node, isSelected, isTarget, isHighlighted)) {
    group.add(createNodeLabel(node, radius, color, isSelected, isTarget, isDimmed));
  }

  return group;
}

function createNodeGeometry(type: KnowledgeNode['type'], radius: number): BufferGeometry {
  if (type === 'theorem') return new IcosahedronGeometry(radius, 2);
  if (type === 'method') return new OctahedronGeometry(radius, 1);
  return new SphereGeometry(radius, 24, 18);
}

function getNodeRadius(node: RenderNode): number {
  return Math.min(9.8, 6.2 + node.degree * 0.55);
}

function shouldShowNodeLabel(
  node: RenderNode,
  isSelected: boolean,
  isTarget: boolean,
  isHighlighted: boolean,
): boolean {
  return isSelected || isTarget || isHighlighted || node.degree >= 3;
}

function createNodeLabel(
  node: RenderNode,
  radius: number,
  color: Color,
  isSelected: boolean,
  isTarget: boolean,
  isDimmed: boolean,
): SpriteText {
  const label = new SpriteText(node.label);
  label.color = '#f8fafc';
  label.textHeight = isSelected ? 5.6 : 4.5;
  label.backgroundColor = 'rgba(3, 7, 18, 0.88)';
  label.padding = [1.7, 1];
  label.borderWidth = isSelected || isTarget ? 0.32 : 0.18;
  label.borderColor = isSelected ? '#f8fafc' : isTarget ? '#fbbf24' : `#${color.getHexString()}`;
  label.borderRadius = 4;
  label.fontFace = 'Inter, Microsoft YaHei, sans-serif';
  label.fontWeight = isSelected || isTarget ? '600' : '500';
  label.center.y = 0.5;
  label.position.y = radius + (isSelected ? 9 : 7.5);
  label.renderOrder = isSelected || isTarget ? 4 : 2;
  label.material.opacity = isDimmed ? 0.34 : 1;
  label.material.depthTest = isDimmed || !(isSelected || isTarget);
  label.material.depthWrite = false;
  return label;
}

function decorateScene(graph: ForceGraphMethods<ForceNode, ForceLink>): () => void {
  const scene = graph.scene();
  const renderer = graph.renderer();
  const previousFog = scene.fog;
  const previousLights = graph.lights();
  const previousToneMapping = renderer.toneMapping;
  const previousExposure = renderer.toneMappingExposure;
  const stars = createStarField();

  const hemisphere = new HemisphereLight('#dbeafe', '#0f172a', 2.05);
  const keyLight = new DirectionalLight('#ffffff', 2.2);
  keyLight.position.set(120, 180, 140);
  const fillLight = new DirectionalLight('#38bdf8', 0.92);
  fillLight.position.set(-160, -90, -120);

  scene.fog = new FogExp2(CANVAS_BACKGROUND, 0.00175);
  scene.add(stars);
  graph.lights([hemisphere, keyLight, fillLight]);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;

  return () => {
    scene.remove(stars);
    stars.geometry.dispose();
    stars.material.dispose();
    scene.fog = previousFog;
    graph.lights(previousLights);
    renderer.toneMapping = previousToneMapping;
    renderer.toneMappingExposure = previousExposure;
  };
}

function createStarField(): Points<BufferGeometry, PointsMaterial> {
  const random = seededRandom(0x4d535047);
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let index = 0; index < STAR_COUNT; index += 1) {
    const radius = 360 + random() * 760;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[index * 3 + 2] = radius * Math.cos(phi);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: '#bae6fd',
    size: 1.05,
    transparent: true,
    opacity: 0.24,
    sizeAttenuation: true,
    depthWrite: false,
    fog: false,
  });
  const stars = new Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function getInitialCameraDistance(nodeCount: number): number {
  return Math.min(520, Math.max(250, 210 + Math.sqrt(nodeCount) * 22));
}

function edgeCurveRotation(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return (hash % 360) * Math.PI / 180;
}

function isFinitePosition(node: RenderNode): boolean {
  return Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z);
}

function getPrerequisiteDepths(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
): ReadonlyMap<string, number> | null {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const depths = new Map<string, number>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
    depths.set(node.id, 0);
  }
  let prerequisiteCount = 0;
  for (const edge of edges) {
    if (edge.relation !== 'prerequisite') continue;
    if (!outgoing.has(edge.source) || !outgoing.has(edge.target)) continue;
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    prerequisiteCount += 1;
  }

  if (prerequisiteCount === 0) return null;
  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .sort();
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    visited += 1;
    for (const next of outgoing.get(id) ?? []) {
      depths.set(next, Math.max(depths.get(next) ?? 0, (depths.get(id) ?? 0) + 1));
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  return visited === nodes.length ? depths : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('3D 图谱渲染失败');
}

export default KnowledgeGraphRenderer3D;
