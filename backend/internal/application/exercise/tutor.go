package exercise

import (
	"context"

	"mathstudy/backend/internal/platform/metautil"
)

// TutorExercise exposes only the question and verified submission state. Answer,
// solution and generated hints deliberately never cross this boundary.
type TutorExercise struct {
	ID                  string   `json:"id"`
	Source              string   `json:"source"`
	Title               string   `json:"title"`
	Content             string   `json:"content"`
	Options             []string `json:"options"`
	KnowledgePointNames []string `json:"knowledge_point_names"`
	Submitted           bool     `json:"submitted"`
}

func (s *Service) GetTutorExercise(ctx context.Context, studentID, exerciseID string) (TutorExercise, error) {
	question, err := s.authorizedExercise(ctx, studentID, exerciseID)
	if err != nil {
		return TutorExercise{}, err
	}
	submitted, err := s.repo.HasSubmittedAttempt(ctx, studentID, exerciseID)
	if err != nil {
		return TutorExercise{}, err
	}
	return TutorExercise{
		ID: question.ID, Source: exerciseSource(question), Title: question.Title, Content: question.Body,
		Options:             metautil.StringSlice(question.Meta, "options"),
		KnowledgePointNames: metautil.StringSlice(question.Meta, "knowledge_point_names"),
		Submitted:           submitted,
	}, nil
}
