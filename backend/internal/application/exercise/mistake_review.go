package exercise

import (
	"context"
	"time"
)

const (
	MistakeReviewPending         = "pending"
	MistakeReviewVerificationDue = "verification_due"
	MistakeReviewMastered        = "mastered"
	MistakeReviewArchived        = "archived"
	mistakeReviewSuccessTarget   = 3
)

func (attempt AttemptRecord) needsReview() bool {
	return !attempt.IsCorrect || attempt.ProcessEvaluation.Status == "incorrect"
}

// MistakeReviewTask is the exercise-side state needed to update one review plan atomically.
type MistakeReviewTask struct {
	ID                       string
	StudentID                string
	ContentID                string
	SourceAttemptID          string
	DailyAssignmentID        string
	Status                   string
	Stage                    int
	ReviewCount              int
	SuccessfulReviewCount    int
	ErrorCount               int
	DueAt                    *time.Time
	LastReviewAttemptID      string
	LastOutcome              *bool
	LastReviewedAt           *time.Time
	MasteredAt               *time.Time
	ArchivedAt               *time.Time
	Revision                 int64
	CreatedAt                time.Time
	UpdatedAt                time.Time
	Exercise                 Exercise
	DailyCorrectionAvailable bool
}

func classifyMistakeReviewSubmission(task MistakeReviewTask, expectedRevision int64, now time.Time) (bool, error) {
	if task.Status == MistakeReviewArchived {
		return false, ErrMistakeRecordArchived
	}
	if task.ID == "" || task.Revision != expectedRevision {
		return false, ErrReviewTaskStale
	}
	switch task.Status {
	case MistakeReviewPending, MistakeReviewVerificationDue:
		if task.DueAt == nil {
			return false, ErrBadRequest
		}
		return !now.Before(*task.DueAt), nil
	case MistakeReviewMastered:
		return false, nil
	default:
		return false, ErrBadRequest
	}
}

func (s *Service) updateMistakeReviewTask(
	ctx context.Context,
	repo Repository,
	lockedTask MistakeReviewTask,
	attempt AttemptRecord,
	attemptExercise Exercise,
	scheduledReview bool,
	now time.Time,
) (int64, error) {
	task := lockedTask
	boundTask := task.ID != ""
	found := boundTask
	if !found {
		var err error
		task, found, err = repo.GetMistakeReviewTaskByContentForUpdate(ctx, attempt.StudentID, attempt.ContentID)
		if err != nil {
			return 0, err
		}
	}
	if !found {
		if !attempt.needsReview() {
			return 0, nil
		}
		errorCount, err := repo.CountIncorrectAttempts(ctx, attempt.StudentID, attempt.ContentID)
		if err != nil {
			return 0, err
		}
		created := newMistakeReviewTask(attempt, attemptExercise, errorCount, now)
		return created.Revision, repo.InsertMistakeReviewTask(ctx, created)
	}
	if task.StudentID != attempt.StudentID || task.ContentID != attempt.ContentID {
		return 0, ErrBadRequest
	}
	activeTask := task.Status == MistakeReviewPending || task.Status == MistakeReviewVerificationDue
	dailyCorrection := activeTask &&
		task.DailyAssignmentID != "" &&
		task.DailyAssignmentID == attempt.DailyAssignmentID &&
		(!boundTask || task.DailyCorrectionAvailable)
	countAsReview := scheduledReview || dailyCorrection
	if !attempt.needsReview() && !countAsReview && !boundTask {
		return task.Revision, nil
	}
	updated := applyMistakeReviewOutcome(task, attempt, attemptExercise, now, countAsReview, boundTask)
	return updated.Revision, repo.UpdateMistakeReviewTask(ctx, updated)
}

func newMistakeReviewTask(attempt AttemptRecord, exercise Exercise, errorCount int, now time.Time) MistakeReviewTask {
	dueAt := now.Add(24 * time.Hour)
	incorrect := false
	if errorCount < 1 {
		errorCount = 1
	}
	return MistakeReviewTask{
		ID:                    attempt.ID,
		StudentID:             attempt.StudentID,
		ContentID:             attempt.ContentID,
		SourceAttemptID:       attempt.ID,
		DailyAssignmentID:     attempt.DailyAssignmentID,
		Status:                MistakeReviewPending,
		Stage:                 0,
		ReviewCount:           0,
		SuccessfulReviewCount: 0,
		ErrorCount:            errorCount,
		DueAt:                 &dueAt,
		LastOutcome:           &incorrect,
		Exercise:              cloneReviewExercise(exercise),
		CreatedAt:             now,
		UpdatedAt:             now,
	}
}

func applyMistakeReviewOutcome(
	task MistakeReviewTask,
	attempt AttemptRecord,
	exercise Exercise,
	now time.Time,
	countAsReview bool,
	boundTask bool,
) MistakeReviewTask {
	task.Revision++
	task.LastOutcome = boolPointer(!attempt.needsReview())
	task.UpdatedAt = now
	if boundTask || countAsReview {
		task.LastReviewAttemptID = attempt.ID
		task.LastReviewedAt = timePointer(now)
	}
	if countAsReview {
		task.ReviewCount++
	}
	// Keep the submitted review accessible without treating an unverified
	// process as success. A fresh exposure must wait before another due review.
	if !attempt.needsReview() && !attempt.ProcessEvaluation.permitsMastery() {
		task.LastOutcome = nil
		if countAsReview {
			task.DueAt = timePointer(now.Add(24 * time.Hour))
		}
		return task
	}

	if attempt.needsReview() {
		if !boundTask && !countAsReview {
			task.LastReviewAttemptID = ""
			task.LastReviewedAt = nil
		}
		task.SourceAttemptID = attempt.ID
		task.DailyAssignmentID = attempt.DailyAssignmentID
		task.Exercise = cloneReviewExercise(exercise)
		task.Status = MistakeReviewPending
		task.Stage = 0
		task.SuccessfulReviewCount = 0
		task.ErrorCount++
		task.DueAt = timePointer(now.Add(24 * time.Hour))
		task.MasteredAt = nil
		task.ArchivedAt = nil
		return task
	}
	if !countAsReview {
		return task
	}

	task.ArchivedAt = nil
	if task.Status == MistakeReviewMastered {
		return task
	}

	task.SuccessfulReviewCount++
	task.Stage = task.SuccessfulReviewCount
	if task.SuccessfulReviewCount >= mistakeReviewSuccessTarget {
		task.Status = MistakeReviewMastered
		task.Stage = mistakeReviewSuccessTarget
		task.DueAt = nil
		task.MasteredAt = timePointer(now)
		return task
	}

	task.Status = MistakeReviewVerificationDue
	interval := 3 * 24 * time.Hour
	if task.SuccessfulReviewCount == 2 {
		interval = 7 * 24 * time.Hour
	}
	task.DueAt = timePointer(now.Add(interval))
	task.MasteredAt = nil
	return task
}

func cloneReviewExercise(exercise Exercise) Exercise {
	return Exercise{
		ID:                   exercise.ID,
		OwnerTeacherID:       exercise.OwnerTeacherID,
		GeneratedByStudentID: exercise.GeneratedByStudentID,
		Status:               exercise.Status,
		Title:                exercise.Title,
		Body:                 exercise.Body,
		Difficulty:           exercise.Difficulty,
		ConceptIDs:           append([]string(nil), exercise.ConceptIDs...),
		Meta:                 cloneAnyMap(exercise.Meta),
	}
}

func cloneAnyMap(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func timePointer(value time.Time) *time.Time {
	return &value
}

func boolPointer(value bool) *bool {
	return &value
}
