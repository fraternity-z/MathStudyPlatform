package teacher

import (
	"context"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"mathstudy/backend/internal/application/learningrange"
	"mathstudy/backend/internal/platform/identifier"
	"mathstudy/backend/internal/platform/maputil"
	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/sliceutil"
	"mathstudy/backend/internal/platform/stringutil"
	"mathstudy/backend/internal/platform/timefmt"
)

var (
	// ErrNotFound is returned when a teacher-owned class or enrollment cannot be found.
	ErrNotFound = errors.New("teacher not found")
	// ErrStudentNotFound is returned when an enrolled student account cannot be found.
	ErrStudentNotFound = errors.New("student not found")
	// ErrBadRequest is returned when a request parameter is outside the supported contract.
	ErrBadRequest = errors.New("teacher bad request")
)

var dayLabels = []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}

const maxStudentListPage = 100

// Repository is the persistence surface required by teacher analytics use cases.
type Repository interface {
	ListAnalyticsStudents(context.Context, string, string, time.Time, time.Time) ([]AnalyticsStudentReadModel, bool, error)
	ListTeacherClassIDs(context.Context, string) ([]string, error)
	ListStudentsInClasses(context.Context, []string) ([]string, error)
	ListTeacherStudents(context.Context, string, StudentListFilter) ([]StudentListItem, int, error)
	CountActiveSessionsSince(context.Context, []string, time.Time) (int, error)
	AverageAttemptScore(context.Context, string, []string, *time.Time) (float64, bool, error)
	KnowledgeNames(context.Context, []string) (map[string]string, error)
	ClassOwnedByTeacher(context.Context, string, string) (bool, error)
	CommonErrors(context.Context, string, []string, int) ([]CommonErrorAggregate, error)
	LowScoreStudents(context.Context, string, []string, float64) (map[string]float64, error)
	ActiveStudentIDsSince(context.Context, []string, time.Time) (map[string]struct{}, error)
	StudentEnrollmentForTeacher(context.Context, string, string) (StudentEnrollment, bool, error)
	GetUser(context.Context, string) (UserInfo, bool, error)
	GetProfile(context.Context, string, string) (StudentProfile, bool, error)
	AverageStudentScore(context.Context, string, string) (float64, bool, error)
	RankByAverageScore(context.Context, string, []string) ([]StudentScore, error)
	LastSessionStartedAt(context.Context, string) (*time.Time, error)
	ListSessionDays(context.Context, string) ([]time.Time, error)
	AttemptConceptCounts(context.Context, string, string) (map[string]int, error)
	RecentAttempts(context.Context, string, string, int) ([]RecentAttempt, error)
	RecentSessions(context.Context, string, int) ([]RecentSession, error)
	RecentMistakes(context.Context, string, string, int) ([]StudentMistake, error)
}

// StudentProfile mirrors the teacher-facing fields stored in student_profiles.
type StudentProfile struct {
	StudentID             string
	MasteryVector         map[string]float64
	TotalExercises        int
	CorrectCount          int
	TotalStudyTimeMinutes int
}

// StudentScore stores one student's average score.
type StudentScore struct {
	StudentID string
	AvgScore  float64
}

// AnalyticsStudentReadModel combines the per-student inputs shared by teacher analytics views.
type AnalyticsStudentReadModel struct {
	StudentID          string
	DisplayName        string
	HasProfile         bool
	Profile            StudentProfile
	RangeScoreSum      float64
	RangeAttemptCount  int
	RangeSeconds       int
	AllScoreSum        float64
	AllAttemptCount    int
	WeeklySeconds      int
	WeeklySessionDates []string
}

// CommonErrorAggregate stores grouped diagnosis errors for a class.
type CommonErrorAggregate struct {
	Content   string
	Count     int
	Topic     string
	ErrorType string
}

// StudentEnrollment stores a teacher-owned student enrollment.
type StudentEnrollment struct {
	ClassID   string
	ClassName string
	JoinedAt  *time.Time
}

// UserInfo stores the user fields used by teacher analytics responses.
type UserInfo struct {
	ID          string
	Username    string
	Email       string
	DisplayName *string
}

// RecentAttempt stores one recent content attempt.
type RecentAttempt struct {
	ID        string
	IsCorrect bool
	Score     float64
	StartedAt time.Time
	Title     string
}

// RecentSession stores one recent learning session.
type RecentSession struct {
	ID        string
	StartedAt time.Time
	EndedAt   *time.Time
}

