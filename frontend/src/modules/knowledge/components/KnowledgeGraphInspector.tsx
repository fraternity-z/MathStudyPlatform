import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowRight,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  Circle,
  LockKeyhole,
  Route,
  Target,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { MarkdownContent } from '@/components/chat/MarkdownContent';
import { cn } from '@/libs/utils/cn';
import { RequestErrorNotice } from '@/components/feedback';
import type { AppError } from '@/libs/http/appError';
import type { KnowledgeGraphIndex } from '@/libs/graph';
import type {
  KnowledgeNode,
  LearningPathItem,
} from '@/modules/knowledge/types/knowledge';

interface KnowledgeGraphInspectorProps {
  nodes: KnowledgeNode[];
  graphIndex: KnowledgeGraphIndex;
  selectedNode: KnowledgeNode | null;
  targetNodeId: string | null;
  path: LearningPathItem[];
  pathLoading: boolean;
  pathError: AppError | null;
  goalSaving: boolean;
  goalError: AppError | null;
  onSelectNode: (nodeId: string) => void;
  onExplain: (node: KnowledgeNode) => void;
  onPractice: (node: KnowledgeNode) => void;
  onMistakes: (node: KnowledgeNode) => void;
  onSetGoal: (node: KnowledgeNode) => void;
  onOpenLearningPath: () => void;
  onRetryPath: () => void;
  onClose?: () => void;
}

export function KnowledgeGraphInspector({
  nodes,
  graphIndex,
  selectedNode,
  targetNodeId,
  path,
  pathLoading,
  pathError,
  goalSaving,
  goalError,
  onSelectNode,
  onExplain,
  onPractice,
  onMistakes,
  onSetGoal,
  onOpenLearningPath,
  onRetryPath,
  onClose,
}: KnowledgeGraphInspectorProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const targetNode = targetNodeId ? graphIndex.nodesById.get(targetNodeId) ?? null : null;
  const selectedPathItem = selectedNode
    ? path.find((item) => item.id === selectedNode.id) ?? null
    : null;
  const prerequisites = selectedNode
    ? graphIndex.prerequisiteEdgesByTarget.get(selectedNode.id) ?? []
    : [];
  const successors = selectedNode
    ? graphIndex.successorEdgesBySource.get(selectedNode.id) ?? []
    : [];

  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [selectedNode?.id, targetNodeId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-surface-900">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-surface-200 px-4 dark:border-surface-700">
        <div className="min-w-0">
          <p className="text-xs font-medium text-surface-500 dark:text-surface-400">
            {selectedNode ? '知识点详情' : targetNode ? '当前学习目标' : '学习导航'}
          </p>
          <h2 className="truncate text-base font-semibold tracking-normal text-surface-900 dark:text-surface-100">
            {selectedNode?.label || targetNode?.label || '选择一个知识点'}
          </h2>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-surface-500 hover:bg-surface-100 hover:text-surface-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-surface-800 dark:hover:text-white"
            title="关闭详情"
            aria-label="关闭详情"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
        {selectedNode ? (
          <NodeDetails
            node={selectedNode}
            target={selectedNode.id === targetNodeId}
            pathItem={selectedPathItem}
            prerequisites={prerequisites
              .map((edge) => graphIndex.nodesById.get(edge.source))
              .filter((node): node is KnowledgeNode => Boolean(node))}
            successors={successors
              .map((edge) => graphIndex.nodesById.get(edge.target))
              .filter((node): node is KnowledgeNode => Boolean(node))}
            graphIndex={graphIndex}
            goalSaving={goalSaving}
            goalError={goalError}
            onSelectNode={onSelectNode}
            onExplain={onExplain}
            onPractice={onPractice}
            onMistakes={onMistakes}
            onSetGoal={onSetGoal}
          />
        ) : (
          <div className="border-b border-surface-200 px-4 py-5 dark:border-surface-700">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <Target className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-surface-900 dark:text-surface-100">
                  {targetNode ? targetNode.label : '尚未设置学习目标'}
                </p>
                <p className="mt-1 text-sm leading-6 text-surface-500 dark:text-surface-400">
                  {targetNode
                    ? '路径模式会突出通向该知识点的先修链和薄弱阻塞点。'
                    : '选择知识点后设为目标，即可生成可执行的先修路径。'}
                </p>
              </div>
            </div>
          </div>
        )}

        <PathSection
          path={path}
          loading={pathLoading}
          error={pathError}
          graphIndex={graphIndex}
          onSelectNode={onSelectNode}
          onRetry={onRetryPath}
          onOpenLearningPath={onOpenLearningPath}
        />

        <NodeIndex
          nodes={nodes}
          selectedNodeId={selectedNode?.id ?? null}
          targetNodeId={targetNodeId}
          onSelectNode={onSelectNode}
        />
      </div>
    </div>
  );
}

