ALTER TABLE "sandbox_configs" ADD COLUMN "nomad_address" text;--> statement-breakpoint
ALTER TABLE "sandbox_configs" ADD COLUMN "nomad_token" text;--> statement-breakpoint
ALTER TABLE "sandbox_configs" ADD COLUMN "nomad_namespace" text DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sandbox_configs" ADD COLUMN "nomad_datacenter" text;--> statement-breakpoint
ALTER TABLE "sandbox_configs" ADD COLUMN "nomad_region" text;