// DashboardStats is returned by /teacher/dashboard/stats.
type DashboardStats struct {
	TotalStudents     int      `json:"total_students"`
	ActiveToday       float64  `json:"active_today"`
	AvgCompletionRate *float64 `json:"avg_completion_rate"`
	PendingGrading    *int     `json:"pending_grading"`
}

// StudentsStats is returned by /teacher/students/stats.
type StudentsStats struct {
	TotalStudents int     `json:"total_students"`
	AvgScore      float64 `json:"avg_score"`
	ActiveToday   float64 `json:"active_today"`
	NeedAttention int     `json:"need_attention"`
}

// StudentListFilter stores teacher student list filters and pagination.
type StudentListFilter struct {
	ClassID  string
	Search   string
	Page     int
	PageSize int
}

// StudentListItem stores one teacher-facing student list row.
type StudentListItem struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	Email       string  `json:"email"`
	DisplayName *string `json:"display_name"`
	ClassID     string  `json:"class_id"`
	ClassName   string  `json:"class_name"`
}

// StudentListResponse is returned by /teacher/students.
type StudentListResponse struct {
	Items      []StudentListItem `json:"items"`
	Total      int               `json:"total"`
	Page       int               `json:"page"`
	PageSize   int               `json:"page_size"`
	TotalPages int               `json:"total_pages"`
}

// AnalyticsOverview stores the teacher analytics summary cards.
type AnalyticsOverview struct {
	TotalStudents     int     `json:"total_students"`
	AvgCompletionRate float64 `json:"avg_completion_rate"`
	AvgScore          float64 `json:"avg_score"`
	AvgStudyHours     float64 `json:"avg_study_hours"`
}

// KnowledgePointMastery stores aggregate concept mastery.
type KnowledgePointMastery struct {
	ConceptID    string  `json:"concept_id"`
	Name         string  `json:"name"`
	Mastery      float64 `json:"mastery"`
	StudentCount int     `json:"student_count"`
}

// WeeklyActivityItem stores one weekly activity chart point.
type WeeklyActivityItem struct {
	Date       string  `json:"date"`
	DayLabel   string  `json:"day_label"`
	ActiveRate float64 `json:"active_rate"`
}

// TopStudentItem stores one top student row.
type TopStudentItem struct {
	Rank      int     `json:"rank"`
	StudentID string  `json:"student_id"`
	Name      string  `json:"name"`
	AvgScore  float64 `json:"avg_score"`
}

// AnalyticsResponse is returned by /teacher/analytics.
type AnalyticsResponse struct {
	Overview        AnalyticsOverview       `json:"overview"`
	KnowledgePoints []KnowledgePointMastery `json:"knowledge_points"`
	WeeklyActivity  []WeeklyActivityItem    `json:"weekly_activity"`
	TopStudents     []TopStudentItem        `json:"top_students"`
}

// ClassAnalyticsStats stores class summary cards.
type ClassAnalyticsStats struct {
	AverageMastery   float64 `json:"average_mastery"`
	AverageScore     float64 `json:"average_score"`
	WeeklyStudyHours float64 `json:"weekly_study_hours"`
}

// ClassTopicMastery stores class concept mastery.
type ClassTopicMastery struct {
	ConceptID    string  `json:"concept_id"`
	Topic        string  `json:"topic"`
	Mastery      float64 `json:"mastery"`
	StudentCount int     `json:"student_count"`
}

// ClassCommonError stores a class common error row.
type ClassCommonError struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Count     int    `json:"count"`
	Topic     string `json:"topic"`
	ErrorType string `json:"error_type"`
}

// ClassAlert stores one teacher-facing class alert.
type ClassAlert struct {
	ID          string `json:"id"`
	StudentID   string `json:"student_id"`
	StudentName string `json:"student_name"`
	Type        string `json:"type"`
	Message     string `json:"message"`
	Severity    string `json:"severity"`
}

// ClassStudentRank stores a class ranking row.
type ClassStudentRank struct {
	StudentID string  `json:"student_id"`
	Name      string  `json:"name"`
	AvgScore  float64 `json:"avg_score"`
}

// ClassAnalyticsResponse is returned by /teacher/classes/{class_id}/analytics.
type ClassAnalyticsResponse struct {
	Stats           ClassAnalyticsStats `json:"stats"`
	TopicMastery    []ClassTopicMastery `json:"topic_mastery"`
	CommonErrors    []ClassCommonError  `json:"common_errors"`
	Alerts          []ClassAlert        `json:"alerts"`
	StudentRankings []ClassStudentRank  `json:"student_rankings"`
}

