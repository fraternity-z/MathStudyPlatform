package progress

import (
	"container/heap"
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"mathstudy/backend/internal/application/learningfeedback"
	"mathstudy/backend/internal/application/learningrange"
	"mathstudy/backend/internal/application/masteryprojection"
	"mathstudy/backend/internal/platform/maputil"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/timefmt"
)

const (
	// StreakLookbackDays matches the Python progress service lookback window.
	StreakLookbackDays = 365

	masteryThreshold = 0.85
	dktModelName     = "dkt-sakt-lite"
)

var (
	// ErrInvalidLearningGoal is returned when the requested target is empty.
	ErrInvalidLearningGoal = errors.New("invalid learning goal")
	// ErrLearningGoalTargetNotFound is returned when the requested knowledge node does not exist.
	ErrLearningGoalTargetNotFound = errors.New("learning goal target not found")
)

// Repository is the persistence surface required by progress use cases.
type Repository interface {
	GetProfile(context.Context, string) (StudentProfile, bool, error)
	GetOverviewSnapshot(context.Context, string, time.Time) (OverviewSnapshot, error)
	GetLearningGoal(context.Context, string) (LearningGoal, bool, error)
	UpsertLearningGoal(context.Context, string, string, time.Time) (LearningGoal, bool, error)
	GetAttemptTotals(context.Context, string) (int, int, error)
	SumStudySeconds(context.Context, string, *time.Time) (int, error)
	CountAttemptsStartedSince(context.Context, string, time.Time) (int, error)
	LatestAttemptStartedAt(context.Context, string) (*time.Time, error)
	ListSubmittedAttemptDays(context.Context, string, int) ([]time.Time, error)
	ListMasteryStates(context.Context, string, []string) ([]MasteryState, error)
	ListCourseConcepts(context.Context) ([]CourseConcept, error)
	ListPrerequisites(context.Context) ([]Prerequisite, error)
	ListLearningStatsByDay(context.Context, string, time.Time, time.Time) ([]PeriodStat, error)
	ListLearningStatsByWeek(context.Context, string, time.Time, time.Time) ([]PeriodStat, error)
	CountErrorsByType(context.Context, string, time.Time, time.Time) (map[string]int, error)
	ListClassStudentIDs(context.Context, string) ([]string, string, bool, error)
	AttemptStatsForStudents(context.Context, string, []string) (map[string]StudentAttemptStats, error)
	AttemptInsightsForStudents(context.Context, string, []string, time.Time, time.Time) (map[string]StudentAttemptInsight, error)
	MasteryStatesForStudents(context.Context, []string) ([]StudentMasteryInsight, error)
	CourseConceptNames(context.Context, []string) (map[string]string, error)
	ListPortraitActionProgresses(context.Context, string) (map[string]PortraitActionProgress, error)
	StartPortraitAction(context.Context, string, string, time.Time) (bool, error)
	DistinctChapters(context.Context) ([]string, error)
}

// StudentProfile mirrors the progress fields in student_profiles.
type StudentProfile struct {
	TotalExercises int
	CorrectCount   int
	MasteryVector  map[string]float64
}

// OverviewSnapshot combines profile fallback and attempt aggregates used by /progress/overview.
type OverviewSnapshot struct {
	TotalExercises int
	CorrectCount   int
	MasteryVector  map[string]float64
	TotalSeconds   int
	TodaySeconds   int
	TodayAttempts  int
	LatestAttempt  *time.Time
}

// LearningGoal stores one student's persisted target node.
type LearningGoal struct {
	TargetID  string
	UpdatedAt time.Time
}

// MasteryState stores DKT state used by read-side progress queries.
type MasteryState struct {
	ConceptID     string
	Mastery       float64
	Confidence    float64
	AttemptCount  int
	LastAttemptAt *time.Time
}

// CourseConcept is a read-only curriculum dimension used by learning evidence.
type CourseConcept struct {
	ID          string
	Name        string
	Description string
	Chapter     *string
	Difficulty  float64
}

type ConceptOption struct {
	ID      string  `json:"id"`
	Label   string  `json:"label"`
	Chapter *string `json:"chapter"`
}

// Prerequisite stores a curriculum requirement, not a personal note link.
type Prerequisite struct {
	SourceID string
	TargetID string
}

// PeriodStat stores one daily or weekly aggregate.
type PeriodStat struct {
	Date             time.Time
	Exercises        int
	CorrectExercises int
	StudySeconds     int
}

