import type { IconProps } from '@phosphor-icons/react';
import {
  Atom,
  BookOpen,
  Cloud,
  Code,
  Cube,
  Database,
  Folder,
  Gear,
  Globe,
  Heart,
  House,
  Lightning,
  Lock,
  Rocket,
  Shield,
  Star,
  Terminal,
  TreeStructure,
  Users,
} from '@phosphor-icons/react';
import type { ComponentType } from 'react';

/**
 * Maps icon name strings to Phosphor icon components.
 * Used by the folder rail to render icons dynamically from a stored string.
 */
const ICON_MAP: Record<string, ComponentType<IconProps>> = {
  atom: Atom,
  'book-open': BookOpen,
  cloud: Cloud,
  code: Code,
  cube: Cube,
  database: Database,
  folder: Folder,
  gear: Gear,
  globe: Globe,
  heart: Heart,
  house: House,
  lightning: Lightning,
  lock: Lock,
  rocket: Rocket,
  shield: Shield,
  star: Star,
  terminal: Terminal,
  'tree-structure': TreeStructure,
  users: Users,
};

/** All available icon names for the icon picker */
export const AVAILABLE_ICONS = Object.keys(ICON_MAP);

/** Returns the Phosphor icon component for a given name, or Folder as fallback */
export function getIconComponent(iconName: string): ComponentType<IconProps> {
  return ICON_MAP[iconName] ?? Folder;
}

interface FolderIconProps {
  iconName: string;
  size?: number;
  className?: string;
  weight?: IconProps['weight'];
}

export function FolderIcon({
  iconName,
  size = 20,
  className,
  weight = 'regular',
}: FolderIconProps): React.JSX.Element {
  const Icon = getIconComponent(iconName);
  return <Icon size={size} className={className} weight={weight} />;
}
