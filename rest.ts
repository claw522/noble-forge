// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, git refs,
// contents, labels, issues, comments and pull requests. Handlers are pure functions
// over the store; app.ts owns HTTP, auth and serialization.

import {
  HttpError,
  branchRef,
  branchTip,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './core.ts';
import {
  buildCommitData,
  buildTreeFromFlat,
  commitOf,
  flattenTree,
  getObject,
  isOid,
  parseTree,
  peelToCommit,
  storeObject,
  treeOfCommit,
} from './gitobj.ts';
import {
  addComment,
  commentJson,
  createIssue,
  createPull,
  issueJson,
  labelJson,
  mergePull,
  pullFiles,
  pullJson,
  repoJson,
  userJson,
} from './domain.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  /** The request's authority, for absolute Link URLs. */
  host: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): HttpError => new HttpError(404, 'Not Found');

function requireRepo(store: Store, owner: string, name: string): RepoRec {
  const repo = store.getRepo(owner, name);
  if (repo === null) throw notFound();
  return repo;
}

/** Slice a list by page/per_page and build the Link header GitHub clients follow. */
function paginate<T>(items: T[], req: RestRequest, basePath: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const url = (p: number): string => `http://${req.host}${basePath}?page=${p}&per_page=${perPage}`;
    headers.link = `<${url(page + 1)}>; rel="next", <${url(lastPage)}>; rel="last"`;
  }
  return { page: slice, headers };
}

