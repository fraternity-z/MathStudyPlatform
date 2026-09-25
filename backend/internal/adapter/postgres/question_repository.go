package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	questionapp "mathstudy/backend/internal/application/question"
	"mathstudy/backend/internal/platform/metautil"
	"mathstudy/backend/internal/platform/sliceutil"
)

// QuestionRepository persists teacher question bank data in PostgreSQL.
type QuestionRepository struct {
	Repository
}

// NewQuestionRepository creates a PostgreSQL-backed question repository.
func NewQuestionRepository(db Querier) (QuestionRepository, error) {
	base, err := NewRepository(db)
	if err != nil {
		return QuestionRepository{}, err
	}
	return QuestionRepository{Repository: base}, nil
}

// MatchConceptIDs finds knowledge nodes whose name or chapter resembles a question group.
func (r QuestionRepository) MatchConceptIDs(ctx context.Context, groupName string) ([]string, error) {
	keywords := splitGroupKeywords(groupName)
	if len(keywords) == 0 {
		return []string{}, nil
	}
	conditions := make([]string, 0, len(keywords))
	args := make([]any, 0, len(keywords))
	for _, keyword := range keywords {
		args = append(args, keyword)
		placeholder := fmt.Sprintf("$%d", len(args))
		conditions = append(conditions, "(name ILIKE '%' || "+placeholder+" || '%' OR chapter ILIKE '%' || "+placeholder+" || '%')")
	}
	rows, err := r.DB().Query(ctx, `
		SELECT DISTINCT id
		FROM public.knowledge_nodes
		WHERE `+strings.Join(conditions, " OR ")+`
		ORDER BY id`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// MatchConceptIDsBatch resolves knowledge nodes for multiple question groups in one query.
func (r QuestionRepository) MatchConceptIDsBatch(ctx context.Context, groupNames []string) ([][]string, error) {
	matches := make([][]string, len(groupNames))
	inputIndexes := make([]int32, 0, len(groupNames))
	keywords := make([]string, 0, len(groupNames))
	for inputIndex, groupName := range groupNames {
		matches[inputIndex] = []string{}
		for _, keyword := range splitGroupKeywords(groupName) {
			inputIndexes = append(inputIndexes, int32(inputIndex))
			keywords = append(keywords, keyword)
		}
	}
	if len(keywords) == 0 {
		return matches, nil
	}

	rows, err := r.DB().Query(ctx, `
		SELECT DISTINCT inputs.input_index, kn.id
		FROM unnest($1::integer[], $2::text[]) AS inputs(input_index, keyword)
		JOIN public.knowledge_nodes kn ON
			kn.name ILIKE '%' || inputs.keyword || '%' OR
			kn.chapter ILIKE '%' || inputs.keyword || '%'
		ORDER BY inputs.input_index, kn.id`,
		inputIndexes,
		keywords,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var inputIndex int
		var conceptID string
		if err := rows.Scan(&inputIndex, &conceptID); err != nil {
			return nil, err
		}
		if inputIndex < 0 || inputIndex >= len(matches) {
			return nil, fmt.Errorf("match concept ids batch: invalid input index %d", inputIndex)
		}
		matches[inputIndex] = append(matches[inputIndex], conceptID)
	}
	return matches, rows.Err()
}

// ConceptIDsExist reports whether every supplied concept ID resolves to a
// current knowledge node.
func (r QuestionRepository) ConceptIDsExist(ctx context.Context, conceptIDs []string) (bool, error) {
	if len(conceptIDs) == 0 {
		return true, nil
	}
	return r.Exists(ctx, `
		SELECT count(DISTINCT id) = cardinality($1::varchar[])
		FROM public.knowledge_nodes
		WHERE id = ANY($1::varchar[])`,
		conceptIDs,
	)
}

// ListQuestions returns teacher-owned problem content with usage statistics.
func (r QuestionRepository) ListQuestions(ctx context.Context, ownerID string, filter questionapp.ListFilter) ([]questionapp.Question, int, error) {
	where, args := questionWhereClause(ownerID, filter)
	var total int
	if err := r.DB().QueryRow(ctx, `
		SELECT count(DISTINCT c.id)::int
		FROM public.contents c
		WHERE `+where,
		args...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize
	args = append(args, filter.PageSize, offset)
	limitPlaceholder := fmt.Sprintf("$%d", len(args)-1)
	offsetPlaceholder := fmt.Sprintf("$%d", len(args))
	rows, err := r.DB().Query(ctx, `
		SELECT `+questionSelectColumns+`
		FROM public.contents c
		LEFT JOIN public.content_attempts ca ON ca.content_id = c.id
		WHERE `+where+`
		GROUP BY c.id
		ORDER BY `+questionOrderBy(filter)+`
		LIMIT `+limitPlaceholder+` OFFSET `+offsetPlaceholder,
		args...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	questions := []questionapp.Question{}
	for rows.Next() {
		question, err := scanQuestion(rows)
		if err != nil {
			return nil, 0, err
		}
		questions = append(questions, question)
	}
	return questions, total, rows.Err()
}

// GetQuestion returns one teacher-owned problem with usage statistics.
func (r QuestionRepository) GetQuestion(ctx context.Context, ownerID string, questionID string) (questionapp.Question, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT `+questionSelectColumns+`
		FROM public.contents c
		LEFT JOIN public.content_attempts ca ON ca.content_id = c.id
		WHERE c.id = $1
			AND c.owner_teacher_id = $2
			AND c.deleted_at IS NULL
			AND c.type = 'PROBLEM'::public.contenttype
		GROUP BY c.id`,
		questionID,
		ownerID,
	)
	question, err := scanQuestion(row)
	if err != nil {
		if err == pgx.ErrNoRows {
			forbidden, err := r.questionVisibleButNotOwned(ctx, ownerID, questionID)
			if err != nil {
				return questionapp.Question{}, false, err
			}
			if forbidden {
				return questionapp.Question{}, false, questionapp.ErrForbidden
			}
			return questionapp.Question{}, false, nil
		}
		return questionapp.Question{}, false, err
	}
	return question, true, nil
}

// SetDailyCandidate maintains the independent daily-question candidate marker.
func (r QuestionRepository) SetDailyCandidate(ctx context.Context, ownerID string, questionID string, enabled bool, now time.Time) (bool, error) {
	if !enabled {
		_, err := r.DB().Exec(ctx, `
			DELETE FROM public.daily_question_candidates
			WHERE content_id = $1 AND teacher_id = $2`,
			questionID,
			ownerID,
		)
		return true, err
	}
	result, err := r.DB().Exec(ctx, `
		INSERT INTO public.daily_question_candidates (
			content_id, teacher_id, priority, is_active, valid_from, valid_until, created_at, updated_at
		)
		SELECT id, owner_teacher_id, 0, true, NULL, NULL, $3, $3
		FROM public.contents
		WHERE
			id = $1 AND
			owner_teacher_id = $2 AND
			type = 'PROBLEM'::public.contenttype AND
			status = 'PUBLISHED'::public.contentstatus AND
			deleted_at IS NULL
		ON CONFLICT (content_id) DO UPDATE SET
			teacher_id = EXCLUDED.teacher_id,
			is_active = true,
			updated_at = EXCLUDED.updated_at`,
		questionID,
		ownerID,
		now,
	)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() == 1, nil
}

// CreateQuestion inserts a draft teacher-owned problem.
func (r QuestionRepository) CreateQuestion(ctx context.Context, ownerID string, input questionapp.QuestionInput, now time.Time) (questionapp.Question, error) {
	var questionID string
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		id, err := tx.insertQuestion(ctx, ownerID, input, now, nil)
		if err != nil {
			return err
		}
		questionID = id
		return nil
	})
	if err != nil {
		return questionapp.Question{}, err
	}
	question, ok, err := r.GetQuestion(ctx, ownerID, questionID)
	if err != nil {
		return questionapp.Question{}, err
	}
	if !ok {
		return questionapp.Question{}, pgx.ErrNoRows
	}
	return question, nil
}

// UpdateQuestion updates a teacher-owned problem.
func (r QuestionRepository) UpdateQuestion(ctx context.Context, ownerID string, questionID string, update questionapp.QuestionUpdate, now time.Time) (questionapp.Question, bool, error) {
	var question questionapp.Question
	var found bool
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		var err error
		question, found, err = tx.updateQuestion(ctx, ownerID, questionID, update, now)
		return err
	})
	return question, found, err
}

func (r QuestionRepository) updateQuestion(ctx context.Context, ownerID string, questionID string, update questionapp.QuestionUpdate, now time.Time) (questionapp.Question, bool, error) {
	current, ok, err := r.loadQuestionForUpdate(ctx, ownerID, questionID)
	if err != nil || !ok {
		if err == nil && !ok {
			forbidden, checkErr := r.questionVisibleButNotOwned(ctx, ownerID, questionID)
			if checkErr != nil {
				return questionapp.Question{}, false, checkErr
			}
			if forbidden {
				return questionapp.Question{}, false, questionapp.ErrForbidden
			}
		}
		return questionapp.Question{}, ok, err
	}
	if update.Title != nil {
		current.Title = *update.Title
	}
	if update.Body != nil {
		current.Body = *update.Body
	}
	if update.Difficulty != nil {
		current.Difficulty = *update.Difficulty
	}
	if update.ConceptIDs != nil {
		current.ConceptIDs = sliceutil.CloneStrings(*update.ConceptIDs)
	}
	if update.Tags != nil {
		current.Tags = sliceutil.CloneStrings(*update.Tags)
	}
	if update.Status != nil {
		status, ok := questionStatusToDB(*update.Status)
		if !ok {
			return questionapp.Question{}, false, questionapp.ErrBadRequest
		}
		if status != "PUBLISHED" {
			scheduled, err := r.hasFutureUniformSchedule(ctx, ownerID, []string{questionID})
			if err != nil {
				return questionapp.Question{}, false, err
			}
			if scheduled {
				return questionapp.Question{}, false, questionapp.ErrScheduled
			}
		}
		current.Status = status
	}
	mergeQuestionMeta(current.Meta, update)

	conceptsJSON, err := json.Marshal(current.ConceptIDs)
	if err != nil {
		return questionapp.Question{}, false, err
	}
	tagsJSON, err := json.Marshal(current.Tags)
	if err != nil {
		return questionapp.Question{}, false, err
	}
	metaJSON, err := json.Marshal(current.Meta)
	if err != nil {
		return questionapp.Question{}, false, err
	}

	tag, err := r.DB().Exec(ctx, `
		UPDATE public.contents
		SET title = $3,
			body = $4,
			difficulty = $5,
			concept_ids = $6::json,
			tags = $7::json,
			meta = $8::json,
			status = $9::public.contentstatus,
			updated_at = $10
		WHERE id = $1
			AND owner_teacher_id = $2
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype`,
		questionID,
		ownerID,
		current.Title,
		current.Body,
		current.Difficulty,
		string(conceptsJSON),
		string(tagsJSON),
		string(metaJSON),
		current.Status,
		now,
	)
	if err != nil {
		return questionapp.Question{}, false, err
	}
	if tag.RowsAffected() == 0 {
		return questionapp.Question{}, false, nil
	}
	if err := r.insertAudit(ctx, questionID, ownerID, "UPDATE", map[string]any{"fields": questionUpdateFields(update)}, now); err != nil {
		return questionapp.Question{}, false, err
	}
	if err := r.insertOutbox(ctx, "CONTENT_CHANGED", map[string]any{"content_id": questionID, "updates": questionUpdateFields(update)}, now); err != nil {
		return questionapp.Question{}, false, err
	}
	question, ok, err := r.GetQuestion(ctx, ownerID, questionID)
	return question, ok, err
}

// DeleteQuestion soft-deletes a teacher-owned problem.
func (r QuestionRepository) DeleteQuestion(ctx context.Context, ownerID string, questionID string, now time.Time) (bool, error) {
	var deleted bool
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		var err error
		deleted, err = tx.deleteQuestion(ctx, ownerID, questionID, now)
		return err
	})
	return deleted, err
}

func (r QuestionRepository) deleteQuestion(ctx context.Context, ownerID string, questionID string, now time.Time) (bool, error) {
	_, found, err := r.loadQuestionForUpdate(ctx, ownerID, questionID)
	if err != nil {
		return false, err
	}
	if !found {
		forbidden, err := r.questionVisibleButNotOwned(ctx, ownerID, questionID)
		if err != nil {
			return false, err
		}
		if forbidden {
			return false, questionapp.ErrForbidden
		}
		return false, nil
	}
	scheduled, err := r.hasFutureUniformSchedule(ctx, ownerID, []string{questionID})
	if err != nil {
		return false, err
	}
	if scheduled {
		return false, questionapp.ErrScheduled
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.contents
		SET deleted_at = $3,
			updated_at = $3
		WHERE id = $1
			AND owner_teacher_id = $2
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype`,
		questionID,
		ownerID,
		now,
	)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := r.insertAudit(ctx, questionID, ownerID, "DELETE", map[string]any{}, now); err != nil {
		return false, err
	}
	if err := r.insertOutbox(ctx, "CONTENT_DELETED", map[string]any{"content_id": questionID}, now); err != nil {
		return false, err
	}
	return true, nil
}

// GetGroups returns distinct titles for teacher-owned problem content.
func (r QuestionRepository) GetGroups(ctx context.Context, ownerID string) ([]string, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT DISTINCT title
		FROM public.contents
		WHERE owner_teacher_id = $1
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype
			AND title <> ''
		ORDER BY title`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := []string{}
	for rows.Next() {
		var group string
		if err := rows.Scan(&group); err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

// GetStats returns question counters matching the existing Python response contract.
func (r QuestionRepository) GetStats(ctx context.Context, ownerID string) (questionapp.Stats, error) {
	var total int
	var published int
	var draft int
	var archived int
	err := r.DB().QueryRow(ctx, `
		SELECT
			count(id)::int AS total,
			count(*) FILTER (WHERE status = 'PUBLISHED')::int AS published,
			count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
			count(*) FILTER (WHERE status = 'ARCHIVED')::int AS archived
		FROM public.contents
		WHERE owner_teacher_id = $1
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype`,
		ownerID,
	).Scan(&total, &published, &draft, &archived)
	if err != nil {
		return questionapp.Stats{}, err
	}
	return questionapp.Stats{
		Total:        total,
		ByDifficulty: map[string]int{"easy": 0, "medium": 0, "hard": 0},
		ByType:       map[string]int{"short_answer": 0, "multiple_choice": 0, "proof": 0},
		ByStatus:     map[string]int{"draft": draft, "published": published, "archived": archived},
	}, nil
}

// BatchPublish publishes teacher-owned problem content.
func (r QuestionRepository) BatchPublish(ctx context.Context, ownerID string, ids []string, now time.Time) (int, error) {
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.contents
		SET status = 'PUBLISHED'::public.contentstatus,
			published_at = $3,
			updated_at = $3
		WHERE owner_teacher_id = $1
			AND id = ANY($2::varchar[])
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype`,
		ownerID,
		ids,
		now,
	)
	if err != nil {
		return 0, err
	}
	count := int(tag.RowsAffected())
	for _, id := range ids[:min(count, len(ids))] {
		if err := r.insertAudit(ctx, id, ownerID, "UPDATE", map[string]any{"status": "published"}, now); err != nil {
			return count, err
		}
	}
	return count, nil
}

// BatchDelete soft-deletes teacher-owned problem content.
func (r QuestionRepository) BatchDelete(ctx context.Context, ownerID string, ids []string, now time.Time) (int, error) {
	var deleted int
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		var err error
		deleted, err = tx.batchDelete(ctx, ownerID, ids, now)
		return err
	})
	return deleted, err
}