// StudentAttemptStats stores ranking inputs for one student.
type StudentAttemptStats struct {
	StudySeconds int
	AttemptCount int
}

// Overview is the /progress/overview response.
type Overview struct {
	TotalExercises   int            `json:"total_exercises"`
	CorrectCount     int            `json:"correct_count"`
	CorrectRate      float64        `json:"correct_rate"`
	StudyMinutes     int            `json:"study_time_minutes"`
	StreakDays       int            `json:"streak_days"`
	MasteredConcepts int            `json:"mastered_concepts"`
	TodayStats       TodayStats     `json:"today_stats"`
	RecentContent    *RecentContent `json:"recent_content"`
}

// TodayStats stores today's progress counters.
type TodayStats struct {
	StudyMinutes       int `json:"study_time_minutes"`
	ExercisesCompleted int `json:"exercises_completed"`
}

// RecentContent stores the latest attempt timestamp.
type RecentContent struct {
	LastAccessed string `json:"last_accessed"`
}

// MasteryResponse is the /progress/mastery response.
type MasteryResponse struct {
	Topics []MasteryTopic `json:"topics"`
	Model  string         `json:"model"`
}

// MasteryTopic stores one concept mastery row.
type MasteryTopic struct {
	Topic      string  `json:"topic"`
	Name       string  `json:"name"`
	Mastery    float64 `json:"mastery"`
	Exercises  int     `json:"exercises"`
	Confidence float64 `json:"confidence"`
}

// PathResponse is the /progress/path response.
type PathResponse struct {
	Path               []PathItem     `json:"path"`
	EstimatedExercises int            `json:"estimated_exercises"`
	Statistics         PathStatistics `json:"statistics"`
}

// PathItem stores one personalized learning path node.
type PathItem struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	Chapter        *string  `json:"chapter"`
	Status         string   `json:"status"`
	LockedBy       []string `json:"locked_by,omitempty"`
	Recommendation string   `json:"recommendation,omitempty"`
	Mastery        float64  `json:"mastery"`
	Confidence     float64  `json:"confidence"`
	Exercises      int      `json:"exercises"`
	Difficulty     float64  `json:"difficulty"`
}

// PathStatistics stores learning path aggregate counters.
type PathStatistics struct {
	Total     int     `json:"total"`
	Completed int     `json:"completed"`
	Progress  float64 `json:"progress"`
}

// LearningGoalResponse is the /progress/learning-goal response.
type LearningGoalResponse struct {
	TargetID  *string `json:"target_id"`
	UpdatedAt *string `json:"updated_at"`
}

// StatisticsResponse is the /progress/statistics response.
type StatisticsResponse struct {
	RangeDays             int                              `json:"range_days"`
	Interval              string                           `json:"interval"`
	StartDate             string                           `json:"start_date"`
	EndDate               string                           `json:"end_date"`
	Daily                 []DailyStat                      `json:"daily"`
	ErrorTypeDistribution map[string]ErrorTypeDistribution `json:"error_type_distribution"`
}

// DailyStat stores one daily or weekly chart point.
type DailyStat struct {
	Date             string `json:"date"`
	Exercises        int    `json:"exercises"`
	CorrectExercises int    `json:"correct_exercises"`
	StudyMinutes     int    `json:"study_minutes"`
}

// ErrorTypeDistribution stores error count and percentage.
type ErrorTypeDistribution struct {
	Count      int     `json:"count"`
	Percentage float64 `json:"percentage"`
}

// ClassRankingResponse is the /progress/class-ranking response.
type ClassRankingResponse struct {
	InClass           bool     `json:"in_class"`
	Available         bool     `json:"available"`
	UnavailableReason string   `json:"unavailable_reason,omitempty"`
	Rank              *int     `json:"rank"`
	Total             int      `json:"total"`
	Percentile        *float64 `json:"percentile"`
}

// Service implements student progress read use cases.
type Service struct {
	repo Repository
	now  func() time.Time
}

// NewService creates a progress service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("progress repository is nil")
	}
	return &Service{
		repo: repo,
		now:  time.Now,
	}, nil
}

// GetLearningGoal returns the student's current target, or null fields when none is set.
func (s *Service) GetLearningGoal(ctx context.Context, userID string) (LearningGoalResponse, error) {
	goal, found, err := s.repo.GetLearningGoal(ctx, userID)
	if err != nil {
		return LearningGoalResponse{}, err
	}
	if !found {
		return LearningGoalResponse{}, nil
	}
	return learningGoalResponse(goal), nil
}

