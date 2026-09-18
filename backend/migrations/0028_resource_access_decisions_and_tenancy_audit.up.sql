-- Explainable resource authorization and transaction-bound tenancy auditing.
-- Keep the boolean predicates on the retrieval hot path. Diagnostic functions
-- call those predicates for the authoritative result and explain it separately.
-- They are administrative SQL helpers, not publication checks or public APIs.

CREATE FUNCTION public.resource_kb_access_decision(
    p_user text,
    p_kb text,
    p_permission text,
    p_owner text DEFAULT NULL,
    p_legacy boolean DEFAULT false
) RETURNS TABLE (
    allowed boolean,
    reason text,
    tenant_id character varying(36),
    knowledge_base_id character varying(36)
)
LANGUAGE sql STABLE
AS $$
    WITH target AS (
        SELECT kb.id, kb.tenant_id, kb.status
        FROM (VALUES (1)) input(dummy)
        LEFT JOIN public.knowledge_bases kb ON kb.id = p_kb
    ), facts AS (
        SELECT target.*,
            p_permission IS NOT NULL AND p_permission IN ('read', 'publish', 'manage') AS permission_valid,
            target.id IS NOT NULL AND public.resource_tenant_member(p_user, target.tenant_id) AS tenant_member,
            target.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.knowledge_base_acl acl
                WHERE acl.knowledge_base_id = target.id
                  AND acl.tenant_id = target.tenant_id
                  AND acl.effect = 'deny'
                  AND (acl.permission = p_permission OR acl.permission = 'manage'
                       OR (p_permission = 'read' AND acl.permission = 'publish'))
                  AND (acl.valid_from IS NULL OR acl.valid_from <= statement_timestamp() AT TIME ZONE 'UTC')
                  AND (acl.valid_to IS NULL OR acl.valid_to > statement_timestamp() AT TIME ZONE 'UTC')
                  AND public.resource_acl_subject(
                      p_user, target.tenant_id, acl.subject_type, acl.subject_id, p_owner
                  )
            ) AS denied,
            target.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.knowledge_base_acl acl
                WHERE acl.knowledge_base_id = target.id
                  AND acl.tenant_id = target.tenant_id
                  AND acl.effect = 'allow'
                  AND (acl.permission = p_permission OR acl.permission = 'manage'
                       OR (p_permission = 'read' AND acl.permission = 'publish'))
                  AND (acl.valid_from IS NULL OR acl.valid_from <= statement_timestamp() AT TIME ZONE 'UTC')
                  AND (acl.valid_to IS NULL OR acl.valid_to > statement_timestamp() AT TIME ZONE 'UTC')
                  AND public.resource_acl_subject(
                      p_user, target.tenant_id, acl.subject_type, acl.subject_id, p_owner
                  )
            ) AS explicitly_allowed
        FROM target
    )
    SELECT
        public.resource_kb_access(p_user, p_kb, p_permission, p_owner, p_legacy) AS allowed,
        CASE
            WHEN NOT permission_valid THEN 'invalid_permission'
            WHEN id IS NULL THEN 'knowledge_base_not_found'
            WHEN status <> 'active' THEN 'knowledge_base_inactive'
            WHEN NOT tenant_member THEN 'tenant_membership_denied'
            WHEN denied THEN 'acl_denied'
            WHEN p_legacy THEN 'legacy_allowed'
            WHEN p_owner = p_user THEN 'owner_allowed'
            WHEN explicitly_allowed THEN 'acl_allowed'
            ELSE 'no_matching_allow'
        END::text AS reason,
        tenant_id,
        COALESCE(id, p_kb::character varying(36)) AS knowledge_base_id
    FROM facts
$$;

