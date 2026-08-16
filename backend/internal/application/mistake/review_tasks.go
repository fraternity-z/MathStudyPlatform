package mistake

import (
	"context"
	"strings"
	"time"

	"mathstudy/backend/internal/platform/numutil"
	"mathstudy/backend/internal/platform/ptrutil"
	"mathstudy/backend/internal/platform/sliceutil"
)

const (
	ReviewTaskViewDue      = "due"
	ReviewTaskViewMastered = "mastered"
	ReviewTaskPending      = "pending"
	ReviewTaskVerification = "verification_due"
	ReviewTaskMastered     = "mastered"
	ReviewTaskArchived     = "archived"
)

// ReviewTaskQuery selects one task view and page.
type ReviewTaskQuery struct {
	View          string
	Page          int
	PageSize      int
	Now           time.Time
	ConceptID     string
	ErrorType     string
	TaskID        string
	DueStatus     string
	Stage         *int
	ErrorCountMin int
	Status        string
	SortBy        string
	SortOrder     string
}

// ReviewTaskAssociation links a historical attempt to its aggregated review task.
type ReviewTaskAssociation struct {
	ID              string
	SourceAttemptID string
	Status          string
	Revision        int64
	DueAt           *time.Time
	MasteredAt      *time.Time
	ArchivedAt      *time.Time
}

// ReviewTaskRow is one persisted task plus its latest error evidence.
type ReviewTaskRow struct {
	Association           ReviewTaskAssociation
	SourceAttemptID       string
	SourceStudentAnswer   string
	DailyAssignmentID     string
	Stage                 int
	ReviewCount           int
	SuccessfulReviewCount int
	ErrorCount            int
	LastOutcome           *bool
	LastReviewedAt        *time.Time
	Content               Content
	Diagnosis             Diagnosis
	AvgMastery            float64
}

// ReviewTaskCounts drives the task tabs without issuing one request per view.
type ReviewTaskCounts struct {
	Active   int `json:"active"`
	DueNow   int `json:"due_now"`
	Mastered int `json:"mastered"`
}

// ReviewTaskListResponse is the paginated review-plan projection.
type ReviewTaskListResponse struct {
	Items      []ReviewTaskItem `json:"items"`
	Pagination PaginationInfo   `json:"pagination"`
	Counts     ReviewTaskCounts `json:"counts"`
}

// ReviewTaskItem is the student-facing review plan for one question.
type ReviewTaskItem struct {
	ID                    string           `json:"id"`
	SourceAttemptID       string           `json:"source_attempt_id"`
	Status                string           `json:"status"`
	Stage                 int              `json:"stage"`
	Revision              int64            `json:"revision"`
	ReviewCount           int              `json:"review_count"`
	SuccessfulReviewCount int              `json:"successful_review_count"`
	ErrorCount            int              `json:"error_count"`
	DueAt                 *string          `json:"due_at"`
	LastOutcome           *bool            `json:"last_outcome"`
	LastReviewedAt        *string          `json:"last_reviewed_at"`
	MasteredAt            *string          `json:"mastered_at"`
	IsDue                 bool             `json:"is_due"`
	CanReview             bool             `json:"can_review"`
	Exercise              MistakeExercise  `json:"exercise"`
	Diagnosis             MistakeDiagnosis `json:"diagnosis"`
	Mastery               MistakeMastery   `json:"mastery"`
}

// GetReviewTasks returns active or verified review plans.
func (s *Service) GetReviewTasks(ctx context.Context, userID string, query ReviewTaskQuery) (ReviewTaskListResponse, error) {
	query = normalizeReviewTaskQuery(query)
	now := s.now().UTC()
	query.Now = now
	rows, total, err := s.repo.ListReviewTasks(ctx, userID, query)
	if err != nil {
		return ReviewTaskListResponse{}, err
	}
	counts, err := s.repo.CountReviewTasks(ctx, userID, now)
	if err != nil {
		return ReviewTaskListResponse{}, err
	}
	knowledgeNames, err := s.knowledgeNames(ctx, contentsFromReviewTaskRows(rows))
	if err != nil {
		return ReviewTaskListResponse{}, err
	}
	items := make([]ReviewTaskItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, toReviewTaskItem(row, now, knowledgeNames))
	}
	return ReviewTaskListResponse{
		Items: items,
		Pagination: PaginationInfo{
			Page:       query.Page,
			PageSize:   query.PageSize,
			Total:      total,
			TotalPages: numutil.TotalPages(total, query.PageSize),
		},
		Counts: counts,
	}, nil
}

