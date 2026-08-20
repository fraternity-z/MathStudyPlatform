import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AIPracticeConfigurator,
  ExercisePanel,
  useExerciseViewModel,
} from '@/modules/exercise';
import type { GenerateQuestionType } from '@/modules/exercise/services/exerciseService';
import { knowledgeService } from '@/modules/knowledge/services/knowledgeService';
import type { KnowledgeNode } from '@/modules/knowledge/types/knowledge';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { MainLayout } from '@/components/layout/MainLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import {
  Bot,
  GraduationCap,
  MessageCircle,
  Sparkles,
  Users,
  WandSparkles,
} from 'lucide-react';
import { buildExerciseTutorLaunch } from './exerciseTutorLaunch';
import { DailyQuestionStatusEntry } from '@/modules/daily-question/components/DailyQuestionStatusEntry';
import { useShanghaiDate } from '@/modules/daily-question/hooks/useShanghaiDate';
import { dailyQuestionService } from '@/modules/daily-question/services/dailyQuestionService';
import type { DailyQuestionAssignment } from '@/modules/daily-question/types/dailyQuestion';
import { toAppError, type AppError } from '@/libs/http/apiClient';

type ExerciseMode = 'class' | 'ai';

const INVALID_CONCEPT_MESSAGE = '指定的知识点不存在，请重新选择';

const makeUiError = (message: string): AppError => ({
  kind: 'validation',
  message,
  retryable: false,
  source: 'ui',
});

const tutorCopy = {
  class: {
    title: '班级题辅导',
    badge: '教师发布',
    description: '围绕当前班级题提供分步提示、思路梳理和作答后的错因讲解。',
    empty: '获取班级题后即可询问导师。',
  },
  ai: {
    title: 'AI 练习教练',
    badge: '自主生成',
    description: '结合所选知识点与难度辅导当前生成题，并识别可能的题目歧义。',
    empty: '生成自主练习题后即可询问导师。',
  },
} as const;