CREATE OR REPLACE FUNCTION public.resource_kb_access(
    p_user text,
    p_kb text,
    p_permission text,
    p_owner text DEFAULT NULL,
    p_legacy boolean DEFAULT false
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT p_permission IS NOT NULL
       AND p_permission IN ('read', 'publish', 'manage')
       AND EXISTS(SELECT 1 FROM public.knowledge_bases kb
       WHERE kb.id=p_kb AND kb.status='active' AND public.resource_tenant_member(p_user,kb.tenant_id)
       AND NOT EXISTS(SELECT 1 FROM public.knowledge_base_acl a
       WHERE a.knowledge_base_id=kb.id AND a.tenant_id=kb.tenant_id AND a.effect='deny'
       AND (a.permission=p_permission OR a.permission='manage' OR (p_permission='read' AND a.permission='publish'))
       AND (a.valid_from IS NULL OR a.valid_from<=statement_timestamp() AT TIME ZONE 'UTC')
       AND (a.valid_to IS NULL OR a.valid_to>statement_timestamp() AT TIME ZONE 'UTC')
       AND public.resource_acl_subject(p_user,kb.tenant_id,a.subject_type,a.subject_id,p_owner))
       AND (p_legacy OR p_owner=p_user OR EXISTS(SELECT 1 FROM public.knowledge_base_acl a
       WHERE a.knowledge_base_id=kb.id AND a.tenant_id=kb.tenant_id AND a.effect='allow'
       AND (a.permission=p_permission OR a.permission='manage' OR (p_permission='read' AND a.permission='publish'))
       AND (a.valid_from IS NULL OR a.valid_from<=statement_timestamp() AT TIME ZONE 'UTC')
       AND (a.valid_to IS NULL OR a.valid_to>statement_timestamp() AT TIME ZONE 'UTC')
       AND public.resource_acl_subject(p_user,kb.tenant_id,a.subject_type,a.subject_id,p_owner))))
$$;

CREATE FUNCTION public.resource_content_access_decision(
    p_user text,
    p_resource text,
    p_permission text DEFAULT 'read'
) RETURNS TABLE (
    allowed boolean,
    reason text,
    tenant_id character varying(36),
    resource_id character varying(36),
    knowledge_base_ids character varying(36)[]
)
LANGUAGE sql STABLE
AS $$
    WITH target AS (
        SELECT content.id, content.tenant_id, content.owner_teacher_id
        FROM (VALUES (1)) input(dummy)
        LEFT JOIN public.contents content ON content.id = p_resource
    ), base AS (
        SELECT target.*,
            p_permission IS NOT NULL AND p_permission IN ('read', 'publish', 'manage') AS permission_valid,
            target.id IS NOT NULL AND public.resource_tenant_member(p_user, target.tenant_id) AS tenant_member,
            target.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.resource_documents document
                WHERE document.resource_id = target.id
            ) AS has_documents,
            target.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.content_acl content_acl
                WHERE content_acl.content_id = target.id
                  AND content_acl.teacher_id = p_user
                  AND content_acl.permission IN ('EDITOR', 'ADMIN')
            ) AS has_legacy_acl
        FROM target
    ), evaluated AS (
        SELECT base.*,
            NOT has_documents OR EXISTS (
                SELECT 1
                FROM public.resource_documents document
                JOIN public.resource_memberships membership
                  ON membership.resource_id = document.resource_id
                 AND membership.knowledge_base_id = document.knowledge_base_id
                 AND membership.tenant_id = document.tenant_id
                 AND membership.status = 'active'
                CROSS JOIN LATERAL public.resource_kb_access_decision(
                    p_user, document.knowledge_base_id, p_permission, base.owner_teacher_id,
                    p_permission = 'read' AND base.has_legacy_acl
                ) decision
                WHERE document.resource_id = base.id
                  AND document.tenant_id = base.tenant_id
                  AND document.status = 'active'
                  AND document.deleted_at IS NULL
                  AND decision.allowed
            ) AS has_accessible_document,
            COALESCE((
                SELECT array_agg(denied.knowledge_base_id ORDER BY denied.knowledge_base_id)
                FROM (
                    SELECT DISTINCT membership.knowledge_base_id
                    FROM public.resource_memberships membership
                    CROSS JOIN LATERAL public.resource_kb_access_decision(
                        p_user, membership.knowledge_base_id, p_permission, base.owner_teacher_id,
                        p_permission = 'read' AND (NOT base.has_documents OR base.has_legacy_acl)
                    ) decision
                    WHERE membership.resource_id = base.id
                      AND membership.status = 'active'
                      AND NOT decision.allowed
                ) denied
            ), ARRAY[]::character varying(36)[]) AS denied_kb_ids,
            COALESCE((
                SELECT array_agg(DISTINCT document.knowledge_base_id ORDER BY document.knowledge_base_id)
                FROM public.resource_documents document
                WHERE document.resource_id = base.id
            ), ARRAY[]::character varying(36)[]) AS document_kb_ids
        FROM base
    )
    SELECT
        public.resource_content_access(p_user, p_resource, p_permission) AS allowed,
        CASE
            WHEN NOT permission_valid THEN 'invalid_permission'
            WHEN id IS NULL THEN 'resource_not_found'
            WHEN NOT tenant_member THEN 'tenant_membership_denied'
            WHEN NOT has_accessible_document THEN 'no_accessible_document_membership'
            WHEN cardinality(denied_kb_ids) > 0 THEN 'knowledge_base_denied'
            WHEN p_permission <> 'read' AND owner_teacher_id IS DISTINCT FROM p_user THEN 'owner_required'
            WHEN p_permission = 'read' THEN 'allowed'
            ELSE 'owner_allowed'
        END::text AS reason,
        tenant_id,
        COALESCE(id, p_resource::character varying(36)) AS resource_id,
        CASE WHEN NOT has_accessible_document THEN document_kb_ids ELSE denied_kb_ids END AS knowledge_base_ids
    FROM evaluated
