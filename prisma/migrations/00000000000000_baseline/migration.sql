-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "public"."attendance_deductions" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "trigger_incident_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "incident_ids" UUID[] NOT NULL,
    "salary_days" INTEGER NOT NULL DEFAULT 1,
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance_evaluations" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "employee_id" UUID,
    "device_user_id" UUID,
    "date" DATE NOT NULL,
    "branch_id" UUID,
    "schedule_id" UUID,
    "policy_id" UUID,
    "result" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attendance_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance_incidents" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "log_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attendance_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."attendance_logs" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "device_log_id" TEXT,
    "user_id" TEXT NOT NULL,
    "verification_type" INTEGER,
    "punch_state" INTEGER,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "raw_data" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_id" UUID,

    CONSTRAINT "attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."branch_assignments" (
    "id" UUID NOT NULL,
    "employee_id" UUID,
    "device_user_id" UUID,
    "device_id" UUID,
    "branch_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."branch_policies" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."branches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT NOT NULL DEFAULT '',
    "exterior_number" TEXT NOT NULL DEFAULT '',
    "interior_number" TEXT NOT NULL DEFAULT '',
    "neighborhood" TEXT NOT NULL DEFAULT '',
    "postal_code" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT 'México',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "manager_name" TEXT NOT NULL DEFAULT '',
    "time_zone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."device_user_photos" (
    "device_id" UUID NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "image_data" BYTEA NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_user_photos_pkey" PRIMARY KEY ("device_id","device_user_id")
);