export const ExercisePage: React.FC = () => {
  const navigate = useNavigate();
  const todayDate = useShanghaiDate();
  const [searchParams] = useSearchParams();
  const requestedMode: ExerciseMode = searchParams.get('mode') === 'ai' ? 'ai' : 'class';
  const requestedConceptId = searchParams.get('concept_id')?.trim() ?? '';
  const shouldAutoStart = requestedMode === 'ai'
    && searchParams.get('autostart') === '1'
    && Boolean(requestedConceptId);
  const {
    currentQuestion: classQuestion,
    isLoading: isClassLoading,
    isSubmitting: isClassSubmitting,
    submitPhase: classSubmitPhase,
    submitResult: classSubmitResult,
    solution: classSolution,
    isLoadingSolution: isClassSolutionLoading,
    solutionError: classSolutionError,
    error: classError,
    errorType: classErrorType,
    errorSource: classErrorSource,
    loadNextQuestion: loadNextClassQuestion,
    submitAnswer: submitClassAnswer,
    loadSolution: loadClassSolution,
  } = useExerciseViewModel();
  const {
    currentQuestion: aiQuestion,
    isGenerating,
    isSubmitting: isAISubmitting,
    submitPhase: aiSubmitPhase,
    submitResult: aiSubmitResult,
    solution: aiSolution,
    isLoadingSolution: isAISolutionLoading,
    solutionError: aiSolutionError,
    error: aiError,
    errorType: aiErrorType,
    errorSource: aiErrorSource,
    generateQuestion: requestAIQuestion,
    submitAnswer: submitAIAnswer,
    loadSolution: loadAISolution,
  } = useExerciseViewModel();
  const classLoadStarted = useRef(false);
  const knowledgeLoaded = useRef(false);
  const knowledgeLoadInFlight = useRef(false);
  const knowledgeRequestId = useRef(0);
  const autoStartedRequest = useRef<string | null>(null);
  const [mode, setMode] = useState<ExerciseMode>(requestedMode);
  const [knowledgeNodes, setKnowledgeNodes] = useState<KnowledgeNode[]>([]);
  const [isLoadingKnowledge, setIsLoadingKnowledge] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<AppError | null>(null);
  const [selectedConceptId, setSelectedConceptId] = useState('');
  const [difficulty, setDifficulty] = useState(0.5);
  const [questionType, setQuestionType] = useState<GenerateQuestionType>('multiple_choice');
  const [dailyAssignment, setDailyAssignment] = useState<DailyQuestionAssignment | null>(null);
  const [isDailyStatusLoading, setIsDailyStatusLoading] = useState(true);
  const [dailyStatusError, setDailyStatusError] = useState<AppError | null>(null);

  useEffect(() => {
    if (classLoadStarted.current) return;
    classLoadStarted.current = true;
    void loadNextClassQuestion();
  }, [loadNextClassQuestion]);

  useEffect(() => {
    const controller = new AbortController();
    const loadDailyStatus = async () => {
      setIsDailyStatusLoading(true);
      setDailyStatusError(null);
      setDailyAssignment(null);
      try {
        const nextAssignment = await dailyQuestionService.getToday(controller.signal);
        if (!controller.signal.aborted) {
          setDailyAssignment(nextAssignment);
        }
      } catch (statusError) {
        if (!controller.signal.aborted) {
          setDailyStatusError(toAppError(statusError, '每日一题状态暂时无法加载'));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsDailyStatusLoading(false);
        }
      }
    };

    void loadDailyStatus();
    return () => controller.abort();
  }, [todayDate]);

  useEffect(() => {
    return () => {
      knowledgeRequestId.current += 1;
    };
  }, []);

  const loadKnowledgeNodes = useCallback(async (force = false) => {
    if ((!force && knowledgeLoaded.current) || knowledgeLoadInFlight.current) return;

    const requestId = knowledgeRequestId.current + 1;
    knowledgeRequestId.current = requestId;
    knowledgeLoadInFlight.current = true;
    setIsLoadingKnowledge(true);
    setKnowledgeError(null);

    try {
      const graph = await knowledgeService.getKnowledgeGraph();
      if (requestId !== knowledgeRequestId.current) return;
      knowledgeLoaded.current = true;
      setKnowledgeNodes(graph.nodes);
      if (graph.nodes.length === 0) {
        setSelectedConceptId('');
        setKnowledgeError(makeUiError('暂无可用知识点，请联系管理员配置'));
        return;
      }
      const requestedNode = requestedConceptId
        ? graph.nodes.find((node) => node.id === requestedConceptId)
        : null;
      setSelectedConceptId((current) => requestedNode?.id || current || graph.nodes[0]?.id || '');
      if (requestedConceptId && !requestedNode) {
        setKnowledgeError(makeUiError(INVALID_CONCEPT_MESSAGE));
      }
    } catch (error) {
      if (requestId === knowledgeRequestId.current) {
        setKnowledgeError(toAppError(error, '知识点加载失败，请稍后重试'));
      }
    } finally {
      if (requestId === knowledgeRequestId.current) {
        knowledgeLoadInFlight.current = false;
        setIsLoadingKnowledge(false);
      }
    }
  }, [requestedConceptId]);

  useEffect(() => {
    setMode(requestedMode);
  }, [requestedMode]);

  useEffect(() => {
    if (mode === 'ai') {
      void loadKnowledgeNodes();
    }
  }, [loadKnowledgeNodes, mode]);

  useEffect(() => {
    if (mode !== 'ai' || !requestedConceptId || knowledgeNodes.length === 0) return;
    const requestedNode = knowledgeNodes.find((node) => node.id === requestedConceptId);
    if (!requestedNode) {
      setKnowledgeError(makeUiError(INVALID_CONCEPT_MESSAGE));
      return;
    }
    setSelectedConceptId(requestedNode.id);
    setKnowledgeError((current) => current?.message === INVALID_CONCEPT_MESSAGE ? null : current);
  }, [knowledgeNodes, mode, requestedConceptId]);

  useEffect(() => {
    if (!shouldAutoStart || mode !== 'ai' || isLoadingKnowledge) return;
    if (!knowledgeNodes.some((node) => node.id === requestedConceptId)) return;
    if (autoStartedRequest.current === requestedConceptId) return;

    autoStartedRequest.current = requestedConceptId;
    void requestAIQuestion(requestedConceptId, difficulty);
  }, [
    difficulty,
    isLoadingKnowledge,
    knowledgeNodes,
    mode,
    requestAIQuestion,
    requestedConceptId,
    shouldAutoStart,
  ]);

  const knowledgeOptions = useMemo(
    () => knowledgeNodes.map((node) => ({
      value: node.id,
      label: node.chapter ? `${node.chapter} · ${node.label}` : node.label,
    })),
    [knowledgeNodes],
  );

  const generateQuestion = () => {
    if (!selectedConceptId) return Promise.resolve();
    return requestAIQuestion(selectedConceptId, difficulty, questionType);
  };

  const retryKnowledgeLoad = () => {
    knowledgeLoaded.current = false;
    return loadKnowledgeNodes(true);
  };

  const handleModeChange = (value: string) => {
    const nextMode: ExerciseMode = value === 'ai' ? 'ai' : 'class';
    setMode(nextMode);
    if (nextMode === 'ai') {
      void loadKnowledgeNodes();
    }
  };

  const activeQuestion = mode === 'class'
    ? classQuestion
    : aiQuestion;
  const activeTutor = tutorCopy[mode];

  const handleCallAITutor = () => {
    if (!activeQuestion) return;
    navigate('/session/new', { state: buildExerciseTutorLaunch(activeQuestion) });
  };

  return (
    <MainLayout>
      <div className="container mx-auto max-w-6xl p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="min-w-0 space-y-6 lg:col-span-8">
            <div>
              <h1 className="text-3xl font-bold tracking-normal text-surface-900 dark:text-surface-100">
                智能刷题
              </h1>
            </div>

            <Tabs
              defaultValue="class"
              value={mode}
              onValueChange={handleModeChange}
            >
              <TabsList className="grid h-11 w-full grid-cols-2 sm:w-auto sm:min-w-[360px]">
                <TabsTrigger value="class" className="gap-2">
                  <Users className="h-4 w-4" />
                  班级题目
                </TabsTrigger>
                <TabsTrigger value="ai" className="gap-2">
                  <WandSparkles className="h-4 w-4" />
                  AI 自主练习
                </TabsTrigger>
              </TabsList>

              <TabsContent value="class" className="mt-6">
                <ExercisePanel
                  currentQuestion={classQuestion}
                  isLoading={isClassLoading}
                  isSubmitting={isClassSubmitting}
                  submitPhase={classSubmitPhase}
                  submitResult={classSubmitResult}
                  solution={classSolution}
                  isLoadingSolution={isClassSolutionLoading}
                  solutionError={classSolutionError}
                  error={classError}
                  errorType={classErrorType}
                  errorSource={classErrorSource}
                  onNextQuestion={loadNextClassQuestion}
                  submitAnswer={submitClassAnswer}
                  onLoadSolution={loadClassSolution}
                />
              </TabsContent>

              <TabsContent value="ai" className="mt-6 space-y-6">
                <AIPracticeConfigurator
                  knowledgeOptions={knowledgeOptions}
                  selectedConceptId={selectedConceptId}
                  difficulty={difficulty}
                  questionType={questionType}
                  isLoadingKnowledge={isLoadingKnowledge}
                  isGenerating={isGenerating}
                  isSubmitting={isAISubmitting}
                  error={knowledgeError || (aiErrorSource === 'generation' ? aiError : null)}
                  hasQuestion={Boolean(aiQuestion)}
                  onConceptChange={setSelectedConceptId}
                  onDifficultyChange={setDifficulty}
                  onQuestionTypeChange={setQuestionType}
                  onGenerate={generateQuestion}
                  onRetryKnowledge={retryKnowledgeLoad}
                />
                {aiQuestion ? (
                  <ExercisePanel
                    currentQuestion={aiQuestion}
                    isLoading={isGenerating}
                    isSubmitting={isAISubmitting}
                    submitPhase={aiSubmitPhase}
                    submitResult={aiSubmitResult}
                    solution={aiSolution}
                    isLoadingSolution={isAISolutionLoading}
                    solutionError={aiSolutionError}
                    error={aiErrorSource === 'submission' ? aiError : null}
                    errorType={aiErrorSource === 'submission' ? aiErrorType : null}
                    errorSource={aiErrorSource === 'submission' ? aiErrorSource : null}
                    onNextQuestion={generateQuestion}
                    submitAnswer={submitAIAnswer}
                    onLoadSolution={loadAISolution}
                  />
                ) : null}
              </TabsContent>
            </Tabs>
          </div>

          <aside className="space-y-6 lg:col-span-4">
            <Card className="border-surface-200 dark:border-surface-700">
              <CardHeader className="border-b border-surface-100 dark:border-surface-800">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="flex min-w-0 items-center gap-2 text-lg">
                    {mode === 'class' ? (
                      <GraduationCap className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
                    ) : (
                      <Bot className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                    <span className="truncate">{activeTutor.title}</span>
                  </CardTitle>
                  <Badge variant={mode === 'class' ? 'default' : 'success'}>
                    {activeTutor.badge}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-5">
                <p className="text-sm leading-6 text-surface-600 dark:text-surface-400">
                  {activeTutor.description}
                </p>
                <Button
                  onClick={handleCallAITutor}
                  disabled={!activeQuestion}
                  className="w-full gap-2"
                >
                  <MessageCircle className="h-4 w-4" />
                  询问 AI 导师
                  <Sparkles className="h-4 w-4 opacity-75" />
                </Button>
                <p className="text-center text-xs text-surface-500 dark:text-surface-400">
                  {activeQuestion
                    ? `当前辅导：${activeQuestion.knowledgePointNames[0] || activeQuestion.title || '练习题'}`
                    : activeTutor.empty}
                </p>
              </CardContent>
            </Card>
            <DailyQuestionStatusEntry
              assignment={dailyAssignment}
              loading={isDailyStatusLoading}
              error={dailyStatusError}
            />
          </aside>
        </div>
      </div>
    </MainLayout>
  );
};