func normalizeReviewTaskQuery(query ReviewTaskQuery) ReviewTaskQuery {
	query.View = strings.ToLower(strings.TrimSpace(query.View))
	query.ConceptID = strings.TrimSpace(query.ConceptID)
	query.ErrorType = strings.TrimSpace(query.ErrorType)
	query.TaskID = strings.TrimSpace(query.TaskID)
	query.DueStatus = strings.ToLower(strings.TrimSpace(query.DueStatus))
	query.Status = strings.ToLower(strings.TrimSpace(query.Status))
	query.SortBy = strings.ToLower(strings.TrimSpace(query.SortBy))
	query.SortOrder = strings.ToLower(strings.TrimSpace(query.SortOrder))
	if query.View != ReviewTaskViewMastered {
		query.View = ReviewTaskViewDue
	}
	if query.DueStatus == "" {
		if query.View == ReviewTaskViewDue {
			query.DueStatus = "due"
		} else {
			query.DueStatus = "all"
		}
	}
	if query.DueStatus == "overdue" {
		query.DueStatus = "due"
	}
	if query.DueStatus == "upcoming" {
		query.DueStatus = "scheduled"
	}
	if query.DueStatus != "all" && query.DueStatus != "due" && query.DueStatus != "scheduled" {
		query.DueStatus = "all"
		if query.View == ReviewTaskViewDue {
			query.DueStatus = "due"
		}
	}
	if query.Stage != nil && (*query.Stage < 0 || *query.Stage > 3) {
		query.Stage = nil
	}
	if query.ErrorCountMin < 0 {
		query.ErrorCountMin = 0
	}
	switch query.Status {
	case "", ReviewTaskPending, ReviewTaskVerification, ReviewTaskMastered, ReviewTaskArchived:
	default:
		query.Status = ""
	}
	if query.SortBy != "due_at" && query.SortBy != "mastered_at" && query.SortBy != "error_count" && query.SortBy != "mastery" && query.SortBy != "stage" {
		if query.View == ReviewTaskViewMastered {
			query.SortBy = "mastered_at"
		} else {
			query.SortBy = "due_at"
		}
	}
	if query.SortOrder != "asc" && query.SortOrder != "desc" {
		switch query.SortBy {
		case "due_at", "mastery", "stage":
			query.SortOrder = "asc"
		default:
			query.SortOrder = "desc"
		}
	}
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 {
		query.PageSize = 20
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	return query
}

func toReviewTaskItem(row ReviewTaskRow, now time.Time, knowledgeNames map[string]string) ReviewTaskItem {
	due := row.Association.DueAt != nil && !now.Before(*row.Association.DueAt)
	canReview := strings.TrimSpace(row.SourceAttemptID) != ""
	return ReviewTaskItem{
		ID:                    row.Association.ID,
		SourceAttemptID:       row.SourceAttemptID,
		Status:                row.Association.Status,
		Stage:                 row.Stage,
		Revision:              row.Association.Revision,
		ReviewCount:           row.ReviewCount,
		SuccessfulReviewCount: row.SuccessfulReviewCount,
		ErrorCount:            row.ErrorCount,
		DueAt:                 optionalAttemptTimestamp(row.Association.DueAt),
		LastOutcome:           ptrutil.Clone(row.LastOutcome),
		LastReviewedAt:        optionalAttemptTimestamp(row.LastReviewedAt),
		MasteredAt:            optionalAttemptTimestamp(row.Association.MasteredAt),
		IsDue:                 due,
		CanReview:             canReview,
		Exercise: MistakeExercise{
			ID:                  row.Content.ID,
			Title:               nonEmpty(row.Content.Title, "无标题"),
			Content:             row.Content.Body,
			Difficulty:          row.Content.Difficulty,
			KnowledgePoints:     sliceutil.CloneStrings(row.Content.ConceptIDs),
			KnowledgePointNames: knowledgePointNames(row.Content, knowledgeNames),
		},
		Diagnosis: MistakeDiagnosis{
			ErrorType:       ptrutil.Clone(row.Diagnosis.ErrorType),
			ErrorSubtype:    row.Diagnosis.ErrorSubtype,
			Severity:        row.Diagnosis.Severity,
			Explanation:     row.Diagnosis.Explanation,
			Suggestion:      row.Diagnosis.Suggestion,
			RelatedConcepts: sliceutil.CloneStrings(row.Diagnosis.RelatedConceptIDs),
		},
		Mastery: MistakeMastery{
			Current:  row.AvgMastery,
			Previous: row.AvgMastery,
			Trend:    masteryTrend(row.AvgMastery),
		},
	}
}