// SetLearningGoal replaces the student's current target.
func (s *Service) SetLearningGoal(ctx context.Context, userID, targetID string) (LearningGoalResponse, error) {
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return LearningGoalResponse{}, ErrInvalidLearningGoal
	}
	goal, found, err := s.repo.UpsertLearningGoal(ctx, userID, targetID, s.now())
	if err != nil {
		return LearningGoalResponse{}, err
	}
	if !found {
		return LearningGoalResponse{}, ErrLearningGoalTargetNotFound
	}
	return learningGoalResponse(goal), nil
}

func learningGoalResponse(goal LearningGoal) LearningGoalResponse {
	targetID := goal.TargetID
	updatedAt := timefmt.DateTimeMicros(goal.UpdatedAt)
	return LearningGoalResponse{TargetID: &targetID, UpdatedAt: &updatedAt}
}

// GetOverview returns the student learning progress overview.
func (s *Service) GetOverview(ctx context.Context, userID string) (Overview, error) {
	now := s.now()
	snapshot, err := s.repo.GetOverviewSnapshot(ctx, userID, learningrange.StartOfPlatformDayUTC(now))
	if err != nil {
		return Overview{}, err
	}

	mastery, _, _, err := s.masteryDetails(ctx, userID, snapshot.MasteryVector, nil)
	if err != nil {
		return Overview{}, err
	}
	masteredConcepts := 0
	for _, value := range mastery {
		if value >= masteryThreshold {
			masteredConcepts++
		}
	}

	streakDays, err := s.calculateStreakDays(ctx, userID)
	if err != nil {
		return Overview{}, err
	}

	var recent *RecentContent
	if snapshot.LatestAttempt != nil {
		recent = &RecentContent{LastAccessed: timefmt.DateTimeRFC3339(learningrange.InPlatformZone(*snapshot.LatestAttempt))}
	}

	return Overview{
		TotalExercises:   snapshot.TotalExercises,
		CorrectCount:     snapshot.CorrectCount,
		CorrectRate:      numutil.RoundPlaces(numutil.Percent(snapshot.TotalExercises, snapshot.CorrectCount), 1),
		StudyMinutes:     snapshot.TotalSeconds / 60,
		StreakDays:       streakDays,
		MasteredConcepts: masteredConcepts,
		TodayStats: TodayStats{
			StudyMinutes:       snapshot.TodaySeconds / 60,
			ExercisesCompleted: snapshot.TodayAttempts,
		},
		RecentContent: recent,
	}, nil
}

// GetMasteryVector returns the concept mastery vector.
func (s *Service) GetMasteryVector(ctx context.Context, userID string) (MasteryResponse, error) {
	profile, _, err := s.repo.GetProfile(ctx, userID)
	if err != nil {
		return MasteryResponse{}, err
	}
	mastery, confidence, attempts, err := s.masteryDetails(ctx, userID, profile.MasteryVector, nil)
	if err != nil {
		return MasteryResponse{}, err
	}

	keys := maputil.SortedFloatKeys(mastery)
	names, err := s.repo.CourseConceptNames(ctx, keys)
	if err != nil {
		return MasteryResponse{}, err
	}
	topics := make([]MasteryTopic, 0, len(keys))
	for _, key := range keys {
		name := names[key]
		if name == "" {
			name = key
		}
		topics = append(topics, MasteryTopic{
			Topic:      key,
			Name:       name,
			Mastery:    mastery[key],
			Exercises:  attempts[key],
			Confidence: confidence[key],
		})
	}
	return MasteryResponse{Topics: topics, Model: dktModelName}, nil
}

