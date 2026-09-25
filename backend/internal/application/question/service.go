package question

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"

	"mathstudy/backend/internal/platform/learningconcept"
	"mathstudy/backend/internal/platform/metautil"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/sliceutil"
)

var (
	// ErrNotFound is returned when a question does not exist or is not accessible.
	ErrNotFound = errors.New("question not found")
	// ErrBadRequest is returned when a request cannot be applied.
	ErrBadRequest = errors.New("question bad request")
	// ErrForbidden is returned when a question exists but is not owned by the current teacher.
	ErrForbidden = errors.New("question forbidden")
	// ErrScheduled is returned when a future uniform daily-question schedule still references the question.
	ErrScheduled = errors.New("question is scheduled for daily question")
)

// Public question bank input limits shared by HTTP and application boundaries.
const (
	MaxBatchOperationIDs            = 100
	MaxBatchImportQuestions         = 200
	MaxAIParseRawTexts              = 10
	MaxAIParseRawTextBytes          = 3000
	MaxAIParsedQuestions            = 20
	MaxQuestionTitleBytes           = 500
	MaxQuestionBodyBytes            = 20000
	MaxQuestionAnswerBytes          = 20000
	MaxQuestionListItems            = 50
	MaxQuestionListItemBytes        = 1000
	MaxQuestionEstimatedTimeSeconds = 24 * 60 * 60
)

// Repository is the persistence surface required by teacher question bank use cases.
type Repository interface {
	MatchConceptIDs(context.Context, string) ([]string, error)
	MatchConceptIDsBatch(context.Context, []string) ([][]string, error)
	ConceptIDsExist(context.Context, []string) (bool, error)
	ListQuestions(context.Context, string, ListFilter) ([]Question, int, error)
	GetQuestion(context.Context, string, string) (Question, bool, error)
	CreateQuestion(context.Context, string, QuestionInput, time.Time) (Question, error)
	UpdateQuestion(context.Context, string, string, QuestionUpdate, time.Time) (Question, bool, error)
	DeleteQuestion(context.Context, string, string, time.Time) (bool, error)
	GetGroups(context.Context, string) ([]string, error)
	GetStats(context.Context, string) (Stats, error)
	BatchPublish(context.Context, string, []string, time.Time) (int, error)
	BatchDelete(context.Context, string, []string, time.Time) (int, error)
	BatchDuplicate(context.Context, string, []string, time.Time) (BatchOperationResponse, error)
	BatchImport(context.Context, string, []QuestionInput, time.Time) (BatchOperationResponse, error)
	SetDailyCandidate(context.Context, string, string, bool, time.Time) (bool, error)
}

// ListFilter stores /questions filters and pagination.
type ListFilter struct {
	Page       int
	PageSize   int
	Search     string
	Difficulty string
	Type       string
	Status     string
	Tags       []string
	Group      string
	SortBy     string
	SortOrder  string
}

// QuestionInput stores fields required to create a question.
type QuestionInput struct {
	Title                string
	Body                 string
	Type                 string
	Difficulty           float64
	ConceptIDs           []string
	Tags                 []string
	Answer               string
	AnswerType           string
	Hints                []string
	SolutionSteps        []string
	Options              *[]string
	EstimatedTimeSeconds int
}

// QuestionUpdate stores optional fields accepted by update question.
type QuestionUpdate struct {
	Title                *string
	Body                 *string
	Type                 *string
	Difficulty           *float64
	ConceptIDs           *[]string
	Tags                 *[]string
	Answer               *string
	AnswerType           *string
	Hints                *[]string
	SolutionSteps        *[]string
	Options              *[]string
	EstimatedTimeSeconds *int
	Status               *string
}

