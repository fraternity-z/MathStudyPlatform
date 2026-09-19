package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	sessionapp "mathstudy/backend/internal/application/session"
)

var _ sessionapp.StudentContextReader = SessionRepository{}

// ReadStudentContext reads a bounded, statement-consistent snapshot without changing learning state.
func (r SessionRepository) ReadStudentContext(ctx context.Context, userID string, request sessionapp.StudentContextRequest) (sessionapp.StudentContextSnapshot, error) {
	var snapshot sessionapp.StudentContextSnapshot
	if strings.TrimSpace(userID) == "" || request.AsOf.IsZero() {
		return snapshot, fmt.Errorf("student context requires a student and snapshot time")
	}
	var raw []byte
	if err := r.DB().QueryRow(ctx, studentContextQuery, userID, request.Message, request.Topic, request.AsOf.UTC()).Scan(&raw); err != nil {
		return snapshot, fmt.Errorf("read student context: %w", err)
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return sessionapp.StudentContextSnapshot{}, fmt.Errorf("decode student context: %w", err)
	}
	return snapshot, nil
}

// Values from the current message and topic are literal substring operands, never SQL patterns.
// A single SELECT gives all evidence the same MVCC snapshot. Timestamp columns store UTC.
const studentContextQuery = `
WITH matches AS MATERIALIZED (
	SELECT kn.id, kn.name, matched.priority, matched.length
	FROM public.knowledge_nodes kn
	JOIN LATERAL (
		SELECT candidate.priority, char_length(candidate.name) AS length
		FROM (VALUES (btrim(kn.name), 0, $2::text), (btrim(kn.name_en), 0, $2::text),
			(btrim(kn.name), 1, $3::text), (btrim(kn.name_en), 1, $3::text)) candidate(name, priority, input)
		WHERE char_length(candidate.name) >= 2
			AND strpos(lower(candidate.input), lower(candidate.name)) > 0
		ORDER BY candidate.priority, char_length(candidate.name) DESC
		LIMIT 1
	) matched ON true
	ORDER BY matched.priority, matched.length DESC, kn.id
	LIMIT 6
), recent AS MATERIALIZED (
	SELECT kn.id, kn.name, 2 AS priority, 0 AS length
	FROM public.student_concept_dkt_states state
	JOIN public.knowledge_nodes kn ON kn.id = state.concept_id
	WHERE NOT EXISTS (SELECT 1 FROM matches)
		AND state.student_id = $1 AND state.attempt_count > 0
		AND state.last_attempt_at <= $4::timestamp
	ORDER BY state.mastery_prob, state.last_attempt_at DESC, kn.id
	LIMIT 6
), selected AS MATERIALIZED (
	SELECT * FROM matches UNION ALL SELECT * FROM recent
), concepts AS MATERIALIZED (
	SELECT selected.id, selected.priority, selected.length, json_build_object(
		'concept_id', selected.id, 'name', selected.name,
		'estimated_mastery', state.mastery_prob, 'confidence', coalesce(state.confidence, 0),
		'attempt_count', coalesce(state.attempt_count, 0),
		'last_attempt_at', to_char(state.last_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS value
	FROM selected
	LEFT JOIN public.student_concept_dkt_states state ON state.concept_id = selected.id
		AND state.student_id = $1 AND state.attempt_count > 0 AND state.last_attempt_at <= $4::timestamp
), prerequisite_candidates AS MATERIALIZED (
	-- Keep the learning path's source = learning target, target = prerequisite contract.
	SELECT DISTINCT selected.id AS target_id, selected.name AS target_name,
		selected.priority, selected.length, kn.id, kn.name
	FROM selected
	JOIN public.knowledge_relations relation ON relation.source_id = selected.id
		AND relation.relation_type = 'HAS_PREREQUISITE'
	JOIN public.knowledge_nodes kn ON kn.id = relation.target_id
	ORDER BY selected.priority, selected.length DESC, selected.id, kn.id
	LIMIT 12
), prerequisites AS (
	SELECT candidate.target_id, candidate.id, json_build_object(
		'target_id', candidate.target_id, 'target_name', candidate.target_name,
		'prerequisite', json_build_object('concept_id', candidate.id, 'name', candidate.name,
			'estimated_mastery', state.mastery_prob, 'confidence', coalesce(state.confidence, 0),
			'attempt_count', coalesce(state.attempt_count, 0),
			'last_attempt_at', to_char(state.last_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) AS value
	FROM prerequisite_candidates candidate
	LEFT JOIN public.student_concept_dkt_states state ON state.concept_id = candidate.id
		AND state.student_id = $1 AND state.attempt_count > 0 AND state.last_attempt_at <= $4::timestamp
), recent_attempts AS MATERIALIZED (
	SELECT ca.id, ca.student_id, ca.content_id, ca.daily_assignment_id,
		ca.review_question_concept_ids, ca.submitted_at
	FROM public.content_attempts ca
	WHERE ca.student_id = $1 AND ca.is_correct = false AND ca.submitted_at IS NOT NULL
		AND ca.submitted_at >= $4::timestamp - interval '30 days' AND ca.submitted_at <= $4::timestamp
	ORDER BY ca.submitted_at DESC, ca.id DESC
	LIMIT 100
), diagnosed AS (
	SELECT ca.id, ca.submitted_at, lower(dr.error_type::text) AS error_type,
		CASE
			WHEN json_typeof(ca.review_question_concept_ids) = 'array' THEN ca.review_question_concept_ids
			WHEN json_typeof(assignment.question_concept_ids) = 'array' THEN assignment.question_concept_ids
			WHEN json_typeof(content.concept_ids) = 'array' THEN content.concept_ids
			ELSE '[]'::json
		END AS concept_ids
	FROM recent_attempts ca
	JOIN public.diagnosis_reports dr ON dr.attempt_id = ca.id
	LEFT JOIN public.contents content ON content.id = ca.content_id
	LEFT JOIN LATERAL (
		SELECT daily.question_concept_ids
		FROM public.daily_question_assignments daily
		WHERE daily.student_id = ca.student_id AND daily.content_id = ca.content_id
			AND (daily.id = ca.daily_assignment_id OR (ca.daily_assignment_id IS NULL
				AND (daily.first_attempt_id = ca.id OR daily.corrected_attempt_id = ca.id)))
		ORDER BY (daily.id = ca.daily_assignment_id) DESC NULLS LAST, daily.id
		LIMIT 1
	) assignment ON true
	WHERE dr.created_at <= $4::timestamp
		AND lower(dr.error_type::text) IN ('conceptual', 'procedural', 'logical', 'symbolic', 'calculation')
), errors AS MATERIALIZED (
	SELECT diagnosed.* FROM diagnosed
	WHERE NOT EXISTS (SELECT 1 FROM matches) OR EXISTS (
		SELECT 1 FROM json_array_elements_text(diagnosed.concept_ids) binding(id)
		JOIN matches ON matches.id = binding.id
	)
	ORDER BY submitted_at DESC, id DESC
	LIMIT 3
), error_values AS (
	SELECT errors.id, errors.submitted_at, json_build_object(
		'error_type', errors.error_type,
		'occurred_at', to_char(errors.submitted_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'concept_names', coalesce((SELECT json_agg(names.name ORDER BY names.id) FROM (
			SELECT DISTINCT kn.id, kn.name FROM json_array_elements_text(errors.concept_ids) binding(id)
			JOIN public.knowledge_nodes kn ON kn.id = binding.id
			ORDER BY kn.id LIMIT 3
		) names), '[]'::json)) AS value
	FROM errors
)
SELECT json_build_object(
	'scope', CASE WHEN EXISTS (SELECT 1 FROM matches) THEN 'topic'
		WHEN EXISTS (SELECT 1 FROM recent) OR EXISTS (SELECT 1 FROM errors) THEN 'recent_learning' ELSE 'empty' END,
	'concepts', coalesce((SELECT json_agg(value ORDER BY priority, length DESC, id) FROM concepts), '[]'::json),
	'prerequisite_gaps', coalesce((SELECT json_agg(value ORDER BY target_id, id) FROM prerequisites), '[]'::json),
	'recent_errors', coalesce((SELECT json_agg(value ORDER BY submitted_at DESC, id DESC) FROM error_values), '[]'::json)
)`