// GetLearningPath returns a personalized learning path.
func (s *Service) GetLearningPath(ctx context.Context, userID string, target string) (PathResponse, error) {
	profile, _, err := s.repo.GetProfile(ctx, userID)
	if err != nil {
		return PathResponse{}, err
	}
	mastery, confidence, attempts, err := s.masteryDetails(ctx, userID, profile.MasteryVector, nil)
	if err != nil {
		return PathResponse{}, err
	}

	nodes, err := s.repo.ListCourseConcepts(ctx)
	if err != nil {
		return PathResponse{}, err
	}
	relations, err := s.repo.ListPrerequisites(ctx)
	if err != nil {
		return PathResponse{}, err
	}

	nodeMap := make(map[string]CourseConcept)
	for _, node := range nodes {
		nodeMap[node.ID] = node
	}
	if len(nodeMap) == 0 {
		return PathResponse{Path: []PathItem{}, Statistics: PathStatistics{}}, nil
	}

	prereqEdges := make(map[string]map[string]struct{}, len(nodeMap))
	dependents := make(map[string]map[string]struct{}, len(nodeMap))
	for id := range nodeMap {
		prereqEdges[id] = map[string]struct{}{}
		dependents[id] = map[string]struct{}{}
	}
	for _, rel := range relations {
		if _, ok := nodeMap[rel.SourceID]; !ok {
			continue
		}
		if _, ok := nodeMap[rel.TargetID]; !ok {
			continue
		}
		prereqEdges[rel.SourceID][rel.TargetID] = struct{}{}
		dependents[rel.TargetID][rel.SourceID] = struct{}{}
	}

	sortedIDs := topologicalLearningOrder(nodeMap, prereqEdges, dependents, mastery)
	// Path completion and prerequisite unlocking use the same evidence floor as portraits.
	verifiedMastery := map[string]float64{}
	if reader, ok := s.repo.(learningfeedback.Reader); ok {
		now := s.now()
		for start := 0; start < len(sortedIDs); start += 12 {
			snapshots, err := reader.ReadLearningFeedback(ctx, userID, sortedIDs[start:min(start+12, len(sortedIDs))], now)
			if err != nil {
				return PathResponse{}, err
			}
			for id, snapshot := range snapshots {
				if learningfeedback.Build(snapshot, now).Stage == "transfer" {
					verifiedMastery[id] = mastery[id]
				}
			}
		}
	}
	if target != "" {
		targetNodes := selectTargetNodes(target, nodeMap)
		if len(targetNodes) > 0 {
			needed := collectLearningSubgraph(targetNodes, prereqEdges, verifiedMastery)
			filtered := make([]string, 0, len(sortedIDs))
			for _, id := range sortedIDs {
				if _, ok := needed[id]; ok {
					filtered = append(filtered, id)
				}
			}
			sortedIDs = filtered
		}
	}

	path := make([]PathItem, 0, len(sortedIDs))
	completed := 0
	estimatedRemaining := 0
	for _, id := range sortedIDs {
		node := nodeMap[id]
		masteryValue := mastery[id]
		confidenceValue := confidence[id]
		exerciseCount := attempts[id]
		lockedBy := lockedPrerequisites(id, prereqEdges, verifiedMastery, confidence)
		status := learningNodeStatus(id, lockedBy, verifiedMastery, confidenceValue, exerciseCount)
		if status == "completed" {
			completed++
		} else if remaining := 5 - exerciseCount; remaining > 0 {
			estimatedRemaining += remaining
		}
		path = append(path, PathItem{
			ID:             id,
			Title:          node.Name,
			Description:    node.Description,
			Chapter:        node.Chapter,
			Status:         status,
			LockedBy:       lockedBy,
			Recommendation: learningRecommendation(status),
			Mastery:        numutil.RoundPlaces(masteryValue, 4),
			Confidence:     numutil.RoundPlaces(confidenceValue, 4),
			Exercises:      exerciseCount,
			Difficulty:     node.Difficulty,
		})
	}

	return PathResponse{
		Path:               path,
		EstimatedExercises: estimatedRemaining,
		Statistics: PathStatistics{
			Total:     len(path),
			Completed: completed,
			Progress:  numutil.RoundPlaces(float64(completed)/float64(max(len(path), 1)), 2),
		},
	}, nil
}

// GetStatistics returns learning activity statistics.
func (s *Service) GetStatistics(ctx context.Context, userID string, rangeType string) (StatisticsResponse, error) {
	kind := learningrange.ParseOrDefault(rangeType, learningrange.Week)
	window := learningrange.Resolve(s.now(), kind)
	var rows []PeriodStat
	var err error
	if window.Interval == learningrange.DayInterval {
		rows, err = s.repo.ListLearningStatsByDay(ctx, userID, window.Start.UTC(), window.End.UTC())
	} else {
		rows, err = s.repo.ListLearningStatsByWeek(ctx, userID, window.Start.UTC(), window.End.UTC())
	}
	if err != nil {
		return StatisticsResponse{}, err
	}

	daily := buildDailyStats(window.Interval, window.Start, window.Today, window.Days, rows)
	errorCounts, err := s.repo.CountErrorsByType(ctx, userID, window.Start.UTC(), window.End.UTC())
	if err != nil {
		return StatisticsResponse{}, err
	}
	distribution := buildErrorDistribution(errorCounts)

	return StatisticsResponse{
		RangeDays:             window.Days,
		Interval:              window.Interval,
		StartDate:             timefmt.Date(window.Start),
		EndDate:               timefmt.Date(window.Today),
		Daily:                 daily,
		ErrorTypeDistribution: distribution,
	}, nil
}

