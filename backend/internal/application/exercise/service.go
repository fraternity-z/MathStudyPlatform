package exercise

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"reflect"
	"slices"
	"sort"
	"strings"
	"time"

	answerocrapp "mathstudy/backend/internal/application/answerocr"
	mathsolverapp "mathstudy/backend/internal/application/mathsolver"
	"mathstudy/backend/internal/platform/maputil"
	"mathstudy/backend/internal/platform/metautil"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/ptrutil"
	"mathstudy/backend/internal/platform/questiondedupe"
	"mathstudy/backend/internal/platform/sliceutil"
	"mathstudy/backend/internal/platform/stringutil"
)

// Public exercise errors mapped by the HTTP layer.
var (
	ErrNotFound                = errors.New("exercise not found")
	ErrForbidden               = errors.New("student is not enrolled")
	ErrBadRequest              = errors.New("bad exercise request")
	ErrOCRUnavailable          = errors.New("image answer OCR is unavailable")
	ErrOCRUnreadable           = errors.New("image answer OCR could not read a reliable answer")
	ErrOCRTimeout              = errors.New("image answer OCR timed out")
	ErrAnswerParseFailed       = errors.New("answer could not be parsed safely")
	ErrMathUnsupported         = errors.New("answer type is unsupported by the math solver")
	ErrMathSolverUnavailable   = errors.New("math solver is unavailable")
	ErrMathSolverTimeout       = errors.New("math solver timed out")
	ErrMathSolverInvalidResult = errors.New("math solver returned an invalid result")
	ErrExerciseChanged         = errors.New("exercise changed while grading")
	ErrAIGenerationUnavailable = errors.New("AI exercise generation is unavailable")
	ErrAIGenerationTimeout     = errors.New("AI exercise generation timed out")
	ErrGeneratedContentInvalid = errors.New("generated exercise content is invalid")
	ErrDailyAssignmentInvalid  = errors.New("daily question assignment is invalid")
	ErrDailyAssignmentClosed   = errors.New("daily question assignment no longer accepts linked attempts")
	ErrReviewTaskStale         = errors.New("mistake review task changed")
	ErrReviewNotDue            = errors.New("mistake review is not due")
	ErrMistakeRecordArchived   = errors.New("mistake record was archived")
	ErrSubmissionConflict      = errors.New("submission id was reused with a different payload")
)

const (
	ExerciseSourceClass        = "class"
	ExerciseSourceAIGenerated  = "ai_generated"
	QuestionTypeMultipleChoice = "multiple_choice"
	QuestionTypeShortAnswer    = "short_answer"
	QuestionBlankMarker        = "＿＿＿＿"
	fullMasteryWeight          = 1.0
	informalRedoMasteryWeight  = 0.35
)

// Repository is the persistence surface required by exercise use cases.
type Repository interface {
	WithTx(context.Context, func(context.Context, Repository) error) error
	LockStudentTracking(context.Context, string) error
	GetTeacherIDForStudent(context.Context, string) (string, bool, error)
	GetLatestSession(context.Context, string) (LearningSession, bool, error)
	CreateSession(context.Context, string, time.Time) (LearningSession, error)
	UpdateSessionCurrentContent(context.Context, string, *string) error
	UpdateSessionAfterSubmit(context.Context, string, string, []string) error
	GetExercise(context.Context, string) (Exercise, bool, error)
	GetExerciseForUpdate(context.Context, string) (Exercise, bool, error)
	GetKnowledgeConcept(context.Context, string) (KnowledgeConcept, bool, error)
	CreateGeneratedExercise(context.Context, string, GeneratedQuestion, time.Time) (Exercise, error)
	ListRecentContentIDs(context.Context, string, int) ([]string, error)
	ListCandidateExercises(context.Context, CandidateFilter) ([]Exercise, error)
	GetProfile(context.Context, string) (StudentProfile, bool, error)
	CreateProfile(context.Context, string, time.Time) (StudentProfile, error)
	HasSubmittedAttempt(context.Context, string, string) (bool, error)
	ListDKTStates(context.Context, string, []string) (map[string]DKTState, error)
	ListRecentInteractions(context.Context, string, string, int) ([]LearningInteraction, error)
	InsertAttempt(context.Context, AttemptRecord) error
	InsertDiagnosis(context.Context, DiagnosisRecord) error
	UpsertDKTStates(context.Context, []DKTState) error
	UpdateProfileTracking(context.Context, string, ProfileTrackingUpdate) error
	GetDailyAssignment(context.Context, string, string) (DailyAssignmentBinding, bool, error)
	GetDailyAssignmentForUpdate(context.Context, string, string) (DailyAssignmentBinding, bool, error)
	GetDailySubmissionResponse(context.Context, string, string, string) (SubmitResponse, bool, error)
	GetRegularSubmissionResponse(context.Context, string, string, string) (SubmitResponse, bool, error)
	HasReadyDailyAssignmentContent(context.Context, string, string) (bool, error)
	ApplyDailyAttempt(context.Context, DailyAttemptUpdate) error
	SaveDailySubmissionResponse(context.Context, string, string, string, SubmitResponse) error
	SaveRegularSubmissionResponse(context.Context, string, string, string, string, SubmitResponse) error
	GetMistakeReviewTask(context.Context, string, string) (MistakeReviewTask, bool, error)
	GetMistakeReviewTaskForUpdate(context.Context, string, string) (MistakeReviewTask, bool, error)
	GetMistakeReviewTaskByContentForUpdate(context.Context, string, string) (MistakeReviewTask, bool, error)
	CountIncorrectAttempts(context.Context, string, string) (int, error)
	InsertMistakeReviewTask(context.Context, MistakeReviewTask) error
	UpdateMistakeReviewTask(context.Context, MistakeReviewTask) error
	GetReviewSubmissionResponse(context.Context, string, string, string, string) (SubmitResponse, bool, error)
	SaveReviewSubmissionResponse(context.Context, string, string, string, string, SubmitResponse) error
	GetMistakeRedoSubmissionResponse(context.Context, string, string, string, string) (SubmitResponse, bool, error)
	SaveMistakeRedoSubmissionResponse(context.Context, string, string, string, string, SubmitResponse) error
	GetMistakeRedoAttemptBinding(context.Context, string, string) (MistakeRedoAttemptBinding, bool, error)
}

// AnswerChecker compares student and correct answers.
type AnswerChecker interface {
	CheckAnswer(context.Context, string, string, string) (AnswerCheckResult, error)
}

// ContextualAnswerChecker compares answers with the complete trusted exercise context.
type ContextualAnswerChecker interface {
	CheckExerciseAnswer(context.Context, AnswerCheckInput) (AnswerCheckResult, error)
}

// AnswerOCR recognizes an answer from one previously uploaded image.
type AnswerOCR interface {
	Recognize(context.Context, string, string) (answerocrapp.Result, error)
}

// SolutionSolver independently solves an exercise when no trusted cached steps exist.
type SolutionSolver interface {
	Solve(context.Context, SolutionInput) (SolutionResult, error)
}

// SolutionVerifier independently checks a generated answer and every returned step.
type SolutionVerifier interface {
	VerifySolution(context.Context, SolutionVerificationInput) (AnswerCheckResult, error)
}

// LearningSession stores the minimal session state used by exercise flow.
type LearningSession struct {
	ID                string
	StudentID         string
	CurrentContentID  *string
	ContentsAttempted []string
}

// Exercise stores problem content.
type Exercise struct {
	ID                   string
	OwnerTeacherID       string
	GeneratedByStudentID string
	Status               string
	Title                string
	Body                 string
	Difficulty           float64
	ConceptIDs           []string
	Meta                 map[string]any
}

// KnowledgeConcept stores trusted knowledge-node context for AI generation.
type KnowledgeConcept struct {
	ID          string
	Name        string
	Description string
	Chapter     string
}

// StudentProfile stores tracking data updated after attempts.
type StudentProfile struct {
	MasteryVector       map[string]float64
	ErrorTendency       map[string]float64
	PreferredDifficulty float64
	LearningPace        float64
	TotalExercises      int
	CorrectCount        int
}

// CandidateFilter stores exercise selection filters.
type CandidateFilter struct {
	StudentID      string
	TeacherID      string
	DifficultyMin  float64
	DifficultyMax  float64
	ExcludeContent []string
	Limit          int
}

// DKTState stores one student-concept DKT state.
type DKTState struct {
	ID              string
	StudentID       string
	ConceptID       string
	MasteryProb     float64
	Confidence      float64
	AttemptCount    int
	CorrectCount    int
	IncorrectCount  int
	SequenceLength  int
	AttentionWeight float64
	LastOutcome     *bool
	LastExerciseID  *string
	LastAttemptAt   *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// LearningInteraction stores one historical input event for DKT sequence updates.
type LearningInteraction struct {
	AttemptID     string
	ExerciseID    string
	ConceptIDs    []string
	IsCorrect     bool
	Difficulty    float64
	MasteryWeight float64
	SubmittedAt   time.Time
}

// AttemptRecord stores data inserted into content_attempts.
type AttemptRecord struct {
	ID                      string
	ContentID               string
	StudentID               string
	DailyAssignmentID       string
	DailySubmissionKey      string
	ReviewTaskID            string
	ReviewSubmissionKey     string
	ReviewSubmissionDigest  string
	RedoOriginalAttemptID   string
	RedoSubmissionKey       string
	RedoSubmissionDigest    string
	RegularSubmissionKey    string
	RegularSubmissionDigest string
	QuestionSnapshot        *Exercise
	MasteryWeight           float64
	StudentAnswer           string
	StudentSteps            []string
	IsCorrect               bool
	Score                   float64
	StartedAt               time.Time
	SubmittedAt             time.Time
	TimeSpentSeconds        int
}

// DailyAssignmentBinding carries the immutable question snapshot bound to a daily task.
type DailyAssignmentBinding struct {
	ID                 string
	StudentID          string
	AssignmentDate     string
	ContentID          string
	Status             string
	FirstAttemptID     string
	FirstResult        string
	CorrectedAttemptID string
	Question           *Exercise
}

// DailyAttemptUpdate atomically attaches one recorded attempt to its daily assignment.
type DailyAttemptUpdate struct {
	AssignmentID string
	StudentID    string
	ContentID    string
	AttemptID    string
	IsCorrect    bool
	SubmittedAt  time.Time
	OnTime       bool
}

// DiagnosisRecord stores data inserted into diagnosis_reports.
type DiagnosisRecord struct {
	ID             string
	AttemptID      string
	ErrorType      *string
	ErrorSubtype   string
	Severity       string
	RelatedConcept []string
	Explanation    string
	Suggestion     string
	CreatedAt      time.Time
}

// ProfileTrackingUpdate stores profile updates after one attempt.
type ProfileTrackingUpdate struct {
	MasteryVector  map[string]float64
	ErrorTendency  map[string]float64
	TotalExercises int
	CorrectCount   int
	UpdatedAt      time.Time
}

// NextQuery stores /exercise/next query params.
type NextQuery struct {
	ConceptID  string
	Difficulty *float64
}

// SubmitRequest stores /exercise/submit request data.
type SubmitRequest struct {
	ExerciseID         string
	DailyAssignmentID  string
	ReviewTaskID       string
	ReviewTaskRevision *int64
	OriginalAttemptID  string
	SubmissionID       string
	AnswerText         string
	AnswerImageURL     string
	AnswerSteps        []string
	TimeSpentSeconds   int
}

// MistakeRedoAttemptBinding keeps an exact redo page bound to its original error evidence.
type MistakeRedoAttemptBinding struct {
	ContentID             string
	RedoOriginalAttemptID string
	IsCorrect             bool
	IsSubmitted           bool
	HasDiagnosis          bool
	IsArchived            bool
	Exercise              Exercise
}

// GenerateExerciseRequest stores a student's AI self-practice selection.
type GenerateExerciseRequest struct {
	ConceptID           string
	Difficulty          float64
	QuestionType        string
	AvoidQuestionBodies []string // Trusted internal history only; HTTP callers cannot populate this field.
}

// GenerationInput carries trusted knowledge context into the question generator.
type GenerationInput struct {
	Concept             KnowledgeConcept
	Difficulty          float64
	QuestionType        string
	AvoidQuestionBodies []string // Trusted internal exercise history; adapters must bound prompt use.
	Feedback            string   // 首次生成为空；重试时携带上次验证失败原因
}

// GeneratedQuestion stores a validated, persistable AI exercise candidate.
type GeneratedQuestion struct {
	Title                string
	Body                 string
	Type                 string
	Difficulty           float64
	Answer               string
	AnswerType           string
	Options              []string
	Hints                []string
	SolutionSteps        []string
	EstimatedTimeSeconds int
	ConceptIDs           []string
	KnowledgePointNames  []string
}

// QuestionGenerator creates structured self-practice questions.
type QuestionGenerator interface {
	GenerateQuestion(context.Context, GenerationInput) (GeneratedQuestion, error)
}

// verifiedGenerated 承载独立求解验证通过的产物。
type verifiedGenerated struct {
	Answer     string   // 经验证的标准答案；四选一映射为选项文本
	Steps      []string // solver 独立生成、经步骤验证的解析
	MathAnswer string   // solver 返回的数学表达式
}

type generatedContentError struct {
	message string
}

func (e generatedContentError) Error() string { return e.message }

func generatedContentInvalid(message string) error {
	return generatedContentError{message: message}
}

func isGeneratedContentError(err error) bool {
	var contentErr generatedContentError
	return errors.As(err, &contentErr)
}

func normalizeGenerationSolverError(err error) error {
	switch {
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrMathSolverTimeout):
		return ErrMathSolverTimeout
	case errors.Is(err, ErrMathSolverInvalidResult):
		return ErrMathSolverInvalidResult
	default:
		return ErrMathSolverUnavailable
	}
}

func normalizeQuestionGenerationError(err error) error {
	switch {
	case errors.Is(err, context.Canceled):
		return context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		return ErrAIGenerationTimeout
	default:
		return ErrAIGenerationUnavailable
	}
}

