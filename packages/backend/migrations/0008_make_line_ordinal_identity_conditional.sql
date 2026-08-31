ALTER TABLE workflow_document_lines
	ADD COLUMN identity_line_ordinal INT UNSIGNED
		GENERATED ALWAYS AS (CASE WHEN external_line_key IS NULL THEN line_ordinal ELSE NULL END) STORED,
	DROP INDEX uq_workflow_document_lines_ordinal,
	ADD UNIQUE KEY uq_workflow_document_lines_fallback_ordinal (document_id, identity_line_ordinal);
