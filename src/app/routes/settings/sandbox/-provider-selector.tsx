import { Cube, Hexagon } from '@phosphor-icons/react';
import { ConfigSection } from '@/app/components/ui/config-section';
import type { SandboxProvider } from '@/lib/sandbox/types';
import { type DefaultSandboxSettings, PROVIDER_LABELS, ProviderCardButton } from './-shared.js';

export interface ProviderSelectorProps {
  selectedProvider: SandboxProvider;
  setSelectedProvider: (provider: SandboxProvider) => void;
  setDefaultSettings: React.Dispatch<React.SetStateAction<DefaultSandboxSettings>>;
}

export function ProviderSelector({
  selectedProvider,
  setSelectedProvider,
  setDefaultSettings,
}: ProviderSelectorProps): React.JSX.Element {
  return (
    <ConfigSection
      icon={Cube}
      title="Provider Selection"
      description="Choose where agent code executes"
      badge={PROVIDER_LABELS[selectedProvider] ?? selectedProvider}
      badgeColor="accent"
      testId="provider-section"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ProviderCardButton
          selected={selectedProvider === 'docker'}
          onClick={() => {
            setSelectedProvider('docker');
            setDefaultSettings((prev) => ({ ...prev, provider: 'docker' }));
          }}
          icon="🐳"
          label="Docker"
          description="Local container isolation. Best for development."
          tags={[{ text: 'Network Isolation' }, { text: 'Resource Limits' }]}
          testId="provider-docker"
        />
        <ProviderCardButton
          selected={selectedProvider === 'kubernetes'}
          onClick={() => {
            setSelectedProvider('kubernetes');
            setDefaultSettings((prev) => ({ ...prev, provider: 'kubernetes' }));
          }}
          icon="☸️"
          label="Kubernetes"
          description="Local K8s via minikube/kind. Production-like isolation."
          tags={[{ text: 'Network Policies', variant: 'accent' }, { text: 'Warm Pool' }]}
          testId="provider-kubernetes"
        />
        <ProviderCardButton
          selected={selectedProvider === 'nomad'}
          onClick={() => {
            setSelectedProvider('nomad');
            setDefaultSettings((prev) => ({ ...prev, provider: 'nomad' }));
          }}
          icon={<Hexagon className="h-6 w-6 text-fg-muted" weight="duotone" />}
          label="Nomad"
          description="Run sandboxes as Nomad jobs using Docker task driver."
          tags={[{ text: 'Job Scheduling', variant: 'accent' }, { text: 'Multi-DC' }]}
          accentColor="attention"
          testId="provider-nomad"
        />
      </div>
    </ConfigSection>
  );
}
