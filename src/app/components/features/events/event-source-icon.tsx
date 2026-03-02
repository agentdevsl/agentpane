import { GithubLogo, Globe, WebhooksLogo } from '@phosphor-icons/react';

export function EventSourceIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}): React.JSX.Element {
  const iconClass = className ?? 'h-5 w-5';
  switch (type) {
    case 'github':
      return <GithubLogo className={iconClass} />;
    case 'linear':
    case 'jira':
      return <Globe className={iconClass} />;
    default:
      return <WebhooksLogo className={iconClass} />;
  }
}