// StudentBasicInfo stores the student detail summary.
type StudentBasicInfo struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Username           string  `json:"username"`
	Email              string  `json:"email"`
	ClassName          string  `json:"class_name"`
	JoinedAt           *string `json:"joined_at"`
	LastActive         *string `json:"last_active"`
	TotalStudyHours    float64 `json:"total_study_hours"`
	TotalExercises     int     `json:"total_exercises"`
	CorrectRate        float64 `json:"correct_rate"`
	AvgScore           float64 `json:"avg_score"`
	Rank               int     `json:"rank"`
	TotalClassStudents int     `json:"total_class_students"`
	StreakDays         int     `json:"streak_days"`
}

// StudentTopicMastery stores one student concept mastery row.
type StudentTopicMastery struct {
	ConceptID     string  `json:"concept_id"`
	Topic         string  `json:"topic"`
	Mastery       float64 `json:"mastery"`
	ExerciseCount int     `json:"exercise_count"`
}

// StudentRecentActivity stores one activity feed row.
type StudentRecentActivity struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Content string `json:"content"`
	Time    string `json:"time"`
	Status  string `json:"status"`
}

// StudentMistake stores one recent mistake row.
type StudentMistake struct {
	ID          string  `json:"id"`
	Content     string  `json:"content"`
	ErrorType   string  `json:"error_type"`
	Date        string  `json:"date"`
	Explanation *string `json:"explanation"`
}

// StudentDetailResponse is returned by /teacher/students/{student_id}/detail.
type StudentDetailResponse struct {
	Student        StudentBasicInfo        `json:"student"`
	TopicMastery   []StudentTopicMastery   `json:"topic_mastery"`
	RecentActivity []StudentRecentActivity `json:"recent_activity"`
	RecentMistakes []StudentMistake        `json:"recent_mistakes"`
}

// Service implements teacher analytics read use cases.
type Service struct {
	repo      Repository
	now       func() time.Time
	idFactory func() (string, error)
}

// NewService creates a teacher service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("teacher repository is nil")
	}
	return &Service{
		repo:      repo,
		now:       time.Now,
		idFactory: defaultIDFactory,
	}, nil
}

// GetDashboardStats returns teacher dashboard card statistics.
func (s *Service) GetDashboardStats(ctx context.Context, teacherID string) (DashboardStats, error) {
	studentIDs, err := s.teacherStudentIDs(ctx, teacherID)
	if err != nil {
		return DashboardStats{}, err
	}
	total := len(studentIDs)
	if total == 0 {
		return DashboardStats{}, nil
	}
	active, err := s.repo.CountActiveSessionsSince(ctx, studentIDs, timefmt.StartOfDay(s.now()))
	if err != nil {
		return DashboardStats{}, err
	}
	return DashboardStats{
		TotalStudents: total,
		ActiveToday:   numutil.RoundPlaces(float64(active)/float64(total)*100, 1),
	}, nil
}

// GetStudentsStats returns teacher student-management card statistics.
func (s *Service) GetStudentsStats(ctx context.Context, teacherID string) (StudentsStats, error) {
	studentIDs, err := s.teacherStudentIDs(ctx, teacherID)
	if err != nil {
		return StudentsStats{}, err
	}
	total := len(studentIDs)
	if total == 0 {
		return StudentsStats{}, nil
	}
	avgScore, ok, err := s.repo.AverageAttemptScore(ctx, teacherID, studentIDs, nil)
	if err != nil {
		return StudentsStats{}, err
	}
	if !ok {
		avgScore = 0
	}
	todayActive, err := s.repo.CountActiveSessionsSince(ctx, studentIDs, timefmt.StartOfDay(s.now()))
	if err != nil {
		return StudentsStats{}, err
	}
	recentActive, err := s.repo.ActiveStudentIDsSince(ctx, studentIDs, s.now().AddDate(0, 0, -7))
	if err != nil {
		return StudentsStats{}, err
	}
	lowScoreStudents, err := s.repo.LowScoreStudents(ctx, teacherID, studentIDs, 60)
	if err != nil {
		return StudentsStats{}, err
	}
	needAttention := map[string]struct{}{}
	for studentID := range lowScoreStudents {
		needAttention[studentID] = struct{}{}
	}
	for _, studentID := range studentIDs {
		if _, ok := recentActive[studentID]; !ok {
			needAttention[studentID] = struct{}{}
		}
	}
	return StudentsStats{
		TotalStudents: total,
		AvgScore:      numutil.RoundPlaces(avgScore, 1),
		ActiveToday:   numutil.RoundPlaces(float64(todayActive)/float64(total)*100, 1),
		NeedAttention: len(needAttention),
	}, nil
}