func (r QuestionRepository) batchDelete(ctx context.Context, ownerID string, ids []string, now time.Time) (int, error) {
	rows, err := r.DB().Query(ctx, `
		SELECT id
		FROM public.contents
		WHERE owner_teacher_id = $1
		  AND id = ANY($2::varchar[])
		  AND deleted_at IS NULL
		  AND type = 'PROBLEM'::public.contenttype
		ORDER BY id
		FOR UPDATE`, ownerID, ids)
	if err != nil {
		return 0, err
	}
	lockedIDs := make([]string, 0, len(ids))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		lockedIDs = append(lockedIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(lockedIDs) == 0 {
		return 0, nil
	}
	scheduled, err := r.hasFutureUniformSchedule(ctx, ownerID, lockedIDs)
	if err != nil {
		return 0, err
	}
	if scheduled {
		return 0, questionapp.ErrScheduled
	}
	tag, err := r.DB().Exec(ctx, `
		UPDATE public.contents
		SET deleted_at = $3,
			updated_at = $3
		WHERE owner_teacher_id = $1
			AND id = ANY($2::varchar[])
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype`,
		ownerID,
		lockedIDs,
		now,
	)
	if err != nil {
		return 0, err
	}
	count := int(tag.RowsAffected())
	for _, id := range lockedIDs[:min(count, len(lockedIDs))] {
		if err := r.insertAudit(ctx, id, ownerID, "DELETE", map[string]any{}, now); err != nil {
			return count, err
		}
	}
	return count, nil
}

// BatchDuplicate duplicates teacher-owned problem content.
func (r QuestionRepository) BatchDuplicate(ctx context.Context, ownerID string, ids []string, now time.Time) (questionapp.BatchOperationResponse, error) {
	response := questionapp.BatchOperationResponse{FailedIDs: []string{}, Errors: []string{}}
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		for _, id := range ids {
			source, ok, err := tx.loadQuestionForUpdate(ctx, ownerID, id)
			if err != nil {
				response.FailedIDs = append(response.FailedIDs, id)
				response.Errors = append(response.Errors, "题目 "+id+" 复制失败: "+err.Error())
				continue
			}
			if !ok {
				response.FailedIDs = append(response.FailedIDs, id)
				response.Errors = append(response.Errors, "题目 "+id+" 不存在或无权访问")
				continue
			}
			input := questionapp.QuestionInput{
				Title:                "[副本] " + source.Title,
				Body:                 source.Body,
				Type:                 stringFromMeta(source.Meta, "type", "short_answer"),
				Difficulty:           source.Difficulty,
				ConceptIDs:           source.ConceptIDs,
				Tags:                 source.Tags,
				Answer:               stringFromMeta(source.Meta, "answer", ""),
				AnswerType:           stringFromMeta(source.Meta, "answer_type", "expression"),
				Hints:                metautil.StringSlice(source.Meta, "hints"),
				SolutionSteps:        metautil.StringSlice(source.Meta, "solution_steps"),
				Options:              optionsFromMeta(source.Meta),
				EstimatedTimeSeconds: metautil.Int(source.Meta, "estimated_time_seconds"),
			}
			if input.EstimatedTimeSeconds == 0 {
				input.EstimatedTimeSeconds = 300
			}
			if _, err := tx.insertQuestion(ctx, ownerID, input, now, map[string]any{"source_id": id}); err != nil {
				response.FailedIDs = append(response.FailedIDs, id)
				response.Errors = append(response.Errors, "题目 "+id+" 复制失败: "+err.Error())
				continue
			}
			response.Success++
		}
		return nil
	})
	if err != nil {
		return questionapp.BatchOperationResponse{}, err
	}
	response.Failed = len(response.FailedIDs)
	return response, nil
}

