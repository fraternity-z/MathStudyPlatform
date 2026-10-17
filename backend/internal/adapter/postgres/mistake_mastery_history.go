package postgres

import (
	"context"

	mistakeapp "mathstudy/backend/internal/application/mistake"
)

// ReadMasteryHistory reconstructs measurements from committed submission snapshots.
// Old attempts without saved mastery updates remain unknown; scores are never used as probabilities.
func (r MistakeRepository) ReadMasteryHistory(ctx context.Context, userID string, conceptIDs []string) (map[string]mistakeapp.MasteryHistory, error) {
	result := map[string]mistakeapp.MasteryHistory{}
	if len(conceptIDs) == 0 {
		return result, nil
	}
	rows, err := r.DB().Query(ctx, `SELECT concept.id, measurement.mastery
		FROM unnest($2::varchar[]) concept(id)
		CROSS JOIN LATERAL (
			SELECT (snapshot.response->'mastery_update'->>concept.id)::double precision AS mastery,
				ca.submitted_at, ca.id AS attempt_id
			FROM public.content_attempts ca
			CROSS JOIN LATERAL (SELECT coalesce(ca.regular_submission_response::jsonb,
				ca.review_submission_response::jsonb, ca.mistake_redo_submission_response::jsonb,
				ca.daily_submission_response::jsonb) AS response) snapshot
			WHERE ca.student_id = $1 AND ca.submitted_at <= (now() AT TIME ZONE 'UTC')
				AND ca.mastery_weight > 0
				AND jsonb_typeof(snapshot.response->'mastery_update'->concept.id) = 'number'
			ORDER BY ca.submitted_at DESC, ca.id DESC LIMIT 2
		) measurement
		ORDER BY concept.id, measurement.submitted_at DESC, measurement.attempt_id DESC`, userID, conceptIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var value float64
		if err := rows.Scan(&id, &value); err != nil {
			return nil, err
		}
		if entry, ok := result[id]; ok {
			entry.Previous = &value
			result[id] = entry
		} else {
			result[id] = mistakeapp.MasteryHistory{Current: value}
		}
	}
	return result, rows.Err()
}