$$;

CREATE OR REPLACE FUNCTION public.resource_content_access(
    p_user text,
    p_resource text,
    p_permission text DEFAULT 'read'
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT p_permission IS NOT NULL
       AND p_permission IN ('read', 'publish', 'manage')
       AND EXISTS(SELECT 1 FROM public.contents c WHERE c.id=p_resource
       AND public.resource_tenant_member(p_user,c.tenant_id)
       AND (NOT EXISTS(SELECT 1 FROM public.resource_documents d WHERE d.resource_id=c.id)
       OR EXISTS(SELECT 1 FROM public.resource_documents d JOIN public.resource_memberships rm
       ON rm.resource_id=d.resource_id AND rm.knowledge_base_id=d.knowledge_base_id AND rm.tenant_id=d.tenant_id AND rm.status='active'
       WHERE d.resource_id=c.id AND d.tenant_id=c.tenant_id AND d.status='active' AND d.deleted_at IS NULL
       AND public.resource_kb_access(p_user,d.knowledge_base_id,p_permission,c.owner_teacher_id,
       p_permission='read' AND EXISTS(SELECT 1 FROM public.content_acl a WHERE a.content_id=c.id AND a.teacher_id=p_user AND a.permission IN ('EDITOR','ADMIN')))))
       AND NOT EXISTS(SELECT 1 FROM public.resource_memberships rm WHERE rm.resource_id=c.id AND rm.status='active'
       AND NOT public.resource_kb_access(p_user,rm.knowledge_base_id,p_permission,c.owner_teacher_id,
         p_permission='read' AND (NOT EXISTS(SELECT 1 FROM public.resource_documents d WHERE d.resource_id=c.id)
         OR EXISTS(SELECT 1 FROM public.content_acl a WHERE a.content_id=c.id AND a.teacher_id=p_user AND a.permission IN ('EDITOR','ADMIN')))))
       AND (p_permission='read' OR c.owner_teacher_id=p_user))
$$;

CREATE TABLE public.resource_tenancy_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id character varying(36),
    entity_type character varying(64) NOT NULL,
    entity_id text NOT NULL,
    action character varying(6) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_metadata jsonb,
    new_metadata jsonb,
    actor_session_user name NOT NULL,
    actor_current_user name NOT NULL,
    backend_pid integer NOT NULL,
    transaction_id bigint NOT NULL,
    occurred_at timestamp without time zone NOT NULL DEFAULT (statement_timestamp() AT TIME ZONE 'UTC')
);

CREATE INDEX ix_resource_tenancy_audit_tenant_time
    ON public.resource_tenancy_audit(tenant_id, occurred_at DESC, id DESC);
CREATE INDEX ix_resource_tenancy_audit_entity
    ON public.resource_tenancy_audit(entity_type, entity_id, occurred_at DESC);

CREATE FUNCTION public.audit_resource_tenancy_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_metadata jsonb;
    new_metadata jsonb;
    audit_tenant_id character varying(36);
    audit_entity_id text;