// BatchImport inserts already parsed teacher questions.
func (r QuestionRepository) BatchImport(ctx context.Context, ownerID string, inputs []questionapp.QuestionInput, now time.Time) (questionapp.BatchOperationResponse, error) {
	response := questionapp.BatchOperationResponse{FailedIDs: []string{}, Errors: []string{}}
	err := r.withTx(ctx, func(tx QuestionRepository) error {
		for index, input := range inputs {
			if _, err := tx.insertQuestion(ctx, ownerID, input, now, nil); err != nil {
				failedID := fmt.Sprintf("index_%d", index)
				response.FailedIDs = append(response.FailedIDs, failedID)
				response.Errors = append(response.Errors, fmt.Sprintf("第 %d 道题目导入失败: %s", index+1, err.Error()))
				continue
			}
			response.Success++
		}
		return nil
	})
	if err != nil {
		return questionapp.BatchOperationResponse{}, err
	}
	response.Failed = len(response.FailedIDs)
	if len(response.Errors) > 20 {
		response.Errors = response.Errors[:20]
	}
	return response, nil
}

type questionUpdateRow struct {
	Title      string
	Body       string
	Difficulty float64
	ConceptIDs []string
	Tags       []string
	Status     string
	Meta       map[string]any
}

func (r QuestionRepository) loadQuestionForUpdate(ctx context.Context, ownerID string, questionID string) (questionUpdateRow, bool, error) {
	row := r.DB().QueryRow(ctx, `
		SELECT title, body, difficulty, concept_ids, tags, status::text, meta
		FROM public.contents
		WHERE id = $1
			AND owner_teacher_id = $2
			AND deleted_at IS NULL
			AND type = 'PROBLEM'::public.contenttype
		FOR UPDATE`,
		questionID,
		ownerID,
	)
	var current questionUpdateRow
	var conceptIDsRaw []byte
	var tagsRaw []byte
	var metaRaw []byte
	if err := row.Scan(&current.Title, &current.Body, &current.Difficulty, &conceptIDsRaw, &tagsRaw, &current.Status, &metaRaw); err != nil {
		if err == pgx.ErrNoRows {
			return questionUpdateRow{}, false, nil
		}
		return questionUpdateRow{}, false, err
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return questionUpdateRow{}, false, fmt.Errorf("decode question concept ids: %w", err)
	}
	tags, err := decodeStringSlice(tagsRaw)
	if err != nil {
		return questionUpdateRow{}, false, fmt.Errorf("decode question tags: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return questionUpdateRow{}, false, fmt.Errorf("decode question meta: %w", err)
	}
	current.ConceptIDs = conceptIDs
	current.Tags = tags
	current.Meta = meta
	return current, true, nil
}

func (r QuestionRepository) hasFutureUniformSchedule(ctx context.Context, ownerID string, questionIDs []string) (bool, error) {
	if len(questionIDs) == 0 {
		return false, nil
	}
	return r.Exists(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM public.daily_question_class_selections selection
			JOIN public.classes class ON class.id = selection.class_id
			WHERE selection.content_id = ANY($2::varchar[])
			  AND class.teacher_id = $1
			  AND selection.assignment_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
			  AND selection.source = 'teacher_bank'
			  AND selection.selection_reason = 'teacher_uniform'
		)`, ownerID, questionIDs)
}

func (r QuestionRepository) questionVisibleButNotOwned(ctx context.Context, ownerID string, questionID string) (bool, error) {
	return r.Exists(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM public.contents c
			WHERE c.id = $1
				AND c.owner_teacher_id <> $2
				AND c.deleted_at IS NULL
				AND c.type = 'PROBLEM'::public.contenttype
				AND (
					c.status = 'PUBLISHED'::public.contentstatus
					OR EXISTS (
						SELECT 1
						FROM public.content_acl acl
						WHERE acl.content_id = c.id AND acl.teacher_id = $2
					)
				)
		)`,
		questionID,
		ownerID,
	)
}