-- CreateTable
CREATE TABLE "public"."device_users" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "uid" INTEGER,
    "name" TEXT,
    "role" INTEGER,
    "card_number" TEXT,
    "raw_data" JSONB NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_id" UUID,
    "employee_id" UUID NOT NULL,
    "display_name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "rfc" TEXT,
    "imss" TEXT,
    "binding_status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "device_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."devices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "tcp_port" INTEGER NOT NULL DEFAULT 4370,
    "driver" TEXT NOT NULL DEFAULT 'node',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sync_interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "branch_id" UUID,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employee_clock_events" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "device_user_id" UUID NOT NULL,
    "previous_device_user_id" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_clock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employee_merge_events" (
    "id" UUID NOT NULL,
    "source_employee_id" UUID NOT NULL,
    "target_employee_id" UUID NOT NULL,
    "original_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_merge_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employee_status_events" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "previous_is_active" BOOLEAN,
    "is_active" BOOLEAN NOT NULL,
    "local_date" DATE NOT NULL,
    "time_zone" TEXT NOT NULL,
    "previous_termination_date" DATE,
    "termination_date" DATE,
    "original_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employee_unification_snapshots" (
    "id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "record" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_unification_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."employees" (
    "id" UUID NOT NULL,
    "employee_number" TEXT,
    "normalized_employee_number" TEXT,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "rfc" TEXT,
    "imss" TEXT,
    "management_code" TEXT,
    "section_code" TEXT,
    "company_code" TEXT,
    "branch_code" TEXT,
    "schedule_type_code" TEXT,
    "hire_date" DATE,
    "termination_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_id" UUID,
    "first_name" TEXT,
    "last_name" TEXT,
    "identification_status" TEXT NOT NULL DEFAULT 'confirmed',
    "merged_into_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "original_name" TEXT,
    "name_split_method" TEXT,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organization_initializations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_initializations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."schedule_assignments" (
    "id" UUID NOT NULL,
    "employee_id" UUID,
    "device_user_id" UUID,
    "schedule_id" UUID,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sync_runs" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "received_count" INTEGER NOT NULL DEFAULT 0,
    "inserted_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "sync_type" TEXT NOT NULL DEFAULT 'attendance',

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."work_schedules" (
    "id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_deductions_trigger_incident_id_key" ON "public"."attendance_deductions"("trigger_incident_id" ASC);

-- CreateIndex
CREATE INDEX "attendance_evaluations_branch_date_idx" ON "public"."attendance_evaluations"("branch_id" ASC, "date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_evaluations_subject_id_date_key" ON "public"."attendance_evaluations"("subject_id" ASC, "date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_incidents_evaluation_id_kind_key" ON "public"."attendance_incidents"("evaluation_id" ASC, "kind" ASC);

-- CreateIndex
CREATE INDEX "attendance_incidents_subject_idx" ON "public"."attendance_incidents"("subject_id" ASC, "occurred_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_logs_device_id_event_key_key" ON "public"."attendance_logs"("device_id" ASC, "event_key" ASC);

-- CreateIndex
CREATE INDEX "attendance_logs_device_occurred_at_idx" ON "public"."attendance_logs"("device_id" ASC, "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "branch_assignments_device_date_idx" ON "public"."branch_assignments"("device_id" ASC, "effective_from" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "branch_assignments_employee_date_idx" ON "public"."branch_assignments"("employee_id" ASC, "effective_from" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "branch_assignments_user_date_idx" ON "public"."branch_assignments"("device_user_id" ASC, "effective_from" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "device_users_active_employee_idx" ON "public"."device_users"("employee_id" ASC) WHERE (binding_status = 'active'::text);

-- CreateIndex
CREATE UNIQUE INDEX "device_users_device_id_device_user_id_key" ON "public"."device_users"("device_id" ASC, "device_user_id" ASC);

-- CreateIndex
CREATE INDEX "device_users_device_name_idx" ON "public"."device_users"("device_id" ASC, "name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "devices_active_endpoint_idx" ON "public"."devices"("ip_address" ASC, "tcp_port" ASC) WHERE (deleted_at IS NULL);

-- CreateIndex
CREATE INDEX "employee_status_events_employee_date_idx" ON "public"."employee_status_events"("employee_id" ASC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "employee_unification_snapshots_source_type_source_id_key" ON "public"."employee_unification_snapshots"("source_type" ASC, "source_id" ASC);

-- CreateIndex
CREATE INDEX "employees_branch_name_idx" ON "public"."employees"("branch_code" ASC, "name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_number_key" ON "public"."employees"("employee_number" ASC);

-- CreateIndex
CREATE INDEX "employees_identification_status_idx" ON "public"."employees"("identification_status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "employees_normalized_employee_number_key" ON "public"."employees"("normalized_employee_number" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "organization_initializations_code_key" ON "public"."organization_initializations"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_assignments_employee_date_idx" ON "public"."schedule_assignments"("employee_id" ASC, "effective_from" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_assignments_user_date_idx" ON "public"."schedule_assignments"("device_user_id" ASC, "effective_from" ASC);

-- CreateIndex
CREATE INDEX "sync_runs_device_started_at_idx" ON "public"."sync_runs"("device_id" ASC, "started_at" DESC);

-- CreateIndex
CREATE INDEX "work_schedules_branch_date_idx" ON "public"."work_schedules"("branch_id" ASC, "effective_from" ASC);

-- AddForeignKey
ALTER TABLE "public"."attendance_deductions" ADD CONSTRAINT "attendance_deductions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."branch_policies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_deductions" ADD CONSTRAINT "attendance_deductions_trigger_incident_id_fkey" FOREIGN KEY ("trigger_incident_id") REFERENCES "public"."attendance_incidents"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_device_user_id_fkey" FOREIGN KEY ("device_user_id") REFERENCES "public"."device_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."branch_policies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."work_schedules"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_incidents" ADD CONSTRAINT "attendance_incidents_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "public"."attendance_evaluations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_incidents" ADD CONSTRAINT "attendance_incidents_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "public"."attendance_logs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_incidents" ADD CONSTRAINT "attendance_incidents_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."branch_policies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_logs" ADD CONSTRAINT "attendance_logs_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."attendance_logs" ADD CONSTRAINT "attendance_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."branch_assignments" ADD CONSTRAINT "branch_assignments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."branch_assignments" ADD CONSTRAINT "branch_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."branch_assignments" ADD CONSTRAINT "branch_assignments_device_user_id_fkey" FOREIGN KEY ("device_user_id") REFERENCES "public"."device_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."branch_assignments" ADD CONSTRAINT "branch_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."branch_policies" ADD CONSTRAINT "branch_policies_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."device_user_photos" ADD CONSTRAINT "device_user_photos_device_id_device_user_id_fkey" FOREIGN KEY ("device_id", "device_user_id") REFERENCES "public"."device_users"("device_id", "device_user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."device_users" ADD CONSTRAINT "device_users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."device_users" ADD CONSTRAINT "device_users_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."device_users" ADD CONSTRAINT "device_users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."devices" ADD CONSTRAINT "devices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_clock_events" ADD CONSTRAINT "employee_clock_events_device_user_id_fkey" FOREIGN KEY ("device_user_id") REFERENCES "public"."device_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_clock_events" ADD CONSTRAINT "employee_clock_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_clock_events" ADD CONSTRAINT "employee_clock_events_previous_device_user_id_fkey" FOREIGN KEY ("previous_device_user_id") REFERENCES "public"."device_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_merge_events" ADD CONSTRAINT "employee_merge_events_source_employee_id_fkey" FOREIGN KEY ("source_employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_merge_events" ADD CONSTRAINT "employee_merge_events_target_employee_id_fkey" FOREIGN KEY ("target_employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employee_status_events" ADD CONSTRAINT "employee_status_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."employees" ADD CONSTRAINT "employees_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."schedule_assignments" ADD CONSTRAINT "schedule_assignments_device_user_id_fkey" FOREIGN KEY ("device_user_id") REFERENCES "public"."device_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."schedule_assignments" ADD CONSTRAINT "schedule_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."schedule_assignments" ADD CONSTRAINT "schedule_assignments_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."work_schedules"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."sync_runs" ADD CONSTRAINT "sync_runs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."work_schedules" ADD CONSTRAINT "work_schedules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Restricciones de PostgreSQL que Prisma no representa en el modelo.
ALTER TABLE "attendance_deductions" ADD CONSTRAINT "attendance_deductions_category_check" CHECK ((category = ANY (ARRAY['arrival'::text, 'meal'::text])));
ALTER TABLE "attendance_deductions" ADD CONSTRAINT "attendance_deductions_salary_days_check" CHECK ((salary_days > 0));
ALTER TABLE "attendance_evaluations" ADD CONSTRAINT "attendance_evaluations_check" CHECK ((num_nonnulls(employee_id, device_user_id) = 1));
ALTER TABLE "attendance_incidents" ADD CONSTRAINT "attendance_incidents_kind_check" CHECK ((kind = ANY (ARRAY['arrival'::text, 'meal_departure'::text, 'meal_return'::text])));
ALTER TABLE "attendance_incidents" ADD CONSTRAINT "attendance_incidents_minutes_check" CHECK ((minutes > 0));
ALTER TABLE "branch_assignments" ADD CONSTRAINT "branch_assignments_check" CHECK ((num_nonnulls(employee_id, device_user_id, device_id) = 1));
ALTER TABLE "device_user_photos" ADD CONSTRAINT "device_user_photos_content_type_check" CHECK ((content_type = 'image/jpeg'::text));
ALTER TABLE "device_users" ADD CONSTRAINT "device_users_binding_status_check" CHECK ((binding_status = ANY (ARRAY['active'::text, 'historical'::text])));
ALTER TABLE "devices" ADD CONSTRAINT "devices_driver_check" CHECK ((driver = ANY (ARRAY['node'::text, 'sdk-bridge'::text])));
ALTER TABLE "devices" ADD CONSTRAINT "devices_sync_interval_seconds_check" CHECK (((sync_interval_seconds >= 15) AND (sync_interval_seconds <= 86400)));
ALTER TABLE "devices" ADD CONSTRAINT "devices_tcp_port_check" CHECK (((tcp_port >= 1) AND (tcp_port <= 65535)));
ALTER TABLE "employee_merge_events" ADD CONSTRAINT "employee_merge_events_check" CHECK ((source_employee_id <> target_employee_id));
ALTER TABLE "employee_status_events" ADD CONSTRAINT "employee_status_events_event_type_check" CHECK ((event_type = ANY (ARRAY['initial'::text, 'terminated'::text, 'reactivated'::text])));
ALTER TABLE "employees" ADD CONSTRAINT "employees_employee_number_check" CHECK ((employee_number ~ '^[0-9]{8}$'::text));
ALTER TABLE "employees" ADD CONSTRAINT "employees_identification_status_check" CHECK ((identification_status = ANY (ARRAY['confirmed'::text, 'pending'::text, 'merged'::text])));
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_check" CHECK ((num_nonnulls(employee_id, device_user_id) = 1));
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])));
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_sync_type_check" CHECK ((sync_type = ANY (ARRAY['attendance'::text, 'users'::text, 'user_photos'::text])));
