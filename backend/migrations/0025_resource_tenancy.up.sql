-- Small-deployment tenancy: authoritative memberships and shared ACL predicates.
DROP INDEX public.uq_resource_documents_registration;
CREATE UNIQUE INDEX uq_resource_documents_registration ON public.resource_documents(knowledge_base_id,created_by,registration_key) WHERE registration_key IS NOT NULL;
ALTER TABLE public.tenants
 ADD COLUMN resource_document_limit integer NOT NULL DEFAULT 10000 CHECK(resource_document_limit>0),
 ADD COLUMN resource_byte_limit bigint NOT NULL DEFAULT 5368709120 CHECK(resource_byte_limit>0),
 ADD COLUMN resource_job_limit integer NOT NULL DEFAULT 100 CHECK(resource_job_limit>0);
CREATE TABLE public.tenant_memberships (
    tenant_id varchar(36) NOT NULL REFERENCES public.tenants(id),
    user_id varchar(36) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
    valid_until timestamp,
    PRIMARY KEY (tenant_id,user_id)
);
INSERT INTO public.tenant_memberships(tenant_id,user_id)
SELECT '00000000-0000-4000-8000-000000000001',id FROM public.users;

CREATE TABLE public.tenant_departments (
    tenant_id varchar(36) NOT NULL REFERENCES public.tenants(id),
    id varchar(36) NOT NULL,
    name varchar(200) NOT NULL CHECK (btrim(name) <> ''),
    status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    PRIMARY KEY (tenant_id,id)
);
CREATE TABLE public.tenant_department_memberships (
    tenant_id varchar(36) NOT NULL,
    department_id varchar(36) NOT NULL,
    user_id varchar(36) NOT NULL,
    PRIMARY KEY (tenant_id,department_id,user_id),
    FOREIGN KEY (tenant_id,department_id) REFERENCES public.tenant_departments(tenant_id,id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id,user_id) REFERENCES public.tenant_memberships(tenant_id,user_id) ON DELETE CASCADE
);

CREATE FUNCTION public.resource_tenant_member(p_user text,p_tenant text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.tenant_memberships m
 JOIN public.users u ON u.id=m.user_id JOIN public.tenants t ON t.id=m.tenant_id
 WHERE m.user_id=p_user AND m.tenant_id=p_tenant AND m.status='active'
 AND (m.valid_until IS NULL OR m.valid_until > statement_timestamp() AT TIME ZONE 'UTC')
 AND u.is_active=true AND u.status='ACTIVE' AND t.status='active')
$$;

CREATE FUNCTION public.resource_acl_subject(p_user text,p_tenant text,p_type text,p_subject text,p_owner text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE p_type
 WHEN 'user' THEN p_subject=p_user
 WHEN 'tenant' THEN p_subject=p_tenant
 WHEN 'owner' THEN p_subject=p_user AND p_owner=p_user
 WHEN 'role' THEN EXISTS(SELECT 1 FROM public.users WHERE id=p_user AND lower(role::text)=lower(p_subject))
 WHEN 'department' THEN EXISTS(SELECT 1 FROM public.tenant_department_memberships m
 JOIN public.tenant_departments d ON d.tenant_id=m.tenant_id AND d.id=m.department_id AND d.status='active'
 WHERE m.tenant_id=p_tenant AND m.user_id=p_user AND m.department_id=p_subject)
 ELSE false END
$$;

CREATE FUNCTION public.resource_kb_access(p_user text,p_kb text,p_permission text,p_owner text DEFAULT NULL,p_legacy boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.knowledge_bases kb
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

CREATE FUNCTION public.resource_content_access(p_user text,p_resource text,p_permission text DEFAULT 'read') RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.contents c WHERE c.id=p_resource
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

-- New ordinary registrations remain in the default small-project workspace.
CREATE FUNCTION public.resource_default_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.tenant_memberships(tenant_id,user_id) VALUES('00000000-0000-4000-8000-000000000001',NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER resource_default_membership AFTER INSERT ON public.users
FOR EACH ROW EXECUTE FUNCTION public.resource_default_membership();

ALTER TABLE public.knowledge_bases ADD CONSTRAINT uq_kb_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.contents ADD CONSTRAINT uq_contents_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.resource_memberships ADD CONSTRAINT fk_membership_kb_tenant FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES public.knowledge_bases(tenant_id,id);
ALTER TABLE public.resource_memberships ADD CONSTRAINT fk_membership_resource_tenant FOREIGN KEY(tenant_id,resource_id) REFERENCES public.contents(tenant_id,id);
ALTER TABLE public.knowledge_base_acl ADD CONSTRAINT fk_acl_kb_tenant FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES public.knowledge_bases(tenant_id,id);
ALTER TABLE public.resource_documents ADD CONSTRAINT fk_document_kb_tenant FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES public.knowledge_bases(tenant_id,id);
ALTER TABLE public.resource_documents ADD CONSTRAINT fk_document_resource_tenant FOREIGN KEY(tenant_id,resource_id) REFERENCES public.contents(tenant_id,id);
ALTER TABLE public.vector_index_generations ADD CONSTRAINT fk_generation_kb_tenant FOREIGN KEY(tenant_id,knowledge_base_id) REFERENCES public.knowledge_bases(tenant_id,id);
ALTER TABLE public.vector_index_generations ADD CONSTRAINT uq_generation_collection UNIQUE(collection_name);
ALTER TABLE public.resource_documents ADD CONSTRAINT uq_document_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.document_versions ADD CONSTRAINT uq_version_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.document_versions ADD CONSTRAINT fk_version_document_tenant FOREIGN KEY(tenant_id,document_id) REFERENCES public.resource_documents(tenant_id,id);
ALTER TABLE public.document_chunks ADD CONSTRAINT uq_chunk_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.document_chunks ADD CONSTRAINT fk_chunk_version_tenant FOREIGN KEY(tenant_id,document_version_id) REFERENCES public.document_versions(tenant_id,id);
ALTER TABLE public.vector_index_generations ADD CONSTRAINT uq_generation_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE public.chunk_vector_manifests ADD CONSTRAINT fk_manifest_chunk_tenant FOREIGN KEY(tenant_id,chunk_id) REFERENCES public.document_chunks(tenant_id,id);
ALTER TABLE public.chunk_vector_manifests ADD CONSTRAINT fk_manifest_generation_tenant FOREIGN KEY(tenant_id,generation_id) REFERENCES public.vector_index_generations(tenant_id,id);
ALTER TABLE public.resource_processing_jobs ADD CONSTRAINT fk_job_resource_tenant FOREIGN KEY(tenant_id,resource_id) REFERENCES public.contents(tenant_id,id);
ALTER TABLE public.resource_processing_jobs ADD CONSTRAINT fk_job_version_tenant FOREIGN KEY(tenant_id,document_version_id) REFERENCES public.document_versions(tenant_id,id);
ALTER TABLE public.resource_processing_jobs ADD CONSTRAINT fk_job_generation_tenant FOREIGN KEY(tenant_id,generation_id) REFERENCES public.vector_index_generations(tenant_id,id);

-- Existing teachers retain publication rights only in the default knowledge base.
INSERT INTO public.knowledge_base_acl(id,tenant_id,knowledge_base_id,subject_type,subject_id,permission)
VALUES ('00000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','role','TEACHER','publish'),
 ('00000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','role','ADMIN','manage')
ON CONFLICT DO NOTHING;