func (r QuestionRepository) insertQuestion(ctx context.Context, ownerID string, input questionapp.QuestionInput, now time.Time, auditDiff map[string]any) (string, error) {
	questionID, err := newUUID()
	if err != nil {
		return "", err
	}
	conceptsJSON, err := json.Marshal(input.ConceptIDs)
	if err != nil {
		return "", err
	}
	tagsJSON, err := json.Marshal(input.Tags)
	if err != nil {
		return "", err
	}
	metaJSON, err := json.Marshal(questionMetaFromInput(input))
	if err != nil {
		return "", err
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.contents (
			id,
			type,
			owner_teacher_id,
			status,
			title,
			body,
			difficulty,
			concept_ids,
			tags,
			meta,
			created_at,
			updated_at,
			published_at,
			deleted_at
		)
		VALUES ($1, 'PROBLEM'::public.contenttype, $2, 'DRAFT'::public.contentstatus, $3, $4, $5, $6::json, $7::json, $8::json, $9, $9, NULL, NULL)`,
		questionID,
		ownerID,
		input.Title,
		input.Body,
		input.Difficulty,
		string(conceptsJSON),
		string(tagsJSON),
		string(metaJSON),
		now,
	)
	if err != nil {
		return "", err
	}
	diff := map[string]any{"title": input.Title, "type": "PROBLEM"}
	for key, value := range auditDiff {
		diff[key] = value
	}
	if err := r.insertAudit(ctx, questionID, ownerID, "CREATE", diff, now); err != nil {
		return "", err
	}
	if err := r.insertOutbox(ctx, "EMBEDDING_REQUIRED", map[string]any{"content_id": questionID, "action": "create"}, now); err != nil {
		return "", err
	}
	return questionID, nil
}

func (r QuestionRepository) insertAudit(ctx context.Context, contentID string, actorID string, action string, diff map[string]any, now time.Time) error {
	auditID, err := newUUID()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(diff)
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.content_audit (id, content_id, actor_user_id, action, at, diff)
		VALUES ($1, $2, $3, $4::public.auditaction, $5, $6::json)`,
		auditID,
		contentID,
		actorID,
		action,
		now,
		string(raw),
	)
	return err
}