// GetClassRanking returns the current student's class ranking.
func (s *Service) GetClassRanking(ctx context.Context, userID string) (ClassRankingResponse, error) {
	studentIDs, teacherID, inClass, err := s.repo.ListClassStudentIDs(ctx, userID)
	if err != nil {
		return ClassRankingResponse{}, err
	}
	if !inClass {
		return ClassRankingResponse{InClass: false, Available: false, Total: 0, UnavailableReason: "未加入班级"}, nil
	}
	if len(studentIDs) == 0 {
		return ClassRankingResponse{InClass: true, Available: false, Total: 0, UnavailableReason: "班级暂无学生"}, nil
	}

	stats, err := s.repo.AttemptStatsForStudents(ctx, teacherID, studentIDs)
	if err != nil {
		return ClassRankingResponse{}, err
	}
	rankingRows := make([]rankingRow, 0, len(studentIDs))
	for _, id := range studentIDs {
		stat := stats[id]
		rankingRows = append(rankingRows, rankingRow{
			StudentID:    id,
			StudySeconds: stat.StudySeconds,
			AttemptCount: stat.AttemptCount,
		})
	}
	sort.Slice(rankingRows, func(i, j int) bool {
		if rankingRows[i].StudySeconds == rankingRows[j].StudySeconds {
			return rankingRows[i].AttemptCount > rankingRows[j].AttemptCount
		}
		return rankingRows[i].StudySeconds > rankingRows[j].StudySeconds
	})

	studentStat := stats[userID]
	if studentStat.AttemptCount == 0 {
		return ClassRankingResponse{
			InClass:           true,
			Available:         false,
			UnavailableReason: "完成课程练习后可查看排名",
			Total:             len(rankingRows),
		}, nil
	}
	if len(rankingRows) < 2 {
		return ClassRankingResponse{
			InClass:           true,
			Available:         false,
			UnavailableReason: "班级人数不足，暂不提供排名",
			Total:             len(rankingRows),
		}, nil
	}
	rank := 1
	lowerPeers := 0
	for _, row := range rankingRows {
		if row.StudentID == userID {
			continue
		}
		if row.StudySeconds > studentStat.StudySeconds ||
			(row.StudySeconds == studentStat.StudySeconds && row.AttemptCount > studentStat.AttemptCount) {
			rank++
		}
		if row.StudySeconds < studentStat.StudySeconds ||
			(row.StudySeconds == studentStat.StudySeconds && row.AttemptCount < studentStat.AttemptCount) {
			lowerPeers++
		}
	}
	total := len(rankingRows)
	percentile := 0.0
	if total > 1 {
		percentile = numutil.RoundPlaces(float64(lowerPeers)/float64(total-1)*100, 1)
	}
	return ClassRankingResponse{
		InClass:    true,
		Available:  true,
		Rank:       &rank,
		Total:      total,
		Percentile: &percentile,
	}, nil
}

func (s *Service) GetCourseConcepts(ctx context.Context) ([]ConceptOption, error) {
	concepts, err := s.repo.ListCourseConcepts(ctx)
	if err != nil {
		return nil, err
	}
	options := make([]ConceptOption, 0, len(concepts))
	for _, concept := range concepts {
		options = append(options, ConceptOption{ID: concept.ID, Label: concept.Name, Chapter: concept.Chapter})
	}
	return options, nil
}

// GetChapters returns distinct curriculum chapters.
func (s *Service) GetChapters(ctx context.Context) ([]string, error) {
	return s.repo.DistinctChapters(ctx)
}