// ExerciseResponse is the Python-compatible exercise summary response.
type ExerciseResponse struct {
	ID                   string   `json:"id"`
	Title                string   `json:"title"`
	Content              string   `json:"content"`
	Difficulty           float64  `json:"difficulty"`
	Type                 string   `json:"type"`
	Source               string   `json:"source"`
	KnowledgePoints      []string `json:"knowledge_points"`
	KnowledgePointNames  []string `json:"knowledge_point_names"`
	HintsAvailable       bool     `json:"hints_available"`
	EstimatedTimeSeconds int      `json:"estimated_time_seconds"`
	Options              []string `json:"options"`
}

// ExerciseDetailResponse is the Python-compatible exercise detail response.
type ExerciseDetailResponse struct {
	ID                  string   `json:"id"`
	Title               string   `json:"title"`
	Content             string   `json:"content"`
	Difficulty          float64  `json:"difficulty"`
	Type                string   `json:"type"`
	Source              string   `json:"source"`
	KnowledgePoints     []string `json:"knowledge_points"`
	KnowledgePointNames []string `json:"knowledge_point_names"`
	Hints               []string `json:"hints"`
	Options             []string `json:"options"`
}

// SolutionResponse is the Python-compatible solution response.
type SolutionResponse struct {
	ExerciseID   string                 `json:"exercise_id"`
	Answer       string                 `json:"answer"`
	Steps        []string               `json:"steps"`
	Source       string                 `json:"source"`
	Verification *EvaluationDetail      `json:"verification,omitempty"`
	Failure      *mathsolverapp.Failure `json:"failure,omitempty"`
}

// SubmitResponse is the Python-compatible answer submission response.
type SubmitResponse struct {
	AttemptID          string             `json:"attempt_id,omitempty"`
	IsCorrect          bool               `json:"is_correct"`
	GradingStatus      string             `json:"grading_status"`
	Recorded           bool               `json:"recorded"`
	Score              float64            `json:"score"`
	StudentAnswerLatex string             `json:"student_answer_latex"`
	CorrectAnswerLatex string             `json:"correct_answer_latex"`
	Diagnosis          *DiagnosisDetail   `json:"diagnosis"`
	Evaluation         EvaluationDetail   `json:"evaluation"`
	Feedback           string             `json:"feedback"`
	MasteryUpdate      map[string]float64 `json:"mastery_update"`
	MasteryModel       string             `json:"mastery_model"`
	NextRecommendation string             `json:"next_recommendation"`
	MasteryWeight      float64            `json:"mastery_weight"`
	ReviewTaskRevision *int64             `json:"review_task_revision,omitempty"`
}

// EvaluationDetail explains how an answer was graded without exposing provider internals.
type EvaluationDetail struct {
	Method     string                   `json:"method"`
	ReasonCode string                   `json:"reason_code"`
	Reason     string                   `json:"reason"`
	Confidence float64                  `json:"confidence"`
	Degraded   bool                     `json:"degraded"`
	Retryable  bool                     `json:"retryable"`
	Evidence   []mathsolverapp.Evidence `json:"evidence"`
}

// DiagnosisDetail stores lightweight diagnostic feedback.
type DiagnosisDetail struct {
	ErrorType        *string  `json:"error_type"`
	ErrorSubtype     string   `json:"error_subtype,omitempty"`
	TaxonomyCode     string   `json:"taxonomy_code,omitempty"`
	ErrorDescription string   `json:"error_description"`
	ErrorStepIndex   *int     `json:"error_step_index"`
	Severity         string   `json:"severity"`
	Suggestion       string   `json:"suggestion"`
	RelatedConcepts  []string `json:"related_concepts"`
}

// AnswerCheckResult stores answer comparison output.
type AnswerCheckResult struct {
	IsCorrect  bool
	Decision   mathsolverapp.Decision
	Method     string
	ReasonCode string
	Reason     string
	Confidence float64
	Degraded   bool
	Retryable  bool
	Evidence   []mathsolverapp.Evidence
	Failure    *mathsolverapp.Failure
}

// MathSolver compares answers with an optional AI/math runtime.
type MathSolver interface {
	CheckAnswer(context.Context, AnswerCheckInput) (AnswerCheckResult, error)
}

// AnswerCheckInput carries answer comparison context into an optional solver.
type AnswerCheckInput struct {
	Exercise      Exercise
	StudentAnswer string
	CorrectAnswer string
	AnswerType    string
	Fallback      AnswerCheckResult
}

const (
	SolutionStatusSolved        = "solved"
	SolutionStatusIndeterminate = "indeterminate"
)

// SolutionInput carries the trusted problem context into an independent solver.
// The standard answer is intentionally omitted and is used only for verification.
type SolutionInput struct {
	Exercise   Exercise
	AnswerType string
}

// SolutionResult stores one bounded, explainable solver candidate.
type SolutionResult struct {
	Status     string
	Answer     string
	Steps      []string
	Method     string
	ReasonCode string
	Reason     string
	Confidence float64
	Retryable  bool
	Evidence   []mathsolverapp.Evidence
}

// SolutionVerificationInput carries a generated solution and the trusted reference answer
// into a separate verification pass. Generation never receives ReferenceAnswer.
type SolutionVerificationInput struct {
	Exercise        Exercise
	CandidateAnswer string
	CandidateSteps  []string
	ReferenceAnswer string
	AnswerType      string
}

// SolverAnswerChecker tries a configured solver before falling back to local comparison.
type SolverAnswerChecker struct {
	Solver   MathSolver
	Fallback AnswerChecker
}

// DiagnosisInput carries answer context into an optional AI diagnostician.
type DiagnosisInput struct {
	Exercise      Exercise
	StudentID     string
	StudentAnswer string
	AnswerSteps   []string
	CorrectAnswer string
	Check         AnswerCheckResult
	Fallback      DiagnosisDetail
}

// Diagnostician generates structured diagnosis for incorrect attempts.
type Diagnostician interface {
	Diagnose(context.Context, DiagnosisInput) (DiagnosisDetail, error)
}

// Service implements adaptive exercise use cases.
type Service struct {
	repo              Repository
	checker           AnswerChecker
	answerOCR         AnswerOCR
	solutionSolver    SolutionSolver
	diagnostician     Diagnostician
	questionGenerator QuestionGenerator
	now               func() time.Time
	newID             func() (string, error)
}

// Option customizes the exercise service.
type Option func(*Service)

// WithDiagnostician enables AI-backed diagnosis with deterministic fallback.
func WithDiagnostician(diagnostician Diagnostician) Option {
	return func(service *Service) {
		service.diagnostician = diagnostician
	}
}

// WithAnswerOCR enables image-only answer recognition before grading starts.
func WithAnswerOCR(answerOCR AnswerOCR) Option {
	return func(service *Service) {
		service.answerOCR = answerOCR
	}
}

// WithSolutionSolver enables independently generated, standard-answer-verified solutions.
func WithSolutionSolver(solver SolutionSolver) Option {
	return func(service *Service) {
		service.solutionSolver = solver
	}
}

// WithQuestionGenerator enables AI-backed student self-practice generation.
func WithQuestionGenerator(generator QuestionGenerator) Option {
	return func(service *Service) {
		service.questionGenerator = generator
	}
}

// NewService creates an exercise service.
func NewService(repo Repository, checker AnswerChecker, options ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("exercise repository is nil")
	}
	if checker == nil {
		checker = NormalizedAnswerChecker{}
	}
	service := &Service{
		repo:    repo,
		checker: checker,
		now:     time.Now,
		newID:   NewUUID,
	}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// GetNextExercise returns the current pending exercise or selects a new one.
func (s *Service) GetNextExercise(ctx context.Context, userID string, query NextQuery) (*ExerciseResponse, error) {
	session, err := s.getOrCreateSession(ctx, userID)
	if err != nil {
		return nil, err
	}
	if session.CurrentContentID != nil {
		current, ok, err := s.repo.GetExercise(ctx, *session.CurrentContentID)
		if err != nil {
			return nil, err
		}
		if ok && current.Status == "PUBLISHED" && current.GeneratedByStudentID == "" {
			assigned, assignmentErr := s.repo.HasReadyDailyAssignmentContent(ctx, userID, current.ID)
			if assignmentErr != nil {
				return nil, assignmentErr
			}
			if !assigned {
				canAccess, accessErr := canAccessExercise(ctx, s.repo, userID, current)
				if accessErr != nil && !errors.Is(accessErr, ErrForbidden) {
					return nil, accessErr
				}
				if canAccess {
					return toExerciseResponse(current), nil
				}
			}
		}
		if err := s.repo.UpdateSessionCurrentContent(ctx, session.ID, nil); err != nil {
			return nil, err
		}
		session.CurrentContentID = nil
	}

	teacherID, ok, err := s.repo.GetTeacherIDForStudent(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrForbidden
	}
	profile, _, err := s.repo.GetProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	targetConcept, targetDifficulty := chooseTarget(query, profile.MasteryVector)
	recentIDs, err := s.repo.ListRecentContentIDs(ctx, userID, 20)
	if err != nil {
		return nil, err
	}

	candidates, err := s.repo.ListCandidateExercises(ctx, CandidateFilter{
		StudentID:      userID,
		TeacherID:      teacherID,
		DifficultyMin:  math.Max(0, targetDifficulty-0.15),
		DifficultyMax:  math.Min(1, targetDifficulty+0.15),
		ExcludeContent: recentIDs,
		Limit:          20,
	})
	if err != nil {
		return nil, err
	}
	candidates = preferConcept(candidates, targetConcept)
	if len(candidates) == 0 {
		candidates, err = s.repo.ListCandidateExercises(ctx, CandidateFilter{
			StudentID:      userID,
			TeacherID:      teacherID,
			DifficultyMin:  0,
			DifficultyMax:  1,
			ExcludeContent: recentIDs,
			Limit:          10,
		})
		if err != nil {
			return nil, err
		}
		candidates = preferConcept(candidates, targetConcept)
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	selected := selectExercise(candidates)
	currentID := selected.ID
	if err := s.repo.UpdateSessionCurrentContent(ctx, session.ID, &currentID); err != nil {
		return nil, err
	}
	return toExerciseResponse(selected), nil
}

// verifyGenerated 对 LLM 生成的题目做独立求解与双重验证。
// 逻辑与 GetSolution 验证段（lines 999-1089）一一对应，最大化复用已有辅助函数。
func (s *Service) verifyGenerated(ctx context.Context, studentID string, generated GeneratedQuestion) (verifiedGenerated, error) {
	if s.solutionSolver == nil {
		return verifiedGenerated{}, ErrMathSolverUnavailable
	}

	// 构造临时 Exercise，Meta 需含判题所需键
	// （deterministicMultipleChoiceCheck 依赖 meta.type / meta.options）
	meta := map[string]any{
		"type":                   generated.Type,
		"options":                append([]string(nil), generated.Options...),
		"answer":                 generated.Answer,
		"answer_type":            generated.AnswerType,
		"estimated_time_seconds": generated.EstimatedTimeSeconds,
	}
	exercise := Exercise{
		GeneratedByStudentID: studentID,
		Title:                generated.Title,
		Body:                 generated.Body,
		Difficulty:           generated.Difficulty,
		ConceptIDs:           append([]string(nil), generated.ConceptIDs...),
		Meta:                 meta,
	}

	// 克隆 Meta 并删除答案/解析，避免求解器偷看答案（同 GetSolution:1000-1002）
	solverExercise := exercise
	solverExercise.Meta = maps.Clone(meta)
	delete(solverExercise.Meta, "answer")
	delete(solverExercise.Meta, "solution_steps")

	// 独立求解
	candidate, err := s.solutionSolver.Solve(ctx, SolutionInput{
		Exercise:   solverExercise,
		AnswerType: metautil.String(meta, "answer_type"),
	})
	if err != nil {
		return verifiedGenerated{}, normalizeGenerationSolverError(err)
	}

	// 结构/范围校验（confidence、字段长度等）
	candidate, ok := normalizeSolutionResult(candidate)
	if !ok {
		return verifiedGenerated{}, ErrMathSolverInvalidResult
	}
	// indeterminate → 失败（同 GetSolution:1019）
	if candidate.Status == SolutionStatusIndeterminate {
		return verifiedGenerated{}, generatedContentInvalid(fmt.Sprintf("独立求解无法确定结果：%s", candidate.Reason))
	}

	// 答案交叉验证：solver 数学答案 vs LLM 所标答案
	// 四选一内部会走 deterministicMultipleChoiceCheck，把 solver 数学答案
	// 映射到选项再与 LLM 选项比对（service.go:1173/1369）
	candidate.Answer = normalizeSolutionChoiceAnswer(exercise, candidate.Answer)
	answerVerification, err := s.verifySolutionAnswer(ctx, exercise, candidate.Answer, generated.Answer)
	if err != nil {
		return verifiedGenerated{}, normalizeGenerationSolverError(err)
	}
	answerVerification = normalizeAnswerCheckResult(answerVerification)
	if answerVerification.Decision != mathsolverapp.DecisionCorrect {
		return verifiedGenerated{}, generatedContentInvalid("独立求解结果与所标答案不一致")
	}

	// 步骤独立验证（SolutionVerifier 接口）
	verifier, ok := s.solutionSolver.(SolutionVerifier)
	if !ok {
		return verifiedGenerated{}, ErrMathSolverUnavailable
	}
	verification, err := verifier.VerifySolution(ctx, SolutionVerificationInput{
		Exercise:        solverExercise,
		CandidateAnswer: candidate.Answer,
		CandidateSteps:  append([]string(nil), candidate.Steps...),
		ReferenceAnswer: generated.Answer,
		AnswerType:      metautil.String(meta, "answer_type"),
	})
	if err != nil {
		return verifiedGenerated{}, normalizeGenerationSolverError(err)
	}
	verification = normalizeAnswerCheckResult(verification)
	if verification.Decision != mathsolverapp.DecisionCorrect {
		return verifiedGenerated{}, generatedContentInvalid("生成解析的推导步骤未通过独立验证")
	}

	// 把 solver 数学答案映射回选项文本，作为经验证的标准答案
	// 复用 matchingOption / optionFromLabel，与 normalizeGeneratedQuestion 同策略
	verifiedAnswer := generated.Answer
	if option, ok := matchingOption(generated.Options, candidate.Answer); ok {
		verifiedAnswer = option
	} else if option, ok := optionFromLabel(generated.Options, candidate.Answer); ok {
		verifiedAnswer = option
	}

	return verifiedGenerated{
		Answer:     verifiedAnswer,
		Steps:      append([]string(nil), candidate.Steps...),
		MathAnswer: candidate.Answer,
	}, nil
}

// GenerateExercise creates and persists one student-owned AI self-practice question.
func (s *Service) GenerateExercise(ctx context.Context, userID string, request GenerateExerciseRequest) (*ExerciseResponse, error) {
	request.ConceptID = strings.TrimSpace(request.ConceptID)
	request.QuestionType = strings.ToLower(strings.TrimSpace(request.QuestionType))
	if request.QuestionType == "" {
		request.QuestionType = QuestionTypeMultipleChoice
	}
	if request.ConceptID == "" || len(request.ConceptID) > 36 ||
		(request.QuestionType != QuestionTypeMultipleChoice && request.QuestionType != QuestionTypeShortAnswer) ||
		math.IsNaN(request.Difficulty) || math.IsInf(request.Difficulty, 0) || request.Difficulty < 0 || request.Difficulty > 1 {
		return nil, ErrBadRequest
	}
	if s.questionGenerator == nil {
		return nil, ErrAIGenerationUnavailable
	}
	concept, ok, err := s.repo.GetKnowledgeConcept(ctx, request.ConceptID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrNotFound
	}
	maxAttempts := 2
	if len(request.AvoidQuestionBodies) > 0 {
		maxAttempts = 3
	}
	var verified verifiedGenerated
	var lastVerifyErr error
	var generated GeneratedQuestion

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		feedback := ""
		if attempt > 1 {
			feedback = lastVerifyErr.Error()
		}

		generated, err = s.questionGenerator.GenerateQuestion(ctx, GenerationInput{
			Concept:             concept,
			Difficulty:          request.Difficulty,
			QuestionType:        request.QuestionType,
			AvoidQuestionBodies: request.AvoidQuestionBodies,
			Feedback:            feedback,
		})
		if err != nil {
			if errors.Is(err, ErrGeneratedContentInvalid) {
				lastVerifyErr = generatedContentInvalid("生成题目 JSON 或格式不符合要求")
				if attempt == maxAttempts {
					return nil, ErrAIGenerationUnavailable
				}
				continue
			}
			return nil, normalizeQuestionGenerationError(err)
		}

		generated.Difficulty = request.Difficulty
		generated.ConceptIDs = []string{concept.ID}
		generated.KnowledgePointNames = []string{concept.Name}
		generated = normalizeGeneratedQuestion(generated)
		if generated.Type != request.QuestionType || !validGeneratedQuestion(generated) {
			lastVerifyErr = generatedContentInvalid("生成题目格式或内容不符合要求")
			if attempt == maxAttempts {
				return nil, ErrAIGenerationUnavailable
			}
			continue
		}
		if questiondedupe.IsDuplicate(generated.Body, request.AvoidQuestionBodies) {
			lastVerifyErr = generatedContentInvalid("生成题目与学生历史题目重复，请更换题目条件、数值或问法")
			if attempt == maxAttempts {
				return nil, ErrAIGenerationUnavailable
			}
			continue
		}

		// solver 未配置：直接失败，不重试（重试无意义）
		if s.solutionSolver == nil {
			return nil, ErrMathSolverUnavailable
		}
		verified, lastVerifyErr = s.verifyGenerated(ctx, userID, generated)
		if lastVerifyErr == nil {
			break // 验证通过
		}
		if !isGeneratedContentError(lastVerifyErr) {
			return nil, lastVerifyErr
		}
		if attempt == maxAttempts {
			return nil, ErrAIGenerationUnavailable // 二次失败，不落库
		}
		// 否则带 lastVerifyErr 进入下一轮重试
	}

	// 用验证结果覆盖（落库前）
	generated.Answer = verified.Answer
	generated.SolutionSteps = verified.Steps

	exercise, err := s.repo.CreateGeneratedExercise(ctx, userID, generated, s.now())
	if err != nil {
		return nil, err
	}
	return toExerciseResponse(exercise), nil
}

