// domain.ts — the forge's domain operations and JSON shapes, shared by the REST,
// GraphQL and MCP surfaces so every surface creates and reads the same objects.

import {
  HttpError,
  VIEWER,
  branchRef,
  branchTip,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './core.ts';
import {
  buildCommitData,
  commitOf,
  diffTrees,
  mergeBase,
  mergeTrees,
  peelToCommit,
  storeObject,
  treeOfCommit,
  type FileChange,
} from './gitobj.ts';

// ---------------------------------------------------------------- shapes

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name) ?? { name }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } };
}

export function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  const headSha = headTip === null ? pull.headSha : (peelToCommit(store, headTip) ?? headTip);
  const baseSha = baseTip === null ? pull.baseSha : (peelToCommit(store, baseTip) ?? baseTip);
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- issues

export function createIssue(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): IssueRec {
  if (typeof input.title !== 'string' || input.title === '') {
    throw new HttpError(422, 'Validation Failed: title is required');
  }
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
  }
  const issue: IssueRec = {
    kind: 'issue',
    id: store.nextGlobalId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
  };
  repo.nextNumber += 1;
  repo.items.set(issue.number, issue);
  return issue;
}

export function addComment(store: Store, repo: RepoRec, number: number, body: string): CommentRec {
  const item = repo.items.get(number);
  if (item === undefined) throw new HttpError(404, 'Not Found');
  const comment: CommentRec = { id: store.nextGlobalId(), body };
  item.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------- pull requests

export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  if (typeof input.title !== 'string' || input.title === '') {
    throw new HttpError(422, 'Validation Failed: title is required');
  }
  const headTip = branchTip(repo, input.head);
  if (headTip === null) throw new HttpError(422, `Validation Failed: head branch "${input.head}" does not exist`);
  const baseTip = branchTip(repo, input.base);
  if (baseTip === null) throw new HttpError(422, `Validation Failed: base branch "${input.base}" does not exist`);
  for (const item of repo.items.values()) {
    if (item.kind === 'pull' && item.state === 'open' && item.headRef === input.head && item.baseRef === input.base) {
      throw new HttpError(422, `Validation Failed: a pull request already exists for ${input.head} into ${input.base}`);
    }
  }
  const pull: PullRec = {
    kind: 'pull',
    id: store.nextGlobalId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha: peelToCommit(store, headTip) ?? headTip,
    baseSha: peelToCommit(store, baseTip) ?? baseTip,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.items.set(pull.number, pull);
  return pull;
}

/** The merge-base tree, base-tip tree and head-tip tree a pull request merges between. */
function pullTrees(store: Store, repo: RepoRec, pull: PullRec): { base: string; head: string; fork: string } | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const head = peelToCommit(store, headTip);
  const base = peelToCommit(store, baseTip);
  if (head === null || base === null) return null;
  const fork = mergeBase(store, base, head);
  if (fork === null) return null;
  const forkTree = treeOfCommit(store, fork);
  const baseTree = treeOfCommit(store, base);
  const headTree = treeOfCommit(store, head);
  if (forkTree === null || baseTree === null || headTree === null) return null;
  return { base, head, fork };
}

/** The files a pull request changes (merge-base tree -> head tree). */
export function pullFiles(store: Store, repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const head = peelToCommit(store, headTip);
  const base = peelToCommit(store, baseTip);
  if (head === null || base === null) return [];
  const fork = mergeBase(store, base, head);
  const fromTree = fork === null ? null : treeOfCommit(store, fork);
  const toTree = treeOfCommit(store, head);
  return diffTrees(store, fromTree, toTree);
}

/** Whether the pull request can merge cleanly into the current base tip. */
export function pullMergeable(store: Store, repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const trees = pullTrees(store, repo, pull);
  if (trees === null) return false;
  const forkTree = treeOfCommit(store, trees.fork)!;
  const baseTree = treeOfCommit(store, trees.base)!;
  const headTree = treeOfCommit(store, trees.head)!;
  return mergeTrees(store, forkTree, baseTree, headTree).ok;
}

/**
 * Merge a pull request into its base branch. `squash` lands one commit with the base
 * tip as its only parent; `merge` lands a two-parent merge commit. Answers the new
 * base tip. Throws HttpError 405 on a conflict or a non-open pull request.
 */
export function mergePull(store: Store, repo: RepoRec, pull: PullRec, method: 'merge' | 'squash'): { sha: string } {
  if (pull.state !== 'open' || pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  const trees = pullTrees(store, repo, pull);
  if (trees === null) throw new HttpError(405, 'Pull Request is not mergeable');
  const forkTree = treeOfCommit(store, trees.fork)!;
  const baseTree = treeOfCommit(store, trees.base)!;
  const headTree = treeOfCommit(store, trees.head)!;
  if (trees.fork === trees.head) throw new HttpError(405, 'Pull Request is not mergeable');
  const merged = mergeTrees(store, forkTree, baseTree, headTree);
  if (!merged.ok) throw new HttpError(405, 'Pull Request is not mergeable');
  const parents = method === 'squash' ? [trees.base] : [trees.base, trees.head];
  const message =
    method === 'squash' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commit = storeObject(store, 'commit', buildCommitData({ tree: merged.tree, parents, message, time: store.nowSec() }));
  repo.refs.set(branchRef(pull.baseRef), commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = commit;
  repo.updatedAt = store.nowIso();
  return { sha: commit };
}

/** One commit on a branch from a full new tree (the contents API's write path). */
export function commitTreeOnBranch(store: Store, repo: RepoRec, branch: string, tree: string, message: string): string {
  const tip = branchTip(repo, branch);
  const parents = tip === null ? [] : [peelToCommit(store, tip) ?? tip];
  const commit = storeObject(store, 'commit', buildCommitData({ tree, parents, message, time: store.nowSec() }));
  repo.refs.set(branchRef(branch), commit);
  repo.updatedAt = store.nowIso();
  return commit;
}

export { commitOf };