func (s *Service) masteryDetails(ctx context.Context, userID string, fallback map[string]float64, conceptIDs []string) (map[string]float64, map[string]float64, map[string]int, error) {
	mastery := maputil.CloneFloatMap(fallback)
	confidence := map[string]float64{}
	attempts := map[string]int{}

	states, err := s.repo.ListMasteryStates(ctx, userID, conceptIDs)
	if err != nil {
		return nil, nil, nil, err
	}
	now := s.now()
	for _, state := range states {
		rawMastery := masteryprojection.Current(state.Mastery, state.LastAttemptAt, now)
		mastery[state.ConceptID] = numutil.RoundPlaces(rawMastery, 4)
		confidence[state.ConceptID] = numutil.RoundPlaces(state.Confidence, 4)
		attempts[state.ConceptID] = state.AttemptCount
	}

	for _, conceptID := range conceptIDs {
		if _, ok := mastery[conceptID]; !ok {
			mastery[conceptID] = 0.5
		}
	}
	return mastery, confidence, attempts, nil
}

func (s *Service) calculateStreakDays(ctx context.Context, userID string) (int, error) {
	days, err := s.repo.ListSubmittedAttemptDays(ctx, userID, StreakLookbackDays)
	if err != nil {
		return 0, err
	}
	if len(days) == 0 {
		return 0, nil
	}
	activeDays := make(map[string]struct{}, len(days))
	for _, day := range days {
		activeDays[timefmt.Date(day)] = struct{}{}
	}
	streak := 0
	current := timefmt.StartOfDay(learningrange.InPlatformZone(s.now()))
	for {
		if _, ok := activeDays[timefmt.Date(current)]; !ok {
			return streak, nil
		}
		streak++
		current = current.AddDate(0, 0, -1)
	}
}

func topologicalLearningOrder(nodes map[string]CourseConcept, prereqEdges, dependents map[string]map[string]struct{}, mastery map[string]float64) []string {
	inDegree := make(map[string]int, len(nodes))
	pq := &learningHeap{}
	for id := range nodes {
		inDegree[id] = len(prereqEdges[id])
		if inDegree[id] == 0 {
			heap.Push(pq, learningHeapItem{id: id, mastery: mastery[id]})
		}
	}

	heap.Init(pq)
	sortedIDs := make([]string, 0, len(nodes))
	seen := make(map[string]struct{}, len(nodes))
	for pq.Len() > 0 {
		item := heap.Pop(pq).(learningHeapItem)
		sortedIDs = append(sortedIDs, item.id)
		seen[item.id] = struct{}{}
		for dependent := range dependents[item.id] {
			inDegree[dependent]--
			if inDegree[dependent] == 0 {
				heap.Push(pq, learningHeapItem{id: dependent, mastery: mastery[dependent]})
			}
		}
	}

	remaining := make([]string, 0, len(nodes)-len(sortedIDs))
	for id := range nodes {
		if _, ok := seen[id]; !ok {
			remaining = append(remaining, id)
		}
	}
	sort.Slice(remaining, func(i, j int) bool {
		left := mastery[remaining[i]]
		right := mastery[remaining[j]]
		if left == right {
			return remaining[i] < remaining[j]
		}
		return left < right
	})
	return append(sortedIDs, remaining...)
}

func collectPrerequisites(target string, prereqEdges map[string]map[string]struct{}) map[string]struct{} {
	needed := map[string]struct{}{}
	stack := []string{target}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, ok := needed[current]; ok {
			continue
		}
		needed[current] = struct{}{}
		for prereq := range prereqEdges[current] {
			stack = append(stack, prereq)
		}
	}
	return needed
}

func selectTargetNodes(target string, nodes map[string]CourseConcept) []string {
	normalized := normalizeTarget(target)
	if normalized == "" {
		return nil
	}
	if _, ok := nodes[target]; ok {
		return []string{target}
	}
	selected := []string{}
	for id, node := range nodes {
		if strings.Contains(normalizeTarget(node.Name), normalized) ||
			strings.Contains(normalizeTarget(node.Description), normalized) ||
			(node.Chapter != nil && strings.Contains(normalizeTarget(*node.Chapter), normalized)) {
			selected = append(selected, id)
		}
	}
	sort.Strings(selected)
	return selected
}

func collectLearningSubgraph(targets []string, prereqEdges map[string]map[string]struct{}, mastery map[string]float64) map[string]struct{} {
	needed := map[string]struct{}{}
	for _, target := range targets {
		if mastery[target] < masteryThreshold {
			for id := range collectPrerequisites(target, prereqEdges) {
				needed[id] = struct{}{}
			}
			continue
		}
		for prereq := range prereqEdges[target] {
			if mastery[prereq] < masteryThreshold {
				for id := range collectPrerequisites(prereq, prereqEdges) {
					needed[id] = struct{}{}
				}
			}
		}
	}
	if len(needed) == 0 {
		for _, target := range targets {
			needed[target] = struct{}{}
		}
	}
	return needed
}