// PreflightSubmit returns a committed idempotent response before the HTTP layer
// consumes AI concurrency or OCR rate-limit capacity.
func (s *Service) PreflightSubmit(ctx context.Context, userID string, request SubmitRequest) (SubmitResponse, bool, error) {
	request, err := normalizeSubmitRequest(request)
	if err != nil {
		return SubmitResponse{}, false, err
	}
	return getSubmissionResponse(ctx, s.repo, userID, request)
}

// SubmitAnswer records an answer, performs lightweight grading, and updates tracking state.
func (s *Service) SubmitAnswer(ctx context.Context, userID string, request SubmitRequest) (SubmitResponse, error) {
	request, err := normalizeSubmitRequest(request)
	if err != nil {
		return SubmitResponse{}, err
	}
	cached, found, err := getSubmissionResponse(ctx, s.repo, userID, request)
	if err != nil {
		return SubmitResponse{}, err
	}
	if found {
		return cached, nil
	}

	dailySubmissionKey := ""
	reviewSubmissionKey := ""
	reviewSubmissionDigest := ""
	redoSubmissionKey := ""
	redoSubmissionDigest := ""
	regularSubmissionKey := ""
	regularSubmissionDigest := ""
	if request.ReviewTaskID != "" {
		reviewSubmissionKey = makeReviewSubmissionKey(request)
		reviewSubmissionDigest = makeReviewSubmissionDigest(request)
	} else if request.OriginalAttemptID != "" {
		redoSubmissionKey = makeMistakeRedoSubmissionKey(request)
		redoSubmissionDigest = makeMistakeRedoSubmissionDigest(request)
	} else if request.DailyAssignmentID != "" {
		dailySubmissionKey = makeDailySubmissionKey(request)
	} else {
		regularSubmissionKey = makeRegularSubmissionKey(request)
		regularSubmissionDigest = makeRegularSubmissionDigest(request)
	}

	var exercise Exercise
	var correctAnswer string
	if request.ReviewTaskID != "" {
		var task MistakeReviewTask
		var ok bool
		task, ok, err = s.repo.GetMistakeReviewTask(ctx, userID, request.ReviewTaskID)
		if err == nil && (!ok || task.ContentID != request.ExerciseID) {
			err = ErrBadRequest
		}
		if err == nil && request.DailyAssignmentID != "" && request.DailyAssignmentID != task.DailyAssignmentID {
			err = ErrBadRequest
		}
		if err == nil && task.SourceAttemptID != request.OriginalAttemptID {
			err = ErrBadRequest
		}
		if err == nil {
			_, err = classifyMistakeReviewSubmission(task, *request.ReviewTaskRevision, s.now().UTC())
		}
		if err == nil {
			exercise = task.Exercise
			correctAnswer = strings.TrimSpace(metautil.String(exercise.Meta, "answer"))
			if correctAnswer == "" {
				err = ErrBadRequest
			}
		}
	} else if request.OriginalAttemptID != "" {
		var binding MistakeRedoAttemptBinding
		var ok bool
		binding, ok, err = s.repo.GetMistakeRedoAttemptBinding(ctx, userID, request.OriginalAttemptID)
		if err == nil {
			exercise, correctAnswer, err = mistakeRedoSubmissionExerciseFromBinding(binding, ok, request.ExerciseID)
		}
	} else if request.DailyAssignmentID == "" {
		exercise, correctAnswer, err = submissionExercise(ctx, s.repo, userID, request.ExerciseID)
	} else {
		exercise, correctAnswer, _, err = dailySubmissionExercise(
			ctx,
			s.repo,
			userID,
			request.DailyAssignmentID,
			request.ExerciseID,
			false,
		)
	}
	if err != nil {
		return SubmitResponse{}, err
	}
	if invalidReference, invalid := invalidMultipleChoiceReferenceCheck(exercise, correctAnswer); invalid {
		return SubmitResponse{}, answerCheckFailure(invalidReference)
	}
	answerType := metautil.String(exercise.Meta, "answer_type")
	studentAnswer := request.AnswerText
	if studentAnswer == "" {
		if s.answerOCR == nil {
			return SubmitResponse{}, ErrOCRUnavailable
		}
		recognized, err := s.answerOCR.Recognize(ctx, request.AnswerImageURL, answerType)
		if err != nil {
			return SubmitResponse{}, mapAnswerOCRError(err)
		}
		studentAnswer = strings.TrimSpace(recognized.AnswerLatex)
		if studentAnswer == "" {
			return SubmitResponse{}, ErrOCRUnreadable
		}
	}

	check, err := s.checkExerciseAnswer(ctx, exercise, studentAnswer, correctAnswer)
	if err != nil {
		return SubmitResponse{}, err
	}
	check = normalizeAnswerCheckResult(check)
	if check.Decision == mathsolverapp.DecisionIndeterminate {
		if err := answerCheckFailure(check); err != nil {
			return SubmitResponse{}, err
		}
		return indeterminateSubmitResponse(studentAnswer, check), nil
	}

	var diagnosis *DiagnosisDetail
	var errorType *string
	if check.Decision == mathsolverapp.DecisionIncorrect {
		diagnosis = s.buildDiagnosis(ctx, DiagnosisInput{
			Exercise:      exercise,
			StudentID:     userID,
			StudentAnswer: studentAnswer,
			AnswerSteps:   request.AnswerSteps,
			CorrectAnswer: correctAnswer,
			Check:         check,
			Fallback:      *basicDiagnosis(check.Reason, exercise.ConceptIDs),
		})
		errorType = diagnosis.ErrorType
	}

	attemptID, err := s.newID()
	if err != nil {
		return SubmitResponse{}, err
	}
	reportID := ""
	if diagnosis != nil {
		reportID, err = s.newID()
		if err != nil {
			return SubmitResponse{}, err
		}
	}

	var response SubmitResponse
	err = s.repo.WithTx(ctx, func(txCtx context.Context, repo Repository) error {
		if err := repo.LockStudentTracking(txCtx, userID); err != nil {
			return err
		}
		now := s.now().UTC().Truncate(time.Microsecond)
		var currentExercise Exercise
		var currentCorrectAnswer string
		var dailyBinding DailyAssignmentBinding
		var reviewTask MistakeReviewTask
		var redoBinding MistakeRedoAttemptBinding
		var hasRedoBinding bool
		var scheduledReview bool
		var readErr error
		if request.ReviewTaskID != "" {
			var found bool
			var cached SubmitResponse
			cached, found, readErr = repo.GetReviewSubmissionResponse(
				txCtx,
				request.ReviewTaskID,
				userID,
				reviewSubmissionKey,
				reviewSubmissionDigest,
			)
			if readErr == nil && found {
				response = cached
				return nil
			}
			if readErr == nil {
				reviewTask, found, readErr = repo.GetMistakeReviewTaskForUpdate(txCtx, userID, request.ReviewTaskID)
				if readErr == nil && (!found || reviewTask.ContentID != request.ExerciseID) {
					readErr = ErrBadRequest
				}
			}
			if readErr == nil {
				scheduledReview, readErr = classifyMistakeReviewSubmission(reviewTask, *request.ReviewTaskRevision, now)
			}
			if readErr == nil {
				currentExercise = reviewTask.Exercise
				currentCorrectAnswer = strings.TrimSpace(metautil.String(currentExercise.Meta, "answer"))
				if currentCorrectAnswer == "" {
					readErr = ErrBadRequest
				}
			}
		} else if request.OriginalAttemptID != "" {
			var cached SubmitResponse
			var found bool
			cached, found, readErr = repo.GetMistakeRedoSubmissionResponse(
				txCtx,
				userID,
				request.OriginalAttemptID,
				redoSubmissionKey,
				redoSubmissionDigest,
			)
			if readErr == nil && found {
				response = cached
				return nil
			}
			if readErr != nil {
				return readErr
			}
			redoBinding, hasRedoBinding, readErr = repo.GetMistakeRedoAttemptBinding(txCtx, userID, request.OriginalAttemptID)
			if readErr == nil {
				currentExercise, currentCorrectAnswer, readErr = mistakeRedoSubmissionExerciseFromBinding(
					redoBinding,
					hasRedoBinding,
					request.ExerciseID,
				)
			}
		} else if request.DailyAssignmentID == "" {
			var cached SubmitResponse
			var found bool
			cached, found, readErr = repo.GetRegularSubmissionResponse(
				txCtx,
				userID,
				regularSubmissionKey,
				regularSubmissionDigest,
			)
			if readErr == nil && found {
				response = cached
				return nil
			}
			if readErr != nil {
				return readErr
			}
			currentExercise, currentCorrectAnswer, readErr = submissionExerciseForUpdate(
				txCtx,
				repo,
				userID,
				request.ExerciseID,
			)
		} else {
			var ok bool
			dailyBinding, ok, readErr = repo.GetDailyAssignmentForUpdate(
				txCtx,
				request.DailyAssignmentID,
				userID,
			)
			if readErr == nil {
				var cached SubmitResponse
				var found bool
				cached, found, readErr = repo.GetDailySubmissionResponse(
					txCtx,
					request.DailyAssignmentID,
					userID,
					dailySubmissionKey,
				)
				if readErr == nil && found {
					response = cached
					return nil
				}
			}
			if readErr == nil {
				currentExercise, currentCorrectAnswer, dailyBinding, readErr = dailySubmissionExerciseFromBinding(
					dailyBinding,
					ok,
					request.ExerciseID,
				)
			}
		}
		if readErr != nil {
			return readErr
		}
		if request.ReviewTaskID != "" && reviewTask.SourceAttemptID != request.OriginalAttemptID {
			return ErrBadRequest
		}
		if request.ReviewTaskID != "" {
			binding, found, bindingErr := repo.GetMistakeRedoAttemptBinding(txCtx, userID, request.OriginalAttemptID)
			if bindingErr != nil {
				return bindingErr
			}
			if !found || binding.ContentID != request.ExerciseID || binding.IsCorrect || !binding.IsSubmitted || !binding.HasDiagnosis || binding.IsArchived {
				return ErrMistakeRecordArchived
			}
		}
		if currentCorrectAnswer != correctAnswer || !sameSubmissionExercise(exercise, currentExercise) {
			return ErrExerciseChanged
		}
		attemptDailyAssignmentID := dailyBinding.ID
		if request.ReviewTaskID != "" && reviewTask.DailyCorrectionAvailable {
			attemptDailyAssignmentID = reviewTask.DailyAssignmentID
		} else if request.ReviewTaskID != "" {
			attemptDailyAssignmentID = ""
		}
		attempt := AttemptRecord{
			ID:                      attemptID,
			ContentID:               currentExercise.ID,
			StudentID:               userID,
			DailyAssignmentID:       attemptDailyAssignmentID,
			DailySubmissionKey:      dailySubmissionKey,
			ReviewTaskID:            request.ReviewTaskID,
			ReviewSubmissionKey:     reviewSubmissionKey,
			ReviewSubmissionDigest:  reviewSubmissionDigest,
			RegularSubmissionKey:    regularSubmissionKey,
			RegularSubmissionDigest: regularSubmissionDigest,
			MasteryWeight:           submissionMasteryWeight(request, scheduledReview, isDailyCorrection(dailyBinding, reviewTask)),
			StudentAnswer:           studentAnswer,
			StudentSteps:            request.AnswerSteps,
			IsCorrect:               check.Decision == mathsolverapp.DecisionCorrect,
			Score:                   boolScore(check.Decision == mathsolverapp.DecisionCorrect),
			StartedAt:               now,
			SubmittedAt:             now,
			TimeSpentSeconds:        request.TimeSpentSeconds,
		}
		questionSnapshot := cloneReviewExercise(currentExercise)
		attempt.QuestionSnapshot = &questionSnapshot
		if request.ReviewTaskID == "" && request.OriginalAttemptID != "" {
			attempt.RedoOriginalAttemptID = request.OriginalAttemptID
			attempt.RedoSubmissionKey = redoSubmissionKey
			attempt.RedoSubmissionDigest = redoSubmissionDigest
		}
		if err := repo.InsertAttempt(txCtx, attempt); err != nil {
			return err
		}
		if request.ReviewTaskID != "" && reviewTask.DailyCorrectionAvailable {
			if err := repo.ApplyDailyAttempt(txCtx, DailyAttemptUpdate{
				AssignmentID: reviewTask.DailyAssignmentID,
				StudentID:    userID,
				ContentID:    currentExercise.ID,
				AttemptID:    attempt.ID,
				IsCorrect:    attempt.IsCorrect,
				SubmittedAt:  shanghaiTime(now),
				OnTime:       false,
			}); err != nil {
				return err
			}
		} else if request.ReviewTaskID == "" && request.DailyAssignmentID != "" {
			if err := repo.ApplyDailyAttempt(txCtx, DailyAttemptUpdate{
				AssignmentID: dailyBinding.ID,
				StudentID:    userID,
				ContentID:    currentExercise.ID,
				AttemptID:    attempt.ID,
				IsCorrect:    attempt.IsCorrect,
				SubmittedAt:  shanghaiTime(now),
				OnTime:       dailyBinding.AssignmentDate == shanghaiDate(now),
			}); err != nil {
				return err
			}
		}

		if diagnosis != nil {
			if err := repo.InsertDiagnosis(txCtx, DiagnosisRecord{
				ID:             reportID,
				AttemptID:      attempt.ID,
				ErrorType:      errorType,
				ErrorSubtype:   diagnosis.ErrorSubtype,
				Severity:       diagnosis.Severity,
				RelatedConcept: diagnosis.RelatedConcepts,
				Explanation:    diagnosis.ErrorDescription,
				Suggestion:     diagnosis.Suggestion,
				CreatedAt:      now,
			}); err != nil {
				return err
			}
		}

		session, err := s.getOrCreateSessionWithRepo(txCtx, repo, userID)
		if err != nil {
			return err
		}
		attempted := appendUnique(session.ContentsAttempted, currentExercise.ID)
		if err := repo.UpdateSessionAfterSubmit(txCtx, session.ID, currentExercise.ID, attempted); err != nil {
			return err
		}

		isCorrect := check.Decision == mathsolverapp.DecisionCorrect
		masteryUpdate, err := s.updateTracking(txCtx, repo, userID, attempt.ID, currentExercise, isCorrect, errorType, attempt.MasteryWeight, now)
		if err != nil {
			return err
		}
		resultingReviewTaskRevision, err := s.updateMistakeReviewTask(txCtx, repo, reviewTask, attempt, currentExercise, scheduledReview, now)
		if err != nil {
			return err
		}

		feedback := buildFeedback(check, diagnosis)
		correctAnswerLatex := ""
		if isCorrect {
			correctAnswerLatex = correctAnswer
		}
		response = SubmitResponse{
			AttemptID:          attempt.ID,
			IsCorrect:          isCorrect,
			GradingStatus:      string(check.Decision),
			Recorded:           true,
			Score:              attempt.Score,
			StudentAnswerLatex: studentAnswer,
			CorrectAnswerLatex: correctAnswerLatex,
			Diagnosis:          diagnosis,
			Evaluation:         evaluationDetail(check),
			Feedback:           feedback,
			MasteryUpdate:      masteryUpdate,
			MasteryModel:       dktModelName,
			NextRecommendation: nextRecommendation(isCorrect, masteryUpdate),
			MasteryWeight:      attempt.MasteryWeight,
		}
		if request.ReviewTaskID != "" {
			response.ReviewTaskRevision = &resultingReviewTaskRevision
			if err := repo.SaveReviewSubmissionResponse(
				txCtx,
				attempt.ID,
				userID,
				reviewSubmissionKey,
				reviewSubmissionDigest,
				response,
			); err != nil {
				return err
			}
		} else if request.OriginalAttemptID != "" {
			if err := repo.SaveMistakeRedoSubmissionResponse(
				txCtx,
				attempt.ID,
				userID,
				redoSubmissionKey,
				redoSubmissionDigest,
				response,
			); err != nil {
				return err
			}
		} else if request.DailyAssignmentID != "" {
			if err := repo.SaveDailySubmissionResponse(
				txCtx,
				attempt.ID,
				userID,
				dailySubmissionKey,
				response,
			); err != nil {
				return err
			}
		} else {
			if err := repo.SaveRegularSubmissionResponse(
				txCtx,
				attempt.ID,
				userID,
				regularSubmissionKey,
				regularSubmissionDigest,
				response,
			); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return SubmitResponse{}, err
	}
	return response, nil
}

func validateDailyAssignmentBinding(binding DailyAssignmentBinding, ok bool, exerciseID string) error {
	if !ok || binding.ID == "" || binding.ContentID != exerciseID || binding.Question == nil || binding.Question.ID != exerciseID {
		return ErrDailyAssignmentInvalid
	}
	switch binding.Status {
	case "ready":
		if binding.FirstAttemptID != "" {
			return ErrDailyAssignmentClosed
		}
		return nil
	case "completed":
		if binding.FirstAttemptID != "" && binding.FirstResult == "incorrect" && binding.CorrectedAttemptID == "" {
			return nil
		}
		return ErrDailyAssignmentClosed
	default:
		return ErrDailyAssignmentInvalid
	}
}

func shanghaiDate(value time.Time) string {
	return shanghaiTime(value).Format("2006-01-02")
}

func shanghaiTime(value time.Time) time.Time {
	return value.In(time.FixedZone("Asia/Shanghai", 8*60*60))
}

func dailySubmissionExercise(
	ctx context.Context,
	repo Repository,
	userID string,
	assignmentID string,
	exerciseID string,
	forUpdate bool,
) (Exercise, string, DailyAssignmentBinding, error) {
	var (
		binding DailyAssignmentBinding
		ok      bool
		err     error
	)
	if forUpdate {
		binding, ok, err = repo.GetDailyAssignmentForUpdate(ctx, assignmentID, userID)
	} else {
		binding, ok, err = repo.GetDailyAssignment(ctx, assignmentID, userID)
	}
	if err != nil {
		return Exercise{}, "", DailyAssignmentBinding{}, err
	}
	return dailySubmissionExerciseFromBinding(binding, ok, exerciseID)
}

func dailySubmissionExerciseFromBinding(
	binding DailyAssignmentBinding,
	ok bool,
	exerciseID string,
) (Exercise, string, DailyAssignmentBinding, error) {
	if err := validateDailyAssignmentBinding(binding, ok, exerciseID); err != nil {
		return Exercise{}, "", DailyAssignmentBinding{}, err
	}
	correctAnswer := strings.TrimSpace(metautil.String(binding.Question.Meta, "answer"))
	if correctAnswer == "" {
		return Exercise{}, "", DailyAssignmentBinding{}, ErrDailyAssignmentInvalid
	}
	return *binding.Question, correctAnswer, binding, nil
}

func mistakeRedoSubmissionExerciseFromBinding(
	binding MistakeRedoAttemptBinding,
	ok bool,
	exerciseID string,
) (Exercise, string, error) {
	if !ok || binding.ContentID != exerciseID || binding.Exercise.ID != exerciseID || binding.IsCorrect || !binding.IsSubmitted || !binding.HasDiagnosis || binding.IsArchived {
		return Exercise{}, "", ErrMistakeRecordArchived
	}
	correctAnswer := strings.TrimSpace(metautil.String(binding.Exercise.Meta, "answer"))
	if correctAnswer == "" {
		return Exercise{}, "", ErrBadRequest
	}
	return cloneReviewExercise(binding.Exercise), correctAnswer, nil
}

func normalizeSubmitRequest(request SubmitRequest) (SubmitRequest, error) {
	request.DailyAssignmentID = strings.TrimSpace(request.DailyAssignmentID)
	request.ReviewTaskID = strings.TrimSpace(request.ReviewTaskID)
	request.OriginalAttemptID = strings.TrimSpace(request.OriginalAttemptID)
	request.SubmissionID = strings.TrimSpace(request.SubmissionID)
	request.AnswerText = strings.TrimSpace(request.AnswerText)
	request.AnswerImageURL = strings.TrimSpace(request.AnswerImageURL)
	if request.ExerciseID == "" || len(request.ReviewTaskID) > 36 || len(request.OriginalAttemptID) > 36 || len(request.SubmissionID) > 128 || (request.AnswerText == "" && request.AnswerImageURL == "") {
		return SubmitRequest{}, ErrBadRequest
	}
	if request.SubmissionID != "" && !isUUID(request.SubmissionID) {
		return SubmitRequest{}, ErrBadRequest
	}
	if request.SubmissionID == "" && (request.ReviewTaskID != "" || request.OriginalAttemptID != "" || request.DailyAssignmentID == "") {
		return SubmitRequest{}, ErrBadRequest
	}
	if request.ReviewTaskID != "" && (request.ReviewTaskRevision == nil || request.OriginalAttemptID == "") {
		return SubmitRequest{}, ErrBadRequest
	}
	if request.ReviewTaskID == "" && request.OriginalAttemptID != "" && request.DailyAssignmentID != "" {
		return SubmitRequest{}, ErrBadRequest
	}
	return request, nil
}

func getSubmissionResponse(
	ctx context.Context,
	repo Repository,
	userID string,
	request SubmitRequest,
) (SubmitResponse, bool, error) {
	if request.ReviewTaskID != "" {
		return repo.GetReviewSubmissionResponse(
			ctx,
			request.ReviewTaskID,
			userID,
			makeReviewSubmissionKey(request),
			makeReviewSubmissionDigest(request),
		)
	}
	if request.OriginalAttemptID != "" {
		return repo.GetMistakeRedoSubmissionResponse(
			ctx,
			userID,
			request.OriginalAttemptID,
			makeMistakeRedoSubmissionKey(request),
			makeMistakeRedoSubmissionDigest(request),
		)
	}
	if request.DailyAssignmentID != "" {
		return repo.GetDailySubmissionResponse(
			ctx,
			request.DailyAssignmentID,
			userID,
			makeDailySubmissionKey(request),
		)
	}
	return repo.GetRegularSubmissionResponse(
		ctx,
		userID,
		makeRegularSubmissionKey(request),
		makeRegularSubmissionDigest(request),
	)
}

func makeDailySubmissionKey(request SubmitRequest) string {
	if request.SubmissionID != "" {
		return "client:" + request.SubmissionID
	}
	payload, _ := json.Marshal(struct {
		ExerciseID     string   `json:"exercise_id"`
		AnswerText     string   `json:"answer_text"`
		AnswerImageURL string   `json:"answer_image_url"`
		AnswerSteps    []string `json:"answer_steps"`
	}{
		ExerciseID:     request.ExerciseID,
		AnswerText:     request.AnswerText,
		AnswerImageURL: request.AnswerImageURL,
		AnswerSteps:    request.AnswerSteps,
	})
	sum := sha256.Sum256(payload)
	return "legacy:" + hex.EncodeToString(sum[:])
}

func makeReviewSubmissionKey(request SubmitRequest) string {
	if request.SubmissionID != "" {
		return "client:" + request.SubmissionID
	}
	payload, _ := json.Marshal(struct {
		ExerciseID     string   `json:"exercise_id"`
		ReviewTaskID   string   `json:"review_task_id"`
		AnswerText     string   `json:"answer_text"`
		AnswerImageURL string   `json:"answer_image_url"`
		AnswerSteps    []string `json:"answer_steps"`
	}{
		ExerciseID:     request.ExerciseID,
		ReviewTaskID:   request.ReviewTaskID,
		AnswerText:     request.AnswerText,
		AnswerImageURL: request.AnswerImageURL,
		AnswerSteps:    request.AnswerSteps,
	})
	sum := sha256.Sum256(payload)
	return "legacy:" + hex.EncodeToString(sum[:])
}

func makeReviewSubmissionDigest(request SubmitRequest) string {
	payload, _ := json.Marshal(struct {
		ExerciseID         string   `json:"exercise_id"`
		DailyAssignmentID  string   `json:"daily_assignment_id"`
		ReviewTaskID       string   `json:"review_task_id"`
		ReviewTaskRevision *int64   `json:"review_task_revision"`
		OriginalAttemptID  string   `json:"original_attempt_id"`
		AnswerText         string   `json:"answer_text"`
		AnswerImageURL     string   `json:"answer_image_url"`
		AnswerSteps        []string `json:"answer_steps"`
		TimeSpentSeconds   int      `json:"time_spent_seconds"`
	}{
		ExerciseID:         request.ExerciseID,
		DailyAssignmentID:  request.DailyAssignmentID,
		ReviewTaskID:       request.ReviewTaskID,
		ReviewTaskRevision: request.ReviewTaskRevision,
		OriginalAttemptID:  request.OriginalAttemptID,
		AnswerText:         request.AnswerText,
		AnswerImageURL:     request.AnswerImageURL,
		AnswerSteps:        request.AnswerSteps,
		TimeSpentSeconds:   request.TimeSpentSeconds,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func makeMistakeRedoSubmissionKey(request SubmitRequest) string { return request.SubmissionID }

func makeMistakeRedoSubmissionDigest(request SubmitRequest) string {
	payload, _ := json.Marshal(struct {
		ExerciseID        string   `json:"exercise_id"`
		OriginalAttemptID string   `json:"original_attempt_id"`
		AnswerText        string   `json:"answer_text"`
		AnswerImageURL    string   `json:"answer_image_url"`
		AnswerSteps       []string `json:"answer_steps"`
		TimeSpentSeconds  int      `json:"time_spent_seconds"`
	}{
		ExerciseID:        request.ExerciseID,
		OriginalAttemptID: request.OriginalAttemptID,
		AnswerText:        request.AnswerText,
		AnswerImageURL:    request.AnswerImageURL,
		AnswerSteps:       request.AnswerSteps,
		TimeSpentSeconds:  request.TimeSpentSeconds,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func makeRegularSubmissionKey(request SubmitRequest) string { return request.SubmissionID }

func makeRegularSubmissionDigest(request SubmitRequest) string {
	payload, _ := json.Marshal(struct {
		ExerciseID       string   `json:"exercise_id"`
		AnswerText       string   `json:"answer_text"`
		AnswerImageURL   string   `json:"answer_image_url"`
		AnswerSteps      []string `json:"answer_steps"`
		TimeSpentSeconds int      `json:"time_spent_seconds"`
	}{
		ExerciseID:       request.ExerciseID,
		AnswerText:       request.AnswerText,
		AnswerImageURL:   request.AnswerImageURL,
		AnswerSteps:      request.AnswerSteps,
		TimeSpentSeconds: request.TimeSpentSeconds,
	})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				return false
			}
		}
	}
	return value[14] == '4' && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'A' || value[19] == 'b' || value[19] == 'B')
}

func submissionMasteryWeight(request SubmitRequest, scheduledReview bool, dailyCorrection bool) float64 {
	if scheduledReview {
		return fullMasteryWeight
	}
	if dailyCorrection || request.ReviewTaskID != "" || request.OriginalAttemptID != "" {
		return informalRedoMasteryWeight
	}
	return fullMasteryWeight
}

func isDailyCorrection(dailyBinding DailyAssignmentBinding, reviewTask MistakeReviewTask) bool {
	if reviewTask.ID != "" {
		return reviewTask.DailyCorrectionAvailable
	}
	return dailyBinding.Status == "completed" &&
		dailyBinding.FirstAttemptID != "" &&
		dailyBinding.FirstResult == "incorrect" &&
		dailyBinding.CorrectedAttemptID == ""
}

func dailySolutionExercise(
	ctx context.Context,
	repo Repository,
	userID string,
	assignmentID string,
	exerciseID string,
) (Exercise, error) {
	binding, ok, err := repo.GetDailyAssignment(ctx, assignmentID, userID)
	if err != nil {
		return Exercise{}, err
	}
	if !ok || binding.ID == "" || binding.ContentID != exerciseID || binding.Question == nil || binding.Question.ID != exerciseID {
		return Exercise{}, ErrDailyAssignmentInvalid
	}
	switch binding.Status {
	case "completed":
		if binding.FirstAttemptID == "" {
			return Exercise{}, ErrDailyAssignmentInvalid
		}
		return *binding.Question, nil
	default:
		return Exercise{}, ErrDailyAssignmentInvalid
	}
}

func submissionExercise(ctx context.Context, repo Repository, userID string, exerciseID string) (Exercise, string, error) {
	return loadSubmissionExercise(ctx, repo, userID, exerciseID, repo.GetExercise)
}

func submissionExerciseForUpdate(ctx context.Context, repo Repository, userID string, exerciseID string) (Exercise, string, error) {
	return loadSubmissionExercise(ctx, repo, userID, exerciseID, repo.GetExerciseForUpdate)
}

// CanSubmitExercise reports whether the exercise currently satisfies the same access and content rules as SubmitAnswer.
func (s *Service) CanSubmitExercise(ctx context.Context, userID string, exerciseID string) (bool, error) {
	_, _, err := submissionExercise(ctx, s.repo, userID, exerciseID)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrBadRequest) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return false, err
}

// CanSubmitReviewExercise reports whether a regular or daily-bound mistake can still be redone.
func (s *Service) CanSubmitReviewExercise(ctx context.Context, userID string, exerciseID string, dailyAssignmentID string) (bool, error) {
	dailyAssignmentID = strings.TrimSpace(dailyAssignmentID)
	if dailyAssignmentID == "" {
		return s.CanSubmitExercise(ctx, userID, exerciseID)
	}
	_, _, _, err := dailySubmissionExercise(ctx, s.repo, userID, dailyAssignmentID, exerciseID, false)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, ErrDailyAssignmentInvalid) || errors.Is(err, ErrDailyAssignmentClosed) {
		return false, nil
	}
	return false, err
}

type exerciseGetter func(context.Context, string) (Exercise, bool, error)

func loadSubmissionExercise(ctx context.Context, repo Repository, userID string, exerciseID string, get exerciseGetter) (Exercise, string, error) {
	exercise, ok, err := get(ctx, exerciseID)
	if err != nil {
		return Exercise{}, "", err
	}
	if !ok || exercise.Status != "PUBLISHED" {
		return Exercise{}, "", ErrBadRequest
	}
	canAccess, err := canAccessExercise(ctx, repo, userID, exercise)
	if err != nil {
		return Exercise{}, "", err
	}
	if !canAccess {
		return Exercise{}, "", ErrBadRequest
	}
	assigned, err := repo.HasReadyDailyAssignmentContent(ctx, userID, exercise.ID)
	if err != nil {
		return Exercise{}, "", err
	}
	if assigned {
		return Exercise{}, "", ErrBadRequest
	}
	correctAnswer := strings.TrimSpace(metautil.String(exercise.Meta, "answer"))
	if correctAnswer == "" {
		return Exercise{}, "", ErrBadRequest
	}
	return exercise, correctAnswer, nil
}

func sameSubmissionExercise(expected Exercise, current Exercise) bool {
	return reflect.DeepEqual(expected, current)
}

func mapAnswerOCRError(err error) error {
	switch {
	case errors.Is(err, answerocrapp.ErrInvalidImage):
		return ErrBadRequest
	case errors.Is(err, answerocrapp.ErrUnreadable):
		return ErrOCRUnreadable
	case errors.Is(err, answerocrapp.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return ErrOCRTimeout
	default:
		return ErrOCRUnavailable
	}
}

func normalizeAnswerCheckResult(check AnswerCheckResult) AnswerCheckResult {
	check.Reason = strings.TrimSpace(check.Reason)
	check.Method = strings.TrimSpace(check.Method)
	check.ReasonCode = strings.TrimSpace(check.ReasonCode)
	if check.Decision == "" {
		switch {
		case check.IsCorrect:
			check.Decision = mathsolverapp.DecisionCorrect
		case check.Reason != "" && check.Confidence >= 0.7:
			check.Decision = mathsolverapp.DecisionIncorrect
		default:
			check.Decision = mathsolverapp.DecisionIndeterminate
		}
	}
	if check.Method == "" {
		check.Method = string(mathsolverapp.MethodNone)
	}
	if check.ReasonCode == "" {
		check.ReasonCode = "unspecified"
	}
	if check.Confidence < 0 || check.Confidence > 1 || math.IsNaN(check.Confidence) || math.IsInf(check.Confidence, 0) {
		check.Decision = mathsolverapp.DecisionIndeterminate
		check.IsCorrect = false
		check.Confidence = 0
		check.ReasonCode = "invalid_confidence"
		check.Reason = "判题结果置信度无效"
	}
	switch check.Decision {
	case mathsolverapp.DecisionCorrect, mathsolverapp.DecisionIncorrect:
		if check.Confidence < 0.7 {
			check.Decision = mathsolverapp.DecisionIndeterminate
			check.Degraded = true
			check.ReasonCode = "grading_low_confidence"
			check.Reason = "自动判题置信度不足，需要补充步骤或人工复核"
		}
	case mathsolverapp.DecisionIndeterminate:
		if check.Confidence >= 0.7 {
			check.Degraded = true
			check.Retryable = true
			check.ReasonCode = "solver_invalid_response"
			check.Reason = "数学判题服务返回了与不确定状态冲突的置信度"
			check.Failure = &mathsolverapp.Failure{
				Code:      mathsolverapp.FailureSolverInvalid,
				Stage:     "grading",
				Message:   check.Reason,
				Retryable: true,
			}
		}
	default:
		check.Decision = mathsolverapp.DecisionIndeterminate
		check.Degraded = true
		check.Retryable = true
		check.ReasonCode = "solver_invalid_response"
		check.Reason = "数学判题服务返回了无效结果"
		check.Failure = &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureSolverInvalid,
			Stage:     "grading",
			Message:   check.Reason,
			Retryable: true,
		}
	}
	check.IsCorrect = check.Decision == mathsolverapp.DecisionCorrect
	return check
}

func answerCheckFailure(check AnswerCheckResult) error {
	if check.Failure == nil {
		return nil
	}
	code := strings.ToLower(strings.TrimSpace(string(check.Failure.Code)))
	switch code {
	case "invalid_input", "input_limit_exceeded", "numeric_parse_failed", "invalid_tolerance":
		return ErrAnswerParseFailed
	case "unsupported_answer_kind":
		return ErrMathUnsupported
	case "canceled":
		if check.Failure.Retryable {
			return ErrMathSolverTimeout
		}
		return context.Canceled
	case "invalid_configuration":
		return ErrMathSolverUnavailable
	case "timeout", "solver_timeout", "math_solver_timeout":
		return ErrMathSolverTimeout
	case "invalid_response", "solver_invalid_response", "math_solver_invalid_response":
		return ErrMathSolverInvalidResult
	case "unavailable", "solver_unavailable", "math_solver_unavailable":
		return ErrMathSolverUnavailable
	default:
		return nil
	}
}

func evaluationDetail(check AnswerCheckResult) EvaluationDetail {
	return EvaluationDetail{
		Method:     check.Method,
		ReasonCode: check.ReasonCode,
		Reason:     check.Reason,
		Confidence: check.Confidence,
		Degraded:   check.Degraded,
		Retryable:  check.Retryable,
		Evidence:   append([]mathsolverapp.Evidence(nil), check.Evidence...),
	}
}

func indeterminateSubmitResponse(studentAnswer string, check AnswerCheckResult) SubmitResponse {
	feedback := strings.TrimSpace(check.Reason)
	if feedback == "" {
		feedback = "当前信息不足，暂时无法可靠判定，请补充步骤或稍后重试。"
	}
	return SubmitResponse{
		IsCorrect:          false,
		GradingStatus:      string(mathsolverapp.DecisionIndeterminate),
		Recorded:           false,
		Score:              0,
		StudentAnswerLatex: studentAnswer,
		CorrectAnswerLatex: "",
		Diagnosis:          nil,
		Evaluation:         evaluationDetail(check),
		Feedback:           feedback,
		MasteryUpdate:      nil,
		MasteryModel:       dktModelName,
		NextRecommendation: "retry",
	}
}

func (s *Service) buildDiagnosis(ctx context.Context, input DiagnosisInput) *DiagnosisDetail {
	fallback := normalizeDiagnosis(input.Fallback, input.Exercise.ConceptIDs)
	if s.diagnostician == nil {
		return &fallback
	}
	input.Fallback = fallback
	diagnosis, err := s.diagnostician.Diagnose(ctx, input)
	if err != nil {
		return &fallback
	}
	diagnosis = normalizeDiagnosis(diagnosis, input.Exercise.ConceptIDs)
	return &diagnosis
}

// GetExercise returns exercise details when the student can access the teacher's content.
func (s *Service) GetExercise(ctx context.Context, userID string, exerciseID string) (ExerciseDetailResponse, error) {
	exercise, err := s.authorizedExercise(ctx, userID, exerciseID)
	if err != nil {
		return ExerciseDetailResponse{}, err
	}
	return ExerciseDetailResponse{
		ID:                  exercise.ID,
		Title:               exercise.Title,
		Content:             exercise.Body,
		Difficulty:          exercise.Difficulty,
		Type:                metaStringDefault(exercise.Meta, "type", "short_answer"),
		Source:              exerciseSource(exercise),
		KnowledgePoints:     sliceutil.CloneStrings(exercise.ConceptIDs),
		KnowledgePointNames: metautil.StringSlice(exercise.Meta, "knowledge_point_names"),
		Hints:               metautil.StringSlice(exercise.Meta, "hints"),
		Options:             metautil.OptionalStringSlice(exercise.Meta, "options"),
	}, nil
}

// GetSolution returns cached steps or a solver candidate verified against the trusted answer.
func (s *Service) GetSolution(ctx context.Context, userID string, exerciseID string, dailyAssignmentID string, reviewTaskID string, reviewTaskRevision *int64, originalAttemptID string, solutionAttemptID string) (SolutionResponse, error) {
	dailyAssignmentID = strings.TrimSpace(dailyAssignmentID)
	reviewTaskID = strings.TrimSpace(reviewTaskID)
	originalAttemptID = strings.TrimSpace(originalAttemptID)
	solutionAttemptID = strings.TrimSpace(solutionAttemptID)
	if len(originalAttemptID) > 36 || len(solutionAttemptID) > 36 || boolInt(dailyAssignmentID != "")+boolInt(reviewTaskID != "")+boolInt(originalAttemptID != "") > 1 {
		return SolutionResponse{}, ErrBadRequest
	}
	if (reviewTaskID == "") != (reviewTaskRevision == nil) {
		return SolutionResponse{}, ErrBadRequest
	}
	if reviewTaskID != "" && solutionAttemptID == "" {
		return SolutionResponse{}, ErrBadRequest
	}
	if reviewTaskID == "" && originalAttemptID == "" && solutionAttemptID != "" {
		return SolutionResponse{}, ErrBadRequest
	}
	if solutionAttemptID != "" && !isUUID(solutionAttemptID) {
		return SolutionResponse{}, ErrBadRequest
	}
	var exercise Exercise
	var err error
	if reviewTaskID != "" {
		exercise, err = reviewSolutionExercise(ctx, s.repo, userID, reviewTaskID, *reviewTaskRevision, exerciseID, solutionAttemptID, s.now().UTC())
	} else if originalAttemptID != "" {
		exercise, err = mistakeRedoSolutionExercise(ctx, s.repo, userID, originalAttemptID, solutionAttemptID, exerciseID)
	} else if dailyAssignmentID == "" {
		exercise, err = regularSolutionExercise(ctx, s.repo, userID, exerciseID)
	} else {
		exercise, err = eligibleDailySolutionExercise(ctx, s.repo, userID, dailyAssignmentID, exerciseID)
	}
	if err != nil {
		return SolutionResponse{}, err
	}
	finalize := func(response SolutionResponse) (SolutionResponse, error) {
		return s.finalizeSolutionResponse(
			ctx,
			userID,
			exerciseID,
			dailyAssignmentID,
			reviewTaskID,
			reviewTaskRevision,
			originalAttemptID,
			solutionAttemptID,
			exercise,
			response,
		)
	}
	answer := strings.TrimSpace(metautil.String(exercise.Meta, "answer"))
	if answer == "" {
		return finalize(unavailableSolution(exerciseID, answer, nil, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureInvalidInput,
			Stage:     "reference_answer",
			Message:   "题目缺少可用于验证解析的标准答案",
			Retryable: false,
		}))
	}
	if invalidReference, invalid := invalidMultipleChoiceReferenceCheck(exercise, answer); invalid {
		verification := evaluationDetail(invalidReference)
		return finalize(unavailableSolution(exerciseID, answer, &verification, invalidReference.Failure))
	}
	steps := metautil.StringSlice(exercise.Meta, "solution_steps")
	if len(steps) > 0 {
		return finalize(SolutionResponse{
			ExerciseID: exerciseID,
			Answer:     answer,
			Steps:      steps,
			Source:     "cached",
		})
	}
	if s.solutionSolver == nil {
		return finalize(unavailableSolution(exerciseID, answer, nil, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureSolverUnavailable,
			Stage:     "solution_generation",
			Message:   "通用数学求解服务未配置",
			Retryable: true,
		}))
	}

	solverExercise := exercise
	solverExercise.Meta = maps.Clone(exercise.Meta)
	delete(solverExercise.Meta, "answer")
	delete(solverExercise.Meta, "solution_steps")
	candidate, err := s.solutionSolver.Solve(ctx, SolutionInput{
		Exercise:   solverExercise,
		AnswerType: metautil.String(exercise.Meta, "answer_type"),
	})
	if err != nil {
		return finalize(unavailableSolution(exerciseID, answer, nil, solutionSolverFailure(err, "solution_generation")))
	}
	candidate, ok := normalizeSolutionResult(candidate)
	if !ok {
		return finalize(unavailableSolution(exerciseID, answer, nil, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureSolverInvalid,
			Stage:     "solution_generation",
			Message:   "通用数学求解服务返回了无效结果",
			Retryable: true,
		}))
	}
	if candidate.Status == SolutionStatusIndeterminate {
		return finalize(unavailableSolution(exerciseID, answer, nil, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureSolverIndeterminate,
			Stage:     "solution_generation",
			Message:   candidate.Reason,
			Retryable: candidate.Retryable,
		}))
	}

	candidate.Answer = normalizeSolutionChoiceAnswer(exercise, candidate.Answer)
	answerVerification, err := s.verifySolutionAnswer(ctx, exercise, candidate.Answer, answer)
	if err != nil {
		return finalize(unavailableSolution(exerciseID, answer, nil, solutionSolverFailure(err, "solution_verification")))
	}
	answerVerification = normalizeAnswerCheckResult(answerVerification)
	answerVerificationDetail := evaluationDetail(answerVerification)
	if answerVerification.Decision != mathsolverapp.DecisionCorrect {
		message := "生成解析未通过标准答案验证"
		retryable := true
		if answerVerification.Reason != "" {
			message = answerVerification.Reason
		}
		if answerVerification.Failure != nil {
			message = answerVerification.Failure.Message
			retryable = answerVerification.Failure.Retryable
		}
		return finalize(unavailableSolution(exerciseID, answer, &answerVerificationDetail, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureVerificationFailed,
			Stage:     "solution_verification",
			Message:   message,
			Retryable: retryable,
		}))
	}

	verifier, ok := s.solutionSolver.(SolutionVerifier)
	if !ok {
		return finalize(unavailableSolution(exerciseID, answer, &answerVerificationDetail, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureSolverUnavailable,
			Stage:     "solution_verification",
			Message:   "通用数学解析验证服务未配置",
			Retryable: true,
		}))
	}
	verification, err := verifier.VerifySolution(ctx, SolutionVerificationInput{
		Exercise:        solverExercise,
		CandidateAnswer: candidate.Answer,
		CandidateSteps:  append([]string(nil), candidate.Steps...),
		ReferenceAnswer: answer,
		AnswerType:      metautil.String(exercise.Meta, "answer_type"),
	})
	if err != nil {
		return finalize(unavailableSolution(exerciseID, answer, &answerVerificationDetail, solutionSolverFailure(err, "solution_verification")))
	}
	verification = normalizeAnswerCheckResult(verification)
	verificationDetail := evaluationDetail(verification)
	if verification.Decision != mathsolverapp.DecisionCorrect {
		message := "生成解析的推导步骤未通过独立验证"
		if verification.Reason != "" {
			message = verification.Reason
		}
		retryable := verification.Decision == mathsolverapp.DecisionIncorrect || verification.Retryable
		if verification.Failure != nil {
			message = verification.Failure.Message
			retryable = verification.Failure.Retryable
		}
		return finalize(unavailableSolution(exerciseID, answer, &verificationDetail, &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureVerificationFailed,
			Stage:     "solution_verification",
			Message:   message,
			Retryable: retryable,
		}))
	}
	return finalize(SolutionResponse{
		ExerciseID:   exerciseID,
		Answer:       answer,
		Steps:        candidate.Steps,
		Source:       "solver_verified",
		Verification: &verificationDetail,
	})
}