func (r QuestionRepository) insertOutbox(ctx context.Context, eventType string, payload map[string]any, now time.Time) error {
	eventID, err := newUUID()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = r.DB().Exec(ctx, `
		INSERT INTO public.outbox_events (id, type, payload, created_at, processed_at, retry_count, last_error)
		VALUES ($1, $2::public.outboxeventtype, $3::json, $4, NULL, 0, NULL)`,
		eventID,
		eventType,
		string(raw),
		now,
	)
	return err
}

func (r QuestionRepository) withTx(ctx context.Context, fn func(QuestionRepository) error) error {
	return withRepositoryTx(ctx, "question", r.Repository, func(base Repository) QuestionRepository {
		return QuestionRepository{Repository: base}
	}, fn)
}

const questionSelectColumns = `
	c.id,
	c.title,
	c.body,
	c.difficulty,
	c.concept_ids,
	c.tags,
	c.status::text,
	c.meta,
	c.created_at,
	c.updated_at,
	count(ca.id)::int AS usage_count,
	coalesce(
		sum(CASE WHEN ca.is_correct THEN 1 ELSE 0 END)::double precision / nullif(count(ca.id), 0),
		0.0
	)::double precision AS correct_rate,
	(
		c.status = 'PUBLISHED'::public.contentstatus
		AND exists (
			SELECT 1
			FROM public.daily_question_candidates dqc
			WHERE dqc.content_id = c.id AND dqc.is_active
		)
	) AS is_daily_candidate`