func lockedPrerequisites(id string, prereqEdges map[string]map[string]struct{}, mastery map[string]float64, confidence map[string]float64) []string {
	locked := []string{}
	for prereq := range prereqEdges[id] {
		if mastery[prereq] < masteryThreshold || confidence[prereq] < 0.5 {
			locked = append(locked, prereq)
		}
	}
	sort.Strings(locked)
	return locked
}

func learningNodeStatus(id string, lockedBy []string, mastery map[string]float64, confidence float64, exercises int) string {
	if mastery[id] >= masteryThreshold && confidence >= 0.5 {
		return "completed"
	}
	if len(lockedBy) > 0 {
		return "locked"
	}
	if exercises > 0 {
		return "current"
	}
	return "available"
}

func learningRecommendation(status string) string {
	switch status {
	case "locked":
		return "先完成先修节点的微课视频和基础练习"
	case "current":
		return "继续进行当前知识点的针对性练习"
	case "available":
		return "可以开始该知识点的入门练习"
	default:
		return ""
	}
}

func buildDailyStats(interval string, startDate time.Time, today time.Time, rangeDays int, rows []PeriodStat) []DailyStat {
	statsByDate := make(map[string]PeriodStat, len(rows))
	for _, row := range rows {
		statsByDate[timefmt.Date(row.Date)] = row
	}

	if interval == "day" {
		daily := make([]DailyStat, 0, rangeDays)
		for i := 0; i < rangeDays; i++ {
			day := startDate.AddDate(0, 0, i)
			if day.After(today) {
				break
			}
			row := statsByDate[timefmt.Date(day)]
			daily = append(daily, DailyStat{
				Date:             timefmt.Date(day),
				Exercises:        row.Exercises,
				CorrectExercises: row.CorrectExercises,
				StudyMinutes:     row.StudySeconds / 60,
			})
		}
		return daily
	}

	firstMonday := startDate.AddDate(0, 0, -weekdayMondayIndex(startDate))
	daily := make([]DailyStat, 0, 53)
	for i := 0; i < 53; i++ {
		weekStart := firstMonday.AddDate(0, 0, i*7)
		if weekStart.After(today) {
			break
		}
		displayDate := weekStart
		if displayDate.Before(startDate) {
			displayDate = startDate
		}
		row := statsByDate[timefmt.Date(weekStart)]
		daily = append(daily, DailyStat{
			Date:             timefmt.Date(displayDate),
			Exercises:        row.Exercises,
			CorrectExercises: row.CorrectExercises,
			StudyMinutes:     row.StudySeconds / 60,
		})
	}
	return daily
}

func buildErrorDistribution(errorCounts map[string]int) map[string]ErrorTypeDistribution {
	total := 0
	for _, count := range errorCounts {
		total += count
	}
	distribution := make(map[string]ErrorTypeDistribution, len(errorCounts))
	for key, count := range errorCounts {
		percentage := 0.0
		if total > 0 {
			percentage = numutil.RoundPlaces(numutil.Percent(total, count), 1)
		}
		distribution[key] = ErrorTypeDistribution{Count: count, Percentage: percentage}
	}
	return distribution
}

func weekdayMondayIndex(value time.Time) int {
	weekday := int(value.Weekday())
	if weekday == 0 {
		return 6
	}
	return weekday - 1
}

func normalizeTarget(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
}

type rankingRow struct {
	StudentID    string
	StudySeconds int
	AttemptCount int
}

type learningHeapItem struct {
	id      string
	mastery float64
}

type learningHeap []learningHeapItem

func (h learningHeap) Len() int {
	return len(h)
}

func (h learningHeap) Less(i int, j int) bool {
	if h[i].mastery == h[j].mastery {
		return h[i].id < h[j].id
	}
	return h[i].mastery < h[j].mastery
}

func (h learningHeap) Swap(i int, j int) {
	h[i], h[j] = h[j], h[i]
}

func (h *learningHeap) Push(item any) {
	*h = append(*h, item.(learningHeapItem))
}

func (h *learningHeap) Pop() any {
	old := *h
	item := old[len(old)-1]
	*h = old[:len(old)-1]
	return item
}
