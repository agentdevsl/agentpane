{{/*
Expand the name of the chart.
*/}}
{{- define "agentpane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "agentpane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "agentpane.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentpane.labels" -}}
helm.sh/chart: {{ include "agentpane.chart" . }}
{{ include "agentpane.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentpane
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agentpane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentpane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "agentpane.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agentpane.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* =========================================================================
   Secret name resolvers
   ========================================================================= */}}

{{/*
Resolve the AI credentials secret name.
Returns existingSecret if set, otherwise the chart-managed secret name.
*/}}
{{- define "agentpane.ai.secretName" -}}
{{- if .Values.ai.existingSecret }}
{{- .Values.ai.existingSecret }}
{{- else }}
{{- printf "%s-ai" (include "agentpane.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Resolve the database secret name.
For external: returns existingSecret if set, otherwise chart-managed secret.
For internal (Bitnami subchart): returns the subchart's secret name.
*/}}
{{- define "agentpane.database.secretName" -}}
{{- if and .Values.database.external.enabled .Values.database.external.existingSecret }}
{{- .Values.database.external.existingSecret }}
{{- else if and .Values.database.internal.enabled .Values.database.internal.auth.existingSecret }}
{{- .Values.database.internal.auth.existingSecret }}
{{- else if .Values.database.external.enabled }}
{{- printf "%s-database" (include "agentpane.fullname" .) }}
{{- else }}
{{- printf "%s-postgresql" .Release.Name }}
{{- end }}
{{- end }}

{{/*
Resolve the database URL.
Constructs the PostgreSQL connection string from individual components when using external DB
without an existingSecret containing a full URL.
*/}}
{{- define "agentpane.database.url" -}}
{{- if .Values.database.external.enabled }}
{{- $host := .Values.database.external.host }}
{{- $port := .Values.database.external.port | default 5432 }}
{{- $user := .Values.database.external.username }}
{{- $db := .Values.database.external.database | default "agentpane" }}
{{- $ssl := .Values.database.external.sslMode | default "require" }}
{{- printf "postgresql://%s:$(DATABASE_PASSWORD)@%s:%v/%s?sslmode=%s" $user $host $port $db $ssl }}
{{- else }}
{{- $host := printf "%s-postgresql" .Release.Name }}
{{- $user := .Values.database.internal.auth.username | default "agentpane" }}
{{- $db := .Values.database.internal.auth.database | default "agentpane" }}
{{- printf "postgresql://%s:$(DATABASE_PASSWORD)@%s:5432/%s" $user $host $db }}
{{- end }}
{{- end }}

{{/*
Resolve the database password secret key.
*/}}
{{- define "agentpane.database.passwordKey" -}}
{{- if .Values.database.external.enabled }}
{{- .Values.database.external.secretKeys.passwordKey | default "password" }}
{{- else }}
{{- .Values.database.internal.auth.secretKeys.passwordKey | default "password" }}
{{- end }}
{{- end }}

{{/*
Resolve the GitHub credentials secret name.
*/}}
{{- define "agentpane.github.secretName" -}}
{{- if .Values.github.existingSecret }}
{{- .Values.github.existingSecret }}
{{- else }}
{{- printf "%s-github" (include "agentpane.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Sandbox namespace name
*/}}
{{- define "agentpane.sandbox.namespace" -}}
{{- .Values.sandbox.namespace | default "agentpane-sandboxes" }}
{{- end }}

{{/*
Detect OpenShift by checking for SecurityContextConstraints API
*/}}
{{- define "agentpane.openshift.enabled" -}}
{{- if .Values.openshift.enabled }}
{{- true }}
{{- else if .Capabilities.APIVersions.Has "security.openshift.io/v1" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Container image reference
*/}}
{{- define "agentpane.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{/*
F11-20: a `agentpane.sandbox.image` helper used to live here; it was unused
by every template and the chart `sandbox.image` value was never read by the
runtime (the DB `sandbox.defaults.image` setting is the source of truth).
Both have been removed to eliminate operator confusion.
*/}}
