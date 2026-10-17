package exercise

import (
	"context"
	"strings"
	"time"

	mathsolverapp "mathstudy/backend/internal/application/mathsolver"
	"mathstudy/backend/internal/platform/metautil"
)

// MaxStudyTimeSeconds bounds a single exercise session, including across midnight.
const MaxStudyTimeSeconds = 2 * 60 * 60

// ProcessEvaluation is independent of the final answer's score. Old attempts
// remain unknown; an omitted process is never interpreted as an incorrect one.
type ProcessEvaluation struct {
	Status string `json:"status"`
	EvaluationDetail
}

func (p ProcessEvaluation) answerCheck() AnswerCheckResult {
	return AnswerCheckResult{
		Decision: mathsolverapp.Decision(p.Status), Method: p.Method,
		ReasonCode: p.ReasonCode, Reason: p.Reason, Confidence: p.Confidence,
		Evidence: p.Evidence,
	}
}

func (p ProcessEvaluation) permitsMastery() bool {
	return p.Status == "not_provided" || p.Status == string(mathsolverapp.DecisionCorrect)
}

func (p ProcessEvaluation) masteryWeight(weight float64, correct bool) float64 {
	if correct && !p.permitsMastery() {
		return 0
	}
	if !correct && p.Status == string(mathsolverapp.DecisionCorrect) {
		return min(weight, informalRedoMasteryWeight)
	}
	return weight
}

func (p ProcessEvaluation) feedback(fallback string, correct bool) string {
	switch p.Status {
	case string(mathsolverapp.DecisionIncorrect):
		if correct {
			return "最终答案正确，但解题过程存在错误，本次不增加掌握度。请检查步骤：" + p.Reason
		}
	case string(mathsolverapp.DecisionIndeterminate):
		if correct {
			return "最终答案正确，所提供的步骤暂时无法可靠评价，本次保留得分，暂不增加掌握度。"
		}
	case string(mathsolverapp.DecisionCorrect):
		if !correct {
			return "所提供的关键步骤成立，但最终答案不正确，请检查最后计算或选项。"
		}
	}
	return fallback
}

func (s *Service) evaluateAnswerSteps(ctx context.Context, exercise Exercise, answer, reference string, steps []string) ProcessEvaluation {
	filtered := make([]string, 0, len(steps))
	for _, step := range steps {
		if step = strings.TrimSpace(step); step != "" {
			filtered = append(filtered, step)
		}
	}
	steps = filtered
	if len(steps) == 0 {
		return ProcessEvaluation{Status: "not_provided"}
	}
	unknown := ProcessEvaluation{Status: string(mathsolverapp.DecisionIndeterminate), EvaluationDetail: EvaluationDetail{
		Method: "none", ReasonCode: "process_unavailable", Reason: "解题过程暂时无法可靠评价", Degraded: true, Retryable: true,
	}}
	verifier, ok := s.solutionSolver.(SolutionVerifier)
	if !ok {
		return unknown
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := verifier.VerifySolution(ctx, SolutionVerificationInput{
		Exercise: exercise, CandidateAnswer: answer, CandidateSteps: steps,
		ReferenceAnswer: reference, AnswerType: metautil.String(exercise.Meta, "answer_type"), StepsOnly: true,
	})
	if err != nil {
		return unknown
	}
	result = normalizeAnswerCheckResult(result)
	if result.Failure != nil || strings.TrimSpace(result.Reason) == "" || len(result.Evidence) == 0 {
		return unknown
	}
	return ProcessEvaluation{Status: string(result.Decision), EvaluationDetail: evaluationDetail(result)}
}

func submissionEvidenceKind(scheduled, repeated bool) string {
	if scheduled {
		return "scheduled_review"
	}
	if repeated {
		return "repeat_practice"
	}
	return "first_attempt"
}

// StartExercise establishes a server clock without recording an attempt or hint.
// Reopening the same unconsumed session is idempotent. Missing/expired clocks
// allow grading but contribute zero study time.
func (s *Service) StartExercise(ctx context.Context, userID string, request SubmitRequest) error {
	request.ExerciseID = strings.TrimSpace(request.ExerciseID)
	request.DailyAssignmentID = strings.TrimSpace(request.DailyAssignmentID)
	request.ReviewTaskID = strings.TrimSpace(request.ReviewTaskID)
	request.OriginalAttemptID = strings.TrimSpace(request.OriginalAttemptID)
	if request.ExerciseID == "" || len(request.ExerciseID) > 36 || len(request.DailyAssignmentID) > 36 ||
		len(request.ReviewTaskID) > 36 || len(request.OriginalAttemptID) > 36 ||
		(request.ReviewTaskID != "" && (request.ReviewTaskRevision == nil || request.OriginalAttemptID == "")) ||
		(request.ReviewTaskID == "" && request.OriginalAttemptID != "" && request.DailyAssignmentID != "") {
		return ErrBadRequest
	}
	return s.repo.WithTx(ctx, func(txCtx context.Context, repo Repository) error {
		if err := repo.LockStudentTracking(txCtx, userID); err != nil {
			return err
		}
		now := s.now().UTC()
		if _, _, err := submissionContext(txCtx, repo, userID, request, now); err != nil {
			return err
		}
		return repo.StartExerciseStudyTime(txCtx, userID, request.ExerciseID, now)
	})
}

func submissionContext(ctx context.Context, repo Repository, userID string, request SubmitRequest, now time.Time) (Exercise, string, error) {
	if request.ReviewTaskID != "" {
		task, ok, err := repo.GetMistakeReviewTask(ctx, userID, request.ReviewTaskID)
		if err != nil {
			return Exercise{}, "", err
		}
		if !ok || task.ContentID != request.ExerciseID || task.SourceAttemptID != request.OriginalAttemptID ||
			(request.DailyAssignmentID != "" && request.DailyAssignmentID != task.DailyAssignmentID) || request.ReviewTaskRevision == nil {
			return Exercise{}, "", ErrBadRequest
		}
		if _, err := classifyMistakeReviewSubmission(task, *request.ReviewTaskRevision, now); err != nil {
			return Exercise{}, "", err
		}
		answer := strings.TrimSpace(metautil.String(task.Exercise.Meta, "answer"))
		if answer == "" {
			return Exercise{}, "", ErrBadRequest
		}
		return task.Exercise, answer, nil
	}
	if request.OriginalAttemptID != "" {
		binding, ok, err := repo.GetMistakeRedoAttemptBinding(ctx, userID, request.OriginalAttemptID)
		if err != nil {
			return Exercise{}, "", err
		}
		return mistakeRedoSubmissionExerciseFromBinding(binding, ok, request.ExerciseID)
	}
	if request.DailyAssignmentID != "" {
		exercise, answer, _, err := dailySubmissionExercise(ctx, repo, userID, request.DailyAssignmentID, request.ExerciseID, false)
		return exercise, answer, err
	}
	return submissionExercise(ctx, repo, userID, request.ExerciseID)
}
