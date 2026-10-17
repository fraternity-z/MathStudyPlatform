import { useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppSelector } from '@/store';
import { selectCurrentUser, selectIsAuthenticated } from '@/modules/auth/state';
import { useExerciseViewModel } from '../hooks/exerciseViewModel';
import { AIPracticeContext, type ExerciseMode } from '../hooks/aiPracticeContext';
import type { GenerateQuestionType } from '../services/exerciseService';
import type { ExerciseAnswerDraft } from './ExercisePanel';

const emptyAnswerDraft: ExerciseAnswerDraft = {
  answer: '',
  steps: '',
  answerImage: null,
  submittedWithImage: false,
  lastSubmission: null,
};

function AIPracticeSession({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ExerciseMode>('class');
  const { pathname } = useLocation();
  const exercise = useExerciseViewModel({ active: pathname === '/exercise' && mode === 'ai' });
  const classExercise = useExerciseViewModel({ active: pathname === '/exercise' && mode === 'class' });
  const [classDraft, setClassDraft] = useState<{ questionId: string; answer: ExerciseAnswerDraft } | null>(null);
  const [selectedConceptId, setSelectedConceptId] = useState('');
  const [difficulty, setDifficulty] = useState(0.5);
  const [questionType, setQuestionType] = useState<GenerateQuestionType>('multiple_choice');
  const [draft, setDraft] = useState<{ questionId: string; answer: ExerciseAnswerDraft } | null>(null);
  const autoStartedRequest = useRef<string | null>(null);
  const appliedConceptRequest = useRef<string | null>(null);
  const questionId = exercise.currentQuestion?.id;

  return (
    <AIPracticeContext.Provider value={{
      exercise,
      classExercise,
      classAnswerDraft: classDraft && classDraft.questionId === classExercise.currentQuestion?.id ? classDraft.answer : emptyAnswerDraft,
      setClassAnswerDraft: (answer) => {
        if (classExercise.currentQuestion) setClassDraft({ questionId: classExercise.currentQuestion.id, answer });
      },
      mode,
      setMode,
      selectedConceptId,
      setSelectedConceptId,
      difficulty,
      setDifficulty,
      questionType,
      setQuestionType,
      answerDraft: draft && draft.questionId === questionId ? draft.answer : emptyAnswerDraft,
      setAnswerDraft: (answer) => {
        if (questionId) setDraft({ questionId, answer });
      },
      autoStartedRequest,
      appliedConceptRequest,
    }}>
      {children}
    </AIPracticeContext.Provider>
  );
}

// Keep in-memory practice state above page routes, scoped to the authenticated student.
export function AIPracticeProvider({ children }: { children: ReactNode }) {
  const user = useAppSelector(selectCurrentUser);
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  if (!isAuthenticated || user?.role !== 'student') return <>{children}</>;
  return <AIPracticeSession key={user.id}>{children}</AIPracticeSession>;
}