function bodyString(body: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = body?.[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------- contents helpers

/** Commit a tree onto a branch, creating the branch from the default tip when needed. */
function commitOn(store: Store, repo: RepoRec, branch: string, tree: string, message: string): string {
  let parent = branchTip(repo, branch);
  if (parent === null && branch !== repo.defaultBranch) parent = branchTip(repo, repo.defaultBranch);
  const parents = parent === null ? [] : [peelToCommit(store, parent) ?? parent];
  const commit = storeObject(store, 'commit', buildCommitData({ tree, parents, message, time: store.nowSec() }));
  repo.refs.set(branchRef(branch), commit);
  repo.updatedAt = store.nowIso();
  return commit;
}

/** Resolve a ref parameter (branch name or commit id) to a commit id. */
function resolveRef(store: Store, repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip === null ? null : peelToCommit(store, tip);
  }
  const tip = branchTip(repo, ref);
  if (tip !== null) return peelToCommit(store, tip);
  if (isOid(ref)) {
    const object = getObject(store, ref);
    if (object !== null && object.type === 'commit') return ref;
    if (object !== null && object.type === 'tag') return peelToCommit(store, ref);
  }
  return null;
}

function treeOfRef(store: Store, repo: RepoRec, ref: string | undefined): string | null {
  const commit = resolveRef(store, repo, ref);
  return commit === null ? null : treeOfCommit(store, commit);
}

// ---------------------------------------------------------------- route handlers

function handleRoot(): RestReply {
  return {
    status: 200,
    body: {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org' },
  };
}

function handleCreateRepo(store: Store, req: RestRequest): RestReply {
  const name = bodyString(req.body, 'name');
  if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
  if (store.getRepo('adaiversen', name) !== null) {
    throw new HttpError(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = store.createRepo(name, bodyString(req.body, 'description') ?? '', req.body?.private === true);
  return { status: 201, body: repoJson(repo) };
}

function handleContents(store: Store, repo: RepoRec, req: RestRequest, pathParts: string[]): RestReply {
  const path = pathParts.join('/');
  if (req.method === 'GET') {
    const tree = treeOfRef(store, repo, req.query.get('ref') ?? undefined);
    if (tree === null) throw notFound();
    // Navigate to the target: a subtree for directories, a blob for files.
    let currentTree: string | null = tree;
    let fileEntry: { mode: string; oid: string } | null = null;
    const segments = path === '' ? [] : path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const object = currentTree === null ? null : getObject(store, currentTree);
      if (object === null || object.type !== 'tree') throw notFound();
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) throw notFound();
      if (i === segments.length - 1 && Number.parseInt(entry.mode, 8) !== 0o40000) {
        fileEntry = { mode: entry.mode, oid: entry.oid };
      } else if (Number.parseInt(entry.mode, 8) === 0o40000) {
        currentTree = entry.oid;
      } else {
        throw notFound();
      }
    }
    if (fileEntry !== null) {
      const blob = getObject(store, fileEntry.oid);
      if (blob === null) throw notFound();
      return {
        status: 200,
        body: {
          type: 'file',
          name: segments[segments.length - 1],
          path,
          sha: fileEntry.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        },
      };
    }
    const dirObject = currentTree === null ? null : getObject(store, currentTree);
    if (dirObject === null || dirObject.type !== 'tree') throw notFound();
    const entries = parseTree(dirObject.data).map((entry) => {
      const isDir = Number.parseInt(entry.mode, 8) === 0o40000;
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const blob = isDir ? null : getObject(store, entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: blob === null ? 0 : blob.data.length,
      };
    });
    return { status: 200, body: entries };
  }

  if (req.method === 'PUT') {
    const content64 = bodyString(req.body, 'content');
    const message = bodyString(req.body, 'message');
    if (content64 === undefined || message === undefined) throw new HttpError(422, 'Validation Failed: content and message are required');
    if (path === '') throw new HttpError(422, 'Validation Failed: path is required');
    const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
    const baseTree = treeOfRef(store, repo, branch) ?? treeOfRef(store, repo, repo.defaultBranch);
    const flat = baseTree === null ? new Map() : flattenTree(store, baseTree);
    const existing = flat.get(path);
    const sha = bodyString(req.body, 'sha');
    if (existing !== undefined) {
      if (sha === undefined) throw new HttpError(422, 'Invalid request. "sha" wasn\'t supplied.');
      if (sha !== existing.oid) throw new HttpError(409, 'Conflict: the sha does not match the current content');
    }
    const data = Buffer.from(content64.replace(/\s+/g, ''), 'base64');
    const blobSha = storeObject(store, 'blob', data);
    flat.set(path, { mode: '100644', oid: blobSha });
    const tree = buildTreeFromFlat(store, flat);
    const commit = commitOn(store, repo, branch, tree, message);
    const name = path.split('/').pop()!;
    return {
      status: existing === undefined ? 201 : 200,
      body: {
        content: { name, path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      },
    };
  }

  if (req.method === 'DELETE') {
    const message = bodyString(req.body, 'message');
    const sha = bodyString(req.body, 'sha');
    if (message === undefined || sha === undefined) throw new HttpError(422, 'Validation Failed: message and sha are required');
    const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
    const baseTree = treeOfRef(store, repo, branch);
    if (baseTree === null) throw notFound();
    const flat = flattenTree(store, baseTree);
    const existing = flat.get(path);
    if (existing === undefined) throw notFound();
    if (sha !== existing.oid) throw new HttpError(409, 'Conflict: the sha does not match the current content');
    flat.delete(path);
    const tree = buildTreeFromFlat(store, flat);
    const commit = commitOn(store, repo, branch, tree, message);
    return { status: 200, body: { content: null, commit: { sha: commit, message } } };
  }

  throw notFound();
}

function handleRepoScoped(store: Store, repo: RepoRec, req: RestRequest, rest: string[]): RestReply {
  const [head, ...tail] = rest;

  if (head === undefined) {
    if (req.method === 'GET') return { status: 200, body: repoJson(repo) };
    if (req.method === 'PATCH') {
      const description = bodyString(req.body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      repo.updatedAt = store.nowIso();
      return { status: 200, body: repoJson(repo) };
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204 };
    }
    throw notFound();
  }

  if (head === 'branches') {
    if (tail.length === 0) {
      if (req.method !== 'GET') throw notFound();
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => {
          const name = ref.slice('refs/heads/'.length);
          const tip = repo.refs.get(ref)!;
          return { name, commit: { sha: peelToCommit(store, tip) ?? tip }, protected: false };
        })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    const branch = tail.join('/');
    const tip = branchTip(repo, branch);
    if (tip === null) throw notFound();
    return { status: 200, body: { name: branch, commit: { sha: peelToCommit(store, tip) ?? tip }, protected: false } };
  }

  if (head === 'commits') {
    if (req.method !== 'GET') throw notFound();
    const start = resolveRef(store, repo, req.query.get('sha') ?? undefined);
    if (start === null) return { status: 200, body: [] };
    const seen = new Set<string>();
    const order: string[] = [];
    const walk = (oid: string): void => {
      if (seen.has(oid)) return;
      const commit = commitOf(store, oid);
      if (commit === null) return;
      seen.add(oid);
      order.push(oid);
      for (const parent of commit.parents) walk(parent);
    };
    walk(start);
    const items = order.map((oid) => {
      const commit = commitOf(store, oid)!;
      return {
        sha: oid,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: new Date(commit.time * 1000).toISOString() },
          committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: new Date(commit.time * 1000).toISOString() },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    const { page, headers } = paginate(items, req, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
    return { status: 200, body: page, headers };
  }

  if (head === 'git' && tail[0] === 'refs') {
    const refParts = tail.slice(1);
    if (refParts.length === 0) {
      if (req.method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: getObject(store, oid)?.type ?? 'commit' } }));
        return { status: 200, body: refs };
      }
      if (req.method === 'POST') {
        const ref = bodyString(req.body, 'ref');
        const sha = bodyString(req.body, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref and sha are required');
        const object = getObject(store, sha);
        if (object === null) throw new HttpError(422, 'Validation Failed: sha does not name an object');
        if (ref.startsWith('refs/heads/') && peelToCommit(store, sha) === null) throw new HttpError(422, 'Validation Failed: sha does not name a commit');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: object.type } } };
      }
      throw notFound();
    }
    const ref = `refs/${refParts.join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) throw notFound();
    return { status: 200, body: { ref, object: { sha: oid, type: getObject(store, oid)?.type ?? 'commit' } } };
  }

  if (head === 'contents') {
    return handleContents(store, repo, req, tail);
  }

  if (head === 'labels') {
    if (tail.length === 0) {
      if (req.method === 'GET') {
        const labels = [...repo.labels.keys()].sort().map((name) => labelJson(repo, name));
        return { status: 200, body: labels };
      }
      if (req.method === 'POST') {
        const name = bodyString(req.body, 'name');
        if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" already exists`);
        repo.labels.set(name, { name, color: bodyString(req.body, 'color') ?? 'ededed', description: bodyString(req.body, 'description') ?? '' });
        return { status: 201, body: labelJson(repo, name) };
      }
      throw notFound();
    }
    const name = tail.join('/');
    const label = repo.labels.get(name);
    if (label === undefined) throw notFound();
    if (req.method === 'GET') return { status: 200, body: labelJson(repo, name) };
    if (req.method === 'DELETE') {
      repo.labels.delete(name);
      return { status: 204 };
    }
    throw notFound();
  }

  if (head === 'issues') {
    if (tail.length === 0) {
      if (req.method === 'POST') {
        const labels = Array.isArray(req.body?.labels) ? (req.body!.labels as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
        const issue = createIssue(store, repo, { title: bodyString(req.body, 'title') ?? '', body: bodyString(req.body, 'body'), labels });
        return { status: 201, body: issueJson(store, repo, issue) };
      }
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const direction = req.query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, headers } = paginate(issues, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
        return { status: 200, body: page.map((issue) => issueJson(store, repo, issue)), headers };
      }
      throw notFound();
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number)) throw notFound();
    if (tail[1] === 'comments') {
      const item = repo.items.get(number);
      if (item === undefined) throw notFound();
      if (req.method === 'GET') return { status: 200, body: item.comments.map(commentJson) };
      if (req.method === 'POST') {
        const body = bodyString(req.body, 'body');
        if (body === undefined) throw new HttpError(422, 'Validation Failed: body is required');
        const comment = addComment(store, repo, number, body);
        return { status: 201, body: commentJson(comment) };
      }
      throw notFound();
    }
    if (tail.length !== 1) throw notFound();
    const item = repo.items.get(number);
    if (item === undefined) throw notFound();
    if (req.method === 'GET') {
      if (item.kind === 'pull') {
        return { status: 200, body: { ...issueJson(store, repo, asIssueView(item)), pull_request: { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}` } } };
      }
      return { status: 200, body: issueJson(store, repo, item) };
    }
    if (req.method === 'PATCH') {
      if (item.kind !== 'issue') throw notFound();
      const title = bodyString(req.body, 'title');
      if (title !== undefined) item.title = title;
      const body = bodyString(req.body, 'body');
      if (body !== undefined) item.body = body;
      const state = bodyString(req.body, 'state');
      if (state === 'open' || state === 'closed') item.state = state;
      if (Array.isArray(req.body?.labels)) {
        const labels = (req.body!.labels as unknown[]).filter((v): v is string => typeof v === 'string');
        for (const name of labels) if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
        item.labels = labels;
      }
      return { status: 200, body: issueJson(store, repo, item) };
    }
    throw notFound();
  }

  if (head === 'pulls') {
    if (tail.length === 0) {
      if (req.method === 'POST') {
        const pull = createPull(store, repo, {
          title: bodyString(req.body, 'title') ?? '',
          body: bodyString(req.body, 'body'),
          head: bodyString(req.body, 'head') ?? '',
          base: bodyString(req.body, 'base') ?? repo.defaultBranch,
        });
        return { status: 201, body: pullJson(store, repo, pull) };
      }
      if (req.method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => a.number - b.number);
        const { page, headers } = paginate(pulls, req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
        return { status: 200, body: page.map((pull) => pullJson(store, repo, pull)), headers };
      }
      throw notFound();
    }
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isInteger(number)) throw notFound();
    const item = repo.items.get(number);
    if (item === undefined || item.kind !== 'pull') throw notFound();
    if (tail.length === 1 && req.method === 'GET') return { status: 200, body: pullJson(store, repo, item) };
    if (tail[1] === 'files' && req.method === 'GET') {
      const changes = pullFiles(store, repo, item);
      const files = changes.map((change) => {
        const additions = change.status === 'removed' ? 0 : 1;
        const deletions = change.status === 'added' ? 0 : 1;
        return { filename: change.path, status: change.status, additions, deletions, changes: additions + deletions };
      });
      return { status: 200, body: files };
    }
    if (tail[1] === 'merge' && req.method === 'PUT') {
      const method = bodyString(req.body, 'merge_method');
      const result = mergePull(store, repo, item, method === 'merge' ? 'merge' : 'squash');
      return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    throw notFound();
  }

  throw notFound();
}

/** A pull request viewed through the issue lens (GitHub serves PRs as issues too). */
function asIssueView(pull: PullRec): IssueRec {
  return {
    kind: 'issue',
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    comments: pull.comments,
  };
}

export function handleRest(store: Store, req: RestRequest): RestReply {
  const segments = req.segments;
  try {
    if (segments.length === 0) {
      if (req.method === 'GET') return handleRoot();
      throw notFound();
    }
    if (segments[0] === 'meta' && segments.length === 1 && req.method === 'GET') {
      return { status: 200, body: { installed_version: 'noble-forge/1.0.0', api_version: '3' } };
    }
    if (segments[0] === 'user' && segments.length === 1 && req.method === 'GET') {
      return { status: 200, body: userJson() };
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (req.method === 'POST') return handleCreateRepo(store, req);
      if (req.method === 'GET') {
        const { page, headers } = paginate(store.listRepos(), req, '/api/v3/user/repos');
        return { status: 200, body: page.map(repoJson), headers };
      }
      throw notFound();
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const repo = requireRepo(store, segments[1]!, segments[2]!);
      return handleRepoScoped(store, repo, req, segments.slice(3));
    }
    throw notFound();
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { message: error.message } };
    throw error;
  }
}