func scanQuestion(scanner rowScanner) (questionapp.Question, error) {
	var question questionapp.Question
	var conceptIDsRaw []byte
	var tagsRaw []byte
	var metaRaw []byte
	var status string
	if err := scanner.Scan(
		&question.ID,
		&question.Title,
		&question.Body,
		&question.Difficulty,
		&conceptIDsRaw,
		&tagsRaw,
		&status,
		&metaRaw,
		&question.CreatedAt,
		&question.UpdatedAt,
		&question.UsageCount,
		&question.CorrectRate,
		&question.IsDailyCandidate,
	); err != nil {
		return questionapp.Question{}, err
	}
	conceptIDs, err := decodeStringSlice(conceptIDsRaw)
	if err != nil {
		return questionapp.Question{}, fmt.Errorf("decode question concept ids: %w", err)
	}
	tags, err := decodeStringSlice(tagsRaw)
	if err != nil {
		return questionapp.Question{}, fmt.Errorf("decode question tags: %w", err)
	}
	meta, err := decodeObjectMap(metaRaw)
	if err != nil {
		return questionapp.Question{}, fmt.Errorf("decode question meta: %w", err)
	}
	question.ConceptIDs = conceptIDs
	question.Tags = tags
	question.Meta = meta
	question.Status = questionStatusFromDB(status)
	question.Type = stringFromMeta(meta, "type", "short_answer")
	return question, nil
}