func regularSolutionExercise(ctx context.Context, repo Repository, userID string, exerciseID string) (Exercise, error) {
	exercise, err := authorizedExercise(ctx, repo, userID, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	assigned, err := repo.HasReadyDailyAssignmentContent(ctx, userID, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	if assigned {
		return Exercise{}, ErrNotFound
	}
	hasAttempt, err := repo.HasSubmittedAttempt(ctx, userID, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	if !hasAttempt {
		return Exercise{}, ErrNotFound
	}
	return exercise, nil
}

func eligibleDailySolutionExercise(
	ctx context.Context,
	repo Repository,
	userID string,
	dailyAssignmentID string,
	exerciseID string,
) (Exercise, error) {
	exercise, err := dailySolutionExercise(ctx, repo, userID, dailyAssignmentID, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	assigned, err := repo.HasReadyDailyAssignmentContent(ctx, userID, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	if assigned {
		return Exercise{}, ErrDailyAssignmentInvalid
	}
	return exercise, nil
}

func reviewSolutionExercise(
	ctx context.Context,
	repo Repository,
	userID string,
	reviewTaskID string,
	reviewTaskRevision int64,
	exerciseID string,
	solutionAttemptID string,
	now time.Time,
) (Exercise, error) {
	task, ok, err := repo.GetMistakeReviewTask(ctx, userID, reviewTaskID)
	if err != nil {
		return Exercise{}, err
	}
	if !ok || task.ContentID != exerciseID {
		return Exercise{}, ErrNotFound
	}
	if task.Revision != reviewTaskRevision {
		return Exercise{}, ErrReviewTaskStale
	}
	if task.Status == MistakeReviewArchived || task.LastReviewAttemptID == "" || task.LastReviewAttemptID != solutionAttemptID {
		return Exercise{}, ErrNotFound
	}
	if task.Status != MistakeReviewMastered && (task.DueAt == nil || !now.Before(*task.DueAt)) {
		return Exercise{}, ErrNotFound
	}
	return task.Exercise, nil
}

func mistakeRedoSolutionExercise(
	ctx context.Context,
	repo Repository,
	userID string,
	originalAttemptID string,
	solutionAttemptID string,
	exerciseID string,
) (Exercise, error) {
	attemptID := originalAttemptID
	if solutionAttemptID != "" {
		attemptID = solutionAttemptID
	}
	binding, ok, err := repo.GetMistakeRedoAttemptBinding(ctx, userID, attemptID)
	if err != nil {
		return Exercise{}, err
	}
	if solutionAttemptID != "" && (!ok || binding.RedoOriginalAttemptID != originalAttemptID) {
		return Exercise{}, ErrNotFound
	}
	exercise, _, err := mistakeRedoSubmissionExerciseFromBinding(binding, ok, exerciseID)
	if errors.Is(err, ErrMistakeRecordArchived) {
		return Exercise{}, ErrNotFound
	}
	return exercise, err
}

func (s *Service) finalizeSolutionResponse(
	ctx context.Context,
	userID string,
	exerciseID string,
	dailyAssignmentID string,
	reviewTaskID string,
	reviewTaskRevision *int64,
	originalAttemptID string,
	solutionAttemptID string,
	expected Exercise,
	response SolutionResponse,
) (SolutionResponse, error) {
	var current Exercise
	err := s.repo.WithTx(ctx, func(txCtx context.Context, repo Repository) error {
		if lockErr := repo.LockStudentTracking(txCtx, userID); lockErr != nil {
			return lockErr
		}
		var loadErr error
		if reviewTaskID != "" {
			current, loadErr = reviewSolutionExercise(txCtx, repo, userID, reviewTaskID, *reviewTaskRevision, exerciseID, solutionAttemptID, s.now().UTC())
		} else if originalAttemptID != "" {
			current, loadErr = mistakeRedoSolutionExercise(txCtx, repo, userID, originalAttemptID, solutionAttemptID, exerciseID)
		} else if dailyAssignmentID == "" {
			current, loadErr = regularSolutionExercise(txCtx, repo, userID, exerciseID)
		} else {
			current, loadErr = eligibleDailySolutionExercise(
				txCtx,
				repo,
				userID,
				dailyAssignmentID,
				exerciseID,
			)
		}
		return loadErr
	})
	if err != nil {
		return SolutionResponse{}, err
	}
	if !sameSubmissionExercise(expected, current) {
		return SolutionResponse{}, ErrExerciseChanged
	}
	return response, nil
}

func unavailableSolution(exerciseID string, answer string, verification *EvaluationDetail, failure *mathsolverapp.Failure) SolutionResponse {
	return SolutionResponse{
		ExerciseID:   exerciseID,
		Answer:       answer,
		Steps:        []string{},
		Source:       "unavailable",
		Verification: verification,
		Failure:      failure,
	}
}

func solutionSolverFailure(err error, stage string) *mathsolverapp.Failure {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return &mathsolverapp.Failure{Code: mathsolverapp.FailureSolverTimeout, Stage: stage, Message: "通用数学求解服务处理超时", Retryable: true}
	case errors.Is(err, context.Canceled):
		return &mathsolverapp.Failure{Code: mathsolverapp.FailureCanceled, Stage: stage, Message: "通用数学求解请求已取消", Retryable: false}
	case errors.Is(err, ErrMathSolverInvalidResult):
		return &mathsolverapp.Failure{Code: mathsolverapp.FailureSolverInvalid, Stage: stage, Message: "通用数学求解服务返回了无效结果", Retryable: true}
	default:
		return &mathsolverapp.Failure{Code: mathsolverapp.FailureSolverUnavailable, Stage: stage, Message: "通用数学求解服务暂不可用", Retryable: true}
	}
}

func normalizeSolutionResult(result SolutionResult) (SolutionResult, bool) {
	result.Status = strings.ToLower(strings.TrimSpace(result.Status))
	result.Answer = strings.TrimSpace(result.Answer)
	result.Method = strings.ToLower(strings.TrimSpace(result.Method))
	result.ReasonCode = strings.ToLower(strings.TrimSpace(result.ReasonCode))
	result.Reason = strings.TrimSpace(result.Reason)
	if result.Method == "" || len(result.Method) > 64 || result.ReasonCode == "" || len(result.ReasonCode) > 128 ||
		result.Reason == "" || len(result.Reason) > 2_000 || result.Confidence < 0 || result.Confidence > 1 ||
		math.IsNaN(result.Confidence) || math.IsInf(result.Confidence, 0) || len(result.Evidence) > 8 {
		return SolutionResult{}, false
	}
	for index := range result.Evidence {
		result.Evidence[index].Kind = strings.ToLower(strings.TrimSpace(result.Evidence[index].Kind))
		result.Evidence[index].Summary = strings.TrimSpace(result.Evidence[index].Summary)
		if result.Evidence[index].Kind == "" || len(result.Evidence[index].Kind) > 64 ||
			result.Evidence[index].Summary == "" || len([]rune(result.Evidence[index].Summary)) > 500 {
			return SolutionResult{}, false
		}
	}
	switch result.Status {
	case SolutionStatusSolved:
		if result.Confidence < 0.7 || result.Answer == "" || len(result.Answer) > 16*1024 ||
			len(result.Steps) == 0 || len(result.Steps) > 10 || len(result.Evidence) == 0 {
			return SolutionResult{}, false
		}
		for index := range result.Steps {
			result.Steps[index] = strings.TrimSpace(result.Steps[index])
			if result.Steps[index] == "" || len(result.Steps[index]) > 5_000 {
				return SolutionResult{}, false
			}
		}
	case SolutionStatusIndeterminate:
		if result.Confidence >= 0.7 {
			return SolutionResult{}, false
		}
		result.Answer = ""
		result.Steps = []string{}
	default:
		return SolutionResult{}, false
	}
	return result, true
}

func (s *Service) verifySolutionAnswer(ctx context.Context, exercise Exercise, candidateAnswer string, correctAnswer string) (AnswerCheckResult, error) {
	if check, ok := deterministicMultipleChoiceCheck(exercise, candidateAnswer, correctAnswer); ok {
		return check, nil
	}
	local, err := (NormalizedAnswerChecker{}).CheckExerciseAnswer(ctx, AnswerCheckInput{
		Exercise:      exercise,
		StudentAnswer: candidateAnswer,
		CorrectAnswer: correctAnswer,
		AnswerType:    metautil.String(exercise.Meta, "answer_type"),
	})
	if err != nil {
		return AnswerCheckResult{}, err
	}
	local = normalizeAnswerCheckResult(local)
	if local.Decision != mathsolverapp.DecisionIndeterminate || local.Failure != nil {
		return local, nil
	}
	return s.checkExerciseAnswer(ctx, exercise, candidateAnswer, correctAnswer)
}

func (s *Service) authorizedExercise(ctx context.Context, userID string, exerciseID string) (Exercise, error) {
	return authorizedExercise(ctx, s.repo, userID, exerciseID)
}

func authorizedExercise(ctx context.Context, repo Repository, userID string, exerciseID string) (Exercise, error) {
	exercise, ok, err := repo.GetExercise(ctx, exerciseID)
	if err != nil {
		return Exercise{}, err
	}
	if !ok {
		_, enrolled, err := repo.GetTeacherIDForStudent(ctx, userID)
		if err != nil {
			return Exercise{}, err
		}
		if !enrolled {
			return Exercise{}, ErrForbidden
		}
		return Exercise{}, ErrNotFound
	}
	canAccess, err := canAccessExercise(ctx, repo, userID, exercise)
	if err != nil {
		return Exercise{}, err
	}
	if !canAccess {
		return Exercise{}, ErrNotFound
	}
	if exercise.Status != "PUBLISHED" {
		return Exercise{}, ErrNotFound
	}
	return exercise, nil
}

func canAccessExercise(ctx context.Context, repo Repository, userID string, exercise Exercise) (bool, error) {
	if exercise.GeneratedByStudentID != "" {
		return exercise.GeneratedByStudentID == userID, nil
	}
	teacherID, ok, err := repo.GetTeacherIDForStudent(ctx, userID)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, ErrForbidden
	}
	return exercise.OwnerTeacherID == teacherID, nil
}

func (s *Service) getOrCreateSession(ctx context.Context, userID string) (LearningSession, error) {
	return s.getOrCreateSessionWithRepo(ctx, s.repo, userID)
}

func (s *Service) getOrCreateSessionWithRepo(ctx context.Context, repo Repository, userID string) (LearningSession, error) {
	session, ok, err := repo.GetLatestSession(ctx, userID)
	if err != nil {
		return LearningSession{}, err
	}
	if ok {
		return session, nil
	}
	return repo.CreateSession(ctx, userID, s.now())
}

func (s *Service) updateTracking(
	ctx context.Context,
	repo Repository,
	userID string,
	attemptID string,
	exercise Exercise,
	isCorrect bool,
	errorType *string,
	masteryWeight float64,
	now time.Time,
) (map[string]float64, error) {
	masteryWeight = normalizeMasteryWeight(masteryWeight)
	profile, ok, err := repo.GetProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		profile, err = repo.CreateProfile(ctx, userID, now)
		if err != nil {
			return nil, err
		}
	}
	concepts := trackedConceptIDs(exercise.ConceptIDs)

	states, err := repo.ListDKTStates(ctx, userID, concepts)
	if err != nil {
		return nil, err
	}
	history, err := repo.ListRecentInteractions(ctx, userID, attemptID, dktMaxSequenceLength)
	if err != nil {
		return nil, err
	}
	current := LearningInteraction{
		AttemptID:     attemptID,
		ExerciseID:    exercise.ID,
		ConceptIDs:    concepts,
		IsCorrect:     isCorrect,
		Difficulty:    exercise.Difficulty,
		MasteryWeight: masteryWeight,
		SubmittedAt:   now,
	}
	sequence := buildDKTSequence(history, current)

	mastery := maputil.CloneFloatMap(profile.MasteryVector)
	tendency := maputil.CloneFloatMap(profile.ErrorTendency)
	if errorType != nil && !isCorrect {
		tendency[*errorType] += masteryWeight
	}
	masteryUpdate := map[string]float64{}
	upserts := make([]DKTState, 0, len(concepts))
	for _, conceptID := range concepts {
		state, hasState := states[conceptID]
		prior, hasPrior := mastery[conceptID]
		prior = dktProfilePrior(
			conceptID,
			prior,
			hasPrior,
			profile.PreferredDifficulty,
			profile.LearningPace,
			exercise.Difficulty,
		)
		if hasState {
			prior = state.MasteryProb
			if state.LastAttemptAt != nil {
				daysSince := now.Sub(*state.LastAttemptAt).Hours() / 24.0
				prior = applyForgetting(prior, daysSince, dktRetentionFloor)
			}
		} else {
			id, err := s.newID()
			if err != nil {
				return nil, err
			}
			state = DKTState{
				ID:        id,
				StudentID: userID,
				ConceptID: conceptID,
				CreatedAt: now,
			}
		}
		result := dktUpdate(prior, conceptID, current, sequence, profile, ptrutil.ValueOrZero(errorType), state.AttemptCount)
		nextMastery := numutil.RoundPlaces(result.mastery, 4)
		nextConfidence := numutil.RoundPlaces(result.confidence, 4)
		mastery[conceptID] = nextMastery
		masteryUpdate[conceptID] = nextMastery
		outcome := isCorrect
		state.StudentID = userID
		state.ConceptID = conceptID
		state.MasteryProb = nextMastery
		state.Confidence = nextConfidence
		state.AttemptCount++
		state.CorrectCount += boolInt(isCorrect)
		state.IncorrectCount += boolInt(!isCorrect)
		state.SequenceLength = result.sequenceLength
		state.AttentionWeight = numutil.RoundPlaces(result.attentionWeight, 4)
		state.LastOutcome = &outcome
		state.LastExerciseID = &exercise.ID
		state.LastAttemptAt = &now
		state.UpdatedAt = now
		upserts = append(upserts, state)
	}
	if err := repo.UpsertDKTStates(ctx, upserts); err != nil {
		return nil, err
	}
	if err := repo.UpdateProfileTracking(ctx, userID, ProfileTrackingUpdate{
		MasteryVector:  mastery,
		ErrorTendency:  tendency,
		TotalExercises: profile.TotalExercises + 1,
		CorrectCount:   profile.CorrectCount + boolInt(isCorrect),
		UpdatedAt:      now,
	}); err != nil {
		return nil, err
	}
	return masteryUpdate, nil
}

func (s *Service) checkExerciseAnswer(ctx context.Context, exercise Exercise, studentAnswer string, correctAnswer string) (AnswerCheckResult, error) {
	if check, ok := deterministicMultipleChoiceCheck(exercise, studentAnswer, correctAnswer); ok {
		return check, nil
	}
	input := AnswerCheckInput{
		Exercise:      exercise,
		StudentAnswer: studentAnswer,
		CorrectAnswer: correctAnswer,
		AnswerType:    metautil.String(exercise.Meta, "answer_type"),
	}
	if checker, ok := s.checker.(ContextualAnswerChecker); ok {
		return checker.CheckExerciseAnswer(ctx, input)
	}
	return s.checker.CheckAnswer(ctx, studentAnswer, correctAnswer, input.AnswerType)
}

func deterministicMultipleChoiceCheck(exercise Exercise, studentAnswer string, correctAnswer string) (AnswerCheckResult, bool) {
	if metaStringDefault(exercise.Meta, "type", "short_answer") != "multiple_choice" {
		return AnswerCheckResult{}, false
	}
	if invalidReference, invalid := invalidMultipleChoiceReferenceCheck(exercise, correctAnswer); invalid {
		return invalidReference, true
	}
	options := metautil.StringSlice(exercise.Meta, "options")
	canonicalCorrect, _ := canonicalCorrectOption(exercise, options, correctAnswer)
	canonicalStudent, studentMatched := canonicalStudentOption(options, studentAnswer)
	if studentMatched && normalizeAnswer(canonicalStudent) == normalizeAnswer(canonicalCorrect) {
		return AnswerCheckResult{
			IsCorrect:  true,
			Decision:   mathsolverapp.DecisionCorrect,
			Method:     "choice_exact",
			ReasonCode: "choice_match",
			Reason:     "所选答案与标准选项一致",
			Confidence: 1,
			Evidence:   []mathsolverapp.Evidence{{Kind: "choice", Summary: "学生选项与标准选项完全一致"}},
		}, true
	}
	return AnswerCheckResult{
		Decision:   mathsolverapp.DecisionIncorrect,
		Method:     "choice_exact",
		ReasonCode: "choice_mismatch",
		Reason:     "所选答案与标准选项不一致",
		Confidence: 1,
		Evidence:   []mathsolverapp.Evidence{{Kind: "choice", Summary: "学生选项与标准选项不同"}},
	}, true
}

func invalidMultipleChoiceReferenceCheck(exercise Exercise, correctAnswer string) (AnswerCheckResult, bool) {
	if metaStringDefault(exercise.Meta, "type", "short_answer") != "multiple_choice" {
		return AnswerCheckResult{}, false
	}
	options := metautil.StringSlice(exercise.Meta, "options")
	if len(options) > 0 {
		if _, ok := canonicalCorrectOption(exercise, options, correctAnswer); ok {
			return AnswerCheckResult{}, false
		}
	}
	reason := "题目标准答案未对应有效选项，无法可靠判定"
	return AnswerCheckResult{
		Decision:   mathsolverapp.DecisionIndeterminate,
		Method:     "choice_exact",
		ReasonCode: "invalid_reference_answer",
		Reason:     reason,
		Degraded:   true,
		Retryable:  false,
		Evidence: []mathsolverapp.Evidence{{
			Kind:    "reference_validation",
			Summary: "标准答案无法归一化为题目选项",
		}},
		Failure: &mathsolverapp.Failure{
			Code:      mathsolverapp.FailureInvalidInput,
			Stage:     "reference_answer",
			Message:   reason,
			Retryable: false,
		},
	}, true
}

func canonicalCorrectOption(exercise Exercise, options []string, answer string) (string, bool) {
	if exercise.GeneratedByStudentID == "" {
		if option, ok := optionFromLabel(options, answer); ok {
			return option, true
		}
	}
	if option, ok := matchingOption(options, answer); ok {
		return option, true
	}
	return optionFromLabel(options, answer)
}

func canonicalStudentOption(options []string, answer string) (string, bool) {
	if option, ok := matchingOption(options, answer); ok {
		return option, true
	}
	return optionFromLabel(options, answer)
}

func matchingOption(options []string, answer string) (string, bool) {
	normalized := normalizeAnswer(answer)
	if normalized == "" {
		return "", false
	}
	for _, option := range options {
		if normalizeAnswer(option) == normalized {
			return option, true
		}
	}
	return "", false
}

func optionFromLabel(options []string, answer string) (string, bool) {
	label := strings.ToUpper(strings.TrimSpace(answer))
	if len(label) != 1 || label[0] < 'A' || label[0] > 'Z' {
		return "", false
	}
	index := int(label[0] - 'A')
	if index >= len(options) {
		return "", false
	}
	return options[index], true
}

// NormalizedAnswerChecker is the deterministic local checker used before the Math Solver agent.
type NormalizedAnswerChecker struct{}

// CheckAnswer performs bounded exact text/expression and rational numeric comparison.
func (NormalizedAnswerChecker) CheckAnswer(ctx context.Context, studentAnswer string, correctAnswer string, answerType string) (AnswerCheckResult, error) {
	result := mathsolverapp.NewComparator().Compare(ctx, mathsolverapp.CompareInput{
		StudentAnswer:   studentAnswer,
		ReferenceAnswer: correctAnswer,
		Kind:            mathAnswerKind(answerType, ""),
	})
	return answerCheckFromMathResult(result), nil
}

// CheckExerciseAnswer includes question type and configured numeric tolerances.
func (NormalizedAnswerChecker) CheckExerciseAnswer(ctx context.Context, input AnswerCheckInput) (AnswerCheckResult, error) {
	result := mathsolverapp.NewComparator().Compare(ctx, mathsolverapp.CompareInput{
		StudentAnswer:   input.StudentAnswer,
		ReferenceAnswer: input.CorrectAnswer,
		Kind:            mathAnswerKind(input.AnswerType, metaStringDefault(input.Exercise.Meta, "type", "")),
		Tolerance: mathsolverapp.Tolerance{
			Absolute: metaNumberString(input.Exercise.Meta, "absolute_tolerance"),
			Relative: metaNumberString(input.Exercise.Meta, "relative_tolerance"),
		},
	})
	return answerCheckFromMathResult(result), nil
}

// CheckAnswer compares answers with a solver and falls back to deterministic local comparison.
func (c SolverAnswerChecker) CheckAnswer(ctx context.Context, studentAnswer string, correctAnswer string, answerType string) (AnswerCheckResult, error) {
	return c.CheckExerciseAnswer(ctx, AnswerCheckInput{
		StudentAnswer: studentAnswer,
		CorrectAnswer: correctAnswer,
		AnswerType:    answerType,
	})
}

// CheckExerciseAnswer uses deterministic evidence first, then the configured general solver.
func (c SolverAnswerChecker) CheckExerciseAnswer(ctx context.Context, input AnswerCheckInput) (AnswerCheckResult, error) {
	fallbackChecker := c.Fallback
	if fallbackChecker == nil {
		fallbackChecker = NormalizedAnswerChecker{}
	}
	var fallback AnswerCheckResult
	var err error
	if checker, ok := fallbackChecker.(ContextualAnswerChecker); ok {
		fallback, err = checker.CheckExerciseAnswer(ctx, input)
	} else {
		fallback, err = fallbackChecker.CheckAnswer(ctx, input.StudentAnswer, input.CorrectAnswer, input.AnswerType)
	}
	if err != nil {
		return AnswerCheckResult{}, err
	}
	fallback = normalizeAnswerCheckResult(fallback)
	if fallback.Decision != mathsolverapp.DecisionIndeterminate {
		return fallback, nil
	}
	if c.Solver == nil {
		return fallback, nil
	}
	input.Fallback = fallback
	result, err := c.Solver.CheckAnswer(ctx, input)
	if err != nil {
		failureCode := mathsolverapp.FailureCode("solver_unavailable")
		reasonCode := "solver_unavailable"
		reason := "数学判题服务暂不可用"
		retryable := true
		if errors.Is(err, context.DeadlineExceeded) {
			failureCode = mathsolverapp.FailureCode("solver_timeout")
			reasonCode = "solver_timeout"
			reason = "数学判题服务处理超时"
		} else if errors.Is(err, context.Canceled) {
			failureCode = mathsolverapp.FailureCanceled
			reasonCode = "solver_canceled"
			reason = "数学判题请求已取消"
			retryable = false
		} else if errors.Is(err, ErrMathSolverInvalidResult) {
			failureCode = mathsolverapp.FailureCode("solver_invalid_response")
			reasonCode = "solver_invalid_response"
			reason = "数学判题服务返回了无效结果"
		}
		fallback.Failure = &mathsolverapp.Failure{Code: failureCode, Stage: "solver", Message: reason, Retryable: retryable}
		fallback.ReasonCode = reasonCode
		fallback.Reason = reason
		fallback.Retryable = retryable
		return fallback, nil
	}
	result = normalizeAnswerCheckResult(result)
	if result.Reason == "" {
		fallback.Failure = &mathsolverapp.Failure{Code: mathsolverapp.FailureCode("solver_invalid_response"), Stage: "solver", Message: "数学判题服务返回了无效结果", Retryable: true}
		fallback.ReasonCode = "solver_invalid_response"
		fallback.Reason = "数学判题服务返回了无效结果"
		fallback.Retryable = true
		return fallback, nil
	}
	return result, nil
}

func answerCheckFromMathResult(result mathsolverapp.Result) AnswerCheckResult {
	return AnswerCheckResult{
		IsCorrect:  result.Decision == mathsolverapp.DecisionCorrect,
		Decision:   result.Decision,
		Method:     string(result.Method),
		ReasonCode: string(result.ReasonCode),
		Reason:     result.Reason,
		Confidence: result.Confidence,
		Degraded:   result.Degraded,
		Retryable:  result.Retryable,
		Evidence:   append([]mathsolverapp.Evidence(nil), result.Evidence...),
		Failure:    result.Failure,
	}
}

func mathAnswerKind(answerType string, questionType string) mathsolverapp.AnswerKind {
	if strings.EqualFold(strings.TrimSpace(questionType), "proof") {
		return mathsolverapp.AnswerKindProof
	}
	switch strings.ToLower(strings.TrimSpace(answerType)) {
	case "numeric", "number":
		return mathsolverapp.AnswerKindNumeric
	case "expression", "formula", "equation":
		return mathsolverapp.AnswerKindExpression
	case "proof":
		return mathsolverapp.AnswerKindProof
	default:
		return mathsolverapp.AnswerKindExpression
	}
}

func metaNumberString(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, ok := meta[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		return fmt.Sprintf("%.17g", typed)
	case float32:
		return fmt.Sprintf("%.9g", typed)
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	default:
		return ""
	}
}

func chooseTarget(query NextQuery, mastery map[string]float64) (string, float64) {
	targetConcept := strings.TrimSpace(query.ConceptID)
	targetDifficulty := 0.5
	if query.Difficulty != nil {
		targetDifficulty = *query.Difficulty
	}
	if targetConcept != "" || query.Difficulty != nil || len(mastery) == 0 {
		return targetConcept, numutil.ClampFloat(targetDifficulty, 0, 1)
	}
	keys := maputil.SortedFloatKeys(mastery)
	midConcept := ""
	midMastery := 0.0
	weakestConcept := ""
	weakestMastery := 1.0
	for _, concept := range keys {
		value := mastery[concept]
		if value < 0.4 && value < weakestMastery {
			weakestConcept = concept
			weakestMastery = value
		} else if value >= 0.4 && value < 0.8 && midConcept == "" {
			midConcept = concept
			midMastery = value
		}
	}
	if weakestConcept != "" {
		return weakestConcept, math.Max(0.2, weakestMastery)
	}
	if midConcept != "" {
		return midConcept, numutil.ClampFloat(midMastery+0.1, 0, 1)
	}
	return "", targetDifficulty
}

func preferConcept(candidates []Exercise, conceptID string) []Exercise {
	if conceptID == "" || len(candidates) == 0 {
		return candidates
	}
	matched := []Exercise{}
	for _, candidate := range candidates {
		if slices.Contains(candidate.ConceptIDs, conceptID) {
			matched = append(matched, candidate)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	return candidates
}

func selectExercise(candidates []Exercise) Exercise {
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].ID < candidates[j].ID
	})
	return candidates[0]
}

func toExerciseResponse(exercise Exercise) *ExerciseResponse {
	return &ExerciseResponse{
		ID:                   exercise.ID,
		Title:                exercise.Title,
		Content:              exercise.Body,
		Difficulty:           exercise.Difficulty,
		Type:                 metaStringDefault(exercise.Meta, "type", "short_answer"),
		Source:               exerciseSource(exercise),
		KnowledgePoints:      sliceutil.CloneStrings(exercise.ConceptIDs),
		KnowledgePointNames:  metautil.StringSlice(exercise.Meta, "knowledge_point_names"),
		HintsAvailable:       len(metautil.StringSlice(exercise.Meta, "hints")) > 0,
		EstimatedTimeSeconds: metautil.IntDefault(exercise.Meta, "estimated_time_seconds", 300),
		Options:              metautil.OptionalStringSlice(exercise.Meta, "options"),
	}
}

func exerciseSource(exercise Exercise) string {
	if exercise.GeneratedByStudentID != "" {
		return ExerciseSourceAIGenerated
	}
	return ExerciseSourceClass
}

func normalizeGeneratedQuestion(question GeneratedQuestion) GeneratedQuestion {
	question.Title = strings.TrimSpace(question.Title)
	question.Body = strings.TrimSpace(question.Body)
	question.Type = strings.ToLower(strings.TrimSpace(question.Type))
	question.Answer = strings.TrimSpace(question.Answer)
	question.AnswerType = strings.ToLower(strings.TrimSpace(question.AnswerType))
	question.Options = sliceutil.AppendUniqueNonEmptyStrings(nil, question.Options...)
	question.Hints = sliceutil.AppendUniqueNonEmptyStrings(nil, question.Hints...)
	question.SolutionSteps = sliceutil.AppendUniqueNonEmptyStrings(nil, question.SolutionSteps...)
	question.ConceptIDs = sliceutil.AppendUniqueNonEmptyStrings(nil, question.ConceptIDs...)
	question.KnowledgePointNames = sliceutil.AppendUniqueNonEmptyStrings(nil, question.KnowledgePointNames...)
	if option, ok := matchingOption(question.Options, question.Answer); ok {
		question.Answer = option
	} else if option, ok := optionFromLabel(question.Options, question.Answer); ok {
		question.Answer = option
	}
	return question
}

func validGeneratedQuestion(question GeneratedQuestion) bool {
	if question.Title == "" || len(question.Title) > 500 || question.Body == "" || len(question.Body) > 20_000 {
		return false
	}
	if question.Answer == "" || len(question.Answer) > 2_000 {
		return false
	}
	switch question.Type {
	case QuestionTypeMultipleChoice:
		if question.AnswerType != "text" || len(question.Options) != 4 || !slices.Contains(question.Options, question.Answer) {
			return false
		}
	case QuestionTypeShortAnswer:
		if (question.AnswerType != "numeric" && question.AnswerType != "expression") || len(question.Options) != 0 || strings.Count(question.Body, QuestionBlankMarker) != 1 {
			return false
		}
	default:
		return false
	}
	for _, option := range question.Options {
		if len(option) > 2_000 {
			return false
		}
	}
	if len(question.Hints) == 0 || len(question.Hints) > 5 || len(question.SolutionSteps) == 0 || len(question.SolutionSteps) > 10 {
		return false
	}
	for _, hint := range question.Hints {
		if len(hint) > 2_000 {
			return false
		}
	}
	for _, step := range question.SolutionSteps {
		if len(step) > 5_000 {
			return false
		}
	}
	return question.Difficulty >= 0 && question.Difficulty <= 1 &&
		question.EstimatedTimeSeconds >= 30 && question.EstimatedTimeSeconds <= 3_600 &&
		len(question.ConceptIDs) == 1 && len(question.KnowledgePointNames) == 1
}

type errorTaxonomy struct {
	ErrorType  *string
	Code       string
	Subtype    string
	Severity   string
	Suggestion string
}

func classifyMathError(reason string) errorTaxonomy {
	normalized := strings.ToLower(reason)
	switch {
	case strings.Contains(normalized, "concept") || strings.Contains(reason, "概念") || strings.Contains(reason, "定义"):
		errorType := "conceptual"
		return errorTaxonomy{ErrorType: &errorType, Code: "C-Type", Subtype: "concept_misunderstanding", Severity: "high", Suggestion: "先回到相关定义和适用条件，再重新判断题目属于哪类对象。"}
	case strings.Contains(normalized, "logic") || strings.Contains(reason, "逻辑") || strings.Contains(reason, "充分") || strings.Contains(reason, "必要"):
		errorType := "logical"
		return errorTaxonomy{ErrorType: &errorType, Code: "L-Type", Subtype: "invalid_inference", Severity: "high", Suggestion: "逐步检查每个推理箭头是否成立，尤其区分充分条件和必要条件。"}
	case strings.Contains(normalized, "symbol") || strings.Contains(reason, "符号") || strings.Contains(reason, "格式"):
		errorType := "symbolic"
		return errorTaxonomy{ErrorType: &errorType, Code: "S-Type", Subtype: "notation_error", Severity: "medium", Suggestion: "规范书写变量、上下标、积分/微分符号和等号链，避免表达式歧义。"}
	case strings.Contains(normalized, "step") || strings.Contains(reason, "步骤") || strings.Contains(reason, "方法") || strings.Contains(reason, "过程"):
		errorType := "procedural"
		return errorTaxonomy{ErrorType: &errorType, Code: "P-Type", Subtype: "procedure_misuse", Severity: "medium", Suggestion: "对照标准算法逐步复核，先确认方法选择，再检查每一步执行。"}
	default:
		errorType := "procedural"
		return errorTaxonomy{ErrorType: &errorType, Code: "P-Type", Subtype: "answer_mismatch", Severity: "medium", Suggestion: "请按步骤复算，并标出最早与标准解不一致的位置。"}
	}
}

func basicDiagnosis(reason string, concepts []string) *DiagnosisDetail {
	explanation := "答案不正确"
	suggestion := "请重新检查解题过程"
	if reason != "" {
		explanation = reason
	}
	taxonomy := classifyMathError(reason)
	return &DiagnosisDetail{
		ErrorType:        taxonomy.ErrorType,
		ErrorSubtype:     taxonomy.Subtype,
		TaxonomyCode:     taxonomy.Code,
		ErrorDescription: explanation,
		ErrorStepIndex:   nil,
		Severity:         taxonomy.Severity,
		Suggestion:       stringutil.NonBlankOr(taxonomy.Suggestion, suggestion),
		RelatedConcepts:  sliceutil.CloneStrings(concepts),
	}
}

func normalizeDiagnosis(diagnosis DiagnosisDetail, concepts []string) DiagnosisDetail {
	if diagnosis.ErrorType != nil {
		value := strings.ToLower(strings.TrimSpace(*diagnosis.ErrorType))
		if value == "" {
			diagnosis.ErrorType = nil
		} else {
			diagnosis.ErrorType = &value
		}
	}
	diagnosis.ErrorSubtype = strings.TrimSpace(diagnosis.ErrorSubtype)
	if diagnosis.ErrorSubtype == "" {
		diagnosis.ErrorSubtype = "answer_mismatch"
	}
	diagnosis.TaxonomyCode = strings.TrimSpace(diagnosis.TaxonomyCode)
	if diagnosis.TaxonomyCode == "" && diagnosis.ErrorType != nil {
		diagnosis.TaxonomyCode = taxonomyCodeForErrorType(*diagnosis.ErrorType)
	}
	diagnosis.ErrorDescription = strings.TrimSpace(diagnosis.ErrorDescription)
	if diagnosis.ErrorDescription == "" {
		diagnosis.ErrorDescription = "答案不正确"
	}
	diagnosis.Severity = strings.ToLower(strings.TrimSpace(diagnosis.Severity))
	switch diagnosis.Severity {
	case "low", "medium", "high":
	default:
		diagnosis.Severity = "medium"
	}
	diagnosis.Suggestion = strings.TrimSpace(diagnosis.Suggestion)
	if diagnosis.Suggestion == "" {
		diagnosis.Suggestion = "请按步骤复算，并标出最早与标准解不一致的位置。"
	}
	diagnosis.RelatedConcepts = uniqueNonEmpty(append(diagnosis.RelatedConcepts, concepts...))
	return diagnosis
}

func taxonomyCodeForErrorType(errorType string) string {
	switch strings.ToLower(strings.TrimSpace(errorType)) {
	case "conceptual":
		return "C-Type"
	case "procedural":
		return "P-Type"
	case "logical":
		return "L-Type"
	case "symbolic":
		return "S-Type"
	default:
		return ""
	}
}

func buildFeedback(check AnswerCheckResult, diagnosis *DiagnosisDetail) string {
	if check.IsCorrect {
		if check.Reason == "" {
			return "回答正确！"
		}
		return "回答正确！" + check.Reason
	}
	if diagnosis != nil && diagnosis.Suggestion != "" {
		return diagnosis.Suggestion
	}
	if check.Reason != "" {
		return "答案不正确。" + check.Reason
	}
	return "答案不正确。"
}

func nextRecommendation(isCorrect bool, masteryUpdate map[string]float64) string {
	if isCorrect || len(masteryUpdate) == 0 {
		return "continue"
	}
	sum := 0.0
	for _, value := range masteryUpdate {
		sum += value
	}
	if sum/float64(len(masteryUpdate)) < 0.3 {
		return "review"
	}
	return "continue"
}

var answerWhitespaceReplacer = strings.NewReplacer(" ", "", "\t", "", "\n", "", "\r", "")

func normalizeAnswer(value string) string {
	return strings.ToLower(answerWhitespaceReplacer.Replace(strings.TrimSpace(value)))
}

func metaStringDefault(meta map[string]any, key string, fallback string) string {
	value := metautil.String(meta, key)
	if value == "" {
		return fallback
	}
	return value
}

func appendUnique(values []string, value string) []string {
	result := sliceutil.CloneStrings(values)
	if !slices.Contains(result, value) {
		result = append(result, value)
	}
	return result
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func boolScore(value bool) float64 {
	if value {
		return 1
	}
	return 0
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
