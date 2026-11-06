ALTER TABLE employee_schedule_versions
  ADD COLUMN overtime_settings JSONB NOT NULL DEFAULT
    '{"enabled":false,"workMode":"daily","restEnabled":false,"dailyRest":null,"additionalRestMinutes":0}'::jsonb,
  ADD CONSTRAINT employee_schedule_versions_overtime_object_check
    CHECK (jsonb_typeof(overtime_settings) = 'object');