// ListStudents returns a paginated teacher-owned student list.
func (s *Service) ListStudents(ctx context.Context, teacherID string, filter StudentListFilter) (StudentListResponse, error) {
	filter, err := normalizeStudentListFilter(filter)
	if err != nil {
		return StudentListResponse{}, err
	}
	items, total, err := s.repo.ListTeacherStudents(ctx, teacherID, filter)
	if err != nil {
		return StudentListResponse{}, err
	}
	return StudentListResponse{
		Items:      items,
		Total:      total,
		Page:       filter.Page,
		PageSize:   filter.PageSize,
		TotalPages: min(numutil.TotalPages(total, filter.PageSize), maxStudentListPage),
	}, nil
}

// GetAnalytics returns the full teacher analytics page.
func (s *Service) GetAnalytics(ctx context.Context, teacherID string, timeRange string) (AnalyticsResponse, error) {
	rangeStart, ok := s.timeRangeStart(timeRange)
	if !ok {
		return AnalyticsResponse{}, ErrBadRequest
	}
	now := s.now()
	students, _, err := s.repo.ListAnalyticsStudents(ctx, teacherID, "", rangeStart, now.AddDate(0, 0, -7))
	if err != nil {
		return AnalyticsResponse{}, err
	}
	total := len(students)
	if total == 0 {
		return emptyAnalytics(), nil
	}

	profiles := make([]StudentProfile, 0, total)
	var scoreSum float64
	var scoreCount int
	var totalSeconds int
	var activeStudents int
	for _, student := range students {
		if student.HasProfile {
			profiles = append(profiles, student.Profile)
		}
		scoreSum += student.RangeScoreSum
		scoreCount += student.RangeAttemptCount
		totalSeconds += student.RangeSeconds
		if student.RangeAttemptCount > 0 {
			activeStudents++
		}
	}
	knowledgePoints, err := s.analyticsKnowledgePoints(ctx, profiles)
	if err != nil {
		return AnalyticsResponse{}, err
	}
	weekly := weeklyActivityFromAnalyticsStudents(students, total, now)
	topStudents := topStudentsFromAnalyticsStudents(students, 5)
	return AnalyticsResponse{
		Overview: AnalyticsOverview{
			TotalStudents:     total,
			AvgCompletionRate: numutil.RoundPlaces(float64(activeStudents)/float64(total)*100, 1),
			AvgScore:          numutil.RoundPlaces(averageScore(scoreSum, scoreCount), 1),
			AvgStudyHours:     numutil.RoundPlaces(float64(totalSeconds)/float64(max(total, 1))/3600, 1),
		},
		KnowledgePoints: knowledgePoints,
		WeeklyActivity:  weekly,
		TopStudents:     topStudents,
	}, nil
}

// GetClassAnalytics returns analytics for a teacher-owned class.
func (s *Service) GetClassAnalytics(ctx context.Context, teacherID string, classID string) (ClassAnalyticsResponse, error) {
	classID = strings.TrimSpace(classID)
	now := s.now()
	weekStart := now.AddDate(0, 0, -7)
	students, owned, err := s.repo.ListAnalyticsStudents(ctx, teacherID, classID, now, weekStart)
	if err != nil {
		return ClassAnalyticsResponse{}, err
	}
	if !owned {
		return ClassAnalyticsResponse{}, ErrNotFound
	}
	total := len(students)
	if total == 0 {
		return emptyClassAnalytics(), nil
	}
	studentIDs := make([]string, 0, total)
	profiles := make([]StudentProfile, 0, total)
	var scoreSum float64
	var scoreCount int
	var seconds int
	for _, student := range students {
		studentIDs = append(studentIDs, student.StudentID)
		if student.HasProfile {
			profiles = append(profiles, student.Profile)
		}
		scoreSum += student.AllScoreSum
		scoreCount += student.AllAttemptCount
		seconds += student.WeeklySeconds
	}
	topicMastery, err := s.classTopicMastery(ctx, profiles)
	if err != nil {
		return ClassAnalyticsResponse{}, err
	}
	commonErrors, err := s.commonErrors(ctx, teacherID, studentIDs)
	if err != nil {
		return ClassAnalyticsResponse{}, err
	}
	alerts, err := s.classAlertsFromAnalyticsStudents(students)
	if err != nil {
		return ClassAnalyticsResponse{}, err
	}
	rankings := classRankingsFromAnalyticsStudents(students, 5)
	return ClassAnalyticsResponse{
		Stats: ClassAnalyticsStats{
			AverageMastery:   averageProfileMastery(profiles),
			AverageScore:     numutil.RoundPlaces(averageScore(scoreSum, scoreCount), 1),
			WeeklyStudyHours: numutil.RoundPlaces(float64(seconds)/float64(max(total, 1))/3600, 1),
		},
		TopicMastery:    topicMastery,
		CommonErrors:    commonErrors,
		Alerts:          alerts,
		StudentRankings: rankings,
	}, nil
}

