package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"mathstudy/backend/internal/application/learningfeedback"
)

var _ learningfeedback.Reader = Repository{}

// ReadLearningFeedback shares one student-scoped snapshot across portrait and practice reads.
// Mutable content, student answers and free-form diagnosis prose are deliberately excluded.
func (r Repository) ReadLearningFeedback(ctx context.Context, userID string, conceptIDs []string, asOf time.Time) (map[string]learningfeedback.Snapshot, error) {
	result := map[string]learningfeedback.Snapshot{}
	if strings.TrimSpace(userID) == "" || asOf.IsZero() || len(conceptIDs) > 12 {
		return nil, errors.New("learning feedback requires a student, snapshot time and at most 12 concepts")
	}
	if len(conceptIDs) == 0 {
		return result, nil
	}
	rows, err := r.DB().Query(ctx, learningFeedbackQuery, userID, conceptIDs, asOf.UTC(), learningfeedback.WindowDays, learningfeedback.AttemptLimit)
	if err != nil {
		return nil, fmt.Errorf("read learning feedback: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var snapshot learningfeedback.Snapshot
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &snapshot); err != nil {
			return nil, fmt.Errorf("decode learning feedback: %w", err)
		}
		result[snapshot.ConceptID] = snapshot
	}
	return result, rows.Err()
}

func (r Repository) ReadRecentLearningFeedback(ctx context.Context, userID string, asOf time.Time) ([]learningfeedback.Snapshot, error) {
	rows, err := r.DB().Query(ctx, `SELECT concept.id
		FROM public.content_attempts ca
		CROSS JOIN LATERAL jsonb_array_elements_text(CASE
			WHEN jsonb_typeof(ca.review_question_concept_ids::jsonb) = 'array' THEN ca.review_question_concept_ids::jsonb
			ELSE '[]'::jsonb END) concept(id)
		WHERE ca.student_id = $1 AND ca.submitted_at <= $2
			AND ca.submitted_at >= $2::timestamp - interval '30 days'
		GROUP BY concept.id
		ORDER BY max(ca.submitted_at) DESC, concept.id
		LIMIT 6`, userID, asOf.UTC())
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	snapshots, err := r.ReadLearningFeedback(ctx, userID, ids, asOf)
	if err != nil {
		return nil, err
	}
	result := make([]learningfeedback.Snapshot, 0, len(ids))
	for _, id := range ids {
		if snapshot, ok := snapshots[id]; ok {
			result = append(result, snapshot)
		}
	}
	return result, nil
}

const learningFeedbackQuery = `
SELECT json_build_object(
	'concept_id', kn.id, 'name', kn.name,
	'mastery', state.mastery_prob, 'confidence', coalesce(state.confidence, 0),
	'lifetime_attempts', coalesce(state.attempt_count, 0),
	'last_attempt_at', to_char(state.last_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'attempts', coalesce(evidence.attempts, '[]'::json)
)
FROM public.course_concepts kn
LEFT JOIN public.student_concept_dkt_states state
	ON state.student_id = $1 AND state.concept_id = kn.id
	AND state.last_attempt_at <= $3::timestamp
LEFT JOIN LATERAL (
	SELECT json_agg(json_build_object(
		'id', recent.id, 'content_id', recent.content_id,
		'body', left(recent.review_question_body, 1200),
		'correct', recent.is_correct, 'mastery_weight', recent.mastery_weight,
		'assistance_status', recent.assistance_status,
		'process_status', coalesce(recent.process_evaluation->>'status', 'unknown'),
		'first_attempt', recent.evidence_kind <> 'repeat_practice' AND NOT EXISTS (
			SELECT 1 FROM public.content_attempts prior
			WHERE prior.student_id = $1 AND prior.content_id = recent.content_id
				AND prior.submitted_at IS NOT NULL
				AND (prior.submitted_at, prior.id) < (recent.submitted_at, recent.id)
		),
		'error_type', coalesce(diagnosis.error_type, ''),
		'error_subtype', coalesce(diagnosis.error_subtype, ''),
		'submitted_at', to_char(recent.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
	) ORDER BY recent.submitted_at DESC, recent.id DESC) AS attempts
	FROM (
		SELECT ca.id, ca.content_id, ca.review_question_body, ca.is_correct,
			ca.mastery_weight, ca.assistance_status, ca.submitted_at, ca.evidence_kind, ca.process_evaluation
		FROM public.content_attempts ca
		WHERE ca.student_id = $1
			AND ca.submitted_at >= $3::timestamp - make_interval(days => $4)
			AND ca.submitted_at <= $3::timestamp
			AND ca.review_question_concept_ids::jsonb @> jsonb_build_array(kn.id)
		ORDER BY ca.submitted_at DESC, ca.id DESC
		LIMIT $5
	) recent
	LEFT JOIN LATERAL (
		SELECT lower(dr.error_type::text) AS error_type, left(dr.error_subtype, 80) AS error_subtype
		FROM public.diagnosis_reports dr
		WHERE dr.attempt_id = recent.id AND dr.created_at <= $3::timestamp
		ORDER BY dr.created_at DESC, dr.id DESC LIMIT 1
	) diagnosis ON true
) evidence ON true
WHERE kn.id = ANY($2::varchar[])
ORDER BY kn.id`