// Question is the Python-compatible question response shape.
type Question struct {
	ID               string         `json:"id"`
	Title            string         `json:"title"`
	Body             string         `json:"body"`
	Type             string         `json:"type"`
	Difficulty       float64        `json:"difficulty"`
	ConceptIDs       []string       `json:"concept_ids"`
	Tags             []string       `json:"tags"`
	Status           string         `json:"status"`
	Meta             map[string]any `json:"meta"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
	UsageCount       int            `json:"usage_count"`
	CorrectRate      float64        `json:"correct_rate"`
	IsDailyCandidate bool           `json:"is_daily_candidate"`
}

// ListResponse is the Python-compatible question list response.
type ListResponse struct {
	Items    []Question `json:"items"`
	Total    int        `json:"total"`
	Page     int        `json:"page"`
	PageSize int        `json:"page_size"`
}

// Stats stores question counters.
type Stats struct {
	Total        int            `json:"total"`
	ByDifficulty map[string]int `json:"by_difficulty"`
	ByType       map[string]int `json:"by_type"`
	ByStatus     map[string]int `json:"by_status"`
}

// GroupsResponse is returned by /questions/groups.
type GroupsResponse struct {
	Groups []string `json:"groups"`
}

// BatchOperationResponse is shared by batch question endpoints.
type BatchOperationResponse struct {
	Success   int      `json:"success"`
	Failed    int      `json:"failed"`
	FailedIDs []string `json:"failed_ids"`
	Errors    []string `json:"errors"`
}

// AIParseQuestionItem is the shape returned by the AI parse endpoint.
type AIParseQuestionItem struct {
	Title         string   `json:"title"`
	Body          string   `json:"body"`
	Type          string   `json:"type"`
	Difficulty    float64  `json:"difficulty"`
	Answer        string   `json:"answer"`
	AnswerType    string   `json:"answer_type"`
	Options       []string `json:"options,omitempty"`
	Hints         []string `json:"hints"`
	SolutionSteps []string `json:"solution_steps"`
	Tags          []string `json:"tags"`
}

// AIParseResponse wraps parsed question candidates.
type AIParseResponse struct {
	Questions []AIParseQuestionItem `json:"questions"`
}

// ParserInput carries raw text and deterministic fallback into an optional LLM parser.
type ParserInput struct {
	RawTexts []string
	Fallback AIParseResponse
}

// Parser extracts structured question candidates from raw text.
type Parser interface {
	ParseQuestions(context.Context, ParserInput) (AIParseResponse, error)
}

// GenerateRequest stores deterministic isomorphic problem generation inputs.
type GenerateRequest struct {
	Template   string
	Ability    float64
	Difficulty *float64
	ConceptIDs []string
	Tags       []string
}

// GeneratedQuestion stores a locally template-validated isomorphic problem.
type GeneratedQuestion struct {
	Title         string               `json:"title"`
	Body          string               `json:"body"`
	Type          string               `json:"type"`
	Difficulty    float64              `json:"difficulty"`
	Answer        string               `json:"answer"`
	AnswerType    string               `json:"answer_type"`
	Hints         []string             `json:"hints"`
	SolutionSteps []string             `json:"solution_steps"`
	ConceptIDs    []string             `json:"concept_ids"`
	Tags          []string             `json:"tags"`
	Template      string               `json:"template"`
	Parameters    map[string]int       `json:"parameters"`
	Validation    GenerationValidation `json:"validation"`
}

// GenerationValidation stores the deterministic local-template validation result.
type GenerationValidation struct {
	HasClosedForm bool    `json:"has_closed_form"`
	InSyllabus    bool    `json:"in_syllabus"`
	Difficulty    float64 `json:"difficulty"`
	Message       string  `json:"message"`
}

// Service implements teacher question bank use cases.
type Service struct {
	repo   Repository
	parser Parser
	now    func() time.Time
}

// Option customizes the question service.
type Option func(*Service)

// WithParser enables LLM-backed question parsing with deterministic fallback.
func WithParser(parser Parser) Option {
	return func(service *Service) {
		service.parser = parser
	}
}

// NewService creates a question service.
func NewService(repo Repository, options ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("question repository is nil")
	}
	service := &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// ListQuestions returns a filtered teacher-owned question page.
func (s *Service) ListQuestions(ctx context.Context, ownerID string, filter ListFilter) (ListResponse, error) {
	filter = normalizeListFilter(filter)
	items, total, err := s.repo.ListQuestions(ctx, ownerID, filter)
	if err != nil {
		return ListResponse{}, err
	}
	return ListResponse{Items: items, Total: total, Page: filter.Page, PageSize: filter.PageSize}, nil
}

// GetQuestion returns one teacher-owned problem.
func (s *Service) GetQuestion(ctx context.Context, ownerID string, questionID string) (Question, error) {
	question, ok, err := s.repo.GetQuestion(ctx, ownerID, questionID)
	if err != nil {
		return Question{}, err
	}
	if !ok {
		return Question{}, ErrNotFound
	}
	return question, nil
}

// CreateQuestion creates a teacher-owned draft problem.
func (s *Service) CreateQuestion(ctx context.Context, ownerID string, input QuestionInput) (Question, error) {
	input = normalizeQuestionInput(input)
	if !validQuestionInput(input) {
		return Question{}, ErrBadRequest
	}
	if len(input.ConceptIDs) == 0 {
		conceptIDs, err := s.repo.MatchConceptIDs(ctx, input.Title)
		if err != nil {
			return Question{}, err
		}
		input.ConceptIDs = conceptIDs
	}
	input.ConceptIDs = conceptIDsOrUncategorized(input.ConceptIDs)
	if err := s.requireConceptIDs(ctx, input.ConceptIDs); err != nil {
		return Question{}, err
	}
	return s.repo.CreateQuestion(ctx, ownerID, input, s.now())
}

// UpdateQuestion updates a teacher-owned problem.
func (s *Service) UpdateQuestion(ctx context.Context, ownerID string, questionID string, update QuestionUpdate) (Question, error) {
	update = normalizeQuestionUpdate(update)
	if !validQuestionUpdate(update) {
		return Question{}, ErrBadRequest
	}
	if updateTouchesMultipleChoiceContract(update) {
		var err error
		update, err = s.normalizeMultipleChoiceUpdate(ctx, ownerID, questionID, update)
		if err != nil {
			return Question{}, err
		}
	}
	if update.Title != nil && update.ConceptIDs == nil {
		conceptIDs, err := s.repo.MatchConceptIDs(ctx, *update.Title)
		if err != nil {
			return Question{}, err
		}
		if len(conceptIDs) > 0 {
			update.ConceptIDs = &conceptIDs
		}
	}
	if update.ConceptIDs != nil {
		conceptIDs := conceptIDsOrUncategorized(*update.ConceptIDs)
		if err := s.requireConceptIDs(ctx, conceptIDs); err != nil {
			return Question{}, err
		}
		update.ConceptIDs = &conceptIDs
	}
	question, ok, err := s.repo.UpdateQuestion(ctx, ownerID, questionID, update, s.now())
	if err != nil {
		return Question{}, err
	}
	if !ok {
		return Question{}, ErrNotFound
	}
	return question, nil
}

// DeleteQuestion soft-deletes a teacher-owned problem.
func (s *Service) DeleteQuestion(ctx context.Context, ownerID string, questionID string) error {
	ok, err := s.repo.DeleteQuestion(ctx, ownerID, questionID, s.now())
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// SetDailyCandidate enables or disables a published teacher-owned question for daily selection.
func (s *Service) SetDailyCandidate(ctx context.Context, ownerID string, questionID string, enabled bool) (Question, error) {
	question, err := s.GetQuestion(ctx, ownerID, questionID)
	if err != nil {
		return Question{}, err
	}
	if enabled && question.Status != "published" {
		return Question{}, ErrBadRequest
	}
	ok, err := s.repo.SetDailyCandidate(ctx, ownerID, questionID, enabled, s.now())
	if err != nil {
		return Question{}, err
	}
	if !ok {
		return Question{}, ErrNotFound
	}
	question.IsDailyCandidate = enabled
	return question, nil
}

// GetGroups returns distinct teacher-owned question group names.
func (s *Service) GetGroups(ctx context.Context, ownerID string) (GroupsResponse, error) {
	groups, err := s.repo.GetGroups(ctx, ownerID)
	if err != nil {
		return GroupsResponse{}, err
	}
	return GroupsResponse{Groups: groups}, nil
}

// GetStats returns teacher question counters.
func (s *Service) GetStats(ctx context.Context, ownerID string) (Stats, error) {
	return s.repo.GetStats(ctx, ownerID)
}

// BatchPublish publishes teacher-owned problem content.
func (s *Service) BatchPublish(ctx context.Context, ownerID string, questionIDs []string) (BatchOperationResponse, error) {
	ids := normalizeIDs(questionIDs)
	if len(ids) == 0 || len(ids) > MaxBatchOperationIDs {
		return BatchOperationResponse{}, ErrBadRequest
	}
	count, err := s.repo.BatchPublish(ctx, ownerID, ids, s.now())
	if err != nil {
		return BatchOperationResponse{}, err
	}
	return BatchOperationResponse{Success: count, Failed: len(ids) - count, FailedIDs: []string{}, Errors: []string{}}, nil
}

// BatchDelete soft-deletes teacher-owned problem content.
func (s *Service) BatchDelete(ctx context.Context, ownerID string, questionIDs []string) (BatchOperationResponse, error) {
	ids := normalizeIDs(questionIDs)
	if len(ids) == 0 || len(ids) > MaxBatchOperationIDs {
		return BatchOperationResponse{}, ErrBadRequest
	}
	count, err := s.repo.BatchDelete(ctx, ownerID, ids, s.now())
	if err != nil {
		return BatchOperationResponse{}, err
	}
	return BatchOperationResponse{Success: count, Failed: len(ids) - count, FailedIDs: []string{}, Errors: []string{}}, nil
}

// BatchDuplicate duplicates teacher-owned problem content.
func (s *Service) BatchDuplicate(ctx context.Context, ownerID string, questionIDs []string) (BatchOperationResponse, error) {
	ids := normalizeIDs(questionIDs)
	if len(ids) == 0 || len(ids) > MaxBatchOperationIDs {
		return BatchOperationResponse{}, ErrBadRequest
	}
	return s.repo.BatchDuplicate(ctx, ownerID, ids, s.now())
}

// BatchImport inserts already parsed questions.
func (s *Service) BatchImport(ctx context.Context, ownerID string, questions []QuestionInput) (BatchOperationResponse, error) {
	if len(questions) == 0 || len(questions) > MaxBatchImportQuestions {
		return BatchOperationResponse{}, ErrBadRequest
	}
	normalized := make([]QuestionInput, 0, len(questions))
	matchIndexes := make(map[string]int)
	matchTitles := make([]string, 0, len(questions))
	questionMatchIndexes := make([]int, len(questions))
	for index, input := range questions {
		input = normalizeQuestionInput(input)
		if !validQuestionInput(input) {
			return BatchOperationResponse{}, ErrBadRequest
		}
		if len(input.ConceptIDs) == 0 {
			key := strings.ToLower(input.Title)
			matchIndex, ok := matchIndexes[key]
			if !ok {
				matchIndex = len(matchTitles)
				matchIndexes[key] = matchIndex
				matchTitles = append(matchTitles, input.Title)
			}
			questionMatchIndexes[index] = matchIndex + 1
		}
		normalized = append(normalized, input)
	}
	if len(matchTitles) > 0 {
		matches, err := s.repo.MatchConceptIDsBatch(ctx, matchTitles)
		if err != nil {
			return BatchOperationResponse{}, err
		}
		if len(matches) != len(matchTitles) {
			return BatchOperationResponse{}, fmt.Errorf("match concept ids batch: unexpected result count %d", len(matches))
		}
		for index, matchIndex := range questionMatchIndexes {
			if matchIndex > 0 {
				normalized[index].ConceptIDs = matches[matchIndex-1]
			}
		}
	}
	for index := range normalized {
		normalized[index].ConceptIDs = conceptIDsOrUncategorized(normalized[index].ConceptIDs)
	}
	conceptIDs := []string{}
	for _, input := range normalized {
		conceptIDs = sliceutil.AppendUniqueNonEmptyStrings(conceptIDs, input.ConceptIDs...)
	}
	if err := s.requireConceptIDs(ctx, conceptIDs); err != nil {
		return BatchOperationResponse{}, err
	}
	return s.repo.BatchImport(ctx, ownerID, normalized, s.now())
}

// ParseQuestions extracts question candidates with an optional LLM parser and deterministic fallback.
func (s *Service) ParseQuestions(ctx context.Context, rawTexts []string) (AIParseResponse, error) {
	if len(rawTexts) == 0 || len(rawTexts) > MaxAIParseRawTexts {
		return AIParseResponse{}, ErrBadRequest
	}
	normalizedTexts := make([]string, 0, len(rawTexts))
	items := make([]AIParseQuestionItem, 0, len(rawTexts))
	for _, text := range rawTexts {
		if len(text) > MaxAIParseRawTextBytes {
			return AIParseResponse{}, ErrBadRequest
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return AIParseResponse{}, ErrBadRequest
		}
		normalizedTexts = append(normalizedTexts, trimmed)
		items = append(items, AIParseQuestionItem{
			Title:         firstNonEmptyLine(trimmed),
			Body:          trimmed,
			Type:          "short_answer",
			Difficulty:    0.5,
			Answer:        "",
			AnswerType:    "expression",
			Hints:         []string{},
			SolutionSteps: []string{},
			Tags:          []string{},
		})
	}
	fallback := AIParseResponse{Questions: items}
	if s.parser == nil {
		return fallback, nil
	}
	parsed, err := s.parser.ParseQuestions(ctx, ParserInput{RawTexts: normalizedTexts, Fallback: fallback})
	if err != nil || len(parsed.Questions) == 0 {
		return fallback, nil
	}
	if len(parsed.Questions) > MaxAIParsedQuestions {
		return fallback, nil
	}
	normalized := AIParseResponse{Questions: make([]AIParseQuestionItem, 0, len(parsed.Questions))}
	for _, item := range parsed.Questions {
		item = normalizeAIParseQuestionItem(item)
		if !validAIParseQuestionItem(item) {
			return fallback, nil
		}
		normalized.Questions = append(normalized.Questions, item)
	}
	return normalized, nil
}

// GenerateIsomorphicProblem creates a validated high-math variant from a small local template set.
func (s *Service) GenerateIsomorphicProblem(_ context.Context, request GenerateRequest) (GeneratedQuestion, error) {
	template := normalizeTemplate(request.Template)
	if template != "integral_power_exp" {
		return GeneratedQuestion{}, ErrBadRequest
	}
	ability := numutil.ClampFloat(request.Ability, 0, 1)
	targetDifficulty := ability
	if request.Difficulty != nil {
		targetDifficulty = numutil.ClampFloat(*request.Difficulty, 0, 1)
	}
	complexity := int(math.Round(1 + targetDifficulty*4))
	if complexity < 1 {
		complexity = 1
	}
	if complexity > 5 {
		complexity = 5
	}
	n := complexity
	a := 1 + int(math.Round(ability*3))
	if a < 1 {
		a = 1
	}
	if a > 5 {
		a = 5
	}
	difficulty := numutil.ClampFloat(0.18+0.13*float64(n)+0.05*float64(a-1), 0.2, 0.95)
	answer := integralPowerExpAnswer(n, a)
	body := fmt.Sprintf("计算不定积分：$\\int x^%d e^{%dx}\\,dx$。", n, a)
	if n == 1 {
		body = fmt.Sprintf("计算不定积分：$\\int x e^{%dx}\\,dx$。", a)
	}
	return GeneratedQuestion{
		Title:      fmt.Sprintf("指数函数与幂函数乘积积分变式 n=%d a=%d", n, a),
		Body:       body,
		Type:       "short_answer",
		Difficulty: difficulty,
		Answer:     answer,
		AnswerType: "expression",
		Hints: []string{
			"优先使用分部积分，并让幂函数次数逐步降低。",
			"每轮分部积分后检查指数函数积分系数。",
		},
		SolutionSteps: integralPowerExpSteps(n, a, answer),
		ConceptIDs:    normalizeStringSlice(request.ConceptIDs),
		Tags:          sliceutil.AppendUniqueNonEmptyStrings(normalizeStringSlice(request.Tags), "isomorphic", "template_validated"),
		Template:      template,
		Parameters:    map[string]int{"n": n, "a": a},
		Validation: GenerationValidation{
			HasClosedForm: true,
			InSyllabus:    n <= 5 && a >= 1 && a <= 5,
			Difficulty:    difficulty,
			Message:       "模板经分部积分递推校验，存在初等闭式解且参数未超出高等数学常见范围。",
		},
	}, nil
}

func normalizeListFilter(filter ListFilter) ListFilter {
	filter.Search = strings.TrimSpace(filter.Search)
	filter.Difficulty = strings.ToLower(strings.TrimSpace(filter.Difficulty))
	filter.Type = strings.ToLower(strings.TrimSpace(filter.Type))
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	filter.Group = strings.TrimSpace(filter.Group)
	filter.SortBy = strings.ToLower(strings.TrimSpace(filter.SortBy))
	filter.SortOrder = strings.ToLower(strings.TrimSpace(filter.SortOrder))
	filter.Tags = normalizeStringSlice(filter.Tags)
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.PageSize < 1 {
		filter.PageSize = 20
	}
	if filter.PageSize > 100 {
		filter.PageSize = 100
	}
	if filter.SortBy == "" {
		filter.SortBy = "created_at"
	}
	if filter.SortOrder != "asc" {
		filter.SortOrder = "desc"
	}
	return filter
}

func normalizeQuestionInput(input QuestionInput) QuestionInput {
	input.Title = strings.TrimSpace(input.Title)
	input.Body = strings.TrimSpace(input.Body)
	input.Type = normalizeQuestionType(input.Type)
	input.Answer = strings.TrimSpace(input.Answer)
	input.AnswerType = normalizeAnswerType(input.AnswerType)
	if input.Difficulty < 0 {
		input.Difficulty = 0
	}
	if input.Difficulty > 1 {
		input.Difficulty = 1
	}
	if input.EstimatedTimeSeconds < 0 {
		input.EstimatedTimeSeconds = 0
	}
	if input.EstimatedTimeSeconds == 0 {
		input.EstimatedTimeSeconds = 300
	}
	input.ConceptIDs = normalizeStringSlice(input.ConceptIDs)
	input.Tags = normalizeStringSlice(input.Tags)
	input.Hints = normalizeStringSlice(input.Hints)
	input.SolutionSteps = normalizeStringSlice(input.SolutionSteps)
	if input.Options != nil {
		options := normalizeStringSlice(*input.Options)
		input.Options = &options
		if input.Type == "multiple_choice" {
			if answer, ok := canonicalQuestionOption(options, input.Answer); ok {
				input.Answer = answer
			}
		}
	}
	return input
}

func conceptIDsOrUncategorized(conceptIDs []string) []string {
	conceptIDs = sliceutil.AppendUniqueNonEmptyStrings(nil, conceptIDs...)
	if len(conceptIDs) == 0 {
		return []string{learningconcept.UncategorizedID}
	}
	return conceptIDs
}

func (s *Service) requireConceptIDs(ctx context.Context, conceptIDs []string) error {
	exist, err := s.repo.ConceptIDsExist(ctx, conceptIDs)
	if err != nil {
		return err
	}
	if !exist {
		return ErrBadRequest
	}
	return nil
}

func normalizeQuestionUpdate(update QuestionUpdate) QuestionUpdate {
	if update.Title != nil {
		value := strings.TrimSpace(*update.Title)
		update.Title = &value
	}
	if update.Body != nil {
		value := strings.TrimSpace(*update.Body)
		update.Body = &value
	}
	if update.Type != nil {
		value := normalizeQuestionType(*update.Type)
		update.Type = &value
	}
	if update.AnswerType != nil {
		value := normalizeAnswerType(*update.AnswerType)
		update.AnswerType = &value
	}
	if update.Answer != nil {
		value := strings.TrimSpace(*update.Answer)
		update.Answer = &value
	}
	if update.Status != nil {
		value := strings.ToLower(strings.TrimSpace(*update.Status))
		update.Status = &value
	}
	if update.ConceptIDs != nil {
		values := normalizeStringSlice(*update.ConceptIDs)
		update.ConceptIDs = &values
	}
	if update.Tags != nil {
		values := normalizeStringSlice(*update.Tags)
		update.Tags = &values
	}
	if update.Hints != nil {
		values := normalizeStringSlice(*update.Hints)
		update.Hints = &values
	}
	if update.SolutionSteps != nil {
		values := normalizeStringSlice(*update.SolutionSteps)
		update.SolutionSteps = &values
	}
	if update.Options != nil {
		values := normalizeStringSlice(*update.Options)
		update.Options = &values
	}
	return update
}

func normalizeAIParseQuestionItem(item AIParseQuestionItem) AIParseQuestionItem {
	item.Title = strings.TrimSpace(item.Title)
	item.Body = strings.TrimSpace(item.Body)
	item.Type = normalizeQuestionType(item.Type)
	item.AnswerType = normalizeAnswerType(item.AnswerType)
	if item.Difficulty < 0 {
		item.Difficulty = 0
	}
	if item.Difficulty > 1 {
		item.Difficulty = 1
	}
	item.Answer = strings.TrimSpace(item.Answer)
	item.Options = normalizeStringSlice(item.Options)
	if item.Type == "multiple_choice" {
		if answer, ok := canonicalQuestionOption(item.Options, item.Answer); ok {
			item.Answer = answer
		}
	}
	item.Hints = normalizeStringSlice(item.Hints)
	item.SolutionSteps = normalizeStringSlice(item.SolutionSteps)
	item.Tags = normalizeStringSlice(item.Tags)
	return item
}

func validQuestionInput(input QuestionInput) bool {
	if !validRequiredString(input.Title, MaxQuestionTitleBytes) ||
		!validRequiredString(input.Body, MaxQuestionBodyBytes) ||
		!validStringBytes(input.Answer, MaxQuestionAnswerBytes) ||
		input.EstimatedTimeSeconds > MaxQuestionEstimatedTimeSeconds ||
		!validQuestionStringSlice(input.ConceptIDs) ||
		!validQuestionStringSlice(input.Tags) ||
		!validQuestionStringSlice(input.Hints) ||
		!validQuestionStringSlice(input.SolutionSteps) {
		return false
	}
	if input.Options != nil && !validQuestionStringSlice(*input.Options) {
		return false
	}
	if input.Type == "multiple_choice" && (input.Options == nil || !validMultipleChoiceAnswer(*input.Options, input.Answer)) {
		return false
	}
	return true
}

func validQuestionUpdate(update QuestionUpdate) bool {
	if update.Title != nil && !validRequiredString(*update.Title, MaxQuestionTitleBytes) {
		return false
	}
	if update.Body != nil && !validRequiredString(*update.Body, MaxQuestionBodyBytes) {
		return false
	}
	if update.Answer != nil && !validStringBytes(*update.Answer, MaxQuestionAnswerBytes) {
		return false
	}
	if update.Difficulty != nil && (*update.Difficulty < 0 || *update.Difficulty > 1) {
		return false
	}
	if update.EstimatedTimeSeconds != nil && (*update.EstimatedTimeSeconds < 0 || *update.EstimatedTimeSeconds > MaxQuestionEstimatedTimeSeconds) {
		return false
	}
	if update.ConceptIDs != nil && !validQuestionStringSlice(*update.ConceptIDs) {
		return false
	}
	if update.Tags != nil && !validQuestionStringSlice(*update.Tags) {
		return false
	}
	if update.Hints != nil && !validQuestionStringSlice(*update.Hints) {
		return false
	}
	if update.SolutionSteps != nil && !validQuestionStringSlice(*update.SolutionSteps) {
		return false
	}
	if update.Options != nil && !validQuestionStringSlice(*update.Options) {
		return false
	}
	return true
}

func validAIParseQuestionItem(item AIParseQuestionItem) bool {
	return validRequiredString(item.Title, MaxQuestionTitleBytes) &&
		validRequiredString(item.Body, MaxQuestionBodyBytes) &&
		validStringBytes(item.Answer, MaxQuestionAnswerBytes) &&
		validQuestionStringSlice(item.Options) &&
		validQuestionStringSlice(item.Hints) &&
		validQuestionStringSlice(item.SolutionSteps) &&
		validQuestionStringSlice(item.Tags) &&
		(item.Type != "multiple_choice" || validMultipleChoiceAnswer(item.Options, item.Answer))
}

func updateTouchesMultipleChoiceContract(update QuestionUpdate) bool {
	return update.Type != nil || update.Answer != nil || update.Options != nil ||
		(update.Status != nil && *update.Status == "published")
}

func (s *Service) normalizeMultipleChoiceUpdate(ctx context.Context, ownerID string, questionID string, update QuestionUpdate) (QuestionUpdate, error) {
	current, ok, err := s.repo.GetQuestion(ctx, ownerID, questionID)
	if err != nil {
		return QuestionUpdate{}, err
	}
	if !ok {
		return QuestionUpdate{}, ErrNotFound
	}
	questionType := strings.ToLower(strings.TrimSpace(current.Type))
	if questionType == "" {
		questionType = strings.ToLower(strings.TrimSpace(metautil.String(current.Meta, "type")))
	}
	answer := strings.TrimSpace(metautil.String(current.Meta, "answer"))
	options := metautil.StringSlice(current.Meta, "options")
	if update.Type != nil {
		questionType = *update.Type
	}
	if update.Answer != nil {
		answer = *update.Answer
	}
	if update.Options != nil {
		options = *update.Options
	}
	if questionType != "multiple_choice" {
		return update, nil
	}
	canonical, ok := canonicalQuestionOption(options, answer)
	if !ok {
		return QuestionUpdate{}, ErrBadRequest
	}
	update.Answer = &canonical
	return update, nil
}

func validMultipleChoiceAnswer(options []string, answer string) bool {
	_, ok := canonicalQuestionOption(options, answer)
	return ok
}

func canonicalQuestionOption(options []string, answer string) (string, bool) {
	label := strings.ToUpper(strings.TrimSpace(answer))
	if len(label) == 1 && label[0] >= 'A' && label[0] <= 'Z' {
		index := int(label[0] - 'A')
		if index < len(options) {
			return options[index], true
		}
	}
	normalizedAnswer := normalizeChoiceValue(answer)
	if normalizedAnswer == "" {
		return "", false
	}
	for _, option := range options {
		if normalizeChoiceValue(option) == normalizedAnswer {
			return option, true
		}
	}
	return "", false
}

var choiceWhitespaceReplacer = strings.NewReplacer(" ", "", "\t", "", "\n", "", "\r", "")

func normalizeChoiceValue(value string) string {
	return strings.ToLower(choiceWhitespaceReplacer.Replace(strings.TrimSpace(value)))
}

func validRequiredString(value string, maxBytes int) bool {
	return strings.TrimSpace(value) != "" && validStringBytes(value, maxBytes)
}

func validStringBytes(value string, maxBytes int) bool {
	return maxBytes <= 0 || len(value) <= maxBytes
}

func validQuestionStringSlice(values []string) bool {
	if len(values) > MaxQuestionListItems {
		return false
	}
	for _, value := range values {
		if !validStringBytes(value, MaxQuestionListItemBytes) {
			return false
		}
	}
	return true
}

func normalizeQuestionType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "multiple_choice", "proof":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "short_answer"
	}
}

func normalizeAnswerType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "numeric", "text":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "expression"
	}
}

func normalizeStringSlice(values []string) []string {
	if values == nil {
		return []string{}
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func normalizeIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func normalizeTemplate(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "integral_power_exp", "int_xn_eax", "power_exp_integral":
		return "integral_power_exp"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func integralPowerExpAnswer(n int, a int) string {
	terms := make([]string, 0, n+1)
	factorialN := factorial(n)
	for k := 0; k <= n; k++ {
		power := n - k
		numerator := factorialN / factorial(power)
		denominator := int(math.Pow(float64(a), float64(k+1)))
		sign := ""
		if k%2 == 1 {
			sign = "-"
		}
		terms = append(terms, formatPolynomialTerm(sign, numerator, denominator, power))
	}
	return fmt.Sprintf("e^{%dx}(%s) + C", a, joinPolynomialTerms(terms))
}

func integralPowerExpSteps(n int, a int, answer string) []string {
	return []string{
		"设 u=x^n, dv=e^{ax}dx，重复使用分部积分。",
		"每一次递推都会把 x 的次数降低 1，并额外乘上 1/a。",
		"当幂次降到 0 后得到指数函数的基础积分项。",
		"整理同类项得到 " + answer,
	}
}

func formatPolynomialTerm(sign string, numerator int, denominator int, power int) string {
	coefficient := ""
	switch {
	case denominator == 1:
		coefficient = fmt.Sprintf("%s%d", sign, numerator)
	case numerator == denominator:
		coefficient = sign + "1"
	default:
		coefficient = fmt.Sprintf("%s%d/%d", sign, numerator, denominator)
	}
	if coefficient == "1" && power > 0 {
		coefficient = ""
	}
	if coefficient == "-1" && power > 0 {
		coefficient = "-"
	}
	switch power {
	case 0:
		return coefficient
	case 1:
		return coefficient + "x"
	default:
		return coefficient + fmt.Sprintf("x^%d", power)
	}
}

func joinPolynomialTerms(terms []string) string {
	if len(terms) == 0 {
		return ""
	}
	result := terms[0]
	for _, term := range terms[1:] {
		if strings.HasPrefix(term, "-") {
			result += " - " + strings.TrimPrefix(term, "-")
			continue
		}
		result += " + " + term
	}
	return result
}

func factorial(value int) int {
	if value <= 1 {
		return 1
	}
	result := 1
	for i := 2; i <= value; i++ {
		result *= i
	}
	return result
}

func firstNonEmptyLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimFunc(line, func(r rune) bool {
			return unicode.IsSpace(r) || r == '#' || r == '-' || r == '*'
		})
		if line != "" {
			if len([]rune(line)) > 500 {
				runes := []rune(line)
				return string(runes[:500])
			}
			return line
		}
	}
	return ""
}