// GetStudentDetail returns teacher-facing student detail data.
func (s *Service) GetStudentDetail(ctx context.Context, teacherID string, studentID string) (StudentDetailResponse, error) {
	enrollment, ok, err := s.repo.StudentEnrollmentForTeacher(ctx, teacherID, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	if !ok {
		return StudentDetailResponse{}, ErrNotFound
	}
	userInfo, ok, err := s.repo.GetUser(ctx, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	if !ok {
		return StudentDetailResponse{}, ErrStudentNotFound
	}
	profile, hasProfile, err := s.repo.GetProfile(ctx, teacherID, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	if !hasProfile {
		profile = StudentProfile{StudentID: studentID, MasteryVector: map[string]float64{}}
	}
	avgScore, scoreOK, err := s.repo.AverageStudentScore(ctx, teacherID, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	if !scoreOK {
		avgScore = 0
	}
	classStudentIDs, err := s.repo.ListStudentsInClasses(ctx, []string{enrollment.ClassID})
	if err != nil {
		return StudentDetailResponse{}, err
	}
	rank, err := s.studentRank(ctx, teacherID, studentID, classStudentIDs)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	lastActive, err := s.repo.LastSessionStartedAt(ctx, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	streakDays, err := s.streakDays(ctx, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	topicMastery, err := s.studentTopicMastery(ctx, teacherID, studentID, profile.MasteryVector)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	recentActivity, err := s.recentActivity(ctx, teacherID, studentID)
	if err != nil {
		return StudentDetailResponse{}, err
	}
	recentMistakes, err := s.repo.RecentMistakes(ctx, teacherID, studentID, 5)
	if err != nil {
		return StudentDetailResponse{}, err
	}

	var joinedAt *string
	if enrollment.JoinedAt != nil {
		value := timefmt.DateTimeMicros(*enrollment.JoinedAt)
		joinedAt = &value
	}
	var lastActiveText *string
	if lastActive != nil {
		value := timefmt.DateTimeMicros(*lastActive)
		lastActiveText = &value
	}
	return StudentDetailResponse{
		Student: StudentBasicInfo{
			ID:                 userInfo.ID,
			Name:               displayName(userInfo),
			Username:           userInfo.Username,
			Email:              userInfo.Email,
			ClassName:          enrollment.ClassName,
			JoinedAt:           joinedAt,
			LastActive:         lastActiveText,
			TotalStudyHours:    numutil.RoundPlaces(float64(profile.TotalStudyTimeMinutes)/60, 1),
			TotalExercises:     profile.TotalExercises,
			CorrectRate:        numutil.RoundPlaces(float64(profile.CorrectCount)/float64(max(profile.TotalExercises, 1))*100, 1),
			AvgScore:           numutil.RoundPlaces(avgScore, 1),
			Rank:               rank,
			TotalClassStudents: len(classStudentIDs),
			StreakDays:         streakDays,
		},
		TopicMastery:   topicMastery,
		RecentActivity: recentActivity,
		RecentMistakes: recentMistakes,
	}, nil
}

func normalizeStudentListFilter(filter StudentListFilter) (StudentListFilter, error) {
	filter.ClassID = strings.TrimSpace(filter.ClassID)
	filter.Search = strings.TrimSpace(filter.Search)
	if filter.Page == 0 {
		filter.Page = 1
	}
	if filter.PageSize == 0 {
		filter.PageSize = 20
	}
	if filter.Page < 1 || filter.Page > maxStudentListPage || filter.PageSize < 1 || filter.PageSize > 100 {
		return StudentListFilter{}, ErrBadRequest
	}
	return filter, nil
}

func (s *Service) teacherStudentIDs(ctx context.Context, teacherID string) ([]string, error) {
	classIDs, err := s.repo.ListTeacherClassIDs(ctx, teacherID)
	if err != nil {
		return nil, err
	}
	if len(classIDs) == 0 {
		return []string{}, nil
	}
	studentIDs, err := s.repo.ListStudentsInClasses(ctx, classIDs)
	if err != nil {
		return nil, err
	}
	return sliceutil.AppendUniqueNonEmptyStrings(studentIDs), nil
}

func (s *Service) timeRangeStart(timeRange string) (time.Time, bool) {
	now := s.now()
	switch strings.ToLower(strings.TrimSpace(timeRange)) {
	case "", "week":
		return now.AddDate(0, 0, -7), true
	case "today":
		return timefmt.StartOfDay(now), true
	case "month":
		return now.AddDate(0, 0, -30), true
	case "semester":
		return now.AddDate(0, 0, -180), true
	default:
		return time.Time{}, false
	}
}

func (s *Service) analyticsKnowledgePoints(ctx context.Context, profiles []StudentProfile) ([]KnowledgePointMastery, error) {
	agg := aggregateMastery(profiles)
	names, err := s.repo.KnowledgeNames(ctx, maputil.SortedStringKeys(agg))
	if err != nil {
		return nil, err
	}
	rows := sortedMasteryAgg(agg)
	limit := min(10, len(rows))
	items := make([]KnowledgePointMastery, 0, limit)
	for _, row := range rows[:limit] {
		items = append(items, KnowledgePointMastery{
			ConceptID:    row.conceptID,
			Name:         nameOrUnknown(names, row.conceptID),
			Mastery:      numutil.RoundPlaces(row.average()*100, 1),
			StudentCount: row.count,
		})
	}
	return items, nil
}

func (s *Service) classTopicMastery(ctx context.Context, profiles []StudentProfile) ([]ClassTopicMastery, error) {
	agg := aggregateMastery(profiles)
	names, err := s.repo.KnowledgeNames(ctx, maputil.SortedStringKeys(agg))
	if err != nil {
		return nil, err
	}
	rows := sortedMasteryAgg(agg)
	limit := min(10, len(rows))
	items := make([]ClassTopicMastery, 0, limit)
	for _, row := range rows[:limit] {
		items = append(items, ClassTopicMastery{
			ConceptID:    row.conceptID,
			Topic:        nameOrUnknown(names, row.conceptID),
			Mastery:      numutil.RoundPlaces(row.average(), 3),
			StudentCount: row.count,
		})
	}
	return items, nil
}

func averageScore(sum float64, count int) float64 {
	if count == 0 {
		return 0
	}
	return sum / float64(count)
}

func weeklyActivityFromAnalyticsStudents(students []AnalyticsStudentReadModel, total int, now time.Time) []WeeklyActivityItem {
	activity := make(map[string]int, 7)
	for _, student := range students {
		for _, date := range student.WeeklySessionDates {
			activity[date]++
		}
	}
	today := timefmt.StartOfDay(now)
	items := make([]WeeklyActivityItem, 0, 7)
	for offset := 6; offset >= 0; offset-- {
		day := today.AddDate(0, 0, -offset)
		count := activity[timefmt.Date(day)]
		rate := 0.0
		if total > 0 {
			rate = numutil.RoundPlaces(numutil.Percent(total, count), 1)
		}
		items = append(items, WeeklyActivityItem{
			Date:       timefmt.Date(day),
			DayLabel:   dayLabels[int(day.Weekday())],
			ActiveRate: rate,
		})
	}
	return items
}

func sortedAnalyticsStudentsByScore(students []AnalyticsStudentReadModel, limit int) []AnalyticsStudentReadModel {
	items := make([]AnalyticsStudentReadModel, 0, len(students))
	for _, student := range students {
		if student.AllAttemptCount > 0 {
			items = append(items, student)
		}
	}
	sort.Slice(items, func(i int, j int) bool {
		left := averageScore(items[i].AllScoreSum, items[i].AllAttemptCount)
		right := averageScore(items[j].AllScoreSum, items[j].AllAttemptCount)
		if left == right {
			return items[i].StudentID < items[j].StudentID
		}
		return left > right
	})
	return items[:min(limit, len(items))]
}

func topStudentsFromAnalyticsStudents(students []AnalyticsStudentReadModel, limit int) []TopStudentItem {
	ranked := sortedAnalyticsStudentsByScore(students, limit)
	items := make([]TopStudentItem, 0, len(ranked))
	for index, student := range ranked {
		items = append(items, TopStudentItem{
			Rank:      index + 1,
			StudentID: student.StudentID,
			Name:      stringutil.NonBlankOr(student.DisplayName, "未知"),
			AvgScore:  numutil.RoundPlaces(averageScore(student.AllScoreSum, student.AllAttemptCount), 1),
		})
	}
	return items
}

func classRankingsFromAnalyticsStudents(students []AnalyticsStudentReadModel, limit int) []ClassStudentRank {
	ranked := sortedAnalyticsStudentsByScore(students, limit)
	items := make([]ClassStudentRank, 0, len(ranked))
	for _, student := range ranked {
		items = append(items, ClassStudentRank{
			StudentID: student.StudentID,
			Name:      stringutil.NonBlankOr(student.DisplayName, "未知"),
			AvgScore:  numutil.RoundPlaces(averageScore(student.AllScoreSum, student.AllAttemptCount), 1),
		})
	}
	return items
}

func (s *Service) classAlertsFromAnalyticsStudents(students []AnalyticsStudentReadModel) ([]ClassAlert, error) {
	lowScoreStudents := map[string]float64{}
	activeStudents := map[string]struct{}{}
	names := make(map[string]string, len(students))
	for _, student := range students {
		names[student.StudentID] = student.DisplayName
		if student.AllAttemptCount > 0 {
			avgScore := averageScore(student.AllScoreSum, student.AllAttemptCount)
			if avgScore < 60 {
				lowScoreStudents[student.StudentID] = avgScore
			}
		}
		if len(student.WeeklySessionDates) > 0 {
			activeStudents[student.StudentID] = struct{}{}
		}
	}

	alerts := []ClassAlert{}
	for _, id := range maputil.SortedFloatKeys(lowScoreStudents) {
		alertID, err := s.idFactory()
		if err != nil {
			return nil, err
		}
		alerts = append(alerts, ClassAlert{
			ID:          alertID,
			StudentID:   id,
			StudentName: stringutil.NonBlankOr(names[id], "未知"),
			Type:        "low_score",
			Message:     "平均成绩 " + formatScore(lowScoreStudents[id]) + " 分，低于及格线",
			Severity:    "high",
		})
	}
	for _, student := range students {
		if _, low := lowScoreStudents[student.StudentID]; low {
			continue
		}
		if _, active := activeStudents[student.StudentID]; active {
			continue
		}
		alertID, err := s.idFactory()
		if err != nil {
			return nil, err
		}
		alerts = append(alerts, ClassAlert{
			ID:          alertID,
			StudentID:   student.StudentID,
			StudentName: stringutil.NonBlankOr(student.DisplayName, "未知"),
			Type:        "inactive",
			Message:     "超过 7 天未学习",
			Severity:    "medium",
		})
	}
	return alerts, nil
}

func (s *Service) commonErrors(ctx context.Context, teacherID string, studentIDs []string) ([]ClassCommonError, error) {
	rows, err := s.repo.CommonErrors(ctx, teacherID, studentIDs, 10)
	if err != nil {
		return nil, err
	}
	items := make([]ClassCommonError, 0, len(rows))
	for _, row := range rows {
		id, err := s.idFactory()
		if err != nil {
			return nil, err
		}
		items = append(items, ClassCommonError{
			ID:        id,
			Content:   row.Content,
			Count:     row.Count,
			Topic:     row.Topic,
			ErrorType: row.ErrorType,
		})
	}
	return items, nil
}

func (s *Service) studentRank(ctx context.Context, teacherID string, studentID string, classStudentIDs []string) (int, error) {
	rows, err := s.repo.RankByAverageScore(ctx, teacherID, classStudentIDs)
	if err != nil {
		return 0, err
	}
	for index, row := range rows {
		if row.StudentID == studentID {
			return index + 1, nil
		}
	}
	return 0, nil
}

func (s *Service) streakDays(ctx context.Context, studentID string) (int, error) {
	days, err := s.repo.ListSessionDays(ctx, studentID)
	if err != nil {
		return 0, err
	}
	active := make(map[string]struct{}, len(days))
	for _, day := range days {
		active[timefmt.Date(day)] = struct{}{}
	}
	current := timefmt.StartOfDay(s.now())
	streak := 0
	for {
		if _, ok := active[timefmt.Date(current)]; !ok {
			return streak, nil
		}
		streak++
		current = current.AddDate(0, 0, -1)
	}
}

func (s *Service) studentTopicMastery(ctx context.Context, teacherID string, studentID string, mastery map[string]float64) ([]StudentTopicMastery, error) {
	conceptIDs := maputil.SortedFloatKeysByValueDesc(mastery)
	names, err := s.repo.KnowledgeNames(ctx, conceptIDs)
	if err != nil {
		return nil, err
	}
	counts, err := s.repo.AttemptConceptCounts(ctx, teacherID, studentID)
	if err != nil {
		return nil, err
	}
	items := make([]StudentTopicMastery, 0, len(conceptIDs))
	for _, id := range conceptIDs {
		items = append(items, StudentTopicMastery{
			ConceptID:     id,
			Topic:         nameOrUnknown(names, id),
			Mastery:       numutil.RoundPlaces(mastery[id], 3),
			ExerciseCount: counts[id],
		})
	}
	return items, nil
}

func (s *Service) recentActivity(ctx context.Context, teacherID string, studentID string) ([]StudentRecentActivity, error) {
	attempts, err := s.repo.RecentAttempts(ctx, teacherID, studentID, 10)
	if err != nil {
		return nil, err
	}
	sessions, err := s.repo.RecentSessions(ctx, studentID, 5)
	if err != nil {
		return nil, err
	}
	type activityWithTime struct {
		item StudentRecentActivity
		at   time.Time
	}
	items := make([]activityWithTime, 0, len(attempts)+len(sessions))
	for _, attempt := range attempts {
		status := "warning"
		if attempt.IsCorrect {
			status = "success"
		}
		content := "完成\"" + stringutil.NonBlankOr(attempt.Title, "未知题目") + "\"练习"
		if attempt.Score != 0 {
			content += "，得分 " + formatScore(attempt.Score)
		}
		items = append(items, activityWithTime{
			item: StudentRecentActivity{
				ID:      attempt.ID,
				Type:    "exercise",
				Content: content,
				Time:    timefmt.DateTimeRFC3339(learningrange.InPlatformZone(attempt.StartedAt)),
				Status:  status,
			},
			at: attempt.StartedAt,
		})
	}
	for _, session := range sessions {
		content := "与 AI 导师对话"
		if session.EndedAt != nil {
			minutes := int(session.EndedAt.Sub(session.StartedAt).Minutes())
			content += " " + strconv.Itoa(minutes) + " 分钟"
		}
		items = append(items, activityWithTime{
			item: StudentRecentActivity{
				ID:      session.ID,
				Type:    "session",
				Content: content,
				Time:    timefmt.DateTimeMicros(session.StartedAt),
				Status:  "info",
			},
			at: session.StartedAt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].at.After(items[j].at)
	})
	limit := min(10, len(items))
	result := make([]StudentRecentActivity, 0, limit)
	for _, item := range items[:limit] {
		result = append(result, item.item)
	}
	return result, nil
}

func emptyAnalytics() AnalyticsResponse {
	return AnalyticsResponse{
		Overview:        AnalyticsOverview{},
		KnowledgePoints: []KnowledgePointMastery{},
		WeeklyActivity:  []WeeklyActivityItem{},
		TopStudents:     []TopStudentItem{},
	}
}

func emptyClassAnalytics() ClassAnalyticsResponse {
	return ClassAnalyticsResponse{
		Stats:           ClassAnalyticsStats{},
		TopicMastery:    []ClassTopicMastery{},
		CommonErrors:    []ClassCommonError{},
		Alerts:          []ClassAlert{},
		StudentRankings: []ClassStudentRank{},
	}
}

type masteryAgg struct {
	conceptID string
	total     float64
	count     int
}

func (m masteryAgg) average() float64 {
	if m.count == 0 {
		return 0
	}
	return m.total / float64(m.count)
}

func aggregateMastery(profiles []StudentProfile) map[string]masteryAgg {
	agg := map[string]masteryAgg{}
	for _, profile := range profiles {
		for conceptID, value := range profile.MasteryVector {
			current := agg[conceptID]
			current.conceptID = conceptID
			current.total += value
			current.count++
			agg[conceptID] = current
		}
	}
	return agg
}

func averageProfileMastery(profiles []StudentProfile) float64 {
	total := 0.0
	count := 0
	for _, profile := range profiles {
		for _, value := range profile.MasteryVector {
			total += value
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return numutil.RoundPlaces(total/float64(count), 3)
}

func sortedMasteryAgg(agg map[string]masteryAgg) []masteryAgg {
	rows := make([]masteryAgg, 0, len(agg))
	for _, row := range agg {
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		left := rows[i].average()
		right := rows[j].average()
		if left == right {
			return rows[i].conceptID < rows[j].conceptID
		}
		return left > right
	})
	return rows
}

func displayName(user UserInfo) string {
	if user.DisplayName != nil && strings.TrimSpace(*user.DisplayName) != "" {
		return *user.DisplayName
	}
	if user.Username != "" {
		return user.Username
	}
	return "未知"
}

func nameOrUnknown(names map[string]string, id string) string {
	if value := strings.TrimSpace(names[id]); value != "" {
		return value
	}
	return "未知知识点"
}

func formatScore(value float64) string {
	rounded := math.Round(value*10) / 10
	if rounded == math.Trunc(rounded) {
		return strconv.Itoa(int(rounded))
	}
	return strings.TrimRight(strings.TrimRight(strconv.FormatFloat(rounded, 'f', 1, 64), "0"), ".")
}

func defaultIDFactory() (string, error) {
	return identifier.NewUUID()
}
