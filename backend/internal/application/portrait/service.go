package portrait

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"mathstudy/backend/internal/application/learningfeedback"
	"mathstudy/backend/internal/application/learningrange"
	"mathstudy/backend/internal/application/masteryprojection"
	"mathstudy/backend/internal/platform/maputil"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/ptrutil"
	"mathstudy/backend/internal/platform/timefmt"
)

// Repository is the persistence surface required by student portrait use cases.
type Repository interface {
	WithTx(context.Context, func(context.Context, Repository) error) error
	LockStudentTracking(context.Context, string) error
	GetProfile(context.Context, string) (Profile, bool, error)
	CreateProfile(context.Context, string, time.Time) (Profile, error)
	GetRangeStats(context.Context, string, time.Time, time.Time) (RangeStats, error)
	ListMasteryStates(context.Context, string) ([]MasteryState, error)
	SavePortrait(context.Context, string, string, string, time.Time, time.Time, int64) (Profile, bool, error)
	ClearPortrait(context.Context, string, time.Time, int64) (bool, error)
}

// RangeStats contains activity-derived fields for one report snapshot window.
type RangeStats struct {
	TotalExercises        int
	CorrectCount          int
	TotalStudyTimeMinutes int
	ErrorTendency         map[string]float64
	RecentConcepts        []string
}

// MasteryState contains the persisted inputs needed to project current DKT mastery.
type MasteryState struct {
	ConceptID     string
	Name          string
	Mastery       float64
	LastAttemptAt *time.Time
}

// Profile stores the learning counters and generated portrait fields.
type Profile struct {
	StudentID             string
	MasteryVector         map[string]float64
	ErrorTendency         map[string]float64
	PreferredDifficulty   float64
	LearningPace          float64
	TotalExercises        int
	CorrectCount          int
	TotalStudyTimeMinutes int
	RecentConcepts        []string
	PortraitContent       *string
	PortraitGeneratedAt   *time.Time
	PortraitRange         *string
	PortraitSnapshotAt    *time.Time
	PortraitVersion       int
	PortraitRevision      int64
}

// PortraitResponse is the Python-compatible GET /portrait response.
type PortraitResponse struct {
	StudentID             string  `json:"student_id"`
	PortraitContent       *string `json:"portrait_content"`
	PortraitGeneratedAt   *string `json:"portrait_generated_at"`
	PortraitRange         *string `json:"portrait_range"`
	PortraitSnapshotAt    *string `json:"portrait_snapshot_at"`
	PortraitVersion       int     `json:"portrait_version"`
	TotalExercises        int     `json:"total_exercises"`
	CorrectRate           float64 `json:"correct_rate"`
	TotalStudyTimeMinutes int     `json:"total_study_time_minutes"`
	HasContent            bool    `json:"has_content"`
}

// GenerateResponse is the Python-compatible POST /portrait/generate response.
type GenerateResponse struct {
	PortraitContent     string `json:"portrait_content"`
	PortraitGeneratedAt string `json:"portrait_generated_at"`
	PortraitRange       string `json:"portrait_range"`
	PortraitSnapshotAt  string `json:"portrait_snapshot_at"`
	PortraitVersion     int    `json:"portrait_version"`
}

// ClearResponse is the Python-compatible DELETE /portrait response.
type ClearResponse struct {
	Cleared bool   `json:"cleared"`
	Message string `json:"message"`
}

// ActivityWindowData contains only behavior observed inside the selected range.
type ActivityWindowData struct {
	RangeType             string
	StartDate             string
	EndDate               string
	SnapshotAt            time.Time
	TotalExercises        int
	CorrectCount          int
	TotalStudyTimeMinutes int
	ErrorTendency         map[string]float64
	RecentConcepts        []string
}

// MasterySnapshotData contains current DKT state, independent from the activity range.
type MasterySnapshotData struct {
	MasteryVector map[string]float64
	ConceptNames  map[string]string
}

// GeneratorInput keeps range activity and current mastery semantics explicit for LLM adapters.
type GeneratorInput struct {
	Activity         ActivityWindowData
	MasterySnapshot  MasterySnapshotData
	FallbackContent  string
	LearningFeedback []learningfeedback.Feedback
}

// Generator creates a narrative portrait from profile data.
type Generator interface {
	GeneratePortrait(context.Context, GeneratorInput) (string, error)
}

// ErrInvalidRange indicates that a portrait report range is unsupported.
var ErrInvalidRange = errors.New("invalid portrait range")

// ErrPortraitChanged indicates that a concurrent portrait operation won the revision race.
var ErrPortraitChanged = errors.New("portrait changed concurrently")

