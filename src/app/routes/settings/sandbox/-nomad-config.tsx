import { Hexagon } from '@phosphor-icons/react';
import { ConfigSection } from '@/app/components/ui/config-section';
import {
  ConnectionStatusIndicator,
  InitErrorBanner,
  type NomadNamespace,
  type NomadStatus,
  SaveButton,
  Toggle,
} from './-shared.js';

export interface NomadConfigProps {
  nomadAddress: string;
  setNomadAddress: (value: string) => void;
  nomadToken: string;
  setNomadToken: (value: string) => void;
  nomadHasToken: boolean;
  nomadTokenDirty: boolean;
  setNomadTokenDirty: (value: boolean) => void;
  nomadNamespace: string;
  setNomadNamespace: (value: string) => void;
  nomadRegion: string;
  setNomadRegion: (value: string) => void;
  nomadDatacenter: string;
  setNomadDatacenter: (value: string) => void;
  nomadSkipTLSVerify: boolean;
  setNomadSkipTLSVerify: (value: boolean) => void;
  nomadStatus: NomadStatus | null;
  nomadStatusLoading: boolean;
  nomadNamespaces: NomadNamespace[];
  nomadDatacenters: string[];
  nomadError: string | null;
  nomadInitError: { error: string; timestamp: string } | null;
  loadNomadStatus: () => void;
  isSavingDefaults: boolean;
  defaultsSaved: boolean;
  saveDefaultSettings: () => void;
}

