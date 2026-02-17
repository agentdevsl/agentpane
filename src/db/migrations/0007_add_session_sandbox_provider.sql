-- Migration: Add sandbox_provider field to sessions table
-- Tracks which sandbox provider (docker or kubernetes) was used for the session

ALTER TABLE sessions ADD COLUMN sandbox_provider TEXT;