// Service implements student portrait read and maintenance use cases.
type Service struct {
	repo      Repository
	generator Generator
	now       func() time.Time
}

// Option customizes the portrait service.
type Option func(*Service)

// WithGenerator enables configurable LLM portrait generation with template fallback.
func WithGenerator(generator Generator) Option {
	return func(service *Service) {
		service.generator = generator
	}
}

// NewService creates a portrait service.
func NewService(repo Repository, options ...Option) (*Service, error) {
	if repo == nil {
		return nil, errors.New("portrait repository is nil")
	}
	service := &Service{repo: repo, now: time.Now}
	for _, option := range options {
		option(service)
	}
	return service, nil
}

// GetPortrait returns the current student's portrait, creating an empty profile when needed.
func (s *Service) GetPortrait(ctx context.Context, userID string) (PortraitResponse, error) {
	profile, err := s.ensureProfile(ctx, userID)
	if err != nil {
		return PortraitResponse{}, err
	}
	return toPortraitResponse(profile), nil
}

// GeneratePortrait builds and stores a profile-based portrait report.
func (s *Service) GeneratePortrait(ctx context.Context, userID string, rangeType string) (GenerateResponse, error) {
	if rangeType == "" {
		rangeType = string(learningrange.All)
	}
	kind, err := learningrange.Parse(rangeType)
	if err != nil {
		return GenerateResponse{}, ErrInvalidRange
	}
	profile, err := s.ensureProfile(ctx, userID)
	if err != nil {
		return GenerateResponse{}, err
	}

	snapshotNow := s.now()
	window := learningrange.Resolve(snapshotNow, kind)
	rangeStats, err := s.repo.GetRangeStats(ctx, userID, window.Start.UTC(), window.End.UTC())
	if err != nil {
		return GenerateResponse{}, err
	}
	masteryStates, err := s.repo.ListMasteryStates(ctx, userID)
	if err != nil {
		return GenerateResponse{}, err
	}
	currentMastery := maputil.CloneFloatMap(profile.MasteryVector)
	conceptNames := map[string]string{}
	for _, state := range masteryStates {
		currentMastery[state.ConceptID] = numutil.RoundPlaces(
			masteryprojection.Current(state.Mastery, state.LastAttemptAt, snapshotNow),
			4,
		)
		if state.Name != "" {
			conceptNames[state.ConceptID] = state.Name
		}
	}
	profile.TotalExercises = rangeStats.TotalExercises
	profile.CorrectCount = rangeStats.CorrectCount
	profile.TotalStudyTimeMinutes = rangeStats.TotalStudyTimeMinutes
	profile.ErrorTendency = rangeStats.ErrorTendency
	profile.RecentConcepts = rangeStats.RecentConcepts
	reportInput := GeneratorInput{
		Activity: ActivityWindowData{
			RangeType:             rangeType,
			StartDate:             timefmt.Date(window.Start),
			EndDate:               timefmt.Date(window.Today),
			SnapshotAt:            window.SnapshotAt,
			TotalExercises:        profile.TotalExercises,
			CorrectCount:          profile.CorrectCount,
			TotalStudyTimeMinutes: profile.TotalStudyTimeMinutes,
			ErrorTendency:         profile.ErrorTendency,
			RecentConcepts:        profile.RecentConcepts,
		},
		MasterySnapshot: MasterySnapshotData{
			MasteryVector: currentMastery,
			ConceptNames:  conceptNames,
		},
	}
	if reader, ok := s.repo.(learningfeedback.Reader); ok {
		sort.Slice(masteryStates, func(i, j int) bool {
			left := masteryprojection.Current(masteryStates[i].Mastery, masteryStates[i].LastAttemptAt, snapshotNow)
			right := masteryprojection.Current(masteryStates[j].Mastery, masteryStates[j].LastAttemptAt, snapshotNow)
			if left == right {
				return masteryStates[i].ConceptID < masteryStates[j].ConceptID
			}
			return left < right
		})
		ids := make([]string, 0, min(6, len(masteryStates)))
		if recentReader, ok := s.repo.(learningfeedback.RecentReader); ok {
			recent, err := recentReader.ReadRecentLearningFeedback(ctx, userID, snapshotNow)
			if err != nil {
				return GenerateResponse{}, err
			}
			for _, snapshot := range recent {
				ids = append(ids, snapshot.ConceptID)
			}
		}
		for _, state := range masteryStates[:min(6, len(masteryStates))] {
			found := false
			for _, id := range ids {
				found = found || id == state.ConceptID
			}
			if !found {
				ids = append(ids, state.ConceptID)
			}
		}
		snapshots, err := reader.ReadLearningFeedback(ctx, userID, ids, snapshotNow)
		if err != nil {
			return GenerateResponse{}, err
		}
		for _, id := range ids {
			if snapshot, ok := snapshots[id]; ok {
				reportInput.LearningFeedback = append(reportInput.LearningFeedback, learningfeedback.Build(snapshot, snapshotNow))
			}
		}
	}
	reportInput.FallbackContent = buildPortraitContent(reportInput)
	content := s.generatePortraitContent(ctx, reportInput)
	if err := ctx.Err(); err != nil {
		return GenerateResponse{}, err
	}
	generatedAt := learningrange.InPlatformZone(s.now())
	var saved Profile
	err = s.repo.WithTx(ctx, func(txCtx context.Context, repo Repository) error {
		if err := repo.LockStudentTracking(txCtx, userID); err != nil {
			return err
		}
		var (
			ok      bool
			saveErr error
		)
		saved, ok, saveErr = repo.SavePortrait(
			txCtx,
			userID,
			content,
			rangeType,
			generatedAt.UTC(),
			window.SnapshotAt.UTC(),
			profile.PortraitRevision,
		)
		if saveErr != nil {
			return saveErr
		}
		if !ok {
			return ErrPortraitChanged
		}
		return nil
	})
	if err != nil {
		return GenerateResponse{}, err
	}
	return GenerateResponse{
		PortraitContent:     ptrutil.ValueOrZero(saved.PortraitContent),
		PortraitGeneratedAt: timefmt.DateTimeRFC3339(generatedAt),
		PortraitRange:       rangeType,
		PortraitSnapshotAt:  timefmt.DateTimeRFC3339(window.SnapshotAt),
		PortraitVersion:     saved.PortraitVersion,
	}, nil
}