BEGIN
    IF TG_TABLE_NAME = 'tenant_memberships' THEN
        IF TG_OP <> 'INSERT' THEN
            old_metadata := jsonb_build_object('tenant_id', OLD.tenant_id, 'user_id', OLD.user_id,
                'status', OLD.status, 'valid_until', OLD.valid_until);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_metadata := jsonb_build_object('tenant_id', NEW.tenant_id, 'user_id', NEW.user_id,
                'status', NEW.status, 'valid_until', NEW.valid_until);
        END IF;
        audit_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        audit_entity_id := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_TABLE_NAME = 'tenant_departments' THEN
        IF TG_OP <> 'INSERT' THEN
            old_metadata := jsonb_build_object('tenant_id', OLD.tenant_id, 'department_id', OLD.id,
                'status', OLD.status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_metadata := jsonb_build_object('tenant_id', NEW.tenant_id, 'department_id', NEW.id,
                'status', NEW.status);
        END IF;
        audit_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        audit_entity_id := COALESCE(NEW.id, OLD.id);
    ELSIF TG_TABLE_NAME = 'tenant_department_memberships' THEN
        IF TG_OP <> 'INSERT' THEN
            old_metadata := jsonb_build_object('tenant_id', OLD.tenant_id,
                'department_id', OLD.department_id, 'user_id', OLD.user_id);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_metadata := jsonb_build_object('tenant_id', NEW.tenant_id,
                'department_id', NEW.department_id, 'user_id', NEW.user_id);
        END IF;
        audit_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        audit_entity_id := concat_ws(':', COALESCE(NEW.department_id, OLD.department_id),
            COALESCE(NEW.user_id, OLD.user_id));
    ELSIF TG_TABLE_NAME = 'knowledge_base_acl' THEN
        IF TG_OP <> 'INSERT' THEN
            old_metadata := jsonb_build_object('id', OLD.id, 'tenant_id', OLD.tenant_id,
                'knowledge_base_id', OLD.knowledge_base_id, 'subject_type', OLD.subject_type,
                'subject_id', OLD.subject_id, 'permission', OLD.permission, 'effect', OLD.effect,
                'valid_from', OLD.valid_from, 'valid_to', OLD.valid_to);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_metadata := jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id,
                'knowledge_base_id', NEW.knowledge_base_id, 'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id, 'permission', NEW.permission, 'effect', NEW.effect,
                'valid_from', NEW.valid_from, 'valid_to', NEW.valid_to);
        END IF;
        audit_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        audit_entity_id := COALESCE(NEW.id, OLD.id);
    ELSIF TG_TABLE_NAME = 'resource_memberships' THEN
        IF TG_OP <> 'INSERT' THEN
            old_metadata := jsonb_build_object('tenant_id', OLD.tenant_id,
                'knowledge_base_id', OLD.knowledge_base_id, 'resource_id', OLD.resource_id,
                'status', OLD.status);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            new_metadata := jsonb_build_object('tenant_id', NEW.tenant_id,
                'knowledge_base_id', NEW.knowledge_base_id, 'resource_id', NEW.resource_id,
                'status', NEW.status);
        END IF;
        audit_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
        audit_entity_id := concat_ws(':', COALESCE(NEW.knowledge_base_id, OLD.knowledge_base_id),
            COALESCE(NEW.resource_id, OLD.resource_id));
    ELSIF TG_TABLE_NAME = 'tenants' THEN
        old_metadata := jsonb_build_object('id', OLD.id, 'status', OLD.status,
            'resource_document_limit', OLD.resource_document_limit,
            'resource_byte_limit', OLD.resource_byte_limit,
            'resource_job_limit', OLD.resource_job_limit);
        new_metadata := jsonb_build_object('id', NEW.id, 'status', NEW.status,
            'resource_document_limit', NEW.resource_document_limit,
            'resource_byte_limit', NEW.resource_byte_limit,
            'resource_job_limit', NEW.resource_job_limit);
        audit_tenant_id := NEW.id;
        audit_entity_id := NEW.id;
    ELSE
        RAISE EXCEPTION 'unsupported resource tenancy audit table: %', TG_TABLE_NAME;
    END IF;

    IF TG_OP = 'UPDATE' AND old_metadata IS NOT DISTINCT FROM new_metadata THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.resource_tenancy_audit(
        tenant_id, entity_type, entity_id, action, old_metadata, new_metadata,
        actor_session_user, actor_current_user, backend_pid, transaction_id
    ) VALUES (
        audit_tenant_id, TG_TABLE_NAME, audit_entity_id, TG_OP, old_metadata, new_metadata,
        session_user, current_user, pg_backend_pid(), txid_current()
    );

    RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER trg_audit_tenant_memberships
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();

CREATE TRIGGER trg_audit_tenant_departments
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_departments
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();

CREATE TRIGGER trg_audit_tenant_department_memberships
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_department_memberships
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();

CREATE TRIGGER trg_audit_knowledge_base_acl
AFTER INSERT OR UPDATE OR DELETE ON public.knowledge_base_acl
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();

CREATE TRIGGER trg_audit_resource_memberships
AFTER INSERT OR UPDATE OR DELETE ON public.resource_memberships
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();

CREATE TRIGGER trg_audit_tenant_limits
AFTER UPDATE OF status, resource_document_limit, resource_byte_limit, resource_job_limit ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.audit_resource_tenancy_change();