function NodeDetails({
  node,
  target,
  pathItem,
  prerequisites,
  successors,
  graphIndex,
  goalSaving,
  goalError,
  onSelectNode,
  onExplain,
  onPractice,
  onMistakes,
  onSetGoal,
}: {
  node: KnowledgeNode;
  target: boolean;
  pathItem: LearningPathItem | null;
  prerequisites: KnowledgeNode[];
  successors: KnowledgeNode[];
  graphIndex: KnowledgeGraphIndex;
  goalSaving: boolean;
  goalError: AppError | null;
  onSelectNode: (nodeId: string) => void;
  onExplain: (node: KnowledgeNode) => void;
  onPractice: (node: KnowledgeNode) => void;
  onMistakes: (node: KnowledgeNode) => void;
  onSetGoal: (node: KnowledgeNode) => void;
}) {
  return (
    <section className="border-b border-surface-200 px-4 py-5 dark:border-surface-700">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-surface-500 dark:text-surface-400">
          {node.chapter || '未分章节'} · {nodeTypeLabel(node.type)}
        </span>
        {target ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Target className="h-3.5 w-3.5" />当前目标
          </span>
        ) : null}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-surface-600 dark:text-surface-300">掌握度</span>
          <span className="font-semibold text-surface-900 dark:text-surface-100">
            {Math.round(node.mastery * 100)}%
          </span>
        </div>
        <Progress value={node.mastery * 100} variant={masteryVariant(node.mastery)} />
      </div>

      <p className="mt-4 text-sm leading-6 text-surface-600 dark:text-surface-300">
        {node.description || '该知识点暂未补充说明。'}
      </p>

      {node.formula ? (
        <div className="mt-4 overflow-x-auto rounded-md border border-surface-200 bg-surface-50 px-3 py-2 dark:border-surface-700 dark:bg-surface-800/60">
          <p className="mb-1 text-xs font-medium text-surface-500 dark:text-surface-400">公式</p>
          <div className="min-w-max text-sm text-surface-900 dark:text-surface-100">
            <MarkdownContent content={`$$\n${node.formula}\n$$`} />
          </div>
        </div>
      ) : null}

      {pathItem?.recommendation ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {pathItem.recommendation}
        </div>
      ) : null}

      {pathItem?.locked_by?.length ? (
        <RelationGroup title="阻塞原因" icon={<LockKeyhole className="h-4 w-4 text-[#f97360]" />}>
          {pathItem.locked_by.map((nodeId) => {
            const blocker = graphIndex.nodesById.get(nodeId);
            return blocker ? (
              <RelationButton key={nodeId} label={blocker.label} onClick={() => onSelectNode(nodeId)} tone="blocked" />
            ) : null;
          })}
        </RelationGroup>
      ) : null}

      <RelationGroup title="先修知识" icon={<ArrowRight className="h-4 w-4" />}>
        {prerequisites.length
          ? prerequisites.map((item) => (
              <RelationButton key={item.id} label={item.label} onClick={() => onSelectNode(item.id)} />
            ))
          : <span className="text-sm text-surface-400">无</span>}
      </RelationGroup>

      <RelationGroup title="后续知识" icon={<ChevronRight className="h-4 w-4" />}>
        {successors.length
          ? successors.map((item) => (
              <RelationButton key={item.id} label={item.label} onClick={() => onSelectNode(item.id)} />
            ))
          : <span className="text-sm text-surface-400">无</span>}
      </RelationGroup>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button size="sm" onClick={() => onExplain(node)}>
          <Bot className="mr-1.5 h-4 w-4" />AI 讲解
        </Button>
        <Button size="sm" variant="outline" onClick={() => onPractice(node)}>
          <BookOpenCheck className="mr-1.5 h-4 w-4" />练习此知识点
        </Button>
        <Button size="sm" variant="outline" onClick={() => onMistakes(node)}>
          <BrainCircuit className="mr-1.5 h-4 w-4" />复习错题
        </Button>
        <Button
          size="sm"
          variant={target ? 'secondary' : 'outline'}
          disabled={target}
          isLoading={goalSaving}
          onClick={() => onSetGoal(node)}
        >
          <Target className="mr-1.5 h-4 w-4" />{target ? '当前目标' : '设为目标'}
        </Button>
      </div>
      {goalError ? <RequestErrorNotice error={goalError} className="mt-3" /> : null}
    </section>
  );
}