func (s *Service) generatePortraitContent(ctx context.Context, input GeneratorInput) string {
	if s.generator == nil {
		return input.FallbackContent
	}
	content, err := s.generator.GeneratePortrait(ctx, input)
	if err != nil {
		return input.FallbackContent
	}
	content = strings.TrimSpace(content)
	if content == "" {
		return input.FallbackContent
	}
	return content
}

// ClearPortrait removes generated portrait content for the current student.
func (s *Service) ClearPortrait(ctx context.Context, userID string) (ClearResponse, error) {
	profile, err := s.ensureProfile(ctx, userID)
	if err != nil {
		return ClearResponse{}, err
	}
	updatedAt := s.now().UTC()
	err = s.repo.WithTx(ctx, func(txCtx context.Context, repo Repository) error {
		if err := repo.LockStudentTracking(txCtx, userID); err != nil {
			return err
		}
		ok, err := repo.ClearPortrait(txCtx, userID, updatedAt, profile.PortraitRevision)
		if err != nil {
			return err
		}
		if !ok {
			return ErrPortraitChanged
		}
		return nil
	})
	if err != nil {
		return ClearResponse{}, err
	}
	return ClearResponse{Cleared: true, Message: "画像已清除"}, nil
}

func (s *Service) ensureProfile(ctx context.Context, userID string) (Profile, error) {
	profile, ok, err := s.repo.GetProfile(ctx, userID)
	if err != nil {
		return Profile{}, err
	}
	if ok {
		return normalizeProfile(profile), nil
	}
	profile, err = s.repo.CreateProfile(ctx, userID, s.now().UTC())
	if err != nil {
		return Profile{}, err
	}
	return normalizeProfile(profile), nil
}

func toPortraitResponse(profile Profile) PortraitResponse {
	return PortraitResponse{
		StudentID:             profile.StudentID,
		PortraitContent:       profile.PortraitContent,
		PortraitGeneratedAt:   optionalPlatformTimestamp(profile.PortraitGeneratedAt),
		PortraitRange:         profile.PortraitRange,
		PortraitSnapshotAt:    optionalPlatformTimestamp(profile.PortraitSnapshotAt),
		PortraitVersion:       profile.PortraitVersion,
		TotalExercises:        profile.TotalExercises,
		CorrectRate:           numutil.RoundPlaces(numutil.Ratio(profile.TotalExercises, profile.CorrectCount), 2),
		TotalStudyTimeMinutes: profile.TotalStudyTimeMinutes,
		HasContent:            profile.PortraitContent != nil,
	}
}

func optionalPlatformTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := timefmt.DateTimeRFC3339(learningrange.InPlatformZone(*value))
	return &formatted
}

