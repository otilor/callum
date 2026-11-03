import type { NewProject, Project } from '../../shared/types.js';
import type { Repo } from './repo.js';

/** Test helper: a project with a name that is free in this repo unless the caller gives one. */
export function makeProject(repo: Repo, overrides: Partial<NewProject> = {}): Project {
  return repo.insertProject({ name: `Project ${repo.listProjects().length + 1}`, ...overrides });
}
