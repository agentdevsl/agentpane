import { createId } from '@paralleldrive/cuid2';
import type {
  Codespace,
  CodespaceMember,
  NewCodespaceMember,
  NewTeam,
  NewTeamMember,
  Team,
  TeamMember,
  User,
} from '../../src/db/schema';
import { codespaceMembers, teamMembers, teams } from '../../src/db/schema';
import type { RbacRole } from '../../src/db/schema/shared/enums';
import { getTestDb } from '../helpers/database';
import { createTestProject } from './project.factory';
import { createTestUser } from './user.factory';

export type TeamFactoryOptions = Partial<NewTeam>;

export function buildTeam(options: TeamFactoryOptions = {}): NewTeam {
  const id = options.id ?? createId();

  return {
    id,
    name: options.name ?? `Test Team ${id.slice(0, 6)}`,
    slug: options.slug ?? `test-team-${id.slice(0, 6)}`,
    description: options.description ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export async function createTestTeam(options: TeamFactoryOptions = {}): Promise<Team> {
  const db = getTestDb();
  const data = buildTeam(options);
  const [team] = await db.insert(teams).values(data).returning();

  if (!team) {
    throw new Error('Failed to create test team');
  }

  return team;
}

export type TeamMemberFactoryOptions = Partial<NewTeamMember> & {
  role?: RbacRole;
};

export async function createTestTeamMember(
  teamId: string,
  userId: string,
  options: TeamMemberFactoryOptions = {}
): Promise<TeamMember> {
  const db = getTestDb();
  const data: NewTeamMember = {
    teamId,
    userId,
    role: options.role ?? 'viewer',
    joinedAt: options.joinedAt ?? new Date().toISOString(),
  };
  const [member] = await db.insert(teamMembers).values(data).returning();

  if (!member) {
    throw new Error('Failed to create test team member');
  }

  return member;
}

export async function createTestCodespaceMember(
  codespaceId: string,
  userId: string,
  options: Partial<NewCodespaceMember> = {}
): Promise<CodespaceMember> {
  const db = getTestDb();
  const data: NewCodespaceMember = {
    codespaceId,
    userId,
    role: options.role ?? 'viewer',
    grantedByTeamId: options.grantedByTeamId ?? null,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  const [member] = await db.insert(codespaceMembers).values(data).returning();

  if (!member) {
    throw new Error('Failed to create test codespace member');
  }

  return member;
}

export type RbacFixture = {
  team: Team;
  user: User;
  codespace: Codespace;
  teamMember: TeamMember;
  codespaceMember: CodespaceMember;
};

export async function createRbacFixture(
  options: { teamRole?: RbacRole; codespaceRole?: RbacRole } = {}
): Promise<RbacFixture> {
  const team = await createTestTeam();
  const user = await createTestUser();
  const codespace = await createTestProject();
  const teamMember = await createTestTeamMember(team.id, user.id, {
    role: options.teamRole ?? 'admin',
  });
  const codespaceMember = await createTestCodespaceMember(codespace.id, user.id, {
    role: options.codespaceRole ?? 'admin',
    grantedByTeamId: team.id,
  });

  return { team, user, codespace, teamMember, codespaceMember };
}