func buildPortraitContent(input GeneratorInput) string {
	activity := input.Activity
	mastery := input.MasterySnapshot
	correctRate := numutil.Ratio(activity.TotalExercises, activity.CorrectCount)
	var builder strings.Builder
	builder.WriteString("# 学生画像分析报告\n\n")
	builder.WriteString(fmt.Sprintf("统计范围：%s 至 %s；行为数据截至 %s。\n\n", activity.StartDate, activity.EndDate, activity.SnapshotAt.Format(time.RFC3339)))
	builder.WriteString("## 范围内学习概况\n")
	builder.WriteString(fmt.Sprintf("- 练习次数: %d\n", activity.TotalExercises))
	builder.WriteString(fmt.Sprintf("- 正确次数: %d\n", activity.CorrectCount))
	builder.WriteString(fmt.Sprintf("- 正确率: %.0f%%\n", correctRate*100))
	builder.WriteString(fmt.Sprintf("- 学习时长: %d 分钟\n", activity.TotalStudyTimeMinutes))

	if len(mastery.MasteryVector) > 0 {
		builder.WriteString("\n## 当前知识点掌握状态\n")
		builder.WriteString("以下为生成报告时读取的当前累计 DKT 状态，不代表本范围内的新增掌握度。\n")
		for _, item := range sortedTop(mastery.MasteryVector, true, 10) {
			name := mastery.ConceptNames[item.key]
			if name == "" {
				name = item.key
			}
			builder.WriteString(fmt.Sprintf("- %s: %.0f%%\n", name, item.value*100))
		}
	}

	if len(activity.ErrorTendency) > 0 {
		builder.WriteString("\n## 范围内错误倾向\n")
		for _, item := range sortedTop(activity.ErrorTendency, false, 8) {
			builder.WriteString(fmt.Sprintf("- %s: %s 次\n", item.key, formatNumber(item.value)))
		}
	}

	if len(activity.RecentConcepts) > 0 {
		builder.WriteString("\n## 范围内近期学习重点\n")
		for _, concept := range activity.RecentConcepts {
			builder.WriteString(fmt.Sprintf("- %s\n", concept))
		}
	}

	builder.WriteString("\n## 改进建议\n")
	if len(input.LearningFeedback) > 0 {
		builder.WriteString("以下依据近30天最多20次作答的题目首答与间隔证据，独立于上方统计范围；仅将未记录本平台题目提示的全权重新题首答纳入验证。提示辅助和历史状态未知单独统计，平台无法确认其他帮助，题数完成不等于已经掌握。\n")
		for _, feedback := range input.LearningFeedback {
			builder.WriteString(fmt.Sprintf("- %s证据：未记录提示首答 %d/%d 正确；提示辅助首答 %d/%d 正确；提示状态未知 %d 道。\n", feedback.ConceptName, feedback.IndependentCorrect, feedback.IndependentAttempts, feedback.HintedCorrect, feedback.HintedAttempts, feedback.UnknownAssistanceAttempts))
			builder.WriteString(fmt.Sprintf("- %s：%s。%s 下一步：%s 验证标准：%s\n", feedback.ConceptName, feedback.Label, feedback.Reason, feedback.NextStep, feedback.SuccessCriterion))
		}
		return builder.String()
	}
	if activity.TotalExercises == 0 {
		builder.WriteString("- 先完成一组基础练习，积累可分析的学习记录。\n")
	} else if correctRate < 0.6 {
		builder.WriteString("- 优先复盘近期错题，针对低掌握知识点进行小步练习。\n")
	} else if correctRate < 0.85 {
		builder.WriteString("- 保持当前节奏，增加中等难度题目的稳定训练。\n")
	} else {
		builder.WriteString("- 可以提高题目难度，并开始总结解题方法迁移到综合题。\n")
	}
	return builder.String()
}

func normalizeProfile(profile Profile) Profile {
	if profile.MasteryVector == nil {
		profile.MasteryVector = map[string]float64{}
	}
	if profile.ErrorTendency == nil {
		profile.ErrorTendency = map[string]float64{}
	}
	if profile.RecentConcepts == nil {
		profile.RecentConcepts = []string{}
	}
	return profile
}

func formatNumber(value float64) string {
	if math.Abs(value-math.Round(value)) < 0.000001 {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%.2f", value)
}

type scoreItem struct {
	key   string
	value float64
}

func sortedTop(values map[string]float64, ascending bool, limit int) []scoreItem {
	items := make([]scoreItem, 0, len(values))
	for key, value := range values {
		items = append(items, scoreItem{key: key, value: value})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].value == items[j].value {
			return items[i].key < items[j].key
		}
		if ascending {
			return items[i].value < items[j].value
		}
		return items[i].value > items[j].value
	})
	if limit > 0 && len(items) > limit {
		return items[:limit]
	}
	return items
}