func questionWhereClause(ownerID string, filter questionapp.ListFilter) (string, []any) {
	args := []any{ownerID}
	conditions := []string{
		"c.owner_teacher_id = $1",
		"c.deleted_at IS NULL",
		"c.type = 'PROBLEM'::public.contenttype",
	}
	if filter.Type != "" {
		args = append(args, filter.Type)
		conditions = append(conditions, fmt.Sprintf("c.meta->>'type' = $%d", len(args)))
	}
	if strings.EqualFold(strings.TrimSpace(filter.Status), "active") {
		conditions = append(conditions, "c.status IN ('DRAFT'::public.contentstatus, 'PUBLISHED'::public.contentstatus)")
	} else if status, ok := questionStatusToDB(filter.Status); ok {
		args = append(args, status)
		conditions = append(conditions, fmt.Sprintf("c.status = $%d::public.contentstatus", len(args)))
	}
	if min, max, ok := questionDifficultyRange(filter.Difficulty); ok {
		args = append(args, min, max)
		conditions = append(conditions, fmt.Sprintf("c.difficulty >= $%d AND c.difficulty <= $%d", len(args)-1, len(args)))
	}
	if filter.Search != "" {
		args = append(args, filter.Search)
		placeholder := fmt.Sprintf("$%d", len(args))
		conditions = append(conditions, "(c.title ILIKE '%' || "+placeholder+" || '%' OR c.body ILIKE '%' || "+placeholder+" || '%')")
	}
	if len(filter.Tags) > 0 {
		args = append(args, filter.Tags)
		conditions = append(conditions, fmt.Sprintf("EXISTS (SELECT 1 FROM json_array_elements_text(c.tags) AS tag(value) WHERE tag.value = ANY($%d::text[]))", len(args)))
	}
	if filter.Group != "" {
		args = append(args, filter.Group)
		conditions = append(conditions, fmt.Sprintf("c.title = $%d", len(args)))
	}
	return strings.Join(conditions, " AND "), args
}

