import { createContext, useContext, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { GenerateQuestionType } from '../services/exerciseService';
import type { useExerciseViewModel } from './exerciseViewModel';
import type { ExerciseAnswerDraft } from '../components/ExercisePanel';

export type ExerciseMode = 'class' | 'ai';

export interface AIPracticeContextValue {
  exercise: ReturnType<typeof useExerciseViewModel>;
  mode: ExerciseMode;
  setMode: Dispatch<SetStateAction<ExerciseMode>>;
  selectedConceptId: string;
  setSelectedConceptId: Dispatch<SetStateAction<string>>;
  difficulty: number;
  setDifficulty: Dispatch<SetStateAction<number>>;
  questionType: GenerateQuestionType;
  setQuestionType: Dispatch<SetStateAction<GenerateQuestionType>>;
  answerDraft: ExerciseAnswerDraft;
  setAnswerDraft: (draft: ExerciseAnswerDraft) => void;
  autoStartedRequest: RefObject<string | null>;
  appliedConceptRequest: RefObject<string | null>;
}

export const AIPracticeContext = createContext<AIPracticeContextValue | null>(null);

export function useAIPractice() {
  const context = useContext(AIPracticeContext);
  if (!context) throw new Error('AI practice requires AIPracticeProvider');
  return context;
}
