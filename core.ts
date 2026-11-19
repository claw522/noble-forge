// core.ts — the shared in-memory state of the forge: one store behind the REST, GraphQL,
// MCP and git surfaces, so an object created on one surface is the same object on all of them.
//
// Everything is deterministic: ids come from counters and timestamps from a logical clock
// seeded at a fixed epoch, so the same sequence of operations always yields the same bytes.

/** The token owner. The suite's seeded scenario fixes the viewer; every surface agrees on it. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** One git object (blob, tree, commit or tag) as raw bytes under its type. */
export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  /** Global numeric id (REST `id`, distinct from the per-repo `number`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** Tips captured at creation, used when a branch has since been deleted. */
  headSha: string;
  baseSha: string;
  comments: CommentRec[];
}

export type NumberedRec = IssueRec | PullRec;

export interface RepoRec {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name (`refs/heads/main`, `refs/tags/v1`) -> object id (commit or tag object). */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  items: Map<number, NumberedRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario epoch

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private globalSeq = 0;
  private tick = 0;

  /** A deterministic timestamp that advances with use (never the wall clock). */
  nowIso(): string {
    this.tick += 1;
    return new Date((EPOCH_SEC + this.tick) * 1000).toISOString();
  }

  nowSec(): number {
    this.tick += 1;
    return EPOCH_SEC + this.tick;
  }

  nextRepoId(): number {
    this.repoSeq += 1;
    return this.repoSeq;
  }

  nextGlobalId(): number {
    this.globalSeq += 1;
    return this.globalSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The viewer's repository, or null. Any other owner reads as absent (404, never 403). */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    const ts = this.nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId(),
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

/** The one store the whole process serves. */
export const store = new Store();

/** The full ref for a branch name. */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** An error that maps onto an HTTP status with a GitHub-shaped {message} body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A branch's tip commit id (following annotated tags is never needed for a branch), or null. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(branchRef(branch)) ?? null;
}