func questionOrderBy(filter questionapp.ListFilter) string {
	direction := "DESC"
	if strings.EqualFold(filter.SortOrder, "asc") {
		direction = "ASC"
	}
	column := "c.created_at"
	switch filter.SortBy {
	case "updated_at":
		column = "c.updated_at"
	case "difficulty":
		column = "c.difficulty"
	case "usage_count":
		column = "usage_count"
	}
	return column + " " + direction + ", c.id " + direction
}

func questionDifficultyRange(value string) (float64, float64, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "easy":
		return 0, 0.33, true
	case "medium":
		return 0.33, 0.67, true
	case "hard":
		return 0.67, 1, true
	default:
		return 0, 0, false
	}
}

func questionStatusToDB(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "draft":
		return "DRAFT", true
	case "published":
		return "PUBLISHED", true
	case "archived":
		return "ARCHIVED", true
	default:
		return "", false
	}
}

func questionStatusFromDB(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "DRAFT":
		return "draft"
	case "PUBLISHED":
		return "published"
	case "ARCHIVED":
		return "archived"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func questionMetaFromInput(input questionapp.QuestionInput) map[string]any {
	meta := map[string]any{
		"answer":                 input.Answer,
		"answer_type":            input.AnswerType,
		"type":                   input.Type,
		"hints":                  input.Hints,
		"solution_steps":         input.SolutionSteps,
		"estimated_time_seconds": input.EstimatedTimeSeconds,
	}
	if input.Options != nil && len(*input.Options) > 0 {
		meta["options"] = *input.Options
	}
	return meta
}

func mergeQuestionMeta(meta map[string]any, update questionapp.QuestionUpdate) {
	if update.Answer != nil {
		meta["answer"] = *update.Answer
	}
	if update.AnswerType != nil {
		meta["answer_type"] = *update.AnswerType
	}
	if update.Type != nil {
		meta["type"] = *update.Type
	}
	if update.Hints != nil {
		meta["hints"] = *update.Hints
	}
	if update.SolutionSteps != nil {
		meta["solution_steps"] = *update.SolutionSteps
	}
	if update.Options != nil {
		meta["options"] = *update.Options
	}
	if update.EstimatedTimeSeconds != nil {
		meta["estimated_time_seconds"] = *update.EstimatedTimeSeconds
	}
}

func questionUpdateFields(update questionapp.QuestionUpdate) []string {
	fields := []string{}
	if update.Title != nil {
		fields = append(fields, "title")
	}
	if update.Body != nil {
		fields = append(fields, "body")
	}
	if update.Type != nil {
		fields = append(fields, "type")
	}
	if update.Difficulty != nil {
		fields = append(fields, "difficulty")
	}
	if update.ConceptIDs != nil {
		fields = append(fields, "concept_ids")
	}
	if update.Tags != nil {
		fields = append(fields, "tags")
	}
	if update.Answer != nil {
		fields = append(fields, "answer")
	}
	if update.AnswerType != nil {
		fields = append(fields, "answer_type")
	}
	if update.Hints != nil {
		fields = append(fields, "hints")
	}
	if update.SolutionSteps != nil {
		fields = append(fields, "solution_steps")
	}
	if update.Options != nil {
		fields = append(fields, "options")
	}
	if update.EstimatedTimeSeconds != nil {
		fields = append(fields, "estimated_time_seconds")
	}
	if update.Status != nil {
		fields = append(fields, "status")
	}
	return fields
}

var groupKeywordSplitter = regexp.MustCompile(`[与和、,，/\s]+`)

func splitGroupKeywords(groupName string) []string {
	groupName = strings.TrimSpace(groupName)
	if groupName == "" {
		return []string{}
	}
	parts := groupKeywordSplitter.Split(groupName, -1)
	keywords := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if len([]rune(part)) >= 2 {
			keywords = append(keywords, part)
		}
	}
	if len(keywords) == 0 {
		keywords = append(keywords, groupName)
	}
	return keywords
}

func stringFromMeta(meta map[string]any, key string, fallback string) string {
	value, ok := metautil.LookupString(meta, key)
	if ok {
		return value
	}
	return fallback
}

func optionsFromMeta(meta map[string]any) *[]string {
	values := metautil.StringSlice(meta, "options")
	if len(values) == 0 {
		return nil
	}
	return &values
}