function PathSection({
  path,
  loading,
  error,
  graphIndex,
  onSelectNode,
  onRetry,
  onOpenLearningPath,
}: {
  path: LearningPathItem[];
  loading: boolean;
  error: AppError | null;
  graphIndex: KnowledgeGraphIndex;
  onSelectNode: (nodeId: string) => void;
  onRetry: () => void;
  onOpenLearningPath: () => void;
}) {
  const nextStep = path.find((item) => item.status === 'current' || item.status === 'available');
  return (
    <section className="border-b border-surface-200 px-4 py-5 dark:border-surface-700">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-surface-900 dark:text-surface-100">
          <Route className="h-4 w-4 text-amber-600" />目标路径
        </h3>
        {path.length ? (
          <button
            type="button"
            onClick={onOpenLearningPath}
            className="text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
          >
            完整路径
          </button>
        ) : null}
      </div>

      {loading ? <p className="mt-3 text-sm text-surface-400">正在计算路径...</p> : null}
      {error ? (
        <RequestErrorNotice error={error} onRetry={onRetry} onRefresh={onRetry} className="mt-3" />
      ) : null}
      {!loading && !error && path.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-surface-500 dark:text-surface-400">
          设置学习目标后，这里会显示先修步骤与阻塞点。
        </p>
      ) : null}

      {nextStep ? (
        <button
          type="button"
          onClick={() => onSelectNode(nextStep.id)}
          className="mt-3 flex w-full items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-left hover:border-amber-400 dark:border-amber-900/60 dark:bg-amber-950/30"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500 text-white">
            <ArrowRight className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-amber-700 dark:text-amber-300">下一步</span>
            <span className="block truncate text-sm font-medium text-surface-900 dark:text-surface-100">
              {nextStep.title}
            </span>
          </span>
        </button>
      ) : null}

      {path.length ? (
        <ol className="mt-3 space-y-1" aria-label="目标学习路径">
          {path.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelectNode(item.id)}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-surface-800"
              >
                <PathStatusIcon status={item.status} />
                <span className="min-w-0 flex-1 truncate text-surface-700 dark:text-surface-300">
                  {graphIndex.nodesById.get(item.id)?.label || item.title}
                </span>
                <span className="text-xs text-surface-400">{Math.round(item.mastery * 100)}%</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function NodeIndex({
  nodes,
  selectedNodeId,
  targetNodeId,
  onSelectNode,
}: {
  nodes: KnowledgeNode[];
  selectedNodeId: string | null;
  targetNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="px-4 py-5">
      <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">节点索引</h3>
      <div className="mt-3 space-y-1" role="list" aria-label="可访问知识点索引">
        {nodes.slice(0, 80).map((node) => (
          <button
            key={node.id}
            type="button"
            role="listitem"
            onClick={() => onSelectNode(node.id)}
            aria-current={node.id === selectedNodeId ? 'true' : undefined}
            className={cn(
              'flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              node.id === selectedNodeId
                ? 'bg-primary-50 text-primary-800 dark:bg-primary-950/40 dark:text-primary-200'
                : 'text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800',
            )}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', masteryDot(node.mastery))} />
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            {node.id === targetNodeId ? <Target className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-label="当前目标" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function RelationGroup({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-2 text-xs font-medium text-surface-500 dark:text-surface-400">
        {icon}{title}
      </h3>
      <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function RelationButton({ label, onClick, tone = 'default' }: { label: string; onClick: () => void; tone?: 'default' | 'blocked' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        tone === 'blocked'
          ? 'border-[#f97360]/40 bg-[#f97360]/10 text-red-700 hover:border-[#f97360] dark:text-red-300'
          : 'border-surface-200 text-surface-600 hover:border-primary-400 hover:text-primary-700 dark:border-surface-700 dark:text-surface-300 dark:hover:text-primary-300',
      )}
    >
      {label}
    </button>
  );
}

function PathStatusIcon({ status }: { status: LearningPathItem['status'] }) {
  if (status === 'completed') return <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="已掌握" />;
  if (status === 'locked') return <LockKeyhole className="h-4 w-4 shrink-0 text-[#f97360]" aria-label="被阻塞" />;
  if (status === 'current') return <Circle className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" aria-label="学习中" />;
  return <Circle className="h-4 w-4 shrink-0 text-surface-400" aria-label="可学习" />;
}

function masteryVariant(mastery: number): 'success' | 'warning' | 'destructive' {
  if (mastery >= 0.8) return 'success';
  if (mastery >= 0.4) return 'warning';
  return 'destructive';
}

function masteryDot(mastery: number): string {
  if (mastery <= 0) return 'bg-surface-400';
  if (mastery >= 0.8) return 'bg-emerald-500';
  if (mastery >= 0.4) return 'bg-amber-500';
  return 'bg-[#f97360]';
}

function nodeTypeLabel(type: KnowledgeNode['type']): string {
  if (type === 'theorem') return '定理';
  if (type === 'method') return '方法';
  return '概念';
}

export function KnowledgeGraphMobileSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="知识点详情">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        onClick={onClose}
        aria-label="关闭详情"
      />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[82vh] min-h-[52vh] flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl dark:bg-surface-900">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-surface-300 dark:bg-surface-600" />
        {children}
      </div>
    </div>
  );
}