export function NomadConfig({
  nomadAddress,
  setNomadAddress,
  nomadToken,
  setNomadToken,
  nomadHasToken,
  setNomadTokenDirty,
  nomadNamespace,
  setNomadNamespace,
  nomadRegion,
  setNomadRegion,
  nomadDatacenter,
  setNomadDatacenter,
  nomadSkipTLSVerify,
  setNomadSkipTLSVerify,
  nomadStatus,
  nomadStatusLoading,
  nomadNamespaces,
  nomadDatacenters,
  nomadError,
  nomadInitError,
  loadNomadStatus,
  isSavingDefaults,
  defaultsSaved,
  saveDefaultSettings,
}: NomadConfigProps): React.JSX.Element {
  return (
    <ConfigSection
      icon={Hexagon}
      title="Nomad Configuration"
      description="Configure your Nomad cluster connection"
      badge={nomadStatus === null ? 'Unknown' : nomadStatus.healthy ? 'Connected' : 'Disconnected'}
      badgeColor={nomadStatus === null ? 'accent' : nomadStatus.healthy ? 'success' : 'accent'}
      testId="nomad-config-section"
    >
      <div className="space-y-6">
        <ConnectionStatusIndicator
          loading={nomadStatusLoading}
          healthy={!!nomadStatus?.healthy}
          statusUnknown={nomadStatus === null}
          title={
            nomadStatusLoading
              ? 'Checking connection...'
              : nomadStatus === null
                ? 'Not checked'
                : nomadStatus.healthy
                  ? 'Connected'
                  : 'Cluster Unreachable'
          }
          subtitle={
            <>
              {nomadStatus?.healthy && nomadStatus.version && (
                <p className="text-xs text-fg-muted">
                  Nomad {nomadStatus.version}
                  {nomadStatus.leader && ` \u00b7 Leader: ${nomadStatus.leader}`}
                </p>
              )}
              {nomadStatus?.healthy && (
                <p className="text-xs text-fg-muted">
                  {nomadStatus.jobCount} sandbox job{nomadStatus.jobCount !== 1 ? 's' : ''}
                </p>
              )}
            </>
          }
          errorMessage={!nomadStatus?.healthy ? nomadError : null}
          onRefresh={loadNomadStatus}
          refreshTestId="refresh-nomad-status"
        />

        {nomadInitError && (
          <InitErrorBanner
            title="Nomad Initialization Failed"
            error={nomadInitError.error}
            timestamp={nomadInitError.timestamp}
            testId="nomad-init-error-banner"
          />
        )}

        {/* Nomad Form Fields */}
        <div className="space-y-4">
          {/* Address */}
          <div>
            <label htmlFor="nomad-address" className="mb-1.5 block text-sm font-medium text-fg">
              Nomad Address
              <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
            </label>
            <input
              id="nomad-address"
              type="text"
              value={nomadAddress}
              onChange={(e) => setNomadAddress(e.target.value)}
              placeholder="http://127.0.0.1:4646"
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="nomad-address-input"
            />
            <p className="mt-1 text-xs text-fg-muted">
              Leave empty to use NOMAD_ADDR environment variable or default
            </p>
          </div>

          {/* ACL Token */}
          <div>
            <label htmlFor="nomad-token" className="mb-1.5 block text-sm font-medium text-fg">
              ACL Token
              <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
            </label>
            <input
              id="nomad-token"
              type="password"
              value={nomadToken}
              onChange={(e) => {
                setNomadToken(e.target.value);
                setNomadTokenDirty(true);
              }}
              placeholder={nomadHasToken ? '••••••••  (token saved)' : 'Secret ACL token'}
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="nomad-token-input"
            />
          </div>

          {/* Skip TLS Verification */}
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-subtle px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-fg">Skip TLS Verification</p>
              <p className="text-xs text-fg-muted">
                Required for local development clusters with self-signed certificates
              </p>
            </div>
            <Toggle
              checked={nomadSkipTLSVerify}
              onToggle={() => setNomadSkipTLSVerify(!nomadSkipTLSVerify)}
              testId="nomad-skip-tls-toggle"
              ariaLabel="Skip TLS Verification"
            />
          </div>

          {/* Namespace */}
          <div>
            <label htmlFor="nomad-namespace" className="mb-1.5 block text-sm font-medium text-fg">
              Namespace
            </label>
            {nomadNamespaces.length > 0 ? (
              <select
                id="nomad-namespace"
                value={nomadNamespace}
                onChange={(e) => setNomadNamespace(e.target.value)}
                className="w-full appearance-none rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="nomad-namespace-select"
              >
                {nomadNamespaces.map((ns) => (
                  <option key={ns.Name} value={ns.Name}>
                    {ns.Name}
                    {ns.Description ? ` - ${ns.Description}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="nomad-namespace"
                type="text"
                value={nomadNamespace}
                onChange={(e) => setNomadNamespace(e.target.value)}
                placeholder="default"
                className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="nomad-namespace-input"
              />
            )}
          </div>

          {/* Region */}
          <div>
            <label htmlFor="nomad-region" className="mb-1.5 block text-sm font-medium text-fg">
              Region
              <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
            </label>
            <input
              id="nomad-region"
              type="text"
              value={nomadRegion}
              onChange={(e) => setNomadRegion(e.target.value)}
              placeholder="global"
              className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid="nomad-region-input"
            />
          </div>

          {/* Datacenter */}
          <div>
            <label htmlFor="nomad-datacenter" className="mb-1.5 block text-sm font-medium text-fg">
              Datacenter
              <span className="ml-1 text-xs font-normal text-fg-subtle">(optional)</span>
            </label>
            {nomadDatacenters.length > 0 ? (
              <select
                id="nomad-datacenter"
                value={nomadDatacenter}
                onChange={(e) => setNomadDatacenter(e.target.value)}
                className="w-full appearance-none rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="nomad-datacenter-select"
              >
                <option value="">Any datacenter</option>
                {nomadDatacenters.map((dc) => (
                  <option key={dc} value={dc}>
                    {dc}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="nomad-datacenter"
                type="text"
                value={nomadDatacenter}
                onChange={(e) => setNomadDatacenter(e.target.value)}
                placeholder="dc1"
                className="w-full rounded-md border border-border bg-surface-subtle px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid="nomad-datacenter-input"
              />
            )}
          </div>
        </div>

        {/* Save button */}
        <div className="flex justify-end">
          <SaveButton
            saving={isSavingDefaults}
            saved={defaultsSaved}
            onClick={saveDefaultSettings}
            testId="save-nomad-settings"
          />
        </div>
      </div>
    </ConfigSection>
  );
}
